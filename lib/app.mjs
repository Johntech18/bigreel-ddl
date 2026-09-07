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
const ACCENT = "#2196f3";
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
  :root { color-scheme: dark; --accent:#2196f3; --accent-2:#64b5f6; --bg:#0b1020; --card:#131a2e; --border:rgba(255,255,255,.08); --text:#eef2f9; --muted:#94a3b8; }
  * { box-sizing: border-box; }
  body { margin:0; background: radial-gradient(1000px 500px at 80% -10%, rgba(33,150,243,.18), transparent 60%), var(--bg); color:var(--text); font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; min-height:100vh; }
  main { max-width: 900px; margin: 0 auto; padding: 20px 16px 80px; }
  a { color: var(--accent-2); }
  header { display:flex; align-items:center; gap:12px; margin: 10px 0 26px; }
  .logo { width:42px; height:42px; border-radius:12px; object-fit:cover; box-shadow:0 6px 20px rgba(33,150,243,.45); }
  h1 { font-size:22px; margin:0; letter-spacing:-.02em; }
  .sub { color:var(--muted); font-size:12.5px; margin-top:3px; }
  .hero { text-align:center; padding: 42px 0 26px; }
  .hero h2 { font-size:clamp(26px,5vw,40px); margin:0 0 12px; letter-spacing:-.03em; line-height:1.15; background:linear-gradient(90deg,#fff,var(--accent-2)); -webkit-background-clip:text; background-clip:text; color:transparent; }
  .hero p { color:var(--muted); font-size:15px; line-height:1.7; max-width:620px; margin:0 auto 26px; }
  .hero .accent { color:var(--accent-2); }
  .searchbar { display:flex; gap:10px; justify-content:center; flex-wrap:wrap; }
  .searchbar input { background:#0d1428; border:1px solid var(--border); border-radius:12px; padding:13px 16px; color:var(--text); font-size:15px; flex:0 1 300px; min-width:200px; outline:none; }
  .searchbar input:focus { border-color:var(--accent); box-shadow:0 0 0 3px rgba(33,150,243,.2); }
  .searchbar input.num { flex:0 0 64px; min-width:64px; text-align:center; }
  .searchbar button { background:var(--accent); border:0; color:#fff; font-weight:700; font-size:15px; padding:0 26px; border-radius:12px; cursor:pointer; transition:filter .15s; }
  .searchbar button:hover { filter:brightness(1.12); }
  .quicklinks { display:flex; gap:10px; justify-content:center; flex-wrap:wrap; margin-top:20px; }
  .quicklinks a { color:var(--muted); text-decoration:none; font-size:12.5px; border:1px solid var(--border); background:var(--card); padding:8px 14px; border-radius:999px; transition:all .15s; }
  .quicklinks a:hover { color:var(--accent-2); border-color:var(--accent); }
  .quicklinks code { color:var(--text); }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:14px; margin:30px 0 8px; }
  .card { background:var(--card); border:1px solid var(--border); border-radius:16px; padding:18px; }
  .card h3 { margin:0 0 8px; font-size:15px; }
  .card p { color:var(--muted); font-size:13px; line-height:1.6; margin:0 0 12px; }
  .card code { background:rgba(33,150,243,.12); color:var(--accent-2); padding:3px 8px; border-radius:8px; font-size:12px; }
  .section { margin-top:38px; }
  .section h2 { font-size:17px; margin:0 0 4px; }
  .section .lead { color:var(--muted); font-size:13px; margin:0 0 16px; }
  .server { border:1px solid var(--border); border-radius:14px; background:var(--card); margin-bottom:12px; overflow:hidden; }
  .server summary { cursor:pointer; list-style:none; display:flex; align-items:center; gap:10px; padding:14px 16px; font-weight:600; font-size:14px; }
  .server summary::-webkit-details-marker { display:none; }
  .server summary .chev { margin-left:auto; color:var(--muted); transition:transform .15s; }
  .server[open] summary .chev { transform:rotate(180deg); }
  .badge { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.08em; padding:2px 8px; border-radius:999px; background:rgba(33,150,243,.14); color:var(--accent-2); border:1px solid rgba(33,150,243,.35); }
  .badge.top { background:rgba(245,158,11,.14); color:#fbbf24; border-color:rgba(245,158,11,.4); }
  .badge.err { background:rgba(239,68,68,.12); color:#f87171; border-color:rgba(239,68,68,.3); }
  .badge.srctx { background:rgba(148,163,184,.12); color:#a5b4c4; border-color:rgba(148,163,184,.3); }
  .badge.srcself { background:rgba(34,197,94,.12); color:#4ade80; border-color:rgba(34,197,94,.3); }
  .src { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:12px 16px; border-top:1px solid rgba(255,255,255,.05); }
  .src .q { font-size:13px; color:var(--text); }
  .src .meta { font-size:11px; color:var(--muted); margin-top:3px; }
  .btn { text-decoration:none; background:var(--accent); color:#fff; font-weight:700; font-size:12px; padding:8px 16px; border-radius:10px; white-space:nowrap; transition:filter .15s; }
  .btn:hover { filter:brightness(1.12); }
  .btn.locked { background:#475569; }
  .empty { color:var(--muted); font-size:13px; padding:12px 16px; border-top:1px solid rgba(255,255,255,.05); }
  .loading, .err { display:flex; justify-content:center; align-items:center; min-height:200px; color:var(--muted); font-size:14px; }
  .err { color:#f87171; }
  .disclaimer { margin-top:48px; font-size:10.5px; line-height:1.7; color:#5b6a83; text-align:center; }
</style>
</head>
<body>
${body}
</body>
</html>`;

const brandHeader = (sub) => `
  <header><img class="logo" src="${LOGO_URL}" alt="BIGREEL"/><div><h1>${BRAND}</h1><div class="sub">${sub}</div></div></header>`;

// Home page: hero, search, endpoint cards, server list.
const homePageHtml = () => html(
  "Home",
  `<main>
  ${brandHeader("Direct download links for movies &amp; TV · by TMDB id")}
  <section class="hero">
    <h2>Every server.<br/>One link to download.</h2>
    <p>Paste a TMDB id - or search by name - and <span class="accent">BIGREEL Downloader</span> gathers direct download links from all of our servers at once, best first.</p>
    <form method="get" action="/find" class="searchbar">
      <input type="text" name="q" placeholder="Movie or show name…" autofocus/>
      <input type="number" name="season" class="num" placeholder="S" min="1"/>
      <input type="number" name="episode" class="num" placeholder="E" min="1"/>
      <button type="submit">Find Links</button>
    </form>
    <div class="quicklinks">
      <a href="/dl/movie/533535"><code>/dl/movie/{tmdb_id}</code> · Deadpool &amp; Wolverine</a>
      <a href="/dl/tv/1396/1/1"><code>/dl/tv/{tmdb_id}/{s}/{e}</code> · Breaking Bad S01E01</a>
      <a href="/find">Search by name →</a>
    </div>
  </section>
  <div class="grid">
    <div class="card"><h3>🎬 Movies</h3><p>One TMDB id brings back every quality &amp; mirror from every server.</p><code>/dl/movie/{tmdb_id}</code></div>
    <div class="card"><h3>📺 TV Shows</h3><p>Season + episode aware - links for exactly the episode you want.</p><code>/dl/tv/{tmdb_id}/{s}/{e}</code></div>
    <div class="card"><h3>⚡ JSON API</h3><p>Same data as JSON for your stream site to fetch links directly.</p><code>/api/dl/movie/{tmdb_id}</code></div>
  </div>
  <section class="section">
    <h2>Servers</h2>
    <p class="lead">Results are merged from all servers, ranked - the best leads.</p>
    <details class="server" open>
      <summary><span class="badge top">Best</span> Elite Server<span class="chev">▾</span></summary>
      <div class="empty">Top-ranked library · quality packs 480p → 2160p × x264/x265 · resolved file-host links</div>
    </details>
    <details class="server" open>
      <summary><span class="badge">Prime</span> Prime Server<span class="chev">▾</span></summary>
      <div class="empty">Rich metadata: 4K / H.265 / Atmos / TrueHD, per-file details</div>
    </details>
    <details class="server" open>
      <summary><span class="badge">Index</span> Index Server<span class="chev">▾</span></summary>
      <div class="empty">Raw file indexer · direct .mkv/.mp4 rows with size &amp; quality</div>
    </details>
    <details class="server" open>
      <summary><span class="badge">Swift</span> Swift Server<span class="chev">▾</span></summary>
      <div class="empty">Multi-mirror host chains · fast direct links</div>
    </details>
    <details class="server" open>
      <summary><span class="badge">Nexus</span> Nexus Server<span class="chev">▾</span></summary>
      <div class="empty">WordPress mirrors · quality-tagged file links</div>
    </details>
  </section>
  <div class="disclaimer">BIGREEL Downloader is an indexer: it aggregates links to content hosted by third parties. It does not host or store any media files. Only download content you have the rights to.</div>
  </main>`
);

// Results page: server accordions + source rows, rendered client-side.
const pageHtml = ({ title, apiUrl, data: initialData, error: initialError, matchTitle }) => html(
  title,
  `<main>
  ${brandHeader("Direct download links")}
  ${matchTitle ? `<h2 style="font-size:20px;margin:0 0 18px;letter-spacing:-.01em">${esc(matchTitle)}</h2>` : ""}
  <div id="app" class="loading">Fetching links from all servers…</style></div>
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
        if (!withSources.length) { app.className = "empty"; app.textContent = "No download links found for this title."; return; }
        app.className = "";
        app.innerHTML = withSources.map(s => \`
          <details class="server" open>
            <summary><span class="badge\${s.provider === "pahe" ? " top" : ""}">\${s.sources.length || "0"} links</span> \${s.source ? \`<span class="badge \${s.source === "nxsha" ? "srctx" : "srcself"}">\${s.source}</span>\` : ""} \${escapeHtml(s.server.name || s.provider)}<span class="chev">▾</span></summary>
            \${s.error ? \`<div class="empty">\${escapeHtml(s.error)}</div>\` : ""}
            \${s.sources.map(x => \`
              <div class="src">
                <div><div class="q">\${escapeHtml(x.label || x.quality || x.url)}</div>
                <div class="meta">\${escapeHtml(x.type || "")}\${x.isEmbed ? " · embed" : ""}\${x.locked ? " · 🔒 locked" : ""}\${x.size ? " · " + escapeHtml(x.size) : ""}\${x.note ? " · " + escapeHtml(x.note) : ""}</div></div>
                <a class="btn\${x.locked ? " locked" : ""}" href="\${escapeAttr(x.url)}" target="_blank" rel="noopener noreferrer">\${x.locked ? "View" : "Download"}</a>
              </div>\`).join("")}
          </details>\`).join("");
      } catch (e) {
        app.className = "err";
        app.textContent = "Failed to load sources: " + e.message;
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
  ${brandHeader("Find a title on TMDB, then gather links")}
  <section class="hero">
    <h2>What do you want to download?</h2>
    <p>We resolve the name to a TMDB id, then fetch links from every server at once.</p>
    <form method="get" action="/find" class="searchbar">
      <input type="text" name="q" placeholder="Movie or show name…" autofocus/>
      <input type="number" name="season" class="num" placeholder="S" min="1"/>
      <input type="number" name="episode" class="num" placeholder="E" min="1"/>
      <button type="submit">Find Links</button>
    </form>
    <div class="quicklinks">
      <a href="/dl/movie/533535"><code>/dl/movie/533535</code></a>
      <a href="/dl/tv/1396/1/1"><code>/dl/tv/1396/1/1</code></a>
    </div>
  </section>
  <p style="color:var(--muted);font-size:12px;text-align:center;margin-top:30px">TV shows need season/episode numbers. Requires <code>TMDB_API_KEY</code>.</p>
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
