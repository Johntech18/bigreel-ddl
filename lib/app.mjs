// server.mjs - BIGREEL Downloader: direct-download link server.
//
// Merges two backends into one response:
//   A) self-hosted scrapers (own modules - Elite/Prime/Index/Swift/Nexus)
//   B) nxsha.app proxy (partner sources)
//
// URL scheme mirrors nxsha.app so a stream site can deep-link by TMDB id:
//   GET /dl/movie/:tmdbId | /dl/tv/:tmdbId/:s/:e   (HTML)
//   GET /api/dl/movie/:tmdbId | /api/dl/tv/...      (JSON)
//
// With TMDB_API_KEY set, /dl/* resolves the tmdbId to a title and scrapes the
// self-hosted providers + nxsha. Without it, /dl/* falls back to the nxsha
// proxy only. Zero dependencies: node:http + built-in fetch (Node 18+).

import http from "node:http";
import { pathToFileURL } from "node:url";
import { getServers, getSources } from "../nxsha.mjs";
import { scrapeMovie, scrapeEpisode, tmdbSearch, findAndScrapeMerged, scrapeMergedById, resolveMetadata } from "../scrapers/index.mjs";

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const BRAND = "BIGREEL Downloader";
const ACCENT = "#F4F2EA";
const LOGO_URL = "https://i.postimg.cc/3RHNvYbT/logo-new.png";

// --- tiny TTL cache so repeated page loads don't hammer the upstream ----------
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 60_000);
// /api/find scrapes every provider (~10-30 s), so it caches much longer.
const FIND_CACHE_TTL_MS = Number(process.env.FIND_CACHE_TTL_MS || 5 * 60_000);
const cache = new Map(); // key -> { expiresAt, data }

function cached(key, ttlMs, loader) {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.data;
  const data = loader();
  cache.set(key, { expiresAt: Date.now() + ttlMs, data });
  return data;
}

// --- helpers ------------------------------------------------------------------

function parseMedia(query, params) {
  const type = params.type === "tv" ? "tv" : "movie";
  if (type === "tv") {
    const season = params.season || query.get("season") || "1";
    const episode = params.episode || query.get("episode") || "1";
    if (!/^\d{1,3}$/.test(season) || !/^\d{1,3}$/.test(episode)) {
      throw new httpError(400, "Invalid season/episode");
    }
    return { tmdbId: params.tmdbId, type, season, episode };
  }
  return { tmdbId: params.tmdbId, type, season: "1", episode: "1" };
}

function json(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

class httpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Server-side HTML escaping for interpolated strings.
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const html = (title, body) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Anton&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500&display=swap" rel="stylesheet"/>
<meta name="theme-color" content="${ACCENT}"/>
<link rel="icon" type="image/png" href="${LOGO_URL}"/>
<meta name="description" content="BIGREEL Downloader - direct download links for movies and TV shows, by TMDB id."/>
<meta property="og:site_name" content="${BRAND}"/>
<meta property="og:title" content="${esc(title)} - ${BRAND}"/>
<meta property="og:description" content="Direct download links for movies and TV shows, aggregated from multiple servers."/>
<meta property="og:type" content="website"/>
<meta property="og:image" content="${LOGO_URL}"/>
<meta name="twitter:card" content="summary"/>
<meta name="twitter:title" content="${esc(title)} - ${BRAND}"/>
<meta name="twitter:description" content="Direct download links for movies and TV shows, aggregated from multiple servers."/>
<meta name="twitter:image" content="${LOGO_URL}"/>
<title>${esc(title)} - ${BRAND}</title>
<style>
  /* --- Manifest tokens (DESIGN.md) --- */
  :root { color-scheme: light; --paper:#F4F2EA; --bar:#E3EBD9; --ink:#1A211B; --stamp:#C2401F; --hold:#A06A12; --mute:#5A6157; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--paper); color:var(--ink); font-family:"IBM Plex Sans", system-ui, sans-serif; min-height:100vh; }
  main { max-width: 900px; margin: 0 auto; padding: 20px 16px 80px; }
  a { color: var(--ink); }
  header { display:flex; align-items:center; gap:12px; margin: 10px 0 26px; }
  .logo { width:42px; height:42px; border-radius:12px; object-fit:cover; box-shadow:0 2px 8px rgba(26,33,27,.25); }
  h1 { font-family:Anton, sans-serif; font-size:26px; margin:0; letter-spacing:.04em; font-weight:400; }
  .sub { color:var(--mute); font-size:12.5px; margin-top:3px; font-family:"IBM Plex Mono", monospace; }
  :focus-visible { outline:3px solid var(--stamp); outline-offset:2px; }
  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration:.01ms !important; transition-duration:.01ms !important; } }
  .hero { text-align:center; padding: 42px 0 26px; }
  .searchbar { display:flex; gap:10px; justify-content:center; flex-wrap:wrap; }
  .searchbar input { background:#0d1428; border:1px solid var(--border); border-radius:12px; padding:13px 16px; color:var(--text); font-size:15px; flex:0 1 300px; min-width:200px; outline:none; }
  .searchbar input:focus { border-color:var(--accent); box-shadow:0 0 0 3px rgba(33,150,243,.2); }
  .searchbar input.num { flex:0 0 64px; min-width:64px; text-align:center; }
  .searchbar button { background:var(--stamp); border:0; color:#fff; font-family:Anton, sans-serif; font-weight:400; letter-spacing:.08em; font-size:15px; padding:0 26px; border-radius:0; cursor:pointer; transition:filter .15s; }
  .searchbar button:hover { filter:brightness(1.12); }
  .quicklinks { display:flex; gap:10px; justify-content:center; flex-wrap:wrap; margin-top:20px; }
  .quicklinks a { color:var(--muted); text-decoration:none; font-size:12.5px; border:1px solid var(--border); background:var(--card); padding:8px 14px; border-radius:999px; transition:all .15s; }
  .quicklinks a:hover { color:var(--accent-2); border-color:var(--accent); }
  .quicklinks code { color:var(--ink); }
  .section { margin-top:38px; }
  .section h2 { font-size:17px; margin:0 0 4px; }
  .section .lead { color:var(--mute); font-size:13px; margin:0 0 16px; }
  .badge { font-family:"IBM Plex Mono", monospace; font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:.08em; padding:2px 8px; border-radius:0; background:transparent; color:var(--mute); border:1px solid var(--mute); }
  .badge.err { color:var(--stamp); border-color:var(--stamp); }
  .badge.srcself { color:var(--mute); }
  .badge.srctx { color:var(--mute); border-style:dashed; }
  .empty { color:var(--mute); font-size:13px; padding:12px 16px; border-top:1px solid rgba(26,33,27,.08); }
  .loading, .err { display:flex; justify-content:center; align-items:center; min-height:200px; color:var(--mute); font-size:14px; font-family:"IBM Plex Mono", monospace; }
  .err { color:var(--stamp); }
  .disclaimer { margin-top:48px; font-size:10.5px; line-height:1.7; color:var(--mute); text-align:center; font-family:"IBM Plex Mono", monospace; }
  /* Manifest extras: hero, sequence, carriers table */
  .hero { text-align:center; padding: 42px 0 26px; }
  .hero h2 { font-family:Anton, sans-serif; font-size:clamp(28px,6vw,46px); margin:0 0 12px; letter-spacing:.02em; line-height:1.15; font-weight:400; }
  .hero p { color:var(--mute); font-size:15px; line-height:1.7; max-width:620px; margin:0 auto 26px; }
  .searchbar input { background:#fff; border:1px solid var(--ink); border-radius:0; padding:13px 16px; color:var(--ink); font-size:15px; flex:0 1 300px; min-width:200px; outline:none; font-family:"IBM Plex Mono", monospace; }
  .searchbar input:focus { border-color:var(--stamp); box-shadow:0 0 0 3px rgba(194,64,31,.15); }
  .searchbar input.num { flex:0 0 64px; min-width:64px; text-align:center; }
  .quicklinks { display:flex; gap:10px; justify-content:center; flex-wrap:wrap; margin-top:20px; }
  .quicklinks a { color:var(--mute); text-decoration:none; font-size:12.5px; border:1px solid var(--mute); background:transparent; padding:8px 14px; border-radius:0; font-family:"IBM Plex Mono", monospace; }
  .quicklinks a:hover { color:var(--ink); border-color:var(--ink); }
  .steps { display:flex; gap:14px; flex-wrap:wrap; margin-top:16px; }
  .step { flex:1 1 200px; border:1px solid var(--ink); padding:16px; font-family:"IBM Plex Mono", monospace; font-size:13px; background:#FBFAF6; }
  .stepnum { font-family:Anton, sans-serif; font-size:20px; color:var(--stamp); display:block; margin-bottom:6px; }
  .manifest { border:2px solid var(--ink); background:#FBFAF6; }
  .mrow { display:flex; gap:18px; padding:12px 16px; border-bottom:1px dashed rgba(90,97,87,.4); align-items:baseline; }
  .mrow:nth-child(odd) { background:var(--bar); }
  .mname { font-family:Anton, sans-serif; font-size:14px; letter-spacing:.06em; flex:0 0 110px; }
  .mdesc { font-size:12.5px; color:var(--mute); }
</style>
</head>
<body>
${body}
</body>
</html>`;

const brandHeader = (sub) => `
  <header><img class="logo" src="${LOGO_URL}" alt="BIGREEL"/><div><h1>${BRAND}</h1><div class="sub">${sub}</div></div></header>`;

// Shared styles for the results listing (the green-bar manifest). Used by
// search page and results page.
const resultsStyle = `
  <style>
  .doc { background:#FBFAF6; border:1px solid rgba(26,33,27,.18); margin-top:18px; position:relative; padding:26px 0 0 34px; }
  .doc::before { content:""; position:absolute; left:12px; top:0; bottom:0; width:4px; background-image:radial-gradient(circle at 2px 10px, var(--paper) 2px, transparent 2.5px); background-size:4px 22px; }
  .titlebar { display:flex; align-items:baseline; gap:14px; padding:0 18px 14px 0; border-bottom:2px solid var(--ink); flex-wrap:wrap; }
  .titlebar h2 { font-family:Anton, sans-serif; font-size:clamp(20px,4vw,30px); margin:0; letter-spacing:.02em; text-transform:uppercase; font-weight:400; }
  .toolbar { display:flex; gap:10px; padding:12px 18px 12px 0; border-bottom:1px solid var(--ink); align-items:center; flex-wrap:wrap; font-family:"IBM Plex Mono", monospace; font-size:12px; }
  .toolbar label { display:flex; gap:6px; align-items:center; color:var(--mute); }
  .toolbar select { font-family:inherit; background:#fff; border:1px solid var(--mute); padding:4px 6px; }
  .carrierhead { font-family:Anton, sans-serif; letter-spacing:.06em; font-size:14px; margin:0; padding:16px 18px 8px 0; display:flex; align-items:baseline; gap:10px; }
  .carrierhead .cnt { font-family:"IBM Plex Mono", monospace; font-size:11px; color:var(--mute); letter-spacing:0; }
  .item { display:flex; align-items:center; gap:14px; padding:10px 18px 10px 12px; font-family:"IBM Plex Mono", monospace; font-size:13px; border-bottom:1px dashed rgba(90,97,87,.4); }
  .item:nth-child(even) { background:var(--bar); }
  .item .fname { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .item .fsize { color:var(--mute); white-space:nowrap; }
  .item .grow { flex:1 1 auto; min-width:0; display:flex; flex-direction:column; gap:2px; }
  .stamp { display:inline-block; font-family:Anton, sans-serif; font-size:11px; letter-spacing:.1em; padding:3px 10px; border:2px solid currentColor; transform:rotate(-2deg); }
  .stamp.direct { color:var(--stamp); }
  .stamp.hold { color:var(--hold); transform:none; }
  .item .meta { font-size:10.5px; color:var(--mute); }
  .endmark { text-align:center; font-family:Anton, sans-serif; letter-spacing:.25em; font-size:12px; color:var(--mute); padding:22px 0; border-top:3px double var(--ink); margin-top:2px; }
  @media (max-width:640px){ .doc { padding-left:26px; } .item { flex-wrap:wrap; gap:6px; } }
  </style>`;

// Home page: masthead, search ("file a request"), sequence, carriers table.
const homePageHtml = () => html(
  "Home",
  `<main>
  ${brandHeader("DIRECT DOWNLOAD MANIFEST")}
  <section class="hero">
    <h2>FILE A REQUEST.<br/>PULL THE FILE.</h2>
    <p>Hand us a title - or a TMDB id - and we return the manifest: every quality and copy across all carriers, direct links stamped and ready.</p>
    <form method="get" action="/find" class="searchbar">
      <input type="text" name="q" placeholder="Movie or show name" autofocus/>
      <input type="number" name="season" class="num" placeholder="S" min="1" aria-label="Season"/>
      <input type="number" name="episode" class="num" placeholder="E" min="1" aria-label="Episode"/>
      <button type="submit">Find Links</button>
    </form>
    <div class="quicklinks">
      <a href="/dl/movie/533535">Deadpool &amp; Wolverine - movie</a>
      <a href="/dl/tv/1396/1/1">Breaking Bad S01E01</a>
    </div>
  </section>
  <section class="section">
    <h2>How a request moves</h2>
    <div class="steps">
      <div class="step"><span class="stepnum">01</span> Search the title</div>
      <div class="step"><span class="stepnum">02</span> Pick an item</div>
      <div class="step"><span class="stepnum">03</span> Pull the file</div>
    </div>
  </section>
  <section class="section">
    <h2>Carriers on file</h2>
    <p class="lead">Every request is tendered to all carriers at once. Results are merged, best first.</p>
    <div class="manifest">
      <div class="mrow"><span class="mname">ELITE</span><span class="mdesc">Quality packs 480p to 2160p, x264/x265, resolved file-host links</span></div>
      <div class="mrow"><span class="mname">NAIJA PLUS</span><span class="mdesc">Naija movies and series, direct links auto-resolved</span></div>
      <div class="mrow"><span class="mname">PRIME</span><span class="mdesc">Rich per-file metadata: 4K, H.265, Atmos, TrueHD</span></div>
      <div class="mrow"><span class="mname">NAIJA</span><span class="mdesc">Naija movies via meetdownload, direct file links</span></div>
      <div class="mrow"><span class="mname">INDIAN</span><span class="mdesc">Torrent magnets and streaming mirrors, big Indian library</span></div>
      <div class="mrow"><span class="mname">INDEX</span><span class="mdesc">Raw file indexer, direct .mkv/.mp4 rows with size and quality</span></div>
      <div class="mrow"><span class="mname">SWIFT</span><span class="mdesc">Multi-mirror host chains, fast direct links</span></div>
      <div class="mrow"><span class="mname">NEXUS</span><span class="mdesc">WordPress mirrors, quality-tagged file links</span></div>
    </div>
  </section>
  <div class="disclaimer">BIGREEL Downloader is an indexer: it aggregates links to content hosted by third parties. It does not host or store any media files. Only download content you have the rights to.</div>
  </main>`
);

// Results page: the manifest listing, rendered client-side.
const pageHtml = ({ title, apiUrl, data: initialData, error: initialError, matchTitle }) => html(
  title,
  resultsStyle +
  `<main>
  ${brandHeader("MANIFEST")}
  <div class="doc">
    <div class="titlebar"><h2>${esc(matchTitle || title)}</h2></div>
    <div id="app" class="loading">Printing manifest…</div>
  </div>
  <div class="disclaimer">BIGREEL Downloader is an indexer: it aggregates links to content hosted by third parties. It does not host or store any media files.</div>
  <script>
    const INITIAL = ${JSON.stringify(initialData || null)};
    const INITIAL_ERROR = ${JSON.stringify(initialError || null)};
    (async () => {
      const app = document.getElementById("app");
      try {
        let data = INITIAL;
        if (!data) {
          const res = await fetch(${JSON.stringify(apiUrl)});
          if (!res.ok) throw new Error("HTTP " + res.status);
          data = await res.json();
        }
        if (INITIAL_ERROR || data.error) {
          app.className = "err";
          app.textContent = INITIAL_ERROR || data.error;
          return;
        }
        let servers = data.servers || null;
        if (!servers && data.providers) {
          servers = data.providers.map(function (p) {
            return { server: { name: p.name || p.provider }, provider: p.provider, sources: p.sources || [], error: p.error || null, source: p.source || "self" };
          });
        }
        const withSources = (servers || []).filter(s => s.sources.length || s.error);
        if (!withSources.length) { app.className = "empty"; app.textContent = "No items on this manifest. Try the original-language title."; return; }
        app.className = "";
        // Green-bar listing: carrier sections, mono rows, stamps.
        app.innerHTML = withSources.map(s => \`
          <h3 class="carrierhead">\${escapeHtml(s.server.name || s.provider)}<span class="cnt">\${s.sources.length || 0} ITEMS\${s.error ? " · CARRIER DID NOT RESPOND" : ""}</span></h3>
          \${s.error && !s.sources.length ? \`<div class="empty">\${escapeHtml(s.error)}</div>\` : ""}
          \${s.sources.map(x => \`
            <div class="item">
              <span class="stamp \${x.locked ? "hold" : "direct"}">\${x.locked ? "HOLD" : "DIRECT"}</span>
              <span class="grow">
                <span class="fname">\${escapeHtml(x.label || x.quality || x.url)}</span>
                <span class="meta">\${escapeHtml(x.quality || "")}\${x.note ? " · " + escapeHtml(x.note) : ""}</span>
              </span>
              <span class="fsize">\${escapeHtml(x.size || "")}</span>
              <a class="btn\${x.locked ? " hold" : ""}" href="\${escapeAttr(x.url)}" target="_blank" rel="noopener noreferrer">\${x.locked ? "Open at host" : "Download"}</a>
            </div>\`).join("")}
          \`).join("") + \`<div class="endmark">END OF MANIFEST</div>\`;
      } catch (e) {
        app.className = "err";
        app.textContent = "Failed to load manifest: " + e.message;
      }
    })();
    function escapeHtml(s) { return String(s).replace(/[&<>"']/g, function (c) { return ({ 38:"&amp;", 60:"&lt;", 62:"&gt;", 34:"&quot;", 39:"&#39;" })[c.charCodeAt(0)] || c; }); }
    function escapeAttr(s) { return escapeHtml(s); }
  </script>
  </main>`
);

const searchPageHtml = () => html(
  "Search",
  `<main>
  ${brandHeader("FILE A REQUEST")}
  <section class="hero">
    <h2>What do you want to pull?</h2>
    <p>Name the title and we return the manifest - every quality and copy across all carriers, best first.</p>
    <form method="get" action="/find" class="searchbar">
      <input type="text" name="q" placeholder="Movie or show name" autofocus/>
      <input type="number" name="season" class="num" placeholder="S" min="1" aria-label="Season"/>
      <input type="number" name="episode" class="num" placeholder="E" min="1" aria-label="Episode"/>
      <button type="submit">Find Links</button>
    </form>
    <div class="quicklinks">
      <a href="/dl/movie/533535">Deadpool &amp; Wolverine - movie</a>
      <a href="/dl/tv/1396/1/1">Breaking Bad S01E01</a>
    </div>
  </section>
  <p style="color:var(--mute);font-size:12px;text-align:center;margin-top:30px;font-family:'IBM Plex Mono',monospace">TV shows need season and episode numbers.</p>
  </main>`
);

// Normalize {providers} -> {servers} for the shared results template.
// Note: the scrapers' internal `post` URL (the source-site page) is deliberately
// dropped - we never expose where each server's links come from.
function providersToServers(providers) {
  return (providers || []).map((p) => ({
    server: { name: p.name || p.provider },
    provider: p.provider,
    sources: p.sources || [],
    error: p.error || null,
    source: p.source || "self",
  }));
}

// --- routing ------------------------------------------------------------------

// Exported so both the standalone server below and the Vercel serverless
// function (api/index.mjs) share one request handler.
export async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const path = url.pathname;
  const m = path.match(/^\/(?:api\/)?dl\/(movie|tv)\/([^/]+)(?:\/(\d+)\/(\d+))?$/);
  const isApi = path.startsWith("/api/");

  try {
    if (path === "/" || path === "/index.html") {
      return res.end(homePageHtml());
    }

    if (path === "/healthz") return json(res, 200, { ok: true, brand: "BIGREEL Downloader" });

    if (path === "/api/servers") {
      const { type, tmdbId, season, episode } = parseMedia(url.searchParams, {});
      const body = cached(`servers:${type}:${tmdbId}:${season}:${episode}`, CACHE_TTL_MS, () =>
        getServers({ tmdbId, type, season, episode }));
      return json(res, 200, await body);
    }

    if (path === "/api/sources") {
      const provider = url.searchParams.get("provider");
      if (!provider) throw new httpError(400, "Missing provider query param");
      const { type, tmdbId, season, episode } = parseMedia(url.searchParams, {});
      const body = cached(`sources:${provider}:${type}:${tmdbId}:${season}:${episode}`, CACHE_TTL_MS, () =>
        getSources({ tmdbId, type, season, episode }, provider));
      return json(res, 200, await body);
    }

    // --- search / find (TMDB-backed, needs TMDB_API_KEY) ---
    if (path === "/api/search") {
      const q = url.searchParams.get("q");
      if (!q) throw new httpError(400, "Missing q query param");
      const body = cached(`search:${q}`, CACHE_TTL_MS, () => tmdbSearch(q));
      return json(res, 200, await body);
    }

    if (path === "/api/find") {
      const q = url.searchParams.get("q");
      if (!q) throw new httpError(400, "Missing q query param");
      const season = url.searchParams.get("season");
      const episode = url.searchParams.get("episode");
      const year = url.searchParams.get("year");
      const minQuality = url.searchParams.get("min_quality") || undefined;
      // NXSHA_ENABLED=0 disables the nxsha proxy globally; ?nxsha=0 does it per request.
      const includeNxsha = url.searchParams.get("nxsha") !== "0" && process.env.NXSHA_ENABLED !== "0";
      const body = cached(`find:${q}:${season || ""}:${episode || ""}:${year || ""}:${minQuality || ""}:${includeNxsha}`, FIND_CACHE_TTL_MS, () =>
        findAndScrapeMerged({ q, season, episode, year, minQuality, includeNxsha }));
      return json(res, 200, await body);
    }

    if (path === "/find") {
      const q = url.searchParams.get("q") || "";
      if (!q) {
        return res.end(searchPageHtml());
      }
      const season = url.searchParams.get("season");
      const episode = url.searchParams.get("episode");
      const minQuality = url.searchParams.get("min_quality") || "";
      // Client-side: page responds instantly, JS fetches the (cached) /api/find.
      const apiUrl = `/api/find?q=${encodeURIComponent(q)}${season ? `&season=${season}` : ""}${episode ? `&episode=${episode}` : ""}${minQuality ? `&min_quality=${encodeURIComponent(minQuality)}` : ""}`;
      return res.end(pageHtml({
        title: `Search: ${q}${season ? ` · S${season}E${episode}` : ""}${minQuality ? ` · ${minQuality}+` : ""}`,
        apiUrl,
      }));
    }

    // --- self-hosted scrapers (no nxsha) ---
    const sm = path.match(/^\/(?:api\/)?scrape\/(movie|tv)\/([^/]+)(?:\/(\d+)\/(\d+))?$/);
    if (sm) {
      const media = parseMedia(url.searchParams, { type: sm[1], tmdbId: sm[2], season: sm[3], episode: sm[4] });
      const title = url.searchParams.get("title");
      const year = url.searchParams.get("year");
      const minQuality = url.searchParams.get("min_quality") || undefined;
      const urlQuery = [];
      if (title) urlQuery.push(`title=${encodeURIComponent(title)}`);
      if (year) urlQuery.push(`year=${encodeURIComponent(year)}`);
      if (minQuality) urlQuery.push(`min_quality=${encodeURIComponent(minQuality)}`);
      const apiPath = `/api/scrape/${media.type}/${media.tmdbId}${media.type === "tv" ? `/${media.season}/${media.episode}` : ""}${urlQuery.length ? `?${urlQuery.join("&")}` : ""}`;
      if (isApi) {
        const cacheKey = `scrape:${media.type}:${media.tmdbId}:${media.season}:${media.episode}:${title || ""}:${year || ""}:${minQuality || ""}`;
        const loader = () => media.type === "tv"
          ? scrapeEpisode({ tmdbId: media.tmdbId, type: "tv", season: media.season, episode: media.episode, title, year, minQuality })
          : scrapeMovie({ tmdbId: media.tmdbId, type: "movie", title, year, minQuality });
        const result = await cached(cacheKey, CACHE_TTL_MS, loader);
        return json(res, 200, result);
      }
      // HTML: respond instantly with the same loading flow as /find - the
      // client fetches /api/scrape/* and renders once sources arrive.
      const meta = await resolveMetadata({ tmdbId: media.tmdbId, type: media.type, title, year });
      const baseTitle = meta?.title || title || `${media.type === "tv" ? `${media.tmdbId} S${media.season}E${media.episode}` : media.tmdbId}`;
      return res.end(pageHtml({
        title: `${baseTitle}${minQuality ? ` · ${minQuality}+` : ""}`,
        apiUrl: apiPath,
        matchTitle: baseTitle,
      }));
    }

    // --- canonical nxsha-style endpoints: tmdbId -> merged links ---
    if (m) {
      const media = parseMedia(url.searchParams, { type: m[1], tmdbId: m[2], season: m[3], episode: m[4] });
      const title = url.searchParams.get("title");
      const year = url.searchParams.get("year");
      const minQuality = url.searchParams.get("min_quality") || undefined;
      const includeNxsha = url.searchParams.get("nxsha") !== "0" && process.env.NXSHA_ENABLED !== "0";
      const urlQuery = [];
      if (title) urlQuery.push(`title=${encodeURIComponent(title)}`);
      if (year) urlQuery.push(`year=${encodeURIComponent(year)}`);
      if (minQuality) urlQuery.push(`min_quality=${encodeURIComponent(minQuality)}`);
      const apiPath = `/api/dl/${media.type}/${media.tmdbId}${media.type === "tv" ? `/${media.season}/${media.episode}` : ""}${urlQuery.length ? `?${urlQuery.join("&")}` : ""}`;
      if (isApi) {
        const cacheKey = `dl:${media.type}:${media.tmdbId}:${media.season}:${media.episode}:${title || ""}:${year || ""}:${minQuality || ""}:${includeNxsha}`;
        const loader = () => scrapeMergedById({ ...media, title, year, minQuality, includeNxsha });
        const result = await cached(cacheKey, FIND_CACHE_TTL_MS, loader);
        return json(res, 200, result);
      }
      // HTML: respond instantly with the same loading flow as /find - the
      // client fetches /api/dl/* and renders once sources arrive.
      const meta = await resolveMetadata({ tmdbId: media.tmdbId, type: media.type, season: media.season, title, year });
      const baseTitle = meta?.title
        ? `${meta.title}${meta.year ? ` (${meta.year})` : ""}`
        : (title || `${media.type === "tv" ? `${media.tmdbId} · S${media.season}E${media.episode}` : media.tmdbId}`);
      const pageTitle = media.type === "tv" ? `${baseTitle} · S${media.season}E${media.episode}` : baseTitle;
      return res.end(pageHtml({
        title: pageTitle,
        apiUrl: apiPath,
        matchTitle: baseTitle,
      }));
    }

    throw new httpError(404, "Not found");
  } catch (err) {
    const status = err.status || 500;
    if (isApi || path.startsWith("/api/")) {
      return json(res, status, { error: err.message || "Internal error" });
    }
    const body = html(
      "Error",
      `<main><div class="err">${status} - ${String(err.message || "Internal error").replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]))}</div></main>`
    );
    res.writeHead(status, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
    });
    return res.end(body);
  }
}

// Only start the long-running server when executed directly (node server.mjs);
// on Vercel this module is imported by api/index.mjs, which must not listen.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const server = http.createServer(handleRequest);
  server.listen(PORT, HOST, () => {
    console.log(`${BRAND} listening on http://${HOST}:${PORT}`);
    console.log(`  movie:  http://${HOST}:${PORT}/dl/movie/{tmdb_id}`);
    console.log(`  tv:     http://${HOST}:${PORT}/dl/tv/{tmdb_id}/{season}/{episode}`);
    console.log(`  json:   http://${HOST}:${PORT}/api/dl/movie/{tmdb_id}`);
  });
}

export default handleRequest;
