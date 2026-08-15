// scrapers/pahe.mjs - metadata-only provider for pahe.ink (WordPress movie/TV site).
//
// Pahe is a big, well-organized library (movies + TV season packs, per-quality
// download boxes with 480p/720p/1080p/2160p × x264/x265). The blog itself is
// open - no Cloudflare on search or posts - but every download link on a post
// is an *ad-locker shortener* (teknoasian.com/?ht=, tpi.li/<slug>, oii.la/…,
// intercelestial.com, linegee.net, …) that reveals the real file URL only after
// a human clicks through captchas + "Generate Link" hops in a browser.
//
// So this provider is deliberately metadata-only: it searches pahe, resolves
// the right post, and extracts the download box (quality, size, mirror host,
// shortener URL) - with every source flagged `locked: true` and a note saying
// the link is an external locked shortener. It tells you *what exists* and
// gives you the exact link to open manually, without pretending to have direct
// file URLs. Verified chain (Aug 2026):
//   /?s=<query> -> li.timeline-post -> h2.post-box-title a[href]   (search)
//   post page   -> div.box.download > quality lines + mirror buttons
//   button      -> external locked shortener (never a direct file)

import { fetchChain, extractLinks, titleMatches, decodeEntities, searchQuery, absolute } from "./base.mjs";

const DEFAULT_DOMAINS = ["pahe.ink"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Mirror button codes pahe uses (host abbreviations) - anything else on the
// box is ignored so nav/social links don't leak into sources.
const MIRROR_RE = /^(SD|GD|MG|1D|1F|PD|VF|GF|HD|4K|UHD)$/i;

// Ad-locker shortener hosts pahe's mirror buttons point at. Their pages embed
// the real destination URL in <input name="token"> as base64 - decode it and
// the link is unlocked (this is what "Bypass Pahe Links"-style userscripts
// do in the browser; we do it server-side). See resolveToken() below.
const SHORTLINK_HOSTS = new Set([
  "tpi.li", "oii.la", "tei.ai", "tii.ai", "iir.ai", "oko.sh", "uii.io", "ouo.io", "aylink.co", "exe.io",
]);

// Decode the destination URL from a shortener's token value. The token is
// `<hex>…<slug>1508<base64(url)>` - the last chunk after "aHR0c" (base64 of
// "http") is the real URL. Falls back to a whole-string base64 scan.
export function resolveToken(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  const b64 = (chunk) => {
    try {
      const decoded = Buffer.from(chunk, "base64").toString("utf8");
      const m = decoded.match(/https?:\/\/[^\u0000-\u001f\s<>"']+/i);
      return m ? m[0] : null;
    } catch {
      return null;
    }
  };
  const last = s.lastIndexOf("aHR0c");
  if (last !== -1) {
    const hit = b64(s.slice(last));
    if (hit) return hit;
  }
  return b64(s);
}

// Extract the leading resolution from a quality label ("1080p x265 DD+5.1" ->
// 1080, "4K …" -> 2160, "480p" -> 480). Returns null when there is none.
function sourceResolution(quality) {
  const s = String(quality || "").toLowerCase();
  const m = s.match(/(\d{3,4})\s*p/);
  if (m) return parseInt(m[1], 10);
  if (/\b4k\b/.test(s)) return 2160;
  return null;
}

// Parse the min_quality filter value: accepts "1080p", "1080", "4K". Returns
// a bare number or null when the value isn't a quality threshold.
function parseMinQuality(v) {
  const s = String(v || "").trim().toLowerCase();
  const m = s.match(/(\d{3,4})\s*p?/);
  if (m) return parseInt(m[1], 10);
  if (s.includes("4k") || s.includes("2160")) return 2160;
  return null;
}

// Keep only sources at or above the requested resolution (null = no filter).
function filterMinQuality(sources, minQuality) {
  const min = parseMinQuality(minQuality);
  if (!min) return sources;
  return sources.filter((s) => {
    const res = sourceResolution(s.quality);
    return res !== null && res >= min;
  });
}

export function makePahe({
  domains = DEFAULT_DOMAINS,
  name = "pahe",
  label = "Pahe.in (metadata - links are external locked shorteners)",
  paceMs = 400,
  shortlinkPaceMs = 900,
  maxFiles = 48,
  maxResolve = 12,
} = {}) {
  const base = domains[0] ? `https://${domains[0]}` : null;
  const shortlinkCache = new Map(); // url -> { expiresAt, dest }

  async function paced() {
    if (paceMs) await sleep(paceMs);
  }

  // Resolve one ad-locker shortener URL to its real destination by decoding
  // the token pahe embeds on the locker page (tpi.li / oii.la / …). Cached
  // per URL so repeated scrapes of the same post don't re-fetch the lockers.
  // tpi.li rate-limits rapid bursts (it serves a stripped page without the
  // token), so space requests out and retry once on failure.
  async function resolveShortlink(url) {
    const hit = shortlinkCache.get(url);
    if (hit && hit.expiresAt > Date.now()) return hit.dest;
    const host = (new URL(url).hostname || "").toLowerCase();
    if (![...SHORTLINK_HOSTS].some((h) => host === h || host.endsWith(`.${h}`))) return null;
    for (let attempt = 0; attempt < 2; attempt++) {
      await sleep(shortlinkPaceMs);
      try {
        const { status, text } = await fetchChain(url);
        if (status !== 200) return null;
        const tok = text.match(/<input[^>]*name=["']token["'][^>]*>/i);
        if (!tok) { await sleep(1200); continue; }
        const val = (tok[0].match(/value=["']([^"']*)["']/i) || [])[1];
        const dest = val ? resolveToken(val) : null;
        if (dest) shortlinkCache.set(url, { expiresAt: Date.now() + 12 * 60 * 60 * 1000, dest });
        return dest;
      } catch {
        await sleep(1200);
      }
    }
    return null;
  }

  // After extraction, try to unlock up to `maxResolve` shortener sources.
  // Resolved ones get the real file-host URL + a note; the rest stay locked.
  async function resolveSources(sources) {
    let remaining = maxResolve;
    for (const s of sources) {
      if (!s.locked || !remaining) continue;
      if (![...SHORTLINK_HOSTS].some((h) => {
        try { const host = new URL(s.url).hostname.toLowerCase(); return host === h || host.endsWith(`.${h}`); } catch { return false; }
      })) continue;
      const dest = await resolveShortlink(s.url);
      remaining--;
      if (!dest) continue;
      s.url = dest;
      s.locked = false;
      s.note = `resolved from pahe's ad-locker shortener - file hosted on ${new URL(dest).hostname}`;
    }
    return sources;
  }

  // WordPress search: /?s=<query> -> timeline posts.
  async function searchPosts(title, year) {
    if (!base) return { posts: [], base: null };
    for (const domain of domains) {
      const domBase = `https://${domain}`;
      const q = encodeURIComponent(searchQuery(title));
      const url = `${domBase}/?s=${q}`;
      try {
        const { status, text } = await fetchChain(url);
        if (status !== 200) continue;
        const posts = [];
        for (const m of text.matchAll(/<h2 class="post-box-title">\s*<a href="([^"]+)">([\s\S]*?)<\/a>/gi)) {
          const anchor = decodeEntities(m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
          const abs = absolute(domBase, m[1]);
          if (!posts.some((p) => p.url === abs)) posts.push({ url: abs, title: anchor || abs });
        }
        if (posts.length) return { posts, base: domBase };
      } catch {
        // mirror unreachable - try the next one
      }
    }
    return { posts: [], base: domains[0] ? `https://${domains[0]}` : null };
  }

  // Walk the download box: quality heading lines ("480p x264 | 550 MB") plus
  // the mirror buttons that follow each one. The box is <br>-delimited chunks:
  // a heading chunk, then a chunk holding the mirror anchors (SD/GD/MG/…). We
  // trim the box at "Related posts"/"Last Updated" so sidebar junk (e.g.
  // "2160p" inside title= attributes) never becomes a heading. Returns
  // per-mirror source objects.
  function extractDownloadBox(html) {
    const sources = [];
    // Match the start of the box's <div> (indexOf would land mid-tag and break
    // the first heading). The box can also repeat (separate sections per
    // source), so stop at "Last Updated"/"Related posts"/</article> - NOT the
    // first </div>.
    const dlTag = /<div[^>]*class="[^"]*\bbox download\b/;
    const dlStart = html.search(dlTag);
    if (dlStart === -1) return sources;
    let inner = html.slice(dlStart);
    const stopIdx = [inner.indexOf("Related posts"), inner.indexOf("Last Updated"), inner.indexOf("</article>")]
      .filter((i) => i !== -1)
      .sort((a, b) => a - b)[0];
    if (stopIdx !== undefined) inner = inner.slice(0, stopIdx);

    let curLabel = null;
    let curSize = "";
    for (const rawChunk of inner.split(/<br\s*\/?>/i)) {
      // Collect mirror anchors first (raw HTML), then strip tags so inline
      // markup inside a heading (e.g. <a>HDR DV</a>) doesn't break it.
      for (const a of rawChunk.matchAll(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
        const button = a[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        if (!MIRROR_RE.test(button)) continue;
        if (!/^https?:\/\//i.test(a[1])) continue;
        if (sources.length >= maxFiles) break;
        sources.push({
          provider: name,
          url: a[1],
          label: `${curLabel || "?"} · ${button}`,
          quality: curLabel || "",
          size: curSize,
          host: button,
          isEmbed: false,
          locked: true,
          note: "this is an external locked link and opens an ad-locker shortener; the real file URL is revealed only after clicking through captchas + 'Generate Link' hops in a browser",
        });
      }
      // quality heading at the start of the chunk: "480p x264 | 550 MB",
      // "HQ 1080p x265 DD+5.1 Atmos | 9.19 GB". Anchored at the chunk start so
      // the "Source: … 2160p …" info line and sidebar text never match.
      const chunk = decodeEntities(rawChunk.replace(/<[^>]+>/g, " "));
      const h = chunk.match(/^\s*((?:HQ\s+)?(?:480p|720p|1080p|2160p|4K)\s+[^|]{1,80})(?:\s*\|\s*([^|]{1,20}))?/i);
      if (h) {
        curLabel = h[1].trim().replace(/\s+/g, " ");
        curSize = h[2] ? h[2].trim() : "";
      }
    }
    return sources;
  }

  async function scrapeMovie({ title, year, minQuality }) {
    if (!base) return { provider: name, error: "no domains configured", sources: [] };
    const { posts, base: activeBase } = await searchPosts(title, year);
    if (!posts.length) return { provider: name, error: `No post found for "${title}" on this server`, sources: [] };

    // Prefer the newest-looking match that still carries the title.
    let post = posts.find((p) => titleMatches(title, p.title, year));
    if (!post && year) post = posts.find((p) => titleMatches(title, p.title, ""));
    if (!post) post = posts[0];

    await paced();
    const { status, text } = await fetchChain(post.url);
    if (status !== 200) return { provider: name, error: `Post returned HTTP ${status}`, sources: [] };
    const sources = await resolveSources(filterMinQuality(extractDownloadBox(text), minQuality));
    if (!sources.length) return { provider: name, post: post.url, error: "No download box found on post (or none at the requested quality)", sources: [] };
    return { provider: name, post: post.url, sources };
  }

  // TV: pahe posts whole-season packs ("Show Name Season N Complete ...").
  // We match the show's post, prefer one mentioning the requested season, and
  // return the season-pack download box (each source is still a locked
  // shortener). Episode-level granularity doesn't exist on this server.
  async function scrapeEpisode({ title, season, episode, minQuality }) {
    if (!base) return { provider: name, error: "no domains configured", sources: [] };
    const { posts, base: activeBase } = await searchPosts(title, null);
    if (!posts.length) return { provider: name, error: `No post found for "${title}" on this server`, sources: [] };

    const seasonRe = season ? new RegExp(`season\\s*${season}(\\b|\\s|$)`, "i") : null;
    let post = posts.find((p) => seasonRe && seasonRe.test(p.title));
    if (!post) post = posts.find((p) => /complete/i.test(p.title));
    if (!post) post = posts.find((p) => titleMatches(title, p.title, ""));
    if (!post) post = posts[0];

    await paced();
    const { status, text } = await fetchChain(post.url);
    if (status !== 200) return { provider: name, error: `Post returned HTTP ${status}`, sources: [] };
    const sources = await resolveSources(filterMinQuality(extractDownloadBox(text), minQuality));
    if (!sources.length) return { provider: name, post: post.url, error: "No download box found on post (or none at the requested quality)", sources: [] };
    // Make the season-pack nature explicit in each label.
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

export const pahe = makePahe();
export default pahe;
