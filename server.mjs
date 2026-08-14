// server.mjs — direct-download server that aggregates links from nxsha.app.
//
// Routes (mirror nxsha's own URL scheme, plus a plain JSON API):
//   GET /dl/movie/:tmdbId                  HTML page with download links
//   GET /dl/tv/:tmdbId/:season/:episode    HTML page with download links
//   GET /api/dl/movie/:tmdbId              JSON: links from all providers
//   GET /api/dl/tv/:tmdbId/:season/:episode  JSON: links from all providers
//   GET /api/servers?type=&tmdbId=&season=&episode=   JSON proxy (decrypted)
//   GET /api/sources?provider=&type=&tmdbId=&season=&episode=  JSON proxy
//   GET /healthz
//
// Zero dependencies: node:http + the built-in fetch (Node 18+).

import http from "node:http";
import { getServers, getSources, getDirectLinks } from "./nxsha.mjs";

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";

// --- tiny TTL cache so repeated page loads don't hammer the upstream ----------
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 60_000);
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

const html = (title, body) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${title}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #09090b; color: #f4f4f5; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 860px; margin: 0 auto; padding: 24px 16px 80px; }
  header { display: flex; align-items: center; gap: 10px; margin: 8px 0 24px; }
  .logo { width: 10px; height: 10px; border-radius: 50%; background: #f59e0b; box-shadow: 0 0 12px rgba(245,158,11,.6); }
  h1 { font-size: 22px; margin: 0; letter-spacing: -0.02em; }
  .sub { color: #71717a; font-size: 12px; margin-top: 4px; }
  .server { border: 1px solid rgba(255,255,255,.06); border-radius: 14px; background: rgba(0,0,0,.35); margin-bottom: 12px; overflow: hidden; }
  .server summary { cursor: pointer; list-style: none; display: flex; align-items: center; gap: 10px; padding: 14px 16px; font-weight: 600; font-size: 14px; }
  .server summary::-webkit-details-marker { display: none; }
  .server summary .chev { margin-left: auto; color: #71717a; transition: transform .15s; }
  .server[open] summary .chev { transform: rotate(180deg); }
  .badge { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; padding: 2px 8px; border-radius: 999px; background: rgba(245,158,11,.12); color: #fbbf24; border: 1px solid rgba(245,158,11,.25); }
  .badge.err { background: rgba(239,68,68,.1); color: #f87171; border-color: rgba(239,68,68,.25); }
  .src { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; border-top: 1px solid rgba(255,255,255,.04); }
  .src .q { font-size: 13px; color: #e4e4e7; }
  .src .meta { font-size: 11px; color: #71717a; margin-top: 2px; }
  .btn { text-decoration: none; background: #f59e0b; color: #000; font-weight: 700; font-size: 12px; padding: 7px 14px; border-radius: 10px; white-space: nowrap; }
  .btn:hover { background: #fbbf24; }
  .empty { color: #71717a; font-size: 13px; padding: 12px 16px; border-top: 1px solid rgba(255,255,255,.04); }
  .loading, .err { display: flex; justify-content: center; align-items: center; min-height: 200px; color: #71717a; font-size: 14px; }
  .err { color: #f87171; }
  .disclaimer { margin-top: 48px; font-size: 10px; line-height: 1.7; color: #52525b; text-align: center; }
</style>
</head>
<body>
${body}
</body>
</html>`;

const pageHtml = ({ title, apiUrl }) => html(
  `Direct Download — ${title}`,
  `<main>
  <header><span class="logo"></span><div><h1>${title}</h1><div class="sub">Direct download links · aggregated</div></div></header>
  <div id="app" class="loading">Fetching sources…</div>
  <div class="disclaimer">This tool is an indexer: it aggregates links to content hosted by third parties. It does not host or store any media files.</div>
  <script>
    (async () => {
      const app = document.getElementById("app");
      try {
        const res = await fetch(${JSON.stringify(apiUrl)});
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();
        const withSources = data.servers.filter(s => s.sources.length || s.error);
        if (!withSources.length) { app.className = "empty"; app.textContent = "No download links found for this title."; return; }
        app.className = "";
        app.innerHTML = withSources.map(s => \`
          <details class="server" open>
            <summary><span class="badge">\${s.sources.length || "0"} links</span> \${escapeHtml(s.server.name || s.provider)}<span class="chev">▾</span></summary>
            \${s.error ? \`<div class="empty">\${escapeHtml(s.error)}</div>\` : ""}
            \${s.sources.map(x => \`
              <div class="src">
                <div><div class="q">\${escapeHtml(x.label || x.quality || x.url)}</div>
                <div class="meta">\${escapeHtml(x.type || "")}\${x.isEmbed ? " · embed" : ""}\${x.provider ? " · " + escapeHtml(x.provider) : ""}</div></div>
                <a class="btn" href="\${escapeAttr(x.url)}" target="_blank" rel="noopener noreferrer">Download</a>
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

// --- routing ------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const path = url.pathname;
  const m = path.match(/^\/(?:api\/)?dl\/(movie|tv)\/([^/]+)(?:\/(\d+)\/(\d+))?$/);
  const isApi = path.startsWith("/api/");

  try {
    if (path === "/" || path === "/index.html") {
      return res.end(html(
        "nxsha-dl-server",
        `<main>
          <header><span class="logo"></span><div><h1>nxsha-dl-server</h1><div class="sub">Direct download link aggregator for nxsha.app</div></div></header>
          <p style="color:#a1a1aa;font-size:14px;line-height:1.7">Try a title:</p>
          <ul style="color:#d4d4d8;font-size:14px;line-height:2">
            <li><a href="/dl/movie/969681" style="color:#fbbf24">Movie · /dl/movie/{tmdb_id}</a></li>
            <li><a href="/dl/tv/1396/1/1" style="color:#fbbf24">TV · /dl/tv/{tmdb_id}/{season}/{episode}</a></li>
          </ul>
          <p style="color:#71717a;font-size:12px;margin-top:32px">JSON API: /api/dl/movie/{tmdb_id} · /api/dl/tv/{tmdb_id}/{s}/{e}</p>
        </main>`
      ));
    }

    if (path === "/healthz") return json(res, 200, { ok: true });

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

    if (m) {
      const media = parseMedia(url.searchParams, { type: m[1], tmdbId: m[2], season: m[3], episode: m[4] });
      const cacheKey = `dl:${media.type}:${media.tmdbId}:${media.season}:${media.episode}`;
      const loader = () => getDirectLinks(media);
      if (isApi) {
        return json(res, 200, await cached(cacheKey, CACHE_TTL_MS, loader));
      }
      const title = media.type === "tv"
        ? `${media.tmdbId} · S${media.season}E${media.episode}`
        : media.tmdbId;
      return res.end(pageHtml({ title, apiUrl: `/api/dl/${media.type}/${media.tmdbId}${media.type === "tv" ? `/${media.season}/${media.episode}` : ""}` }));
    }

    throw new httpError(404, "Not found");
  } catch (err) {
    const status = err.status || 500;
    if (isApi || path.startsWith("/api/")) {
      return json(res, status, { error: err.message || "Internal error" });
    }
    const body = html(
      "Error",
      `<main><div class="err">${status} — ${String(err.message || "Internal error").replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]))}</div></main>`
    );
    res.writeHead(status, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
    });
    return res.end(body);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`nxsha-dl-server listening on http://${HOST}:${PORT}`);
  console.log(`  movie:  http://${HOST}:${PORT}/dl/movie/{tmdb_id}`);
  console.log(`  tv:     http://${HOST}:${PORT}/dl/tv/{tmdb_id}/{season}/{episode}`);
  console.log(`  json:   http://${HOST}:${PORT}/api/dl/movie/{tmdb_id}`);
});
