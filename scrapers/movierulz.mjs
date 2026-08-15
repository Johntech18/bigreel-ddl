// scrapers/movierulz.mjs - scraper for the 5movierulz.watch Indian movie site.
//
// The site is a custom PHP (not WordPress) index of Indian cinema - Telugu,
// Tamil, Malayalam, Hindi/Bollywood and Hollywood-dubbed releases with a big
// year-by-year library. Verified structure (Aug 2026):
//   /category/<lang>-movies-<year>   -> post list, newest first, paginated ?page=N
//   /category/web-series             -> latest-feed (shows + movies, newest first)
//   <slug>-<id>.html                 -> post page with two link sections:
//       "DOWNLOAD TORRENT FILES"     -> magnet: links, label carries size+quality
//                                        ("GET THIS TORRENT 2.3 gb 1080p") - DIRECT
//       "STREAM & DOWNLOAD HIGH-SPEED LINKS" -> mirror cards (Streamlare,
//                                        Uperbox, EasySyncr, Streamwish,
//                                        Filelions) - external file-host links.
//
// Search is not usable server-side: the WordPress-style ?s= endpoint is
// Cloudflare-challenged and ?search= ignores the query, so discovery walks the
// category pages (homepage nav lists every category) and matches post titles
// locally. The torrent magnets are real direct download links (unlocked); the
// streaming mirrors are browser-interaction file hosts (locked, with a note) -
// the same split pahe uses for its shortener links.
//
// Note: post pages embed \r characters inside hrefs to foil naive scrapers -
// strip CRs before parsing.

import { fetchChain, titleMatches, normalizeTitle, decodeEntities } from "./base.mjs";

const DEFAULT_DOMAINS = ["www.5movierulz.watch"];

// Language category prefixes present in the homepage nav (each × years).
const LANG_PREFIXES = ["bollywood", "telugu", "tamil", "malayalam", "hollywood"];
// Extra categories useful for TV / year-less discovery.
const EXTRA_CATEGORIES = ["web-series", "telugu-featured", "tamil-featured", "bollywood-featured", "malayalam-featured", "hollywood-featured"];

// Streaming hosts movierulz mirrors point at. They need a real browser session
// (Cloudflare challenge, JS "Loading…" page, or a token chain that loops and
// errors for plain clients) so they are always reported locked.
const STREAM_HOSTS = new Set(["vcdnlare.com", "uperbox.cx", "easysyncr.me", "hglink.to", "minochinos.com", "filelions.to", "streamwish.com", "streamlare.com"]);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Extract the leading resolution from a quality label ("1080p" -> 1080,
// "2160p" -> 2160, "4K" -> 2160). Returns null when there is none.
function sourceResolution(quality) {
  const s = String(quality || "").toLowerCase();
  const m = s.match(/(\d{3,4})\s*p/);
  if (m) return parseInt(m[1], 10);
  if (/\b4k\b/.test(s)) return 2160;
  return null;
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

export function makeMovierulz({
  domains = DEFAULT_DOMAINS,
  name = "movierulz",
  label = "5MovieRulz (Indian - torrent + streaming links)",
  paceMs = 400,
  cacheTtlMs = 60 * 60 * 1000,
  maxPagesPerCategory = 2,
  maxRetries = 2,
} = {}) {
  const base = domains[0] ? `https://${domains[0]}` : null;
  const listingCache = new Map(); // category url -> { expiresAt, posts }

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
      await sleep(800 * (i + 1));
    }
    throw lastErr || new Error(`Failed after ${maxRetries} attempts`);
  }

  // Parse post links + titles out of a listing page. Post URLs match the
  // `<slug>-<numeric id>.html` pattern; nav/sidebar links don't. Some listings
  // (e.g. web-series) wrap the title in an image, so fall back to the anchor's
  // title= attribute when the anchor text is empty.
  function parsePosts(html) {
    const out = [];
    const seen = new Set();
    const clean = String(html).replace(/\r/g, "");
    for (const m of clean.matchAll(/<a([^>]*)href="([^"]+)"([^>]*)>([\s\S]*?)<\/a>/gi)) {
      const url = m[2];
      if (!/\/[a-z0-9-]+-\d+\.html$/i.test(url)) continue;
      let title = decodeEntities(m[4].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
      if (!title) {
        const attr = (m[1] + " " + m[3]).match(/title="([^"]+)"/i);
        if (attr) title = decodeEntities(attr[1]);
      }
      if (!title || seen.has(url)) continue;
      seen.add(url);
      out.push({ url: url.startsWith("http") ? url : `${base}${url}`, title });
    }
    return out;
  }

  // Fetch (and cache) one listing page, walking up to maxPagesPerCategory.
  async function fetchCategory(categoryUrl) {
    const hit = listingCache.get(categoryUrl);
    if (hit && hit.expiresAt > Date.now()) return hit.posts;
    const posts = [];
    for (let page = 1; page <= maxPagesPerCategory; page++) {
      const url = page === 1 ? categoryUrl : `${categoryUrl}?page=${page}`;
      let r;
      try {
        r = await fetchWithRetry(url);
      } catch {
        break;
      }
      const pagePosts = parsePosts(r.text);
      posts.push(...pagePosts);
      if (pagePosts.length < 10) break; // last page
      if (posts.length >= 60) break; // enough for matching
    }
    listingCache.set(categoryUrl, { expiresAt: Date.now() + cacheTtlMs, posts });
    return posts;
  }

  // Candidate categories in scan order (most-likely-first): the title's year's
  // language pages, then the neighbouring years (posts are filed by *posting*
  // year - a "(2025)" film can sit in the 2026 category). TV starts with the
  // web-series latest feed so recent shows resolve in one fetch.
  function categoriesFor({ year, type }) {
    const cats = [];
    if (type === "tv") cats.push(`${base}/category/web-series`);
    const years = year
      ? [String(year), String(year - 1), String(year + 1)]
      : [String(new Date().getFullYear())];
    for (const y of years) {
      for (const lang of LANG_PREFIXES) cats.push(`${base}/category/${lang}-movies-${y}`);
    }
    if (!year) {
      for (const c of EXTRA_CATEGORIES) cats.push(`${base}/category/${c}`);
    }
    return cats;
  }

  // Find posts matching the title across the candidate categories. Stops as
  // soon as a match lands - one post is enough for pickPost to work with, and
  // the miss path (full walk) is the slow-but-rare case.
  async function searchPosts(title, year, type) {
    if (!base) return { posts: [], base: null };
    const t = normalizeTitle(title);
    const found = [];
    for (const catUrl of categoriesFor({ year, type })) {
      let posts = [];
      try {
        posts = await fetchCategory(catUrl);
      } catch {
        continue;
      }
      for (const p of posts) {
        const nt = normalizeTitle(p.title);
        if (!nt.includes(t)) continue;
        if (year && !nt.includes(String(year))) continue;
        if (!found.some((f) => f.url === p.url)) found.push(p);
      }
      if (found.length) break; // first match is enough to fetch a post
    }
    return { posts: found, base };
  }

  // Pick the best matching post: exact normalized title, then title-with-year,
  // then the first title match. For TV prefer whole-season packs.
  function pickPost(posts, title, year, season) {
    const t = normalizeTitle(title);
    let pool = posts;
    if (year) {
      const withYear = posts.filter((p) => normalizeTitle(p.title).includes(String(year)));
      if (withYear.length) pool = withYear;
    }
    if (season) {
      const seasonMatch = pool.filter((p) => new RegExp(`season\\s*${season}(\\b|\\s|$)`, "i").test(p.title));
      if (seasonMatch.length) pool = seasonMatch;
      else {
        const complete = pool.filter((p) => /complete/i.test(p.title));
        if (complete.length) pool = complete;
      }
    }
    return (
      pool.find((p) => normalizeTitle(p.title) === t) ||
      pool.find((p) => normalizeTitle(p.title).includes(t)) ||
      pool[0]
    );
  }

  // The article body (main content only) with scripts/styles and CRs removed.
  function articleBody(html) {
    const clean = String(html).replace(/\r/g, "");
    const start = clean.indexOf("<article");
    const end = clean.indexOf("</article>", start);
    const body = (start === -1 ? clean : clean.slice(start, end > start ? end : start + 60000))
      .replace(/<script[\s\S]*?<\/script>/g, "")
      .replace(/<style[\s\S]*?<\/style>/g, "");
    return body;
  }

  // Extract sources from a post: torrent magnets (direct, unlocked) + the
  // streaming mirror cards (external file hosts, locked).
  function extractSources(body) {
    const sources = [];
    // Torrents: <a href="magnet:..."><span>🧲</span><span>GET THIS TORRENT</span><span>2.3 gb 1080p</span></a>
    for (const m of body.matchAll(/<a[^>]*href="(magnet:[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
      const inner = decodeEntities(m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
      const sizeQ = inner.match(/(\d+(?:\.\d+)?\s*(?:gb|mb|kb))\s+(\d{3,4}p)/i);
      const quality = sizeQ ? sizeQ[2].toLowerCase() : "";
      const size = sizeQ ? sizeQ[1].toLowerCase() : "";
      sources.push({
        provider: name,
        url: m[1],
        label: `Torrent · ${inner || "magnet"}`,
        quality,
        size,
        host: "Torrent",
        isEmbed: false,
        locked: false,
        note: "magnet link - open in a torrent client to download",
      });
    }
    // Streaming mirrors: <a href="https://host/..." class="stream-link-btn"><span>▶</span><span>Streamlare</span></a>
    for (const m of body.matchAll(/<a[^>]*href="(https?:\/\/[^"]+)"[^>]*class="[^"]*stream-link-btn[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)) {
      const inner = decodeEntities(m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
      const platform = inner.replace(/▶/g, "").trim() || "Stream";
      sources.push({
        provider: name,
        url: m[1],
        label: `Stream · ${platform}`,
        quality: "",
        size: "",
        host: platform,
        isEmbed: true,
        locked: true,
        note: "external file-host link (Streamlare/Uperbox/EasySyncr/Streamwish/Filelions): the real file URL only resolves when this host is opened in a browser",
      });
    }
    return sources;
  }

  async function scrapeMovie({ title, year, minQuality }) {
    if (!base) return { provider: name, error: "no domains configured", sources: [] };
    const { posts, base: activeBase } = await searchPosts(title, year, "movie");
    if (!posts.length) return { provider: name, error: `No post found for "${title}" on this server`, sources: [] };
    const post = pickPost(posts, title, year, null);
    await paced();
    const { status, text } = await fetchWithRetry(post.url);
    if (status !== 200) return { provider: name, error: `Post returned HTTP ${status}`, sources: [] };
    const sources = filterMinQuality(extractSources(articleBody(text)), minQuality);
    if (!sources.length) return { provider: name, post: post.url, error: "No download links found on post", sources: [] };
    return { provider: name, post: post.url, sources };
  }

  // TV: movierulz posts whole-season packs (e.g. "The Legend of Karna Season 1
  // (2026) HDRip [Telugu]") with torrent + streaming links for the pack, not
  // per-episode pages. Match the show (preferring the requested season) and
  // return the pack's links.
  async function scrapeEpisode({ title, year, season, episode, minQuality }) {
    if (!base) return { provider: name, error: "no domains configured", sources: [] };
    const { posts, base: activeBase } = await searchPosts(title, year, "tv");
    if (!posts.length) return { provider: name, error: `No post found for "${title}" on this server`, sources: [] };
    const post = pickPost(posts, title, year, season);
    await paced();
    const { status, text } = await fetchWithRetry(post.url);
    if (status !== 200) return { provider: name, error: `Post returned HTTP ${status}`, sources: [] };
    const sources = filterMinQuality(extractSources(articleBody(text)), minQuality);
    if (!sources.length) return { provider: name, post: post.url, error: "No download links found on post", sources: [] };
    for (const s of sources) {
      s.note = `whole-season pack (S${season ?? "?"}) - ${s.note}`;
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

export const movierulz = makeMovierulz();
export default movierulz;
