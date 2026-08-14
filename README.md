# nxsha-dl-server

A zero-dependency Node.js server that aggregates **direct download links** for movies and TV shows using TMDB ids, sourced from [nxsha.app](https://web.nxsha.app).

It mirrors nxsha's own URL scheme:

- Movie: `GET /dl/movie/{tmdb_id}`
- TV:    `GET /dl/tv/{tmdb_id}/{season_number}/{episode_number}`

## Quick start

```bash
node server.mjs          # Node 18+ required, no npm install needed
```

Then open:

- `http://localhost:3000/dl/movie/969681` — Spider-Man: Brand New Day
- `http://localhost:3000/dl/tv/1396/1/1` — Breaking Bad S01E01

## Endpoints

| Route | Description |
|---|---|
| `GET /dl/movie/:tmdbId` | HTML page listing download links from every provider |
| `GET /dl/tv/:tmdbId/:season/:episode` | HTML page for an episode |
| `GET /api/dl/movie/:tmdbId` | Same data as JSON (`servers[].sources[]`) |
| `GET /api/dl/tv/:tmdbId/:season/:episode` | Same data as JSON |
| `GET /api/servers?type=movie&tmdbId=…` | Raw, decrypted response from nxsha's `/api/servers` |
| `GET /api/sources?provider=mbox&type=movie&tmdbId=…` | Raw, decrypted response from nxsha's `/api/sources` |
| `GET /scrape/movie/:tmdbId?title=&year=` | **Self-hosted** HTML page (no nxsha) |
| `GET /scrape/tv/:tmdbId/:s/:e?title=&year=` | **Self-hosted** HTML page for an episode |
| `GET /api/scrape/movie/:tmdbId?title=&year=` | **Self-hosted** JSON (`providers[].sources[]`) |
| `GET /api/scrape/tv/:tmdbId/:s/:e?title=&year=` | **Self-hosted** JSON |
| `GET /api/search?q=…` | TMDB search by name → candidates (`tmdbId`, type, title, year) |
| `GET /api/find?q=…&season=&episode=` | **Title → scrape** in one call: best TMDB match, then all providers |
| `GET /find` | HTML search box (results page at `/find?q=…`) |
| `GET /healthz` | Health check |

> The `/scrape*` and `/find` routes resolve links **directly from the source sites** with our
> own scraper modules — they never call nxsha. Pass `title`/`year` as query params, or set
> `TMDB_API_KEY` (free, themoviedb.org) and use just the tmdbId — or no id at all:

```bash
# no TMDB id needed, just the name
curl 'http://localhost:3000/api/find?q=spider-man'            # best movie match, scraped
curl 'http://localhost:3000/api/find?q=breaking+bad&season=1&episode=1'  # TV episode
curl 'http://localhost:3000/api/search?q=spider-man'          # raw candidates first
```

`/api/find` picks the best match by normalized-title score (exact match, year nudge,
and a TV preference when `season`/`episode` are supplied). If the best match is a TV
show and no `season`/`episode` was given, it tells you so instead of scraping nothing.

**`/api/find` merges both backends** — the self-hosted scrapers *and* nxsha's proxy
providers — into one `providers[]` list. Each entry carries a `source` field
(`"self"` or `"nxsha"`) and a display `name`, so same-named scrapers stay distinct
(e.g. self `hdhub4u` vs nxsha's `4k-bk`). Use `&nxsha=0` for self-only results.

## Self-hosted scrapers (`scrapers/`)

Instead of proxying nxsha, the `scrapers/` modules scrape the same source sites nxsha's
backend wraps. Architecture:

```
scrapers/
  base.mjs        # HTTP helpers (UA, cookie jar, redirect chains), HTML utils
  filmyfly.mjs    # DataLife Engine sites (filmsay.com): search -> post -> go.php -> server.php
  hdhub4u.mjs     # WordPress mirrors (filmmilf.xyz): ?s= search -> post -> file-host links
  a111477.mjs     # static "Index of /" file indexer (a.111477.xyz): listing -> file rows
  fzmovies.mjs    # FzMovies (fzmovies.xyz/.live/.host): session-bound search -> downloadkey chain
  index.mjs       # registry + unified scrapeMovie/scrapeEpisode API
```

Each module exposes `scrapeMovie({title, year})` and `scrapeEpisode({title, season, episode})`
and returns `{ provider, sources, errors }`. `sources[]` items look like:

```json
{
  "provider": "filmyfly",
  "url": "https://…",
  "label": "… 1080p ESub.mkv",
  "size": "2.97 GB",
  "host": "Direct Download (10Gbps)",
  "isEmbed": false,
  "locked": false
}
```

`locked: true` means the file host blocked automated resolution (e.g. login-walled
hosts like GDFLIX); the locker URL is returned so it still works in a browser.

### How the filmyfly chain works (verified)

1. Search: `GET /index.php?do=search&subaction=search&story=<query>` (DataLife Engine)
2. Post page contains one `/go.php?url=<…>` link per quality — the payload is
   Laravel AES-256-GCM encrypted, but **we never decrypt it**; the site resolves it.
3. `go.php` renders "File Information" + "Choose a Download Server" with
   `/server.php?id=<n>` links per host.
4. `server.php?id=n` 302-redirects straight to the real file URL.
   (Verified with `video-downloads.googleusercontent.com`, `hubcloud.cx`, `mediafire.com`.)

The site rate-limits `/server.php` per IP, so the scraper paces requests (400 ms),
caches resolved links for 12 h, and caps work per scrape. Some hosts are
login-walled (403) — those are reported as errors, not failures of the whole scrape.

### How the hdhub4u chain works (verified)

1. Search: `GET /?s=<query>` (WordPress — sanitize punctuation, it breaks search)
2. Post (`/?p=<id>`) links to file hosts, e.g. `new1.filesdl.in/cloud/<shortid>`
3. `filesdl.in` 302-redirects to `filesdl.top`, which sits behind **Cloudflare's
   managed JS challenge** (`cf-ray`, "Just a moment...", `challenges.cloudflare.com`).
   We verified that full browser headers **and** TLS impersonation (curl_cffi) both
   fail — it's not a session/referer/token flow, it's a challenge that needs real
   JS execution. `scrapers/filesdl.mjs` handles this:
   - plain cookie-jar fetch first (works if the site relaxes), then
   - if `FLARESOLVERR_URL` is set, it asks flaresolverr for the solved page and
     extracts the direct file URL;
   - otherwise the link is flagged `locked: true` with a diagnostic note.

**Unlocking filesdl links (optional, needs Docker):**

```bash
docker run -p 8191:8191 ghcr.io/flaresolverr/flaresolverr:latest
FLARESOLVERR_URL=http://127.0.0.1:8191 node server.mjs
```

The flaresolverr path is covered by a hermetic mock test in `test.mjs`; the
real unlock depends on the challenge's difficulty (managed challenges with an
interactive captcha may still defeat it).

### Adding a provider (e.g. OrVid)

Provider names on nxsha rotate; at research time the API listed `mbox`, `hdhub4u`,
`k4khdhub`, `filmyfly` — **OrVid** didn't appear and no public reference to it was
found, so there's no module yet. Adding one is a single file + one registry line:

```js
// scrapers/orvid.mjs
export const orvid = makeSomething({ domains: ["…"], name: "orvid" });
// scrapers/index.mjs
import { orvid } from "./orvid.mjs";
export const registry = { filmyfly, hdhub4u, orvid };
```

### The fzmovies provider (real direct CDN links)

`fzmovies.xyz` / `fzmovies.live` / `fzmovies.host` are mirror domains of FzMovies, a
movie download site. Unlike the file-host lockers above, **its final links are
direct CDN file URLs** (`.y9a8ua48mhss5ye.cyou` mirrors serving real `.mp4`/`.mkv`
bytes — verified with a range request: HTTP 206, actual file data). The full
session-bound chain (verified live, and cross-checked against the
`21toffy/Fzmovies_scraper_script` GitHub repo which documents the older
`fzmovies.net` flow):

1. `GET /index.php` — establishes the `PHPSESSID` session cookie.
2. `POST /csearch.php` (`searchname=<query>`) — result rows in `class='mainbox'`
   divs, each linking to `movie-<Title>--hmp4.htm` with title/year/quality.
3. `GET /movie-<Title>--hmp4.htm` — one `download1.php?downloadoptionskey=<key>`
   link per quality (480p/720p/…), each carrying a `&pt=` token in its `onclick`.
4. **`POST` `download1.php?...&pt=<pt>`** — mints a fresh
   `download.php?downloadkey=<key2>` link. (GET fails here — the POST is required.)
5. `GET /download.php?downloadkey=<key2>` **with the session cookie + referer** —
   the site answers "Your download keys have expired" without the cookie; with it,
   you get 3 mirror `<input name='download1' value='https://…cyou/res/…'>` URLs.

Links are active ~12 h. Two details that bit us during research: `fetchChain`
absorbs cookies but doesn't *send* the jar, so the final GET must pass
`Cookie:` explicitly; and mirrors serve the movie page with Cloudflare-mangled
attributes (`&quot;` entities), so the `pt` token must be scraped from the whole
anchor tag, not just the `href`.

**TV shows** live on the sibling FzTVseries site (`mobiletvshows.site` /
`fztvseries.live` — the same template, `fzmovies.live`'s footer links to it).
Same session-bound pattern with its own chain:

1. `GET /subfolder-<Show>.htm` — the show page URL is predictable, so we skip
   `search.php` entirely (it returns a fixed popular-shows carousel for any
   query).
2. Show page → `files-<Show>--<id>.htm` season links (`Season 1`…`Season 5`).
3. Season page → episode rows `S01E01 - Title` with `episode.php?fileid=<id>
   &ftype=2` (High MP4) / `&ftype=3` (WEBM) links.
4. `episode.php` → `downloadmp4.php?fileid=<id>&dkey=<hash>` links.
5. `downloadmp4.php` **with the session cookie + referer** (otherwise "Download
   key not present or session expired") → `filelink.php?sn=<mirror>&id=
   /rlink_t/…` mirror links.
6. `filelink.php` JS-redirects to the direct `.cyou` URL.

Verified: Breaking Bad S01E01 → 6 direct mirror URLs (2 mirrors × High MP4 +
WEBM). Note the site's banners may claim "downloads are not working" — the
*chains* still resolve; individual mirrors rotate (the page says "if the first
link doesn't work, try the one below"), so we return every mirror per quality.

### The a.111477.xyz provider (an actual indexer)

`a.111477.xyz` is a plain "Index of /" file listing — the easiest kind of site to
scrape: no search API, no JS, no login. `/movies/` and `/tvs/` list directories
named `Title (Year)`, movie dirs contain direct `.mkv`/`.mp4` rows with quality
and size in the name (`Spider-Man.No.Way.Home.2021.2160p.UHD…mkv · 26.9 GB`),
and TV shows nest `Season N/` dirs with `S01E01` episode files. The scraper:

1. fetches the (cached, 1 h TTL) category listing — pages are huge (~10 MB),
2. matches the `Title (Year)` directory by normalized title,
3. parses the file rows into sources with `quality`/`size`/`label`,
4. probes one file link: the listing HTML is open, but the **file paths are
   Cloudflare-gated for bots** (403 + cf-ray even with browser TLS/cookies), so
   links are flagged `locked: true` with a note — they work in a real browser
   (and would work with a `FLARESOLVERR_URL`).

### What makes a site scrapable

Any site that (1) has a **discovery** mechanism (WordPress `?s=`, DLE
`?do=search`, RSS, sitemap, category pages), (2) exposes **resolvable links**
(direct files or a redirect chain we can follow — filmyfly's `go.php →
server.php` pattern is shared by most DLE movie mirrors), and (3) is **not behind
Cloudflare-style JS challenges / captchas / login walls**. If it matches, point a
provider at it without code changes:

```bash
FILMYFLY_DOMAINS="filmsay.com,new-mirror.com" node server.mjs
```

Each configured mirror is tried in order, so a dead one is skipped automatically
(verified: `dead-mirror.invalid,filmsay.com` still resolves via `filmsay.com`).

Each source object looks like:

```json
{
  "id": "hdhub4u-0",
  "provider": "hdhub4u",
  "url": "https://…",            // direct download / stream URL
  "headers": {},
  "quality": "1080p 3.4 GB | Multi | HDTC | x264",
  "label": "1080p 3.4 GB | Multi | HDTC | x264",
  "isEmbed": false,
  "type": "mp4"
}
```

## Deploy to Vercel

The repo is Vercel-ready: `api/index.mjs` re-exports the exact same request
handler as the standalone server, and `vercel.json` rewrites every route
(`/dl/*`, `/find`, `/api/*`, …) to that single serverless function. The
in-memory cache and session jars work per instance, so nothing needs external
state.

1. Push this folder to a Git repo (or use `vercel --cwd .` from the folder).
2. Log in: `vercel login`
3. Set env vars in the Vercel dashboard (Settings → Environment Variables)
   — at minimum `TMDB_API_KEY` (free, themoviedb.org). Optional: `FLARESOLVERR_URL`,
   `FZMOVIES_DOMAINS`, `FZMOVIES_TV_DOMAINS`, `FILMYFLY_DOMAINS`, `HDHUB4U_DOMAINS`,
   `A111477_DOMAINS`.
4. `vercel --prod`

Scrapes hit live source sites and can take 10–30 s, so `maxDuration` is set to
60 s in `vercel.json` (the Hobby-plan ceiling — bump it to 300 on Pro).

> Note: the standalone server stays fully supported — `node server.mjs` — the
> handler is shared, so the deployed behavior matches local.

## Configuration (env vars)

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Listen port |
| `HOST` | `127.0.0.1` | Listen address |
| `NXSHA_BASE_URL` | `https://web.nxsha.app` | Upstream base |
| `CACHE_TTL_MS` | `60000` | In-memory cache TTL for aggregator responses |
| `FIND_CACHE_TTL_MS` | `300000` | Cache TTL for `/api/find` (it scrapes every provider, so it caches longer) |
| `TMDB_API_KEY` | — | Free key from themoviedb.org; enables `/api/search`, `/api/find`, and tmdbId → title resolution |
| `FLARESOLVERR_URL` | — | Optional; URL of a running flaresolverr, used to unlock Cloudflare-challenged file hosts (filesdl) |
| `FILMYFLY_DOMAINS` | `filmsay.com` | Comma-separated mirror domains for the filmyfly scraper; tries each in order |
| `HDHUB4U_DOMAINS` | `filmmilf.xyz,hdhub4u.world,hdhub4u.page` | Comma-separated mirror domains for the hdhub4u scraper; tries each in order |
| `A111477_DOMAINS` | `a.111477.xyz` | Domain(s) for the static file indexer provider |
| `FZMOVIES_DOMAINS` | `fzmovies.xyz,fzmovies.live,fzmovies.host` | Mirror domains for the fzmovies movie provider; tries each in order |
| `FZMOVIES_TV_DOMAINS` | `mobiletvshows.site,fztvseries.live` | Mirror domains for the fzmovies TV provider (FzTVseries) |

## How nxsha.app works (reverse-engineered)

The site's `/dl/*` pages are Next.js apps whose "Security Check" is **purely cosmetic**: it's a client-side math problem (`num1 + num2`) that produces no token. Submitting it just flips a React state flag and starts the real fetch flow.

Every API call is `GET /api/{servers,sources}?q=<ciphertext>`:

1. The frontend builds a JSON payload, e.g. `{"tmdbId":"969681","type":"movie","imdb_id":"","season":"1","episode":"1","method":"dl","_req_ts":…,"_req_salt":"…"}`
2. It encrypts it with `CryptoJS.AES.encrypt(json, "S8x!Jk4ZP1uG8$my")` — OpenSSL `Salted__` format (AES-256-CBC, key/IV derived via `EVP_BytesToKey` with MD5), then base64url without padding.
3. `GET /api/servers` returns `{"_hash": "<same format>"}`; decrypt + `JSON.parse` yields the provider list (`scraper` names like `mbox`, `hdhub4u`, `k4khdhub`, `filmyfly`).
4. For each provider, `GET /api/sources?q=<encrypted {provider, …}>` returns the actual links, already resolved to direct URLs (some are signed CDN links that expire).

The passphrase lives in the site's public JS bundle (`String.fromCharCode(83,56,120,33,74,107,52,90,80,49,117,71,56,36,109,121)`), so this is obfuscation rather than real security.

This server implements exactly that protocol in `nxsha.mjs` using Node's built-in `crypto` module — no CryptoJS dependency needed.

## Building your own aggregator

nxsha itself is just a wrapper around per-site scrapers. Each entry in `/api/servers` (`scraper` field) is a source site (hdhub4u, filmyfly, …). If you want your own system, the architecture is:

1. **Scraper modules** — one per source site; given a title/query, return candidate pages.
2. **Resolver** — extract the real download URL(s) from each page (often behind shorteners, embedded players, or JS-rendered links).
3. **Indexer/API** — the layer nxsha exposes here: a `servers` endpoint for available scrapers and a `sources` endpoint that runs the scrape on demand.

`nxsha.mjs` is a clean place to start if you'd rather plug in your own scrapers behind the same HTTP API.

## Disclaimer

This project is an indexer: it aggregates links to media hosted by third-party providers. It hosts, stores, or transmits no media files itself. Respect the copyright status of content in your jurisdiction.
