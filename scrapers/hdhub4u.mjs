// scrapers/hdhub4u.mjs — scraper for hdhub4u-branded WordPress mirrors
// (e.g. filmmilf.xyz, "Hdhub4u Bollywood Filmyzilla And Filmyfly").
//
// Verified chain (filmmilf.xyz, Aug 2026):
//   1. Search:  GET /?s=<query>   (WordPress)
//   2. Post:    https://<site>/?p=<id> — content links to file hosts,
//               e.g. https://new1.filesdl.in/cloud/<shortid>
//   3. filesdl: rotates to filesdl.top; final file page may require a
//               session cookie/referer (best-effort: we follow the chain
//               with a cookie jar; if the host still blocks us we return
//               the locker URL flagged `locked: true`).

import { fetchChain, extractLinks, normalizeTitle, titleMatches, absolute, searchQuery } from "./base.mjs";
import { resolveFilesdl } from "./filesdl.mjs";

const DEFAULT_DOMAINS = ["filmmilf.xyz"];

export function makeHdhub4u({ domains = DEFAULT_DOMAINS, name = "hdhub4u", label = "HDHub4u (self)" } = {}) {
  // Skip links that point back at our own configured mirrors / site chrome.
  function isOwnHost(url) {
    try {
      const host = new URL(url).hostname.replace(/^www\./, "");
      return domains.some((d) => d.replace(/^www\./, "") === host);
    } catch {
      return true;
    }
  }

  async function searchPosts(title, year) {
    // Try each configured mirror in order; first one that yields posts wins.
    for (const domain of domains) {
      const domBase = `https://${domain}`;
      const url = `${domBase}/?s=${encodeURIComponent(searchQuery(title))}`;
      try {
        const { status, text } = await fetchChain(url);
        if (status !== 200) continue;
        const posts = [];
        for (const { url: href, text: anchor } of extractLinks(text)) {
          // WordPress post links: ?p=<id> permalinks or pretty permalinks
          const abs = absolute(domBase, href);
          const isPost = /[?&]p=\d+/.test(abs) || /\.html$/.test(abs) || /\/(20\d\d\/\d\d\/|archives\/)/.test(abs);
          if (!isPost) continue;
          const hay = anchor || abs;
          if (!titleMatches(title, hay, year)) continue;
          if (!posts.some((p) => p.url === abs)) {
            posts.push({ url: abs, title: (anchor || abs).replace(/^(Read|View|Visit):\s*/i, "") });
          }
        }
        if (posts.length) return { posts, base: domBase };
      } catch {
        // mirror unreachable — try the next one
      }
    }
    return { posts: [], base: domains[0] ? `https://${domains[0]}` : null };
  }

  // File-host / download links inside a post. filesdl.cloud pattern is the
  // dominant one on these mirrors; any other http(s) host we don't own is kept
  // as a candidate too.
  function extractFileLinks(html) {
    const out = [];
    for (const { url, text } of extractLinks(html)) {
      if (!/^https?:/.test(url)) continue;
      if (isOwnHost(url) || /wordpress|gravatar|gmpg\.org|wp-content|\.css|\.js|\.png|\.jpg|\.webp|\.svg|#/.test(url)) continue;
      if (!out.some((o) => o.url === url)) out.push({ url, label: text || url });
    }
    return out;
  }

  // filesdl.cloud/<id> -> follow the chain; falls back to flaresolverr when the
  // host sits behind a Cloudflare challenge (see filesdl.mjs).
  async function resolveFileHost(fileUrl) {
    return resolveFilesdl(fileUrl);
  }

  async function scrapeMovie({ title, year }) {
    if (!domains.length) return { provider: name, error: "no domains configured" };
    const { posts } = await searchPosts(title, year);
    if (!posts.length) return { provider: name, error: `No posts found for "${title}"`, sources: [] };

    const post = posts[0];
    const { status, text } = await fetchChain(post.url);
    if (status !== 200) return { provider: name, error: `Post returned HTTP ${status}`, sources: [] };

    const fileLinks = extractFileLinks(text);
    const sources = [];
    for (const fl of fileLinks) {
      const r = await resolveFileHost(fl.url);
      if (r.locked) {
        sources.push({
          provider: name,
          url: r.url,
          label: fl.label || r.note,
          quality: fl.label,
          isEmbed: true,
          locked: true,
          note: r.note,
        });
      } else {
        sources.push({ provider: name, url: r.url, label: fl.label, quality: fl.label, isEmbed: false });
      }
    }
    return { provider: name, post: post.url, sources, errors: [] };
  }

  // TV: same site pattern — episodes are sections inside the show's post(s).
  async function scrapeEpisode({ title, season, episode }) {
    if (!domains.length) return { provider: name, error: "no domains configured" };
    const seasonStr = String(season).padStart(2, "0");
    const episodeStr = String(episode).padStart(2, "0");
    const { posts } = await searchPosts(title);
    if (!posts.length) return { provider: name, error: `No posts found for "${title}"`, sources: [] };

    const want = new RegExp(`s?${seasonStr}\\s*e?${episodeStr}`, "i");
    const sources = [];
    for (const post of posts.slice(0, 3)) {
      const { status, text } = await fetchChain(post.url);
      if (status !== 200) continue;
      const links = extractLinks(text);
      for (let i = 0; i < links.length; i++) {
        const l = links[i];
        const windowText = `${l.text} ${(links[i + 1] || {}).text || ""}`;
        if (!want.test(windowText) && !want.test(l.text)) continue;
        if (!/^https?:/.test(l.url) || isOwnHost(l.url) || /wp-content/.test(l.url)) continue;
        const r = await resolveFileHost(l.url);
        sources.push(r.locked
          ? { provider: name, url: r.url, label: l.text, quality: l.text, isEmbed: true, locked: true, note: r.note }
          : { provider: name, url: r.url, label: l.text, quality: l.text, isEmbed: false });
      }
    }
    return { provider: name, sources, errors: [] };
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

export const hdhub4u = makeHdhub4u();
export default hdhub4u;
