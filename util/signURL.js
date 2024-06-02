const { createHash } = require("node:crypto");
const ms = require("ms");

// i set maybe 3 hours is worth it
const expirationTime = ms("3h");

module.exports = function signUrl(url) {
  const cdnToken = process.env?.BUNNY_CDN_TOKEN_AUTH;
  if (!cdnToken) return null;

  // expires 24 hour
  const expires = Math.floor((Date.now() + expirationTime) / 1000);
  const parsedURL = new URL(url);
  
	const hashableBase = cdnToken + decodeURIComponent(parsedURL.pathname) + expires;

	let token = Buffer.from(createHash("sha256").update(hashableBase).digest()).toString("base64");

	token = token.replace(/\n/g, "").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  
  const processedURL = new URL(url);
  
  for (const [key, value] of Object.entries({token, expires})) {
    processedURL.searchParams.append(String(key), String(value));
  };
  
  return processedURL.toString();
};