// scrapers/filmyfly.mjs - scraper for FilmyFly mirrors (DataLife Engine sites).
//
// Verified resolution chain (filmsay.com, Aug 2026):
//   1. Search:  GET /index.php?do=search&subaction=search&story=<query>
//   2. Post:    https://<site>/<slug>.html   (contains /go.php?url=<enc> links,
//               one per quality/size, encrypted with Laravel's AES-256-GCM)
//   3. go.php:  renders "File Information" + "Choose a Download Server" page
//               with /server.php?id=<numeric> links per host
//   4. server.php?id=N: 302-redirects straight to the real file URL
//               (verified: video-downloads.googleusercontent.com, hubcloud.cx, …)
//
// We never need to decrypt the go.php payload - the site resolves it for us.

import { fetchChain, extractLinks, titleMatches, absolute, REQUEST_TIMEOUT_MS, UA, CookieJar, searchQuery } from "./base.mjs";

const DEFAULT_DOMAINS = ["filmsay.com"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The site rate-limits /server.php per IP, so resolved links are cached and
// requests are paced. Cache lives for `cacheTtlMs` (links expire server-side).
export function makeFilmyfly({
  domains = DEFAULT_DOMAINS,
  name = "filmyfly",
  label = "FilmyFly",
  cacheTtlMs = 12 * 60 * 60 * 1000,
  paceMs = 400,
  maxServersPerFile = 4,
  maxFiles = 8,
} = {}) {
  const base = domains[0] ? `https://${domains[0]}` : null;
  const linkCache = new Map(); // server.php url -> { expiresAt, final }

  async function paced() {
    if (paceMs) await sleep(paceMs);
  }

  async function searchPosts(title, year) {
    // Try each configured mirror in order; first one that yields posts wins.
    for (const domain of domains) {
      const domBase = `https://${domain}`;
      const q = encodeURIComponent(searchQuery(title));
      const url = `${domBase}/index.php?do=search&subaction=search&story=${q}`;
      try {
        const { status, text } = await fetchChain(url);
        if (status !== 200) continue;
        const posts = [];
        for (const { url: href, text: anchor } of extractLinks(text)) {
          if (!/\.html$/.test(href)) continue;
          const abs = absolute(domBase, href);
          const hay = anchor || abs;
          if (!titleMatches(title, hay, year)) continue;
          if (!posts.some((p) => p.url === abs)) posts.push({ url: abs, title: anchor || abs });
        }
        if (posts.length) return { posts, base: domBase };
      } catch {
        // mirror unreachable - try the next one
      }
    }
    return { posts: [], base: domains[0] ? `https://${domains[0]}` : null };
  }

  // Extract go.php (locked download) links from a post, with their labels.
  function extractGoLinks(html, base) {
    const out = [];
    for (const { url, text } of extractLinks(html)) {
      if (!url.includes("go.php")) continue;
      const abs = absolute(base, url);
      if (!out.some((o) => o.url === abs)) out.push({ url: abs, label: text || abs });
    }
    return out;
  }

  // go.php -> page with file info + per-host server.php links. Threads a shared
  // cookie jar and referer so any session set by go.php reaches server.php.
  async function resolveGo(goUrl, jar, base) {
    await paced();
    const { status, text, url: finalUrl } = await fetchChain(goUrl, { jar });
    if (status !== 200) return { error: `go.php returned HTTP ${status}`, servers: [] };
    const title = (text.match(/<title>([^<]*)<\/title>/) || [])[1] || "";
    const info = {
      label: title.replace(/\s*-\s*Download Servers$/i, "").trim(),
      size: (text.match(/📦\s*&nbsp;?([^<]*)/) || [])[1] || "",
      url: finalUrl,
    };
    const servers = [];
    for (const { url, text: serverLabel } of extractLinks(text)) {
      if (!/server\.php\?id=\d+/.test(url)) continue;
      servers.push({ url: absolute(base, url), label: serverLabel || url });
    }
    return { info, servers };
  }

  // server.php?id=N -> 302 to the real file. Cached per server link; paced;
  // uses the shared jar + referer from the go.php page.
  async function resolveServer(serverUrl, { jar, referer } = {}) {
    const hit = linkCache.get(serverUrl);
    if (hit && hit.expiresAt > Date.now()) return { final: hit.final, status: 302, cached: true };
    await paced();
    try {
      const { status, headers, url } = await fetchChain(serverUrl, { jar, headers: { Referer: referer }, maxRedirects: 8 });
      let final = null;
      if (status >= 300 && status < 400 && headers.get("location")) final = headers.get("location");
      else if (status === 200) final = url; // host returned the page (locker)
      if (final) linkCache.set(serverUrl, { expiresAt: Date.now() + cacheTtlMs, final });
      return { url, status, final };
    } catch {
      // redirect chain exhausted -> let the runtime follow it natively
      const c = new AbortController();
      const timer = setTimeout(() => c.abort(), REQUEST_TIMEOUT_MS);
      try {
        const res = await fetch(serverUrl, { redirect: "follow", signal: c.signal, headers: { "User-Agent": UA, Referer: referer } });
        return { url: res.url, status: res.status, final: res.url };
      } catch (e) {
        return { url: serverUrl, status: 0, final: null, error: e.message };
      } finally {
        clearTimeout(timer);
      }
    }
  }

  async function scrapeMovie({ title, year }) {
    if (!domains.length) return { provider: name, error: "no domains configured" };
    const { posts, base: activeBase } = await searchPosts(title, year);
    if (!posts.length) return { provider: name, error: `No posts found for "${title}"`, sources: [] };

    const post = posts[0];
    const jar = new CookieJar();
    const { status, text } = await fetchChain(post.url, { jar });
    if (status !== 200) return { provider: name, error: `Post returned HTTP ${status}`, sources: [] };

    const goLinks = extractGoLinks(text, activeBase).slice(0, maxFiles);
    const sources = [];
    const errors = [];
    for (const go of goLinks) {
      const { info, servers, error } = await resolveGo(go.url, jar, activeBase);
      if (error) { errors.push(error); continue; }
      for (const s of servers.slice(0, maxServersPerFile)) {
        try {
          const r = await resolveServer(s.url, { jar, referer: go.url });
          if (r.final) {
            sources.push({
              provider: name,
              url: r.final,
              label: info.label,
              quality: info.label,
              size: info.size,
              host: s.label,
              isEmbed: false,
              cached: !!r.cached,
            });
          } else {
            errors.push(`${s.label}: no redirect (HTTP ${r.status})`);
          }
        } catch (e) {
          errors.push(`${s.label}: ${e.message}`);
        }
      }
    }
    return { provider: name, post: post.url, sources, errors };
  }

  // TV: episode links live inside the show's post. DLE search finds the post;
  // then we keep only go.php links whose label matches S{season}E{episode}.
  async function scrapeEpisode({ title, season, episode }) {
    if (!domains.length) return { provider: name, error: "no domains configured" };
    const seasonStr = String(season).padStart(2, "0");
    const episodeStr = String(episode).padStart(2, "0");
    const { posts, base: activeBase } = await searchPosts(title);
    if (!posts.length) return { provider: name, error: `No posts found for "${title}"`, sources: [] };

    const want = new RegExp(`s?${seasonStr}\\s*e?${episodeStr}`, "i");
    const sources = [];
    const errors = [];
    for (const post of posts.slice(0, 3)) {
      const jar = new CookieJar();
      const { status, text } = await fetchChain(post.url, { jar });
      if (status !== 200) continue;
      // Walk go.php links in DOM order, remembering the label immediately before each.
      const raw = [...text.matchAll(/<a[^>]*href="([^"]*go\.php[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)]
        .map((m) => ({ url: absolute(activeBase, m[1]), label: m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() }));
      for (const go of raw) {
        if (!want.test(go.label) && !want.test(go.url)) continue;
        const { info, servers, error } = await resolveGo(go.url, jar, activeBase);
        if (error) { errors.push(error); continue; }
        for (const s of servers.slice(0, maxServersPerFile)) {
          try {
            const r = await resolveServer(s.url, { jar, referer: go.url });
            if (r.final) {
              sources.push({
                provider: name,
                url: r.final,
                label: go.label || info.label,
                quality: go.label || info.label,
                size: info.size,
                host: s.label,
                isEmbed: false,
              });
            }
          } catch (e) {
            errors.push(`${s.label}: ${e.message}`);
          }
        }
      }
    }
    return { provider: name, sources, errors };
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

export const filmyfly = makeFilmyfly();
export default filmyfly;
