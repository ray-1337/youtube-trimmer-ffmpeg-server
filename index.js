require("dotenv/config");

const Express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const { validateURL, getInfo } = require("ytdl-core");
const { Readable, PassThrough } = require("node:stream");
const { v4: uuidv4 } = require("uuid");
const { request } = require("undici");

const signURL = require("./util/signURL");

const ffmpeg = require("fluent-ffmpeg-7");
const { path: ffmpegPath } = require("@ffmpeg-installer/ffmpeg");
const { path: ffprobePath } = require("@ffprobe-installer/ffprobe");

if (!process.env.WSL) {
  ffmpeg.setFfmpegPath(ffmpegPath);
  ffmpeg.setFfprobePath(ffprobePath);
};

if (!process.env?.BUNNY_STORAGENAME || !process.env?.BUNNY_HOSTNAME || !process.env?.BUNNY_AUTH) {
  console.error("this project is still a draft, meaning bunnycdn authentication is required to upload the trimmed file.");
  return process.exit(0);
};

const app = Express();

app
.use(Express.json({type: "application/json", strict: true}))
.use(cors())
.use(helmet());

app.get("/", (_, res) => res.sendStatus(200));

app.post("/trim", async (req, res) => {
  if (!req.headers?.authorization?.length || req.headers.authorization !== process.env.SERVER_AUTH) {
    return res.sendStatus(403);
  };

  const body = req.body;
  if (!body?.url || typeof body?.url !== "string") {
    return res.status(400).send("youtube url is required.");
  };

  // { ..., duration: [0, 60] }
  if (!body?.duration || !Array.isArray(body.duration) || body.duration.length !== 2) {
    return res.status(400).send("duration is required.");
  };

  let [minSecond, maxSecond] = body.duration;
  if (isNaN(minSecond) || isNaN(maxSecond)) {
    return res.status(400).send("invalid duration.");
  };

  if (minSecond >= maxSecond) {
    minSecond = Math.max(0, maxSecond - 1);
  } else if (maxSecond <= minSecond) {
    maxSecond = Math.max(0, minSecond + 1);
  };

  try {
    // validate if the url from the body is youtube url
    if (!validateURL(body.url)) {
      return res.status(400).send("invalid youtube url.");
    };

    // retrieving youtube content info
    const cookie = process.env.COOKIE_BYPASS;
    const data = await getInfo(body.url, {
      requestOptions: {
        headers: {
          // used to bypass age-restricted video, etc
          cookie: (typeof cookie === "string" && cookie.length >= 1) ? cookie : undefined
        }
      }
    });

    if (!data) {
      return res.status(500).send("unable to fetch the data of the current youtube url.");
    };

    // code below is adapted from my previous project, https://github.com/ray-1337/youtube-discord-embed
    const liteFilteredFormats = data.formats
    .filter(format => format.hasAudio && format.hasVideo && !format.isLive && !format.isHLS);

    // the highest quality you can get (video w/ audio) is hd720, maybe there will be a workaround in the future
    const filteredFormats = liteFilteredFormats.filter(format => format.quality === "medium" || format.quality === "hd720");

    let highestFormat = filteredFormats.find(format => format.quality === "hd720");

    if (!highestFormat) {
      const lowest = filteredFormats.find(format => format.quality === "medium");
      if (!lowest) {
        return res.status(500).send("no video available after search.");
      };

      highestFormat = lowest;
    };


    const firstRawVideoURL = highestFormat;
    if (!firstRawVideoURL?.url?.length || !firstRawVideoURL?.mimeType?.length) {
      return res.status(500).send("unable to fetch video after filter.");
    };

    // resetting the duration
    const maxVideoDurationSecond = Math.round(+firstRawVideoURL.approxDurationMs / 1000);
    if (maxSecond >= maxVideoDurationSecond) {
      maxSecond = maxVideoDurationSecond;
    };

    if (minSecond >= maxSecond) {
      minSecond = Math.max(0, maxSecond - 1);
    };

    // trim processing
    const buffers = [];
    const bufferStream = new PassThrough();

    await new Promise(async (resolve, reject) => {
      const ffmpegConcept = ffmpeg(firstRawVideoURL.url)
      .addOptions([
        '-i', firstRawVideoURL.url,
        '-ss', minSecond,
        '-to', maxSecond,
        "-c:a", "aac",
        "-f", "mp4",
        "-movflags faststart+isml+frag_keyframe"
      ])

      ffmpegConcept
      .on('end', () => resolve(true))
      .on('error', (err, stdout, stderr) => {
        console.error(err);
        console.error(stdout, stderr)
        return reject(err);
      });

      bufferStream.on('data', (buf) => buffers.push(buf));

      ffmpegConcept.writeToStream(bufferStream);
    });
    
    const concatenatedBuffer = Buffer.concat(buffers);

    if (!buffers?.length || !concatenatedBuffer?.length) {
      return res.status(500).send("no content presented after trim.");
    };

    const readableBuffer = Readable.from(Buffer.concat(buffers));

    // after trim, the video will be uploaded to my cloud storage (e.g. BunnyCDN)
    // thats why i use buffer instead of writing an output as a file

    // for folder naming purposes, i use UUID
    const folderName = uuidv4();
    const fileName = `${Date.now()}`;
    const combinedFileName = `${folderName}/${fileName}.mp4`;

    const upload = await request(`https://${process.env.BUNNY_HOSTNAME}/${process.env.BUNNY_STORAGENAME}/${combinedFileName}`, {
      method: "PUT",

      body: readableBuffer,

      headers: {
        "AccessKey": process.env.BUNNY_AUTH,
        "content-type": "application/octet-stream",
        "accept": "application/json"
      }
    });

    if (upload.statusCode !== 201) {
      return res.status(500).send(`something went wrong [${upload.statusCode}] while uploading trimmed file to the storage.`);
    };

    const finalURL = `https://${process.env.BUNNY_CDN_ENDPOINT}/${combinedFileName}`;

    // sign the URL (optional)
    if (typeof process.env.BUNNY_CDN_TOKEN_AUTH === "string" || process.env?.BUNNY_CDN_TOKEN_AUTH?.length) {
      const signedURL = signURL(finalURL);
      if (typeof signedURL !== "string" || signedURL === null) {
        return res.status(500).send("unable to sign trimmed file URL from the backend.");
      };
  
      return res.send(signedURL);
    };

    return res.send(finalURL);
  } catch (error) {
    console.error(error);

    return res.status(500).send("an unexpected error occurred from the backend server.");
  };
});

// connect
const PORT = process.env?.PORT?.length ? process.env.PORT : 3000;

app.listen(Number(PORT), () => {
  return console.log(`Successfully launching the server with port [${PORT}]`);
});