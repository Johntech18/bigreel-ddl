// scrapers/a111477.mjs - scraper for the static file indexer at a.111477.xyz.
//
// The site is a plain "Index of /" file listing - no search API, no JS app:
//   /movies/        -> "Name (Year)/" directories (large page, ~10 MB)
//   /tvs/           -> "Show Name/" or "Show Name (Year)/" directories
//   <movie dir>/    -> file rows: "Name.1080p...mkv ⬇️ 4.7 GB" with a direct href
//   <show dir>/     -> "Season N/" directories -> episode files
//                    "Show - S01E01 - Ep Title [WEBRip-1080p]...mkv ⬇️ 3.4 GB"
//
// Listing pages are open HTML (no Cloudflare challenge), but the *file* links
// are Cloudflare-gated for bots (403 with cf-ray; browser TLS + cookies both
// fail). We index everything and probe one file per scrape to decide whether
// links should be flagged locked (they still work in a real browser, and with
// FLARESOLVERR_URL set the site could be fully unlocked like filesdl).

import { fetchChain, extractLinks, titleMatches, normalizeTitle, searchQuery, absolute } from "./base.mjs";

const DEFAULT_DOMAINS = ["a.111477.xyz"];

export function makeA111477({
  domains = DEFAULT_DOMAINS,
  name = "a111477",
  label = "A.111477 Indexer",
  cacheTtlMs = 60 * 60 * 1000,
  paceMs = 350,
  maxRetries = 3,
} = {}) {
  const base = domains[0] ? `https://${domains[0]}` : null;
  const listingCache = new Map(); // category -> { expiresAt, rows }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function paced() {
    if (paceMs) await sleep(paceMs);
  }

  // The site 429s bursts (pages are ~10 MB), so pace every request and back
  // off on 429.
  async function fetchWithRetry(url) {
    let lastErr;
    for (let i = 0; i < maxRetries; i++) {
      await paced();
      try {
        const r = await fetchChain(url);
        if (r.status === 429) {
          lastErr = new Error(`Rate limited (429) after attempt ${i + 1}`);
          await sleep(1500 * (i + 1));
          continue;
        }
        return r;
      } catch (e) {
        lastErr = e;
        await sleep(1000 * (i + 1));
      }
    }
    throw lastErr || new Error(`Failed after ${maxRetries} attempts`);
  }

  // Parse an index page into rows: { name, href, size }.
  function parseRows(html) {
    const rows = [];
    const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    for (const m of html.matchAll(trRe)) {
      const tr = m[1];
      const a = tr.match(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
      if (!a) continue;
      const name = a[2].replace(/<[^>]+>/g, "").replace(/&#128203;|⬇️/g, "").trim();
      if (!name || name === "../") continue;
      // size lives in <td class="size" data-sort="...">4.7 GB</td>
      const sizeCell = tr.match(/class="size"[^>]*>([^<]*)/);
      const size = sizeCell ? sizeCell[1].replace(/&#128203;|⬇️/g, "").trim() : "";
      rows.push({
        name,
        href: absolute(base, a[1]),
        size: size === "-" ? "" : size,
        isDir: name.endsWith("/") || /\/$/.test(a[1]),
      });
    }
    return rows;
  }

  // Fetch (and cache) a category listing.
  async function fetchListing(category) {
    const hit = listingCache.get(category);
    if (hit && hit.expiresAt > Date.now()) return hit.rows;
    const url = `${base}/${category}/`;
    const { status, text } = await fetchWithRetry(url);
    if (status !== 200) throw new Error(`Listing ${category} returned HTTP ${status}`);
    const rows = parseRows(text);
    listingCache.set(category, { expiresAt: Date.now() + cacheTtlMs, rows });
    return rows;
  }

  // Find a directory row matching title (and optionally year).
  function findDir(rows, title, year) {
    const t = normalizeTitle(title);
    const matches = rows.filter((r) => r.isDir && titleMatches(title, r.name, ""));
    if (!matches.length) return null;
    if (year) {
      const withYear = matches.find((r) => r.name.includes(`(${year})`));
      if (withYear) return withYear;
    }
    // prefer exact normalized name over substring matches
    const exact = matches.find((r) => normalizeTitle(r.name) === t) || matches.find((r) => normalizeTitle(r.name).includes(t));
    return exact || matches[0];
  }

  async function searchPosts(title, year, type) {
    if (!base) return { posts: [], base };
    const category = type === "tv" ? "tvs" : "movies";
    const rows = await fetchListing(category);
    const dir = findDir(rows, title, year);
    if (!dir) return { posts: [], base };
    return { posts: [{ url: dir.href, title: dir.name.replace(/\/$/, "") }], base };
  }

  // Probe a file link to see if it's currently Cloudflare-gated. One probe per
  // scrape (the whole site shares the same protection config).
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

  // Turn file rows into source objects (quality label + size from the name).
  function toSources(rows, probe) {
    const sources = [];
    for (const r of rows) {
      if (r.isDir) continue;
      if (!/\.(mkv|mp4|m4v|webm|avi|ts|mov)(\?|#|$)/i.test(r.href)) continue;
      sources.push({
        provider: name,
        url: r.href,
        label: r.name,
        quality: r.name,
        size: r.size,
        isEmbed: false,
        locked: probe?.locked || false,
        note: probe?.note || null,
      });
    }
    return sources;
  }

  async function scrapeMovie({ title, year }) {
    const { posts, base: activeBase } = await searchPosts(title, year, "movie");
    if (!posts.length) return { provider: name, error: `No post found for \"${title}\" on this indexer`, sources: [] };
    const { status, text } = await fetchWithRetry(posts[0].url);
    if (status !== 200) return { provider: name, error: `Directory returned HTTP ${status}`, sources: [] };
    const rows = parseRows(text);
    const files = rows.filter((r) => !r.isDir);
    if (!files.length) return { provider: name, post: posts[0].url, error: "No media files in directory", sources: [] };
    const probe = await probeFile(files[0].href);
    return { provider: name, post: posts[0].url, sources: toSources(files, probe) };
  }

  async function scrapeEpisode({ title, season, episode }) {
    const { posts, base: activeBase } = await searchPosts(title, null, "tv");
    if (!posts.length) return { provider: name, error: `No post found for \"${title}\" on this indexer`, sources: [] };

    const seasonStr = String(season).padStart(2, "0");
    const episodeStr = String(episode).padStart(2, "0");
    const want = new RegExp(`s?${seasonStr}\\s*e?${episodeStr}`, "i");

    // find the "Season N/" dir
    const { status, text } = await fetchWithRetry(posts[0].url);
    if (status !== 200) return { provider: name, error: `Show directory returned HTTP ${status}`, sources: [] };
    const showRows = parseRows(text);
    const seasonRow = showRows.find((r) => r.isDir && new RegExp(`season\\s*${season}`, "i").test(r.name));
    if (!seasonRow) return { provider: name, post: posts[0].url, error: `Season ${season} not found`, sources: [] };

    const sRes = await fetchWithRetry(seasonRow.href);
    if (sRes.status !== 200) return { provider: name, error: `Season dir returned HTTP ${sRes.status}`, sources: [] };
    const epRows = parseRows(sRes.text).filter((r) => !r.isDir);
    const matched = epRows.filter((r) => want.test(r.name) && /\.(mkv|mp4|m4v|webm|avi|ts|mov)(\?|#|$)/i.test(r.href));
    if (!matched.length) return { provider: name, post: posts[0].url, error: `Episode S${seasonStr}E${episodeStr} not found`, sources: [] };

    const probe = await probeFile(matched[0].href);
    return { provider: name, post: posts[0].url, sources: toSources(matched, probe) };
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

export const a111477 = makeA111477();
export default a111477;
