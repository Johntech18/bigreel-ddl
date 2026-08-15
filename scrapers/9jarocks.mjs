// scrapers/9jarocks.mjs - scraper for 9jarocks.net (Nigerian entertainment site).
//
// WordPress (verified Aug 2026) with a large library: Nollywood + Hollywood +
// Asian dramas, TV series and movies. Search works server-side via the
// standard WordPress endpoint:
//   /?s=<query>                -> post list (URLs match /<slug>-<id>.html)
//   /videodownload/<slug>-<id>.html -> post with a "DOWNLOAD LINKS" section:
//       <a ...>DOWNLOAD FAST SERVER</a>              -> associationfoam.com JS
//                                                      auto-form shortener
//       <a href="https://loadedfiles.net/<id>/<name>.mkv">DOWNLOAD</a>
//                                                  -> per-quality / per-episode
//                                                     file-host pages
//
// Every link is a browser-interaction hop, so this provider is metadata-only
// (like pahe's locked mode): quality labels come from the filenames
// ("The.Avengers.2012.540p.x265.AAC" -> 540p), and all sources are flagged
// locked with a note. The loadedfiles token chain rotates on every request and
// never serves bytes to a plain client; the FAST SERVER link is an obfuscated
// JS auto-form - both need a real browser.

import { fetchChain, normalizeTitle, decodeEntities } from "./base.mjs";

const DEFAULT_DOMAINS = ["9jarocks.net"];

// File hosts used for actual downloads. Everything else (e.g. the
// associationfoam.com "FAST SERVER" shortener) is a redirect/auto-form hop.
const FILE_HOSTS = new Set(["loadedfiles.net", "loadedfiles.org"]);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Leading resolution from a label ("540p" -> 540, "1080p" -> 1080).
function sourceResolution(quality) {
  const m = String(quality || "").match(/(\d{3,4})\s*p/i);
  return m ? parseInt(m[1], 10) : null;
}

function parseMinQuality(v) {
  const s = String(v || "").trim().toLowerCase();
  const m = s.match(/(\d{3,4})\s*p?/);
  if (m) return parseInt(m[1], 10);
  if (s.includes("4k") || s.includes("2160")) return 2160;
  return null;
}

function filterMinQuality(sources, minQuality) {
  const min = parseMinQuality(minQuality);
  if (!min) return sources;
  return sources.filter((s) => {
    const res = sourceResolution(s.quality);
    return res !== null && res >= min;
  });
}

// Derive a human label from a loadedfiles filename: quality + codec + container.
// "The.Avengers.2012.540p.x265.AAC.[9jaRocks.Com].mkv" -> "540p · X265 · MKV"
function labelFromFilename(filename) {
  const base = decodeURIComponent(String(filename || "")).replace(/\[[^\]]*\]/g, " ");
  const q = (base.match(/\b(\d{3,4})p\b/i) || [])[1] || "";
  const codec = (base.match(/\.(x26[45]|h26[45]|hevc|avc|aac|dd5\.1|ddp5\.1|web-?dl|hdtv|bluray|webrip|hdrip)/i) || [])[1] || "";
  const ext = (base.match(/\.(mkv|mp4|avi|webm)/i) || [])[1] || "";
  const parts = [q ? `${q}p` : "", codec && codec.toUpperCase(), ext && ext.toUpperCase()].filter(Boolean);
  return parts.join(" · ") || "";
}

export function make9jarocks({
  domains = DEFAULT_DOMAINS,
  name = "ninejarocks",
  label = "9jarocks (Nigerian - metadata, links are browser-gated)",
  paceMs = 350,
  maxRetries = 2,
  cacheTtlMs = 60 * 60 * 1000,
} = {}) {
  const base = domains[0] ? `https://${domains[0]}` : null;
  const postCache = new Map(); // url -> { expiresAt, text }

  async function paced() {
    if (paceMs) await sleep(paceMs);
  }

  async function fetchWithRetry(url) {
    let lastErr;
    for (let i = 0; i < maxRetries; i++) {
      await paced();
      try {
        const r = await fetchChain(url);
        if (r.status === 200) return r;
        lastErr = new Error(`HTTP ${r.status} for ${url}`);
      } catch (e) {
        lastErr = e;
      }
      await sleep(600 * (i + 1));
    }
    throw lastErr || new Error(`Failed after ${maxRetries} attempts`);
  }

  // Post links + titles from a WordPress search results page. Post URLs match
  // `/<slug>-<numeric id>.html`; nav/sidebar/guide links don't.
  function parsePosts(html) {
    const out = [];
    const seen = new Set();
    for (const m of String(html).matchAll(/<a([^>]*)href="([^"]+)"([^>]*)>([\s\S]*?)<\/a>/gi)) {
      const url = m[2];
      if (!/-id\d+\.html$/i.test(url)) continue;
      let title = decodeEntities(m[4].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
      if (!title) {
        const attr = (m[1] + " " + m[3]).match(/title="([^"]+)"/i);
        if (attr) title = decodeEntities(attr[1]);
      }
      if (!title || /how to download/i.test(title) || seen.has(url)) continue;
      seen.add(url);
      out.push({ url: url.startsWith("http") ? url : `${base}${url}`, title });
    }
    return out;
  }

  async function searchPosts(title) {
    if (!base) return [];
    const t = normalizeTitle(title);
    const { text } = await fetchWithRetry(`${base}/?s=${encodeURIComponent(title)}`);
    return parsePosts(text).filter((p) => normalizeTitle(p.title).includes(t));
  }

  // Best match: exact normalized title, then title-with-year, then first.
  // TV prefers a post naming the requested season; the year is a preference,
  // never a hard filter (many posts omit it, e.g. "The Boys Season 5").
  function pickPost(posts, title, year, season) {
    const t = normalizeTitle(title);
    let pool = posts;
    if (season) {
      const bySeason = pool.filter((p) => new RegExp(`season\\s*${season}(\\b|\\s|$|-|\\()`, "i").test(p.title));
      if (bySeason.length) pool = bySeason;
      else {
        const complete = pool.filter((p) => /complete/i.test(p.title));
        if (complete.length) pool = complete;
      }
    }
    const exact = pool.find((p) => normalizeTitle(p.title) === t);
    if (exact) return exact;
    if (year) {
      const withYear = pool.find((p) => normalizeTitle(p.title).includes(String(year)));
      if (withYear) return withYear;
    }
    return pool.find((p) => normalizeTitle(p.title).includes(t)) || pool[0];
  }

  // The "DOWNLOAD LINKS" section of a post, with scripts/styles stripped.
  function downloadSection(text) {
    const clean = String(text)
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ");
    const start = clean.indexOf("DOWNLOAD LINKS");
    if (start === -1) return "";
    const end = clean.indexOf("SCREENSHOT", start);
    const cut = end > start ? end : start + 15000;
    return clean.slice(start, cut);
  }

  // Build the source list for a post's download section.
  function extractSources(section, { episode } = {}) {
    const sources = [];
    const lockedNote = "browser-gated download page (loadedfiles countdown + token chain / JS auto-form shortener) - open this link in a browser to download";

    // Per-episode rows: <em>EPISODE 3</em><br /><a href="https://loadedfiles.net/...">SERVER 1</a>
    // Some rows carry the full filename (quality in it), others are hex-id
    // only with the server name in the anchor text - use whichever exists.
    const episodeRows = [...section.matchAll(/<em>EPISODE\s*(\d+)<\/em>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
    for (const m of episodeRows) {
      const ep = parseInt(m[1], 10);
      if (episode && ep !== episode) continue;
      const href = m[2];
      const txt = decodeEntities(m[3].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()) || "";
      const fn = decodeURIComponent(href.split("/").pop() || "");
      const hasFn = /\.(mkv|mp4|avi|webm)/i.test(fn);
      const quality = ((fn.match(/\b(\d{3,4})p\b/i) || [])[1] || "").toLowerCase();
      const label = hasFn ? labelFromFilename(href) : txt || "Download";
      sources.push({
        provider: name,
        url: href,
        label: `S?E${String(ep).padStart(2, "0")} · ${label}`,
        quality,
        size: "",
        host: new URL(href).host,
        isEmbed: false,
        locked: true,
        note: lockedNote,
      });
    }

    // Remaining download anchors (quality rows, fast-server shortener, or
    // whole-season packs where there are no per-episode markers).
    const epHrefs = new Set(episodeRows.map((r) => r[2]));
    for (const m of section.matchAll(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
      const href = m[1];
      const inner = decodeEntities(m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).toUpperCase();
      if (!/^https?:/.test(href)) continue;
      // Skip links already captured as episode rows.
      if (epHrefs.has(href)) continue;
      const host = new URL(href).host;
      if (FILE_HOSTS.has(host)) {
        const fn = decodeURIComponent(href.split("/").pop() || "");
        const hasFn = /\.(mkv|mp4|avi|webm)/i.test(fn);
        const quality = ((fn.match(/\b(\d{3,4})p\b/i) || [])[1] || "").toLowerCase();
        const label = hasFn ? labelFromFilename(href) : inner || "Download";
        sources.push({
          provider: name,
          url: href,
          label,
          quality,
          size: "",
          host,
          isEmbed: false,
          locked: true,
          note: lockedNote,
        });
      } else if (/FAST SERVER/i.test(inner) || !FILE_HOSTS.has(host)) {
        // The FAST SERVER shortener (or any non-file-host link).
        sources.push({
          provider: name,
          url: href,
          label: "FAST SERVER",
          quality: "",
          size: "",
          host,
          isEmbed: false,
          locked: true,
          note: "JS auto-form shortener - open in a browser to reach the download",
        });
      }
    }
    return sources;
  }

  async function scrapeMovie({ title, year, minQuality }) {
    if (!base) return { provider: name, error: "no domains configured", sources: [] };
    const posts = await searchPosts(title);
    if (!posts.length) return { provider: name, error: `No post found for "${title}" on this server`, sources: [] };
    const post = pickPost(posts, title, year, null);
    const { text } = await fetchWithRetry(post.url);
    const sources = filterMinQuality(extractSources(downloadSection(text)), minQuality);
    if (!sources.length) return { provider: name, post: post.url, error: "No download links found on post", sources: [] };
    return { provider: name, post: post.url, sources };
  }

  // TV posts list per-episode rows ("EPISODE 1..N"). Match the season post,
  // then filter rows to the requested episode (or keep the whole season when
  // the post has no per-episode markers).
  async function scrapeEpisode({ title, year, season, episode, minQuality }) {
    if (!base) return { provider: name, error: "no domains configured", sources: [] };
    // The registry passes query params as strings - coerce before comparing.
    if (season != null) season = Number(season);
    if (episode != null) episode = Number(episode);
    const posts = await searchPosts(title);
    if (!posts.length) return { provider: name, error: `No post found for "${title}" on this server`, sources: [] };
    const post = pickPost(posts, title, year, season);
    const { text } = await fetchWithRetry(post.url);
    const section = downloadSection(text);
    const hasEpisodeRows = /<em>EPISODE\s*\d+<\/em>/i.test(section);
    const sources = filterMinQuality(extractSources(section, { episode: hasEpisodeRows ? episode : undefined }), minQuality);
    if (!sources.length) return { provider: name, post: post.url, error: "No download links found on post", sources: [] };
    for (const s of sources) {
      if (!hasEpisodeRows) s.note = `whole-season pack (S${season ?? "?"}) - ${s.note}`;
      else if (s.label.startsWith("S?E")) s.label = s.label.replace("S?", `S${season ?? "?"}`);
    }
    return { provider: name, post: post.url, sources };
  }

  return {
    name,
    label,
    domains,
    searchPosts,
    scrapeMovie,
    scrapeEpisode,
  };
}

export const ninejarocks = make9jarocks();
export default ninejarocks;
