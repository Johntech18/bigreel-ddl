// nxsha.mjs - client for the nxsha.app direct-download API.
//
// How it works (reverse-engineered from the site's own frontend bundle):
//   1. The web app (web.nxsha.app) guards /dl/* pages with a purely client-side
//      "security check" (add two random numbers). No token is produced - once you
//      "verify", the frontend just starts calling the API.
//   2. Every API call is `GET /api/{servers,sources}?q=<ciphertext>` where
//      `q` is a JSON payload encrypted with CryptoJS.AES.encrypt(msg, passphrase)
//      in OpenSSL "Salted__" format, then base64url-encoded (no padding).
//   3. Responses come back as JSON `{ "_hash": <same ciphertext format> }`.
//      Decrypt and JSON.parse to get the real body.
//   4. `/api/servers` returns the list of scraper providers. `/api/sources`
//      takes `provider: <scraper name>` and returns the actual download links.
//
// The passphrase below is literally present in the site's public JS:
//   String.fromCharCode(83,56,120,33,74,107,52,90,80,49,117,71,56,36,109,121)
// This is obfuscation, not real security - the API is effectively public.

import crypto from "node:crypto";

const PASSPHRASE = "S8x!Jk4ZP1uG8$my";

const BASE_URL = (process.env.NXSHA_BASE_URL || "https://web.nxsha.app").replace(/\/+$/, "");
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT_MS = 30_000;

// --- CryptoJS-compatible AES (OpenSSL "Salted__" format) ----------------------

// EVP_BytesToKey with MD5 and one iteration, exactly like CryptoJS's OpenSSL KDF.
function evpBytesToKey(password, salt, keyLen, ivLen) {
  const pw = Buffer.from(password, "utf8");
  let derived = Buffer.alloc(0);
  let prev = Buffer.alloc(0);
  while (derived.length < keyLen + ivLen) {
    prev = crypto.createHash("md5").update(Buffer.concat([prev, pw, salt])).digest();
    derived = Buffer.concat([derived, prev]);
  }
  return {
    key: derived.subarray(0, keyLen),
    iv: derived.subarray(keyLen, keyLen + ivLen),
  };
}

// CryptoJS defaults: AES-256, CBC, PKCS#7, passphrase -> EVP_BytesToKey(MD5, 1 iter).
function encryptOpenSSL(plaintext, passphrase) {
  const salt = crypto.randomBytes(8);
  const { key, iv } = evpBytesToKey(passphrase, salt, 32, 16);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  const out = Buffer.concat([Buffer.from("Salted__", "ascii"), salt, ct]);
  return out.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decryptOpenSSL(encoded, passphrase) {
  let b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4 !== 0) b64 += "=";
  const raw = Buffer.from(b64, "base64");
  if (raw.subarray(0, 8).toString("ascii") !== "Salted__") {
    throw new Error("Unexpected ciphertext format (expected OpenSSL salted format)");
  }
  const salt = raw.subarray(8, 16);
  const { key, iv } = evpBytesToKey(passphrase, salt, 32, 16);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([decipher.update(raw.subarray(16)), decipher.final()]).toString("utf8");
}

// Mirrors the frontend's encodeData(): adds anti-replay noise, AES-encrypts,
// then base64url without padding.
export function encodeData(obj) {
  const r = {
    ...obj,
    _req_ts: Date.now(),
    _req_salt: Math.random().toString(36).substring(2, 12),
  };
  return encryptOpenSSL(JSON.stringify(r), PASSPHRASE);
}

// Mirrors the frontend's decodeData(): decrypt, parse, drop noise fields.
export function decodeData(encoded) {
  if (!encoded) return null;
  try {
    const parsed = JSON.parse(decryptOpenSSL(encoded, PASSPHRASE));
    delete parsed._req_ts;
    delete parsed._req_salt;
    return parsed;
  } catch {
    return null;
  }
}

// --- API calls ----------------------------------------------------------------

async function apiGet(path, payload) {
  const q = encodeData(payload);
  const url = `${BASE_URL}${path}?q=${encodeURIComponent(q)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`nxsha upstream returned HTTP ${res.status}`);
    const json = await res.json();
    const body = decodeData(json._hash);
    if (body === null) throw new Error("Failed to decrypt nxsha response");
    return body;
  } finally {
    clearTimeout(timer);
  }
}

// A media descriptor used by every nxsha payload.
export function mediaPayload({ tmdbId, type, imdbId = "", season = "1", episode = "1" }) {
  return {
    tmdbId: String(tmdbId),
    type, // "movie" | "tv"
    imdb_id: imdbId,
    season: String(season),
    episode: String(episode),
    method: "dl",
  };
}

export async function getServers(media) {
  return apiGet("/api/servers", mediaPayload(media));
}

export async function getSources(media, provider) {
  return apiGet("/api/sources", { provider, ...mediaPayload(media) });
}

// Fetch sources from every provider for the given media, with limited
// concurrency and per-provider timeout. Mirrors what the site's frontend does.
export async function getDirectLinks(media, { concurrency = 4 } = {}) {
  const { servers = [] } = await getServers(media);
  const results = new Array(servers.length);
  let idx = 0;

  const worker = async () => {
    while (idx < servers.length) {
      const i = idx++;
      const server = servers[i];
      const provider = server.scraper || String(server.id);
      try {
        const data = await getSources(media, provider);
        results[i] = {
          server,
          provider,
          sources: Array.isArray(data.sources) ? data.sources.filter(Boolean) : [],
          error: data.error || null,
        };
      } catch (err) {
        results[i] = { server, provider, sources: [], error: err.message };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, servers.length) }, worker));
  return { servers: results };
}
