# BIGREEL Downloader

A zero-dependency Node.js server that aggregates **direct download links** for movies and TV shows using TMDB ids. It merges **self-hosted scrapers** (Elite, Prime, Index, Swift, Nexus) with [nxsha.app](https://web.nxsha.app) partner sources, and mirrors nxsha's URL scheme so a stream site can deep-link straight by TMDB id:

- Movie: `GET /dl/movie/{tmdb_id}`
- TV:    `GET /dl/tv/{tmdb_id}/{season_number}/{episode_number}`

**Server naming:** the real source sites are hidden behind friendly names - the best (pahe) is **Elite Server** and always leads the list:

| Friendly name | Backend | Notes |
|---|---|---|
| **Elite Server** | pahe | Best overall · quality packs 480p → 2160p × x264/x265 · shortener tokens auto-resolved to file hosts |
| **Indian Server** | 5movierulz.watch | Big Indian library (Telugu/Tamil/Malayalam/Hindi/Hollywood-dubs) · torrent magnets (direct) + streaming mirrors (locked) |
| **Prime Server** | cinextream | Rich metadata: 4K / H.265 / Atmos / TrueHD |
| **Index Server** | a111477 | Raw file indexer · direct .mkv/.mp4 rows |
| **Swift Server** | filmyfly | Multi-mirror host chains · fast direct links |
| **Nexus Server** | hdhub4u | WordPress mirrors · quality-tagged file links |
| (nxsha providers) | nxsha.app proxy | Partner sources merged in, tagged `source: "nxsha"` |

`/dl/*` and `/api/dl/*` now fetch the **merged** result: self-hosted scrapers plus nxsha, ranked Elite-first.

## Quick start

```bash
node server.mjs          # Node 18+ required, no npm install needed
```

Then open:

- `http://localhost:3000/dl/movie/969681` - Spider-Man: Brand New Day
- `http://localhost:3000/dl/tv/1396/1/1` - Breaking Bad S01E01

## Endpoints

| Route | Description |
|---|---|
| `GET /dl/movie/:tmdbId` | HTML page: merged links from self-hosted servers + nxsha, Elite-first |
| `GET /dl/tv/:tmdbId/:season/:episode` | HTML page for an episode |
| `GET /api/dl/movie/:tmdbId` | Same data as JSON (`providers[].sources[]`, `match`) |
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
> own scraper modules - they never call nxsha. Pass `title`/`year` as query params, or set
> `TMDB_API_KEY` (free, themoviedb.org) and use just the tmdbId - or no id at all:

```bash
# no TMDB id needed, just the name
curl 'http://localhost:3000/api/find?q=spider-man'            # best movie match, scraped
curl 'http://localhost:3000/api/find?q=breaking+bad&season=1&episode=1'  # TV episode
curl 'http://localhost:3000/api/search?q=spider-man'          # raw candidates first
```

`/api/find` picks the best match by normalized-title score (exact match, year nudge,
and a TV preference when `season`/`episode` are supplied). If the best match is a TV
show and no `season`/`episode` was given, it tells you so instead of scraping nothing.

**`/api/find` merges both backends** - the self-hosted scrapers *and* nxsha's proxy
providers - into one `providers[]` list. Each entry carries a `source` field
(`"self"` or `"nxsha"`) and a friendly display `name` (Elite Server, Prime Server, …),
so same-named scrapers stay distinct (e.g. self `hdhub4u` → Nexus Server vs nxsha's
`4k-bb`). Self-hosted providers are ranked Elite-first. Use `&nxsha=0` for self-only results.

**`/dl/*` works the same way from just a TMDB id** - that's the integration point for a
stream site: `GET /dl/movie/533535` resolves the id via `TMDB_API_KEY`, scrapes every
self-hosted server, merges nxsha, and renders the list. Without `TMDB_API_KEY` it falls
back to the nxsha proxy only.

## Self-hosted scrapers (`scrapers/`)

Instead of proxying nxsha, the `scrapers/` modules scrape the same source sites nxsha's
backend wraps. Architecture:

```
scrapers/
  base.mjs        # HTTP helpers (UA, cookie jar, redirect chains), HTML utils
  filmyfly.mjs    # DataLife Engine sites (filmsay.com): search -> post -> go.php -> server.php
  hdhub4u.mjs     # WordPress mirrors (filmmilf.xyz): ?s= search -> post -> file-host links
  a111477.mjs     # static "Index of /" file indexer (a.111477.xyz): listing -> file rows
  cinextream.mjs  # ddl.cinextream.cc TMDB-id API: wasm-decrypted responses over the same indexer
  pahe.mjs        # pahe.ink WordPress library: metadata + token-decode of ad-locker shorteners
  movierulz.mjs   # 5movierulz.watch Indian site: category-page discovery -> torrent magnets + streaming mirrors
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
2. Post page contains one `/go.php?url=<…>` link per quality - the payload is
   Laravel AES-256-GCM encrypted, but **we never decrypt it**; the site resolves it.
3. `go.php` renders "File Information" + "Choose a Download Server" with
   `/server.php?id=<n>` links per host.
4. `server.php?id=n` 302-redirects straight to the real file URL.
   (Verified with `video-downloads.googleusercontent.com`, `hubcloud.cx`, `mediafire.com`.)

The site rate-limits `/server.php` per IP, so the scraper paces requests (400 ms),
caches resolved links for 12 h, and caps work per scrape. Some hosts are
login-walled (403) - those are reported as errors, not failures of the whole scrape.

### How the hdhub4u chain works (verified)

1. Search: `GET /?s=<query>` (WordPress - sanitize punctuation, it breaks search)
2. Post (`/?p=<id>`) links to file hosts, e.g. `new1.filesdl.in/cloud/<shortid>`
3. `filesdl.in` 302-redirects to `filesdl.top`, which sits behind **Cloudflare's
   managed JS challenge** (`cf-ray`, "Just a moment...", `challenges.cloudflare.com`).
   We verified that full browser headers **and** TLS impersonation (curl_cffi) both
   fail - it's not a session/referer/token flow, it's a challenge that needs real
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
`k4khdhub`, `filmyfly` - **OrVid** didn't appear and no public reference to it was
found, so there's no module yet. Adding one is a single file + one registry line:

```js
// scrapers/orvid.mjs
export const orvid = makeSomething({ domains: ["…"], name: "orvid" });
// scrapers/index.mjs
import { orvid } from "./orvid.mjs";
export const registry = { filmyfly, hdhub4u, orvid };
```

### The a.111477.xyz provider (an actual indexer)

`a.111477.xyz` is a plain "Index of /" file listing - the easiest kind of site to
scrape: no search API, no JS, no login. `/movies/` and `/tvs/` list directories
named `Title (Year)`, movie dirs contain direct `.mkv`/`.mp4` rows with quality
and size in the name (`Spider-Man.No.Way.Home.2021.2160p.UHD…mkv · 26.9 GB`),
and TV shows nest `Season N/` dirs with `S01E01` episode files. The scraper:

1. fetches the (cached, 1 h TTL) category listing - pages are huge (~10 MB),
2. matches the `Title (Year)` directory by normalized title,
3. parses the file rows into sources with `quality`/`size`/`label`,
4. probes one file link: the listing HTML is open, but the **file paths are
   Cloudflare-gated for bots** (403 + cf-ray even with browser TLS/cookies), so
   links are flagged `locked: true` with a note - they work in a real browser
   (and would work with a `FLARESOLVERR_URL`).

### The cinextream provider (same indexer, TMDB-id API)

`ddl.cinextream.cc` is a Next.js frontend whose backend is **the same file
indexer as a.111477.xyz** - every resolved file URL points at
`a.111477.xyz/movies|tvs/…`. It improves on raw listing-walking by taking a
TMDB id directly:

- `GET /api/movie/{tmdbId}` and `GET /api/tv/{tmdbId}/{s}/{e}` → file lists
  with per-file `resolution` / `codec` / `audio` / `source` / `size` / `hdr`,
- `GET /api/meta/movie/{tmdbId}` → title/poster/overview (TMDB-backed),
- `GET /api/subs/movie/{tmdbId}` → subtitles.

Every response is `{"enc":"<hex>"}` - AES-encrypted with a key baked into the
site's own `/wasm/codec.wasm` (5.7 KB). Node runs WebAssembly natively, so the
scraper instantiates their codec and calls its exported `decrypt()` exactly like
the browser does - **zero npm dependencies**, and the wasm itself validates the
key layout at runtime. Requires a `tmdbId`, which the `/api/find` and
`/api/scrape/*` flows always have (via `TMDB_API_KEY`). File links carry the
same Cloudflare-gated `locked` flag as the raw indexer.

### The pahe.ink provider (metadata-only)

`pahe.ink` is a big WordPress library (movies + whole-season TV packs) with clean
search (`/?s=<query>` → timeline posts) and per-quality download boxes
(480p/720p/1080p/2160p × x264/x265, each quality offering 4–6 mirror hosts).
The blog is open - no Cloudflare on search or posts - **but every download link
on a post is an ad-locker shortener** (`teknoasian.com/?ht=`, `tpi.li/<slug>`,
`oii.la/…`, intercelestial, linegee, …) that reveals the real file URL only
after a human clicks through captchas + "Generate Link" hops in a browser.

So the pahe provider is **metadata-first**: it searches pahe, picks the right
post, and extracts the download box (quality, size, mirror host, and the
shortener URL). Then it **unlocks up to 12 shorteners per scrape** - the
locker pages (`tpi.li` / `oii.la` / …) embed the real destination URL in
`<input name="token">` as a base64 suffix, which we decode server-side (the
same trick "Bypass Pahe Links"-style userscripts do in the browser, minus the
captcha clicking - the token is in the raw HTML). Resolved sources point at
the real file host:

```json
{
  "provider": "pahe",
  "url": "https://mega.nz/file/CxJWmAAL#EjPeZP6Hr4kmkNTKlKvcwnlVyNr6njC5UkptB4yOzI8",
  "label": "1080p x265 DD+5.1 · 2.63 GB · GD",
  "quality": "1080p x265 DD+5.1",
  "size": "2.63 GB",
  "host": "GD",
  "locked": false,
  "note": "resolved from pahe's ad-locker shortener - file hosted on mega.nz"
}
```

Sources that couldn't be unlocked (rate-limited, rotated, or beyond the per-
scrape cap) stay flagged:

```json
{
  "url": "https://tpi.li/cBtbFoKc",
  "locked": true,
  "note": "external locked link - opens pahe's ad-locker shortener; resolve in a browser (captcha + Generate Link hops)"
}
```

Resolutions are cached per shortener URL (12 h) so repeated scrapes of the
same post are cheap. TV scrapes resolve the whole-season pack post (pahe
doesn't do per-episode pages), and each TV source's note says so.

You can filter pahe's (locked) sources by minimum quality with `min_quality`
(`480p`, `1080p`, `2160p`, `4K` - accepts bare numbers too) on any `/find`,
`/scrape*`, or their JSON equivalents:

```bash
# only 1080p and above, from every provider
curl 'http://localhost:3000/api/find?q=deadpool+wolverine&min_quality=1080p'
curl 'http://localhost:3000/api/scrape/movie/533535?title=Deadpool%20%26%20Wolverine&year=2024&min_quality=2160p'
```

The filter is applied inside the pahe provider (other providers are
unaffected) and pahe's HTML page shows ` · 1080p+` in its title.

### What makes a site scrapable

Any site that (1) has a **discovery** mechanism (WordPress `?s=`, DLE
`?do=search`, RSS, sitemap, category pages), (2) exposes **resolvable links**
(direct files or a redirect chain we can follow - filmyfly's `go.php →
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
state. Set `TMDB_API_KEY` so `/dl/*` can resolve tmdbIds to titles and scrape
the self-hosted servers.

1. Push this folder to a Git repo (or use `vercel --cwd .` from the folder).
2. Log in: `vercel login`
3. Set env vars in the Vercel dashboard (Settings → Environment Variables)
   - at minimum `TMDB_API_KEY` (free, themoviedb.org). Optional:   `FLARESOLVERR_URL`,
   `FILMYFLY_DOMAINS`, `HDHUB4U_DOMAINS`, `A111477_DOMAINS`, `CINEXTREAM_DOMAINS`, `PAHE_DOMAINS`, `MOVIERULZ_DOMAINS`.
4. `vercel --prod`

Scrapes hit live source sites and can take 10–30 s, so `maxDuration` is set to
60 s in `vercel.json` (the Hobby-plan ceiling - bump it to 300 on Pro).

> Note: the standalone server stays fully supported - `node server.mjs` - the
> handler is shared, so the deployed behavior matches local.

## Configuration (env vars)

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Listen port |
| `HOST` | `127.0.0.1` | Listen address |
| `NXSHA_BASE_URL` | `https://web.nxsha.app` | Upstream base |
| `CACHE_TTL_MS` | `60000` | In-memory cache TTL for aggregator responses |
| `FIND_CACHE_TTL_MS` | `300000` | Cache TTL for `/api/find` (it scrapes every provider, so it caches longer) |
| `TMDB_API_KEY` | - | Free key from themoviedb.org; enables `/api/search`, `/api/find`, and tmdbId → title resolution |
| `FLARESOLVERR_URL` | - | Optional; URL of a running flaresolverr, used to unlock Cloudflare-challenged file hosts (filesdl) |
| `FILMYFLY_DOMAINS` | `filmsay.com` | Comma-separated mirror domains for the filmyfly scraper; tries each in order |
| `HDHUB4U_DOMAINS` | `filmmilf.xyz,hdhub4u.world,hdhub4u.page` | Comma-separated mirror domains for the hdhub4u scraper; tries each in order |
| `A111477_DOMAINS` | `a.111477.xyz` | Domain(s) for the static file indexer provider |
| `CINEXTREAM_DOMAINS` | `ddl.cinextream.cc` | Domain(s) for the cinextream API provider (same a.111477.xyz files, TMDB-id lookup) |
| `PAHE_DOMAINS` | `pahe.ink` | Domain(s) for the pahe provider; shortener links are auto-unlocked via token decode (up to 12 per scrape) |
| `MOVIERULZ_DOMAINS` | `www.5movierulz.watch` | Domain(s) for the Indian server (movierulz); search is unavailable server-side so discovery walks the site's category pages |

## How nxsha.app works (reverse-engineered)

The site's `/dl/*` pages are Next.js apps whose "Security Check" is **purely cosmetic**: it's a client-side math problem (`num1 + num2`) that produces no token. Submitting it just flips a React state flag and starts the real fetch flow.

Every API call is `GET /api/{servers,sources}?q=<ciphertext>`:

1. The frontend builds a JSON payload, e.g. `{"tmdbId":"969681","type":"movie","imdb_id":"","season":"1","episode":"1","method":"dl","_req_ts":…,"_req_salt":"…"}`
2. It encrypts it with `CryptoJS.AES.encrypt(json, "S8x!Jk4ZP1uG8$my")` - OpenSSL `Salted__` format (AES-256-CBC, key/IV derived via `EVP_BytesToKey` with MD5), then base64url without padding.
3. `GET /api/servers` returns `{"_hash": "<same format>"}`; decrypt + `JSON.parse` yields the provider list (`scraper` names like `mbox`, `hdhub4u`, `k4khdhub`, `filmyfly`).
4. For each provider, `GET /api/sources?q=<encrypted {provider, …}>` returns the actual links, already resolved to direct URLs (some are signed CDN links that expire).

The passphrase lives in the site's public JS bundle (`String.fromCharCode(83,56,120,33,74,107,52,90,80,49,117,71,56,36,109,121)`), so this is obfuscation rather than real security.

This server implements exactly that protocol in `nxsha.mjs` using Node's built-in `crypto` module - no CryptoJS dependency needed.

## Building your own aggregator

nxsha itself is just a wrapper around per-site scrapers. Each entry in `/api/servers` (`scraper` field) is a source site (hdhub4u, filmyfly, …). If you want your own system, the architecture is:

1. **Scraper modules** - one per source site; given a title/query, return candidate pages.
2. **Resolver** - extract the real download URL(s) from each page (often behind shorteners, embedded players, or JS-rendered links).
3. **Indexer/API** - the layer nxsha exposes here: a `servers` endpoint for available scrapers and a `sources` endpoint that runs the scrape on demand.

`nxsha.mjs` is a clean place to start if you'd rather plug in your own scrapers behind the same HTTP API.

## Disclaimer

This project is an indexer: it aggregates links to media hosted by third-party providers. It hosts, stores, or transmits no media files itself. Respect the copyright status of content in your jurisdiction.
