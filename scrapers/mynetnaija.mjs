// scrapers/mynetnaija.mjs - scraper for mynetnaija.ng (WordPress movie download site).
//
// Resolution chain:
//   1. Search:   GET /wp-json/wp/v2/posts?search=<title>  (WP REST API, bypasses Cloudflare)
//   2. Post:     https://mynetnaija.ng/<slug>/  (contains download button linking to /episode-download/)
//   3. Download: https://mynetnaija.ng/episode-download/download-movie-{id}/  (has meetdownload.com link)
//   4. meetdownload.com: has7up.kissorgrab.com URL in JS onclick (needs browser)
//
// The WP REST API works with a normal User-Agent header, bypassing Cloudflare bot verification.
// Search results may not be exact, so we normalize and match titles ourselves.
// TV episode support is limited - the site primarily hosts movies.

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

  // Fetch JSON from WP REST API
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

  // Fetch HTML page with redirect following
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

    // Search with the full query first
    const results = await apiGet(
      `/wp-json/wp/v2/posts?search=${encodeURIComponent(q)}&per_page=10&_fields=id,title,link,categories`
    );

    if (!Array.isArray(results)) return [];

    // Filter to movies (category 16 = "Movies")
    const moviePosts = results.filter((p) => p.categories?.includes(16));

    // Score and sort by title match quality
    const scored = moviePosts.map((post) => {
      const postTitle = decodeHtmlEntities(post.title?.rendered || "");
      const nPost = normalizeTitle(postTitle);
      const nQuery = normalizeTitle(title);
      let score = 0;

      // Exact match
      if (nPost === nQuery) score += 100;
      // Title contains query or vice versa
      else if (nPost.includes(nQuery) || nQuery.includes(nPost)) score += 50;
      // Partial word match
      else {
        const postWords = nPost.split(/\s+/);
        const queryWords = nQuery.split(/\s+/);
        const matching = queryWords.filter((w) => postWords.includes(w));
        score += (matching.length / queryWords.length) * 40;
      }

      // Year match
      if (year && nPost.includes(String(year))) score += 20;

      return { post, postTitle, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored
      .filter((s) => s.score > 10)
      .map((s) => ({ url: s.post.link, title: s.postTitle, id: s.post.id }));
  }

  // Extract download page URL from post content HTML
  function extractDownloadPageUrl(html) {
    // Look for /episode-download/download-movie-{id}/ pattern
    const match = html.match(/href="([^"]*\/episode-download\/download-movie-\d+[^"]*)"/i);
    if (match) {
      let url = decodeHtmlEntities(match[1]);
      if (!url.startsWith("http")) url = `${API_BASE}${url}`;
      return url;
    }
    return null;
  }

  // Extract meetdownload.com URL from download page HTML
  function extractMeetdownloadUrl(html) {
    const match = html.match(/href="([^"]*meetdownload\.com[^"]*)"/i);
    if (match) return decodeHtmlEntities(match[1]);
    return null;
  }

  // Extract 7up.kissorgrab.com URL from meetdownload page JS onclick handler
  function extractDirectDownloadUrl(html) {
    // Pattern: location.href = 'https://7up.kissorgrab.com/dl/...';
    const match = html.match(
      /location\.href\s*=\s*['"]+(https?:\/\/7up\.kissorgrab\.com\/dl\/[^'"]+)/i
    );
    if (match) return match[1];

    // Also check for waploaded.com alternative
    const altMatch = html.match(
      /href=['"]+(https?:\/\/films\.waploaded\.com\/[^'"]+)/i
    );
    if (altMatch) return decodeHtmlEntities(altMatch[1]);

    return null;
  }

  // Extract file size info from meetdownload page
  function extractFileSize(html) {
    const match = html.match(/Download Video\s*\(([^)]+)\)/i);
    return match ? match[1] : null;
  }

  // Extract quality info from download URL or page text
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

    try {
      // Step 1: Fetch the post content via WP REST API to find the download page URL
      const postData = await apiGet(
        `/wp-json/wp/v2/posts/${post.id}?_fields=content`
      );
      const postContent = postData?.content?.rendered || "";

      const downloadPageUrl = extractDownloadPageUrl(postContent);
      if (!downloadPageUrl) {
        return { provider: name, post: post.url, error: "No download page link found in post", sources: [] };
      }

      // Step 2: Try to fetch the download page to find meetdownload.com link
      // The /episode-download/ pages are often Cloudflare-protected (404 for bots)
      let meetdownloadUrl = null;
      let dlHtml = "";
      try {
        const { status: dlStatus, text } = await fetchHtml(downloadPageUrl);
        if (dlStatus === 200) {
          dlHtml = text;
          meetdownloadUrl = extractMeetdownloadUrl(dlHtml);
        }
      } catch {
        // Download page may be blocked; continue with constructed URL
      }

      // Step 3: If we got a meetdownload URL, try to resolve further
      if (meetdownloadUrl) {
        try {
          const { status: mdStatus, text: mdHtml } = await fetchHtml(meetdownloadUrl);
          if (mdStatus === 200) {
            const fileSize = extractFileSize(mdHtml);

            // Extract the direct 7up link from meetdownload page
            const directUrl = extractDirectDownloadUrl(mdHtml);
            if (directUrl) {
              sources.push({
                provider: name,
                url: directUrl,
                label: `${post.title} · 7up direct`,
                quality: extractQuality(directUrl, mdHtml),
                size: fileSize,
                isEmbed: false,
                locked: true,
                note: "7up.kissorgrab.com (needs browser)",
              });
            }

            // Add meetdownload link
            sources.push({
              provider: name,
              url: meetdownloadUrl,
              label: `${post.title} · meetdownload`,
              quality: extractQuality(mdHtml, meetdownloadUrl),
              size: fileSize,
              isEmbed: false,
              locked: true,
              note: "meetdownload.com (needs browser)",
            });

            // Check for waploaded.com alternative
            const waploadedMatch = mdHtml.match(
              /href=['"]+(https?:\/\/films\.waploaded\.com\/[^'"]+)/i
            );
            if (waploadedMatch) {
              sources.push({
                provider: name,
                url: decodeHtmlEntities(waploadedMatch[1]),
                label: `${post.title} · waploaded`,
                quality: "HD",
                size: fileSize,
                isEmbed: false,
                locked: true,
                note: "waploaded.com (needs browser)",
              });
            }
          }
        } catch {
          // meetdownload fetch failed; still return the URL as locked
        }
      }

      // Always include the download page URL as a locked fallback
      if (!sources.length) {
        sources.push({
          provider: name,
          url: downloadPageUrl,
          label: `${post.title} · download page`,
          quality: "HD",
          size: null,
          isEmbed: false,
          locked: true,
          note: "mynetnaija.ng download page (needs browser)",
        });
      }
    } catch (e) {
      errors.push(e.message);
    }

    return { provider: name, post: post.url, sources, errors };
  }

  // TV episode scraping - mynetnaija primarily hosts movies, but we try anyway
  async function scrapeEpisode({ title, season, episode }) {
    const posts = await searchPosts(title);
    if (!posts.length) {
      return { provider: name, error: `No posts found for "${title}"`, sources: [] };
    }

    // Try to find a post matching the specific episode
    const seasonStr = String(season).padStart(2, "0");
    const episodeStr = String(episode).padStart(2, "0");
    const epPattern = new RegExp(`s?${seasonStr}\\s*e?${episodeStr}`, "i");

    let matchedPost = posts.find((p) => epPattern.test(p.title));
    if (!matchedPost) {
      // Fall back to first post if no episode-specific match
      matchedPost = posts[0];
    }

    // Reuse movie scraping logic since the download flow is the same
    return scrapeMovie({ title: matchedPost.title });
  }

  return {
    name,
    label,
    domain,
    searchPosts,
    scrapeMovie,
    scrapeEpisode,
  };
}

// Decode common HTML entities
function decodeHtmlEntities(str) {
  return String(str)
    .replace(/&#8211;/g, "–")
    .replace(/&#8212;/g, "—")
    .replace(/&#8216;/g, "'")
    .replace(/&#8217;/g, "'")
    .replace(/&#8220;/g, '"')
    .replace(/&#8221;/g, '"')
    .replace(/&#038;/g, "&")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#8230;/g, "...")
    .replace(/&#\d+;/g, (m) => String.fromCodePoint(parseInt(m.slice(2, -1), 10)));
}

export const mynetnaija = makeMynetnaija();
export default mynetnaija;
