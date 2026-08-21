// scrapers/cinextream.mjs - scraper for the ddl.cinextream.cc API.
//
// ddl.cinextream.cc is a Next.js frontend whose backend is the same file
// indexer as a.111477.xyz: every resolved file URL points at
// https://a.111477.xyz/movies|tvs/... It improves on raw listing-walking by
// taking a TMDB id directly:
//
//   GET /api/movie/{tmdbId}              -> { enc }  movie files
//   GET /api/tv/{tmdbId}/{s}/{e}         -> { enc }  episode files
//   GET /api/meta/movie/{tmdbId}         -> { enc }  title/poster/overview
//   GET /api/subs/movie/{tmdbId}         -> { enc }  subtitles
//
// Every response is `{"enc":"<hex>"}` - AES-encrypted with the key baked into
// their own /wasm/codec.wasm (a 5.7 KB WebAssembly module). Node runs wasm
// natively, so we instantiate their codec and call its exported `decrypt`
// (srcPtr=256, srcLen, keyPtr=0, keyLen=32, dstPtr) exactly like the browser
// does - zero npm dependencies. The key layout is validated at runtime by the
// wasm itself (decrypt fails on bad data), so no key copy lives in this repo.
//
// File links are the same Cloudflare-gated a.111477.xyz URLs the indexer
// serves, so one probe per scrape decides the `locked` flag (they still work
// in a real browser, and with FLARESOLVERR_URL the site could be unlocked).

import { fetchChain } from "./base.mjs";

const DEFAULT_DOMAINS = ["ddl.cinextream.cc"];

export function makeCinextream({
  domains = DEFAULT_DOMAINS,
  name = "cinextream",
  label = "Cinextream (a.111477 backend)",
} = {}) {
  const codecCache = new Map(); // domain -> Promise<wasm exports>

  // Instantiate their codec.wasm once per domain and cache the exports.
  // The wasm is binary, so fetch raw bytes with fetch() (fetchChain decodes
  // to text and would corrupt it).
  function getCodec(base) {
    if (!codecCache.has(base)) {
      codecCache.set(base, (async () => {
        const res = await fetch(`${base}/wasm/codec.wasm`, { headers: { "User-Agent": "Mozilla/5.0" } });
        if (!res.ok) throw new Error(`codec.wasm returned HTTP ${res.status}`);
        const raw = await res.arrayBuffer();
        const { instance } = await WebAssembly.instantiate(raw, {});
        return instance.exports;
      })());
    }
    return codecCache.get(base);
  }

  // Decrypt an `enc` hex payload by running their wasm decrypt().
  async function decrypt(base, enc) {
    const hex = String(enc).trim();
    if (!hex || hex.length % 2 !== 0) throw new Error("Malformed encrypted payload");
    const t = await getCodec(base);
    const a = new Uint8Array(hex.match(/.{1,2}/g).map((e) => parseInt(e, 16)));
    const s = a.length;
    const r = 256 + s + 64;
    new Uint8Array(t.memory.buffer).set(a, 256);
    t.decrypt(256, s, 0, 32, r);
    return new TextDecoder().decode(new Uint8Array(t.memory.buffer, r, s));
  }

  // Fetch + decrypt one API endpoint. Tries each configured domain in order.
  async function api(path) {
    let lastErr;
    for (const domain of domains) {
      const base = `https://${domain}`;
      try {
        const res = await fetchChain(`${base}${path}`);
        if (res.status !== 200) {
          lastErr = new Error(`HTTP ${res.status}`);
          continue;
        }
        const { enc } = JSON.parse(res.text);
        const json = JSON.parse(await decrypt(base, enc));
        return { base, json };
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error("No reachable cinextream domain");
  }

  // Probe the first file to decide whether links are currently Cloudflare-gated
  // (same protection config as the a.111477.xyz indexer).
  async function probeFile(url) {
    try {
      const { status, headers } = await fetchChain(url, { maxRedirects: 2 });
      const isCF = status === 403 && String(headers.get?.("server") || "").toLowerCase().includes("cloudflare");
      if (isCF) {
        return { locked: true, note: "This is a direct download link with no ad, just pass through cloudflare challenge and you are good to go!" };
      }
      if (status >= 200 && status < 400) return { locked: false };
      return { locked: true, note: `file probe returned HTTP ${status}` };
    } catch (e) {
      return { locked: true, note: `file probe failed: ${e.message}` };
    }
  }

  function toSources(files, probe) {
    return (files || [])
      .slice()
      .sort((a, b) => (a.priority || 0) - (b.priority || 0))
      .map((f) => ({
        provider: name,
        url: f.url,
        label: f.name,
        quality: f.resolution || "",
        size: f.size || "",
        codec: f.codec || null,
        audio: f.audio || null,
        source: f.source || null,
        hdr: Boolean(f.hdr),
        fileType: f.fileType || null,
        isEmbed: false,
        locked: probe?.locked || false,
        note: probe?.note || null,
      }));
  }

  async function scrapeMovie({ title, year, tmdbId }) {
    if (!tmdbId) {
      return { provider: name, error: "cinextream needs a tmdbId (TMDB_API_KEY set; /api/find or /api/scrape/movie/:tmdbId)", sources: [] };
    }
    try {
      const { base, json } = await api(`/api/movie/${tmdbId}`);
      const files = json.files || [];
      if (!files.length) return { provider: name, post: `${base}/movie/${tmdbId}`, error: "No files for this movie", sources: [] };
      const probe = await probeFile(files[0].url);
      return { provider: name, post: `${base}/movie/${tmdbId}`, sources: toSources(files, probe) };
    } catch (e) {
      return { provider: name, error: e.message, sources: [] };
    }
  }

  async function scrapeEpisode({ title, season, episode, tmdbId }) {
    if (!tmdbId) {
      return { provider: name, error: "cinextream needs a tmdbId (TMDB_API_KEY set; /api/find or /api/scrape/tv/:tmdbId/:s/:e)", sources: [] };
    }
    try {
      const { base, json } = await api(`/api/tv/${tmdbId}/${season}/${episode}`);
      const files = json.files || [];
      if (!files.length) return { provider: name, post: `${base}/tv/${tmdbId}/${season}/${episode}`, error: `No files for S${season}E${episode}`, sources: [] };
      const probe = await probeFile(files[0].url);
      return { provider: name, post: `${base}/tv/${tmdbId}/${season}/${episode}`, sources: toSources(files, probe) };
    } catch (e) {
      return { provider: name, error: e.message, sources: [] };
    }
  }

  return { name, label, domains, scrapeMovie, scrapeEpisode };
}

export const cinextream = makeCinextream();
export default cinextream;
