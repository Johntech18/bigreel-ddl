// scrapers/naijaprey.mjs - scraper for naijaprey.tv (WordPress movie/series download site).
//
// Resolution chain:
//   1. Search:   GET /wp-json/wp/v2/posts?search=<title>  (WP REST API)
//   2. Post:     https://www.naijaprey.tv/<slug>/  (has download links to vdl.np-downloader.com)
//   3. Download: vdl.np-downloader.com/sdm_downloads/download-{slug}/  (links to wildshare.net)
//   4. wildshare.net: has file size + multi-step pt= download links (needs browser)

import { UA, REQUEST_TIMEOUT_MS, normalizeTitle, searchQuery } from "./base.mjs";

const DEFAULT_DOMAIN = "www.naijaprey.tv";
const DL_DOMAIN = "vdl.np-downloader.com";
const FILE_DOMAIN = "wildshare.net";

export function makeNaijaprey({
  domain = DEFAULT_DOMAIN,
  name = "naijaprey",
  label = "NaijaPrey",
} = {}) {
  const API_BASE = `https://${domain}`;
  const HEADERS = {
    "User-Agent": UA,
    Accept: "application/json",
  };

  // Category IDs: 1228 = Movie, 1518 = Series
  const MOVIE_CATEGORY = 1228;
  const SERIES_CATEGORY = 1518;

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

  // Search WP REST API for a title and return matching posts
  async function searchPosts(title, year, categories) {
    const q = searchQuery(title);
    if (!q) return [];

    let catParam = "";
    if (categories) {
      catParam = `&categories=${categories}`;
    }

    const results = await apiGet(
      `/wp-json/wp/v2/posts?search=${encodeURIComponent(q)}&per_page=10&_fields=id,title,link,categories${catParam}`
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
        score += (matching.length / queryWords.length) * 40;
      }

      if (year && nPost.includes(String(year))) score += 20;

      // Boost movies over series when searching for movies
      if (post.categories?.includes(MOVIE_CATEGORY)) score += 5;

      const isMovie = post.categories?.includes(MOVIE_CATEGORY);
      const isSeries = post.categories?.includes(SERIES_CATEGORY);

      return { post, postTitle, score, isMovie, isSeries };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored
      .filter((s) => s.score > 10)
      .map((s) => ({
        url: s.post.link,
        title: s.postTitle,
        id: s.post.id,
        isMovie: s.isMovie,
        isSeries: s.isSeries,
      }));
  }

  // Extract np-downloader URLs from post content
  function extractDownloadUrls(html) {
    const urls = [];
    const escapedDomain = DL_DOMAIN.replace(/\./g, "\\.");
    // Match JSON-encoded hrefs (from WP REST API: href=\\\"...")
    const regex = new RegExp(`href=\\\\\"(https?:\\\\/${escapedDomain}\\\\/[^'\"]*)\\\\\"`, "gi");
    let match;
    while ((match = regex.exec(html)) !== null) {
      const url = match[1].replace(/\\\//g, "/");
      if (!urls.includes(url)) urls.push(url);
    }
    // Also try standard HTML format
    const regex2 = new RegExp(`href=\"(https?://${escapedDomain}/[^\"]*)\"`, "gi");
    while ((match = regex2.exec(html)) !== null) {
      if (!urls.includes(match[1])) urls.push(match[1]);
    }
    return urls;
  }

  // Extract wildshare URL from np-downloader page
  function extractWildshareUrl(html) {
    const escapedDomain = FILE_DOMAIN.replace(/\./g, "\\.");
    const match = html.match(
      new RegExp(`href=\"(https?://${escapedDomain}/[^\"]*)\"`, "i")
    );
    if (match) return match[1];
    return null;
  }

  // Extract file size from wildshare page
  function extractWildshareSize(html) {
    const match = html.match(/Size:\s*\(([^)]+)\)/i);
    return match ? match[1] : null;
  }

  // Extract quality from filename/title
  function extractQuality(text) {
    const t = (text || "").toLowerCase();
    if (/2160p|4k|uhd/i.test(t)) return "2160p";
    if (/1080p|fullhd/i.test(t)) return "1080p";
    if (/720p/i.test(t)) return "720p";
    if (/480p/i.test(t)) return "480p";
    if (/\.mkv/i.test(t)) return "MKV";
    if (/\.mp4/i.test(t)) return "MP4";
    return "HD";
  }

  // Extract filename from wildshare URL
  function extractFilename(wildshareUrl) {
    try {
      const parts = new URL(wildshareUrl).pathname.split("/");
      return decodeURIComponent(parts[parts.length - 1]) || null;
    } catch {
      return null;
    }
  }

  async function scrapeMovie({ title, year }) {
    const posts = await searchPosts(title, year, MOVIE_CATEGORY);
    if (!posts.length) {
      return { provider: name, error: `No posts found for "${title}"`, sources: [] };
    }

    const post = posts[0];
    const sources = [];
    const errors = [];

    // Fetch post content via WP REST API to get np-downloader URLs
    let downloadUrls = [];
    try {
      const postData = await apiGet(
        `/wp-json/wp/v2/posts/${post.id}?_fields=content`
      );
      const postContent = postData?.content?.rendered || "";
      downloadUrls = extractDownloadUrls(postContent);
    } catch (e) {
      errors.push(`API content fetch: ${e.message}`);
    }

    // For movies, there's typically one download link
    // For each np-downloader URL, fetch it and get the wildshare link
    for (const dlUrl of downloadUrls.slice(0, 1)) {
      try {
        const { text: dlHtml } = await fetchHtml(dlUrl);
        const wildshareUrl = extractWildshareUrl(dlHtml);
        if (wildshareUrl) {
          // Fetch wildshare page for file size
          let fileSize = null;
          let quality = "HD";
          try {
            const { text: wlHtml } = await fetchHtml(wildshareUrl);
            fileSize = extractWildshareSize(wlHtml);
            const filename = extractFilename(wildshareUrl);
            if (filename) quality = extractQuality(filename);
            if (!fileSize) {
              // Try to get size from the initial wildshare page
              const sizeMatch = wlHtml.match(/Size:\s*\(([^)]+)\)/i);
              if (sizeMatch) fileSize = sizeMatch[1];
            }
          } catch { /* wildshare blocked or timeout */ }

          sources.push({
            provider: name, url: wildshareUrl,
            label: `${post.title} · ${FILE_DOMAIN}`,
            quality, size: fileSize, isEmbed: false, locked: true,
            note: "External link (needs browser to download)",
          });
        }
      } catch (e) {
        errors.push(`Download page fetch: ${e.message}`);
      }
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

  async function scrapeEpisode({ title, season, episode }) {
    // Search for series posts
    const posts = await searchPosts(title, null, SERIES_CATEGORY);
    if (!posts.length) {
      // Fall back to movie search
      const moviePosts = await searchPosts(title, null, MOVIE_CATEGORY);
      if (!moviePosts.length) {
        return { provider: name, error: `No posts found for "${title}"`, sources: [] };
      }
      return scrapeMovie({ title: moviePosts[0].title });
    }

    const post = posts[0];
    const sources = [];
    const errors = [];

    // Fetch post content to get all episode download links
    try {
      const postData = await apiGet(
        `/wp-json/wp/v2/posts/${post.id}?_fields=content`
      );
      const postContent = postData?.content?.rendered || "";
      const downloadUrls = extractDownloadUrls(postContent);

      // Resolve each download URL to its wildshare URL + filename
      const resolved = [];
      for (const dlUrl of downloadUrls) {
        try {
          const { text: dlHtml } = await fetchHtml(dlUrl);
          const wildshareUrl = extractWildshareUrl(dlHtml);
          if (wildshareUrl) {
            const filename = extractFilename(wildshareUrl);
            resolved.push({ dlUrl, wildshareUrl, filename });
          }
        } catch (e) {
          errors.push(`Download page fetch: ${e.message}`);
        }
      }

      // If season+episode requested, filter by np-downloader URL or filename
      // np-downloader URLs: download-{title}-season-{N}-episode-{N}
      // wildshare filenames: {Title}.S01E01.mkv
      let targets = resolved;
      if (season && episode && resolved.length > 1) {
        const seasonNum = Number(season);
        const episodeNum = Number(episode);
        // Try np-downloader URL first (more reliable)
        const urlPattern = new RegExp(`season-${seasonNum}-episode-${episodeNum}`, "i");
        let matched = resolved.filter((r) => r.dlUrl && urlPattern.test(r.dlUrl));
        // Fall back to wildshare filename (S01E01 pattern)
        if (!matched.length) {
          const filePattern = new RegExp(`S0*${season}E0*${episode}`, "i");
          matched = resolved.filter((r) => r.filename && filePattern.test(r.filename));
        }
        if (matched.length) targets = matched;
      }

      // Fetch file sizes from wildshare pages
      for (const t of targets) {
        let fileSize = null;
        let quality = "HD";
        try {
          const { text: wlHtml } = await fetchHtml(t.wildshareUrl);
          fileSize = extractWildshareSize(wlHtml);
          if (t.filename) quality = extractQuality(t.filename);
        } catch { /* wildshare blocked */ }

        sources.push({
          provider: name, url: t.wildshareUrl,
          label: `${post.title} · ${FILE_DOMAIN}`,
          quality, size: fileSize, isEmbed: false, locked: true,
          note: "External link (needs browser to download)",
        });
      }
    } catch (e) {
      errors.push(`API content fetch: ${e.message}`);
    }

    // Fallback
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

export const naijaprey = makeNaijaprey();
export default naijaprey;
