// scrapers/base.mjs - shared plumbing for the self-hosted scrapers.
//
// These modules scrape public index pages from the same source sites nxsha's
// own backend wraps (filmyfly, hdhub4u-branded mirrors, …). The whole module
// family is a link indexer: it never hosts or transmits media files.

export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

export const REQUEST_TIMEOUT_MS = 25_000;
export const MAX_REDIRECTS = 8;

// Minimal cookie jar so file hosts that set a session cookie on the first hit
// work on the second.
export class CookieJar {
  constructor() {
    this.cookies = new Map(); // name -> value
  }
  absorb(setCookieHeaders) {
    for (const raw of setCookieHeaders || []) {
      const [pair] = raw.split(";");
      const idx = pair.indexOf("=");
      if (idx < 0) continue;
      this.cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }
  header() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

// GET and return { status, headers, text }. Follows up to MAX_REDIRECTS
// redirects manually so the cookie jar and intermediate hops are visible.
export async function fetchChain(url, { headers = {}, jar = new CookieJar(), maxRedirects = MAX_REDIRECTS } = {}) {
  let current = url;
  const seen = new Set();
  for (let i = 0; i <= maxRedirects; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(current, {
        headers: { "User-Agent": UA, ...headers },
        redirect: "manual",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    jar.absorb(setCookies.length ? setCookies : splitSetCookie(res.headers.get("set-cookie")));

    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      const next = new URL(location, current).toString();
      if (seen.has(next)) throw new Error(`Redirect loop at ${next}`);
      seen.add(next);
      current = next;
      continue;
    }
    return { status: res.status, headers: res.headers, text: await res.text(), url: current };
  }
  throw new Error(`Too many redirects from ${url}`);
}

function splitSetCookie(value) {
  if (!value) return [];
  // Node <19 returns a single header with ", " separators; split conservatively.
  return value.split(/,(?=[^;]+=)/).map((s) => s.trim());
}

// Simple HTML entity decoder (numeric + common named entities).
export function decodeEntities(str) {
  return String(str)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'");
}

// Normalize a title for fuzzy matching: lowercase, strip punctuation/diacritics.
export function normalizeTitle(s) {
  return decodeEntities(String(s))
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ");
}

// A search-friendly query: letters, digits, spaces only (WordPress search in
// particular chokes on punctuation like colons and hyphens).
export function searchQuery(title) {
  return normalizeTitle(title).replace(/\s+/g, " ").trim();
}

// Extract all (url, anchorText) pairs from HTML matching `href` or `src`.
// Falls back to aria-label/title attributes when the anchor wraps media.
export function extractLinks(html) {
  const out = [];
  const seen = new Set();
  const re = /<(?:a|link)([^>]*)href="([^"]+)"([^>]*)>([\s\S]*?)<\/(?:a|link)>|<(?:a|link)([^>]*)href="([^"]+)"([^>]*)>/gi;
  for (const m of html.matchAll(re)) {
    const attrs = (m[1] || "") + (m[3] || "") + (m[5] || "") + (m[7] || "");
    const url = m[2] || m[6];
    if (!url || url.startsWith("#")) continue;
    let text = decodeEntities((m[4] || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    if (!text) {
      const label = attrs.match(/aria-label="([^"]+)"/) || attrs.match(/title="([^"]+)"/);
      if (label) text = decodeEntities(label[1]);
    }
    if (seen.has(url)) {
      const existing = out.find((o) => o.url === url);
      if (existing && !existing.text && text) existing.text = text;
      continue;
    }
    seen.add(url);
    out.push({ url, text });
  }
  // bare hrefs inside elements with known link classes
  const re2 = /href="([^"]+)"/g;
  for (const m of html.matchAll(re2)) {
    const url = m[1];
    if (url.startsWith("#")) continue;
    if (!seen.has(url)) { seen.add(url); out.push({ url, text: "" }); }
  }
  return out;
}

export function titleMatches(title, text, year) {
  const t = normalizeTitle(title);
  if (!t) return false;
  const hay = normalizeTitle(text);
  if (!hay.includes(t)) return false;
  if (year && !hay.includes(String(year))) return false;
  return true;
}

export function absolute(base, url) {
  try {
    return new URL(url, base).toString();
  } catch {
    return url;
  }
}
