// scrapers/filesdl.mjs — resolver for the filesdl.cloud / filesdl.top file host
// used by hdhub4u-branded WordPress mirrors.
//
// Findings (Aug 2026): filesdl.in 302-redirects to filesdl.top, which sits
// behind Cloudflare's *managed* JS challenge ("Just a moment...",
// challenges.cloudflare.com). Full browser headers and TLS impersonation
// (curl_cffi) both fail — the challenge requires real JS execution, so plain
// HTTP cannot unlock it.
//
// Strategy:
//   1. Try a plain cookie-jar fetch first (cheap; works if the site relaxes).
//   2. If a Cloudflare challenge is detected and FLARESOLVERR_URL is set, ask
//      flaresolverr (a Playwright-based challenge solver) for the page and
//      extract the real download link from the solved HTML.
//   3. Otherwise return { locked: true } with a diagnostic note.

import { fetchChain, extractLinks, decodeEntities, absolute } from "./base.mjs";

const CF_RE = /(Just a moment|challenges\.cloudflare\.com|cf-chl|captcha-bypass|challenge-platform)/i;

function isCloudflareChallenge(status, headers, text) {
  if (status !== 403 && status !== 429) return false;
  if (String(headers.get?.("server") || "").toLowerCase().includes("cloudflare")) return true;
  return CF_RE.test(text || "");
}

// Best-effort: pull the real file URL out of a solved filesdl page.
function extractFileUrl(html, baseUrl) {
  const candidates = [];
  for (const { url, text } of extractLinks(html)) {
    const u = absolute(baseUrl, url);
    const looksLikeFile = /\.(mp4|mkv|m4v|webm|mov|avi|zip|rar|7z|ts|mp3)(\?|#|$)/i.test(u) ||
      /(download|dl|get|file|direct)/i.test(u) && !/logout|login/.test(u);
    const label = `${text || ""} ${url}`.toLowerCase();
    if (looksLikeFile && !/logout|login|#/.test(u)) candidates.push(u);
    if (/\.(mp4|mkv|m4v)(\?|#|$)/i.test(u) && !/logout/.test(label)) candidates.unshift(u);
  }
  // data-* attributes and JSON-ish script assignments
  for (const m of html.matchAll(/(?:data-(?:url|href|file|download)|"(?:url|file|download)?")\s*[:=]\s*"([^"]+)"/gi)) {
    const u = absolute(baseUrl, decodeEntities(m[1]));
    if (/^https?:/i.test(u) && /\.(mp4|mkv|m4v|webm|zip|rar|7z)(\?|#|$)/i.test(u)) candidates.push(u);
  }
  // de-dupe, prefer file extensions
  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    const key = c.split("?")[0];
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

export async function resolveFilesdl(fileUrl, { flareSolverrUrl = process.env.FLARESOLVERR_URL || null, timeoutMs = 60_000 } = {}) {
  // Phase 1: plain fetch (cookie jar + referer to the WordPress post).
  try {
    const { status, headers, text } = await fetchChain(fileUrl, {
      headers: { Referer: "https://filmmilf.xyz/" },
      maxRedirects: 6,
    });
    if (!isCloudflareChallenge(status, headers, text)) {
      const urls = extractFileUrl(text, fileUrl);
      if (urls.length) return { locked: false, url: urls[0], candidates: urls.slice(0, 3), via: "direct", status };
      return { locked: true, url: fileUrl, note: `file page returned HTTP ${status} with no download link`, status };
    }
    if (!flareSolverrUrl) {
      return {
        locked: true,
        url: fileUrl,
        note: "Cloudflare challenge — set FLARESOLVERR_URL to a running flaresolverr to unlock",
        status,
      };
    }
  } catch (e) {
    if (!flareSolverrUrl) return { locked: true, url: fileUrl, note: `fetch failed: ${e.message}` };
  }

  // Phase 2: solve the challenge via flaresolverr.
  try {
    const res = await fetch(`${flareSolverrUrl.replace(/\/+$/, "")}/v1`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cmd: "request.get", url: fileUrl, maxTimeout: timeoutMs }),
    });
    if (!res.ok) return { locked: true, url: fileUrl, note: `flaresolverr returned HTTP ${res.status}` };
    const j = await res.json();
    const html = j?.solution?.response || j?.solution?.content || "";
    const status = j?.solution?.status || 200;
    if (!html) return { locked: true, url: fileUrl, note: "flaresolverr returned no page content" };
    const urls = extractFileUrl(html, fileUrl);
    if (urls.length) return { locked: false, url: urls[0], candidates: urls.slice(0, 3), via: "flaresolverr", status };
    return { locked: true, url: fileUrl, note: "flaresolverr solved the page but no download link was found", status };
  } catch (e) {
    return { locked: true, url: fileUrl, note: `flaresolverr request failed: ${e.message}` };
  }
}

export default resolveFilesdl;
