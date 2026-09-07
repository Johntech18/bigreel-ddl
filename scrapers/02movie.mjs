// scrapers/02movie.mjs - scraper for 02movie.com (AES-GCM encrypted API).
//
// Resolution chain:
//   1. Token:      02movie.com/api/movies/download-token?id={tmdbId}
//   2. Primary:    02movie.com/api/movies/download?id={tmdbId}&t={token}  (AES-GCM)
//   3. Fallback:   02movie.com/api/movies/fallback?tmdbId={tmdbId}&t={token}  (AES-GCM)
//
// All API responses are AES-GCM encrypted with key = SHA256("o2by_M0v1e_S3cur_Ek3y!").
// The downloader server (02moviedownloader.top) requires Cloudflare Turnstile and
// cannot be used without a browser, so it is not included here.

import { UA, REQUEST_TIMEOUT_MS } from "./base.mjs";

const DEFAULT_BASE = "https://02movie.com";

const KEY_PARTS = ["o2by", "M0v1e", "S3cur", "Ek3y!"];

// --- crypto helpers ----------------------------------------------------------

let _apiKey = null;
async function getApiKey() {
  if (_apiKey) return _apiKey;
  const raw = new TextEncoder().encode(KEY_PARTS.join("_"));
  const hash = await crypto.subtle.digest("SHA-256", raw);
  _apiKey = await crypto.subtle.importKey("raw", hash, { name: "AES-GCM" }, false, ["decrypt"]);
  return _apiKey;
}

async function decryptAesGcm(encoded) {
  const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  const iv = bytes.slice(0, 12);
  const tag = bytes.slice(12, 28);
  const cipher = bytes.slice(28);
  // AES-GCM: ciphertext + tag concatenated by the JS runtime
  const combined = new Uint8Array(cipher.length + tag.length);
  combined.set(cipher, 0);
  combined.set(tag, cipher.length);
  const key = await getApiKey();
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, combined);
  return JSON.parse(new TextDecoder().decode(plain));
}

// --- fetch helpers -----------------------------------------------------------

function fetchJson(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  return fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json", ...opts.headers },
    method: opts.method || "GET",
    body: opts.body || undefined,
    signal: controller.signal,
  })
    .finally(() => clearTimeout(timer));
}

// Get a download token from the API (required before any download/fallback call).
async function getDownloadToken(base, tmdbId, type, season, episode) {
  let path;
  if (type === "tv" && season && episode) {
    path = `/api/tv/download-token?id=${encodeURIComponent(tmdbId)}&season=${season}&episode=${episode}`;
  } else {
    path = `/api/movies/download-token?id=${encodeURIComponent(tmdbId)}`;
  }
  const res = await fetchJson(`${base}${path}`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`download-token HTTP ${res.status} — ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  if (!json.token || typeof json.token !== "string") {
    throw new Error("download-token did not return a valid token");
  }
  return json.token;
}

// Fetch an encrypted API path, append the token, and decrypt.
async function fetchDecrypted(base, path, token) {
  const sep = path.includes("?") ? "&" : "?";
  const url = `${base}${path}${sep}t=${encodeURIComponent(token)}`;
  let res;
  try {
    res = await fetchJson(url);
  } catch (err) {
    throw new Error(`fetch failed for ${url}: ${err.message}`);
  }
  if (!res.ok) {
    let body = "";
    try { body = await res.text(); } catch { /* ignore */ }
    throw new Error(`02movie HTTP ${res.status} for ${url} — body: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  if (json._e && typeof json._e === "string") {
    return await decryptAesGcm(json._e);
  }
  return json;
}

// --- extract download options ------------------------------------------------

function formatSize(val) {
  if (!val) return null;
  if (typeof val === "string" && /[KMGT]B/i.test(val)) return val;
  const n = Number(val);
  if (isNaN(n)) return null;
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(2)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

function extractOptions(data, server) {
  // fallback format: { links: [{ quality, downloadLink, size, format, name }] }
  if (Array.isArray(data?.links) && data.links.length) {
    return data.links.map((o) => ({
      url: o.downloadLink,
      quality: o.quality || "Unknown",
      size: formatSize(o.size),
      format: (o.format || "mp4").toUpperCase(),
      name: o.name || "",
      server,
    })).filter((o) => o.url);
  }
  // streams -> links
  if (Array.isArray(data?.streams) && data.streams.length) {
    return data.streams.flatMap((stream) => {
      const links = Array.isArray(stream.links) ? stream.links : [];
      return links.map((o) => ({
        url: o.url?.startsWith("/") ? `${DEFAULT_BASE}${o.url}` : o.url,
        quality: o.quality || stream.quality || "Unknown",
        size: formatSize(o.size || null),
        format: (o.format || "mp4").toUpperCase(),
        name: "",
        server,
      }));
    }).filter((o) => o.url);
  }
  // downloadOptions
  if (Array.isArray(data?.downloadOptions) && data.downloadOptions.length) {
    return data.downloadOptions.map((o) => ({
      url: o.url?.startsWith("/") ? `${DEFAULT_BASE}${o.url}` : o.url,
      quality: o.quality || "Unknown",
      size: formatSize(o.size),
      format: (o.format || "mp4").toUpperCase(),
      name: "",
      server,
    })).filter((o) => o.url);
  }
  return [];
}

// --- verify download link (HEAD request) -------------------------------------

async function verifyDownload(url) {
  try {
    const res = await fetch(url, {
      method: "HEAD",
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(8000),
      redirect: "follow",
    });
    return res.status < 400 || res.status === 405;
  } catch {
    return false;
  }
}

// --- shared scrape logic -----------------------------------------------------

async function fetchAllLinks(base, tmdbId, type, season, episode) {
  // Step 1: get download token
  const token = await getDownloadToken(base, tmdbId, type, season, episode);

  // Step 2: fetch primary + fallback in parallel with the token
  let primaryPath, fallbackPath;
  if (type === "tv" && season && episode) {
    primaryPath = `/api/tv/download?id=${encodeURIComponent(tmdbId)}&season=${season}&episode=${episode}`;
    fallbackPath = `/api/tv/fallback?tmdbId=${encodeURIComponent(tmdbId)}&season=${season}&episode=${episode}`;
  } else {
    primaryPath = `/api/movies/download?id=${encodeURIComponent(tmdbId)}`;
    fallbackPath = `/api/movies/fallback?tmdbId=${encodeURIComponent(tmdbId)}`;
  }

  const [primary, fallback] = await Promise.allSettled([
    fetchDecrypted(base, primaryPath, token),
    fetchDecrypted(base, fallbackPath, token),
  ]);

  const server1 = primary.status === "fulfilled" ? extractOptions(primary.value, 1) : [];
  const server2 = fallback.status === "fulfilled" ? extractOptions(fallback.value, 2) : [];

  const errors = [];
  if (primary.status === "rejected") errors.push(`primary: ${primary.reason?.message}`);
  if (fallback.status === "rejected") errors.push(`fallback: ${fallback.reason?.message}`);

  return { all: [...server1, ...server2], errors };
}

// --- scraper export ----------------------------------------------------------

export function make02movie({
  base = DEFAULT_BASE,
  name = "02movie",
} = {}) {
  async function scrapeMovie({ tmdbId, title }) {
    if (!tmdbId) {
      return { provider: name, error: "02movie requires a TMDB ID", sources: [] };
    }
    const { all, errors } = await fetchAllLinks(base, tmdbId, "movie");

    // Verify links in parallel, skip unverifiable
    const results = await Promise.allSettled(
      all.map((opt) =>
        verifyDownload(opt.url).then((ok) => {
          if (!ok) throw new Error("not ok");
          return opt;
        })
      )
    );

    const verified = results
      .filter((r) => r.status === "fulfilled")
      .map((r) => r.value);

    const sources = verified.map((opt) => ({
      provider: name, url: opt.url,
      label: `${title || "Movie"} · ${opt.name || "02movie"} · ${opt.quality}`,
      quality: opt.quality || "HD",
      size: opt.size || null,
      format: opt.format || "MP4",
      isEmbed: false, locked: false,
      note: `Direct link (server ${opt.server})`,
    }));

    // If nothing verified, add first link as locked
    if (!sources.length && all.length) {
      const first = all[0];
      sources.push({
        provider: name, url: first.url,
        label: `${title || "Movie"} · ${first.name || "02movie"} · ${first.quality}`,
        quality: first.quality || "HD",
        size: first.size || null,
        format: first.format || "MP4",
        isEmbed: false, locked: true,
        note: "Link found but could not verify availability",
      });
    }

    return { provider: name, sources, errors };
  }

  async function scrapeEpisode({ tmdbId, season, episode, title }) {
    if (!tmdbId) {
      return { provider: name, error: "02movie requires a TMDB ID", sources: [] };
    }
    const s = season || "1";
    const e = episode || "1";
    const { all, errors } = await fetchAllLinks(base, tmdbId, "tv", s, e);

    const results = await Promise.allSettled(
      all.map((opt) =>
        verifyDownload(opt.url).then((ok) => {
          if (!ok) throw new Error("not ok");
          return opt;
        })
      )
    );

    const verified = results
      .filter((r) => r.status === "fulfilled")
      .map((r) => r.value);

    const sources = verified.map((opt) => ({
      provider: name, url: opt.url,
      label: `${title || "TV"} S${s}E${e} · ${opt.name || "02movie"} · ${opt.quality}`,
      quality: opt.quality || "HD",
      size: opt.size || null,
      format: opt.format || "MP4",
      isEmbed: false, locked: false,
      note: `Direct link (server ${opt.server})`,
    }));

    if (!sources.length && all.length) {
      const first = all[0];
      sources.push({
        provider: name, url: first.url,
        label: `${title || "TV"} S${s}E${e} · ${first.name || "02movie"} · ${first.quality}`,
        quality: first.quality || "HD",
        size: first.size || null,
        format: first.format || "MP4",
        isEmbed: false, locked: true,
        note: "Link found but could not verify availability",
      });
    }

    return { provider: name, sources, errors };
  }

  return { name, scrapeMovie, scrapeEpisode };
}

export const movie02 = make02movie();
export default movie02;
