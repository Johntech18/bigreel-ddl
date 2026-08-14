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
| `GET /healthz` | Health check |

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

## Configuration (env vars)

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Listen port |
| `HOST` | `127.0.0.1` | Listen address |
| `NXSHA_BASE_URL` | `https://web.nxsha.app` | Upstream base |
| `CACHE_TTL_MS` | `60000` | In-memory cache TTL for aggregator responses |

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
