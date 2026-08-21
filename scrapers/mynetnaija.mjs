// scrapers/mynetnaija.mjs - scraper for mynetnaija.ng (WordPress movie download site).
//
// Resolution chain:
//   1. Search:   GET /wp-json/wp/v2/posts?search=<title>  (WP REST API, bypasses Cloudflare)
//   2. Post:     https://mynetnaija.ng/<slug>/  (has download button linking to /episode-download/)
//   3. Download: /episode-download/download-movie-{id}/  (may link to meetdownload.com)
//   4. meetdownload.com: has7up.kissorgrab.com URL in JS onclick (needs browser)
//
// The WP REST API works with a normal User-Agent header, bypassing Cloudflare bot verification.
// The /episode-download/ pages and meetdownload.com are behind Cloudflare and need a browser.

import { UA, REQUEST_TIMEOUT_MS, normalizeTitle, searchQuery } from "./base.mjs";

const DEFAULT_DOMAIN = "mynetnaija.ng";

export function makeMynetnaija({
  domain = DEFAULT_DOMAIN,
  name = "mynetnaija",
  label = "NetNaija",
} = {}) {
  const API_BASE = `https://${domain}`;
  const HEADERS = {
    "User-Agent": UA,
    Accept: "application/json",
  };

  async function apiGet(path) {
    const url = `${API_BASE}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: HEADERS,
        cache: "no-store",
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`WP REST API returned HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchHtml(path) {
    const url = path.startsWith("http") ? path : `${API_BASE}${path}`;
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

  // Search WP REST API for a title and return matching posts
  async function searchPosts(title, year) {
    const q = searchQuery(title);
    if (!q) return [];

    const results = await apiGet(
      `/wp-json/wp/v2/posts?search=${encodeURIComponent(q)}&per_page=10&_fields=id,title,link,categories`
    );

    if (!Array.isArray(results)) return [];

    // Filter to movies (category 16 = "Movies")
    const moviePosts = results.filter((p) => p.categories?.includes(16));

    const scored = moviePosts.map((post) => {
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
        score += (matching.length / queryWords.length) * 40;
      }

      if (year && nPost.includes(String(year))) score += 20;

      return { post, postTitle, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored
      .filter((s) => s.score > 10)
      .map((s) => ({ url: s.post.link, title: s.postTitle, id: s.post.id }));
  }

  function extractMeetdownloadUrl(html) {
    const match = html.match(/href="([^"]*meetdownload\.com[^"]*)"/i);
    if (match) return decodeHtmlEntities(match[1]);
    return null;
  }

  function extractDirectDownloadUrl(html) {
    const match = html.match(
      /location\.href\s*=\s*['"]+(https?:\/\/7up\.kissorgrab\.com\/dl\/[^'"]+)/i
    );
    if (match) return match[1];

    const altMatch = html.match(
      /href=['"]+(https?:\/\/films\.waploaded\.com\/[^'"]+)/i
    );
    if (altMatch) return decodeHtmlEntities(altMatch[1]);

    return null;
  }

  function extractFileSize(html) {
    const match = html.match(/Download Video\s*\(([^)]+)\)/i);
    return match ? match[1] : null;
  }

  function extractQuality(text, url) {
    const combined = `${text} ${url || ""}`.toLowerCase();
    if (/2160p|4k|uhd/i.test(combined)) return "2160p";
    if (/1080p|fullhd/i.test(combined)) return "1080p";
    if (/720p|hd/i.test(combined)) return "720p";
    if (/480p/i.test(combined)) return "480p";
    return "HD";
  }

  async function scrapeMovie({ title, year }) {
    const posts = await searchPosts(title, year);
    if (!posts.length) {
      return { provider: name, error: `No posts found for "${title}"`, sources: [] };
    }

    const post = posts[0];
    const sources = [];
    const errors = [];

    // Fetch post content via WP REST API to get the download page URL
    let downloadPageUrl = null;
    try {
      const postData = await apiGet(
        `/wp-json/wp/v2/posts/${post.id}?_fields=content`
      );
      const postContent = postData?.content?.rendered || "";
      const match = postContent.match(
        /href="([^"]*\/episode-download\/download-movie-\d+[^"]*)"/i
      );
      if (match) {
        downloadPageUrl = decodeHtmlEntities(match[1]);
        if (!downloadPageUrl.startsWith("http")) downloadPageUrl = `${API_BASE}${downloadPageUrl}`;
      }
    } catch (e) {
      errors.push(`API content fetch: ${e.message}`);
    }

    // Try to fetch the download page for meetdownload.com link
    // Note: this page returns HTTP 404 but still serves valid content
    if (downloadPageUrl) {
      try {
        const { text: dlHtml } = await fetchHtml(downloadPageUrl);
        if (dlHtml) {
          const meetdownloadUrl = extractMeetdownloadUrl(dlHtml);
          if (meetdownloadUrl) {
            // Always add meetdownload link — it's valuable even without fetching it
            let fileSize = extractFileSize(dlHtml);
            sources.push({
              provider: name, url: meetdownloadUrl,
              label: `${post.title} · meetdownload`,
              quality: extractQuality(dlHtml, meetdownloadUrl),
              size: fileSize, isEmbed: false, locked: true,
              note: "External link (not a direct link and there's no ads)",
            });
            // Try to fetch meetdownload page for direct link + exact size
            try {
              const { text: mdHtml } = await fetchHtml(meetdownloadUrl);
              const mdSize = extractFileSize(mdHtml) || fileSize;
              const directUrl = extractDirectDownloadUrl(mdHtml);
              if (directUrl) {
                sources.push({
                  provider: name, url: directUrl,
                  label: `${post.title} · direct`,
                  quality: extractQuality(directUrl, mdHtml),
                  size: mdSize, isEmbed: false, locked: false,
                  note: "Direct Link resolved and found - file hosted on " + new URL(directUrl).hostname,
                });
              }
              // Update size if we got a better one from meetdownload
              if (mdSize && sources[0]) sources[0].size = mdSize;
            } catch { /* meetdownload blocked */ }
          }
        }
      } catch { /* download page blocked */ }
    }

    // Fallback: return the post page as a locked source
    if (!sources.length) {
      sources.push({
        provider: name, url: post.url,
        label: `${post.title}`, quality: "HD", size: null,
        isEmbed: false, locked: true,
        note: "External Link (You will be taken to an external site to download)",
      });
    }

    return { provider: name, post: post.url, sources, errors };
  }

  // TV: mynetnaija primarily hosts movies
  async function scrapeEpisode({ title, season, episode }) {
    const posts = await searchPosts(title);
    if (!posts.length) {
      return { provider: name, error: `No posts found for "${title}"`, sources: [] };
    }
    return scrapeMovie({ title: posts[0].title });
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
    .replace(/&#\d+;/g, (m) => String.fromCodePoint(parseInt(m.slice(2, -1), 10)));
}

export const mynetnaija = makeMynetnaija();
export default mynetnaija;
