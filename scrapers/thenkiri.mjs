// scrapers/thenkiri.mjs - scraper for thenkiri.com (WordPress, Elementor posts)
// whose files are hosted on downloadwella.com (XFileSharing/Sibsoft server).
//
// Resolution chain:
//   1. Search:  GET /wp-json/wp/v2/posts?search=<title>  (WP REST API, open)
//   2. Post:    GET /wp-json/wp/v2/posts/<id>?_fields=content
//               -> content has one <a href="https://downloadwella.com/<id>/<file>.html">
//                  per quality/episode (Elementor button widgets)
//   3. File:    GET the downloadwella .html page -> hidden form (op=download2, id=…)
//   4. Direct:  POST the form back -> page contains a signed direct URL
//               (https://dwXX.downloadwella.com/d/<token>/<filename>) - no captcha,
//               no countdown, but the signed URL expires, so it's resolved on demand.
//
// Post categories: 14 = International (movies), 4 = TV Series, 83 = Bollywood,
// 97/98 = Asian/Korean Movies, 108 = K-Drama.

import { UA, REQUEST_TIMEOUT_MS, normalizeTitle, searchQuery } from "./base.mjs";

const DEFAULT_DOMAIN = "thenkiri.com";
const FILE_HOST = "downloadwella.com";

// Cache of resolved direct links - the signed URLs expire, so keep the TTL short.
const RESOLVE_TTL_MS = Number(process.env.THENKIRI_RESOLVE_TTL_MS || 30 * 60 * 1000);
const _resolveCache = new Map(); // pageUrl -> { at, url }

// Signed direct link: https://<node>.downloadwella.com/d/<token>/<filename> -
// node subdomains rotate unpredictably (dwbe01, fsmc02, …), so match any
// downloadwella.com host with a /d/ path.
const DIRECT_RE = /(https?:\/\/[a-z0-9-]+\.downloadwella\.com\/d\/[^"'\s<]+)/i;

// downloadwella (XFileSharing) throttles bursts of link generations per IP, so
// pace the resolve requests.
const RESOLVE_PACING_MS = Number(process.env.THENKIRI_PACING_MS || 2500);
let _lastResolveAt = 0;
async function paceResolve() {
  const wait = _lastResolveAt + RESOLVE_PACING_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  _lastResolveAt = Date.now();
}

export function makeThenkiri({
  domain = DEFAULT_DOMAIN,
  name = "thenkiri",
  label = "TheNkiri",
} = {}) {
  const API_BASE = `https://${domain}`;
  const HEADERS = { "User-Agent": UA, Accept: "application/json" };

  async function apiGet(path) {
    const url = `${API_BASE}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: HEADERS, cache: "no-store", signal: controller.signal });
      if (!res.ok) throw new Error(`WP REST API returned HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchHtml(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "text/html" },
        redirect: "follow",
        cache: "no-store",
        signal: controller.signal,
      });
      return { status: res.status, text: await res.text(), url: res.url || url };
    } finally {
      clearTimeout(timer);
    }
  }

  // Search WP REST API and score the posts against the query (same scheme the
  // other WP-based scrapers use). Note: passing `categories` to WP search makes
  // this site return unrelated recent posts, so we search unfiltered and rely
  // on scoring (the post title/slug carries "S04 | TV Series" etc.).
  async function searchPosts(title, year) {
    const q = searchQuery(title);
    if (!q) return [];
    const results = await apiGet(
      // per_page=20: WP's relevance order is loose (posts matching only one
      // query word can outrank the exact-title post), so cast a wider net and
      // let the scoring below pick the winner.
      `/wp-json/wp/v2/posts?search=${encodeURIComponent(q)}&per_page=20&_fields=id,title,link,categories`
    );
    if (!Array.isArray(results)) return [];

    const scored = results.map((post) => {
      const postTitle = decodeHtmlEntities(post.title?.rendered || "");
      const nPost = normalizeTitle(postTitle);
      const nQuery = normalizeTitle(title);
      let score = 0;

      if (nPost === nQuery) score += 100;
      else if (nPost.includes(nQuery) || nQuery.includes(nPost)) score += 50;
      else {
        const postWords = nPost.split(/\s+/);
        const queryWords = nQuery.split(/\s+/);
        const matching = queryWords.filter((w) => postWords.includes(w));
        score += (matching.length / Math.max(queryWords.length, 1)) * 40;
      }
      if (year && nPost.includes(String(year))) score += 20;

      return { post, postTitle, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored
      .filter((s) => s.score > 10)
      .map((s) => ({ url: s.post.link, title: s.postTitle, id: s.post.id, score: s.score }));
  }

  // Pull every downloadwella link out of a post's rendered content. The WP REST
  // response JSON-escapes the HTML (href=\"…\"), so match both forms.
  function extractFileLinks(content) {
    const urls = new Set();
    const patterns = [
      /href=\\"(https?:\\\/\\\/[^"\\]*downloadwella[^"\\]*)\\"/gi, // JSON-escaped
      /href="(https?:\/\/[^"]*downloadwella[^"]*)"/gi, // plain HTML
    ];
    for (const re of patterns) {
      for (const m of content.matchAll(re)) {
        const url = m[1].replace(/\\\//g, "/");
        if (/\.html?$/i.test(url)) urls.add(url);
      }
    }
    return [...urls];
  }

  // Extract quality / episode tags from the link's file name.
  function fileMeta(filePageUrl, postTitle) {
    let fname = "";
    try {
      fname = decodeURIComponent(new URL(filePageUrl).pathname.split("/")[2] || "");
    } catch { /* ignore */ }
    const hay = `${fname} ${postTitle}`;
    let quality = "HD";
    if (/2160p|4k|uhd/i.test(hay)) quality = "2160p";
    else if (/1080p|fullhd/i.test(hay)) quality = "1080p";
    else if (/720p|hq\b/i.test(hay)) quality = "720p";
    else if (/480p/i.test(hay)) quality = "480p";
    const episodeMatch = fname.match(/\bS\d{1,2}E\d{1,2}\b/i);
    return { fname, quality, episode: episodeMatch ? episodeMatch[0].toUpperCase() : null };
  }

  // Resolve one downloadwella .html page to a signed direct URL (XFileSharing
  // op=download2 POST). No captcha and no countdown on this host (verified).
  // `pageHtml` (already fetched for the size) is reused for the form fields.
  async function resolveDirect(pageUrl, pageHtml = null) {
    const cached = _resolveCache.get(pageUrl);
    if (cached && Date.now() - cached.at < RESOLVE_TTL_MS) return cached.url;

    const html = pageHtml ?? (await fetchHtml(pageUrl)).text;
    if (!html) throw new Error(`downloadwella page empty for ${pageUrl}`);

    const fields = {};
    for (const m of html.matchAll(/<input[^>]*type="hidden"[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g)) {
      fields[m[1]] = m[2];
    }
    if (fields.op !== "download2" || !fields.id) {
      // Some pages expose the direct link without a form step
      const direct = html.match(DIRECT_RE);
      if (direct) {
        _resolveCache.set(pageUrl, { at: Date.now(), url: direct[1] });
        return direct[1];
      }
      throw new Error("downloadwella form not found (page layout changed or file removed)");
    }

    await paceResolve();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(pageUrl, {
        method: "POST",
        headers: {
          "User-Agent": UA,
          "Content-Type": "application/x-www-form-urlencoded",
          Referer: pageUrl,
        },
        body: new URLSearchParams({
          op: fields.op,
          id: fields.id,
          rand: fields.rand || "",
          referer: fields.referer || "",
          method_free: fields.method_free || "",
          method_premium: fields.method_premium || "",
        }),
        redirect: "manual",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const body = await res.text();
    // Node subdomains rotate (dwbe01…dwbeNN, dwXX, …) - match any hostname
    // that starts with "dw" under downloadwella.com.
    const direct =
      body.match(DIRECT_RE)?.[1] ||
      res.headers.get("location");
    if (!direct) {
      // XFileSharing serves its home page (or a countdown page) when the
      // per-IP free-link quota is exhausted or a wait timer is active.
      const wait = body.match(/countdown_str[^"]*"|Wait \d+ seconds|please wait[^<]*/i);
      const note = wait ? "wait timer active" : "per-IP link quota exhausted (try again later)";
      throw new Error(`downloadwella did not return a direct link - ${note}`);
    }

    _resolveCache.set(pageUrl, { at: Date.now(), url: direct });
    return direct;
  }

  // File size from the downloadwella page (statd row) or the forum-code textarea.
  function extractSize(html) {
    const sizeRow = html.match(/class="statd">size<\/span>\s*<span>([^<]+)<\/span>/i);
    if (sizeRow) return sizeRow[1].trim();
    const code = html.match(/\[URL=[^\]]+\]([^[]+)\[\/URL\]/i);
    if (code) {
      const m = code[1].match(/(\d+)\s*$/); // bytes in the forum code
      if (m) {
        const bytes = Number(m[1]);
        if (bytes > 1073741824) return `${(bytes / 1073741824).toFixed(2)} GB`;
        if (bytes > 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
      }
    }
    return null;
  }

  async function scrapePost(post, { season, episode } = {}) {
    const sources = [];
    const errors = [];
    let content = "";
    try {
      const postData = await apiGet(`/wp-json/wp/v2/posts/${post.id}?_fields=content`);
      content = postData?.content?.rendered || "";
    } catch (e) {
      errors.push(`API content fetch: ${e.message}`);
      return { sources, errors };
    }

    let links = extractFileLinks(content);
    if (season && episode && links.length > 1) {
      const se = new RegExp(`S0*${season}E0*${episode}`, "i");
      const matched = links.filter((u) => se.test(u));
      if (matched.length) links = matched;
    }

    for (const pageUrl of links) {
      const { fname, quality, episode: epTag } = fileMeta(pageUrl, post.title);
      // Fetch the file page once: it carries the size AND the download2 form.
      let pageHtml = null;
      try {
        pageHtml = (await fetchHtml(pageUrl)).text;
      } catch { /* size/form are fetched again by resolveDirect if null */ }
      const size = pageHtml ? extractSize(pageHtml) : null;

      try {
        const direct = await resolveDirect(pageUrl, pageHtml);
        sources.push({
          provider: name,
          url: direct,
          label: `${post.title}${epTag ? ` · ${epTag}` : ""}`,
          quality,
          size,
          isEmbed: false,
          locked: false,
          note: "Direct link resolved from downloadwella (signed URL, may expire)",
        });
      } catch (e) {
        errors.push(`${fname || pageUrl}: ${e.message}`);
        sources.push({
          provider: name,
          url: pageUrl,
          label: `${post.title}${epTag ? ` · ${epTag}` : ""}`,
          quality,
          size,
          isEmbed: false,
          locked: true,
          note: "Could not resolve server-side - opens the downloadwella file page",
        });
      }
    }

    return { sources, errors };
  }

  async function scrapeMovie({ title, year }) {
    const posts = await searchPosts(title, year);
    if (!posts.length) {
      return { provider: name, error: `No posts found for "${title}"`, sources: [] };
    }
    const post = posts[0];
    const { sources, errors } = await scrapePost(post);
    if (!sources.length) {
      return { provider: name, error: `No download links on "${post.title}"`, sources: [], errors };
    }
    return { provider: name, post: post.url, sources, errors };
  }

  async function scrapeEpisode({ title, season, episode }) {
    // Search unfiltered (WP's `categories` param breaks this site's search) and
    // lean on scoring: series posts carry "Sxx" and "TV Series" in the title.
    let posts = [];
    try {
      posts = await searchPosts(title, null);
    } catch (e) {
      return { provider: name, error: e.message, sources: [] };
    }
    if (!posts.length) {
      return { provider: name, error: `No posts found for "${title}"`, sources: [] };
    }

    // Prefer a post whose title/slug mentions the season ("S04", "season-4")
    // when several posts match the show.
    const seTag = `s${String(Number(season) || 0).padStart(2, "0")}`;
    const preferred = posts.find((p) => {
      const hay = normalizeTitle(p.title + " " + p.url);
      return hay.includes(seTag) || hay.includes(`season ${Number(season)}`);
    }) || posts[0];

    const { sources, errors } = await scrapePost(preferred, { season, episode });
    if (!sources.length) {
      return {
        provider: name,
        error: `No download links on "${preferred.title}"`,
        sources: [],
        errors,
      };
    }
    return { provider: name, post: preferred.url, sources, errors };
  }

  return { name, label, domain, searchPosts, scrapeMovie, scrapeEpisode };
}

function decodeHtmlEntities(str) {
  return String(str)
    .replace(/&#8211;/g, "–").replace(/&#8212;/g, "—")
    .replace(/&#8216;/g, "'").replace(/&#8217;/g, "'")
    .replace(/&#8220;/g, '"').replace(/&#8221;/g, '"')
    .replace(/&#038;/g, "&").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'")
    .replace(/&#8230;/g, "...")
    .replace(/&#(\d+);/g, (m) => String.fromCodePoint(parseInt(m.slice(2, -1), 10)));
}

export const thenkiri = makeThenkiri();
export default thenkiri;
