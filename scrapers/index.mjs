// scrapers/index.mjs - provider registry + unified scrape API.
//
// Each provider is a scraper module exposing:
//   scrapeMovie({ title, year }) -> { provider, sources, errors, post? }
//   scrapeEpisode({ title, season, episode }) -> { provider, sources, errors }
//
// Providers are registered by name so adding a new source site (e.g. OrVid
// once its URL pattern is known) is just one more entry here.

import { makeFilmyfly, filmyfly as defaultFilmyfly } from "./filmyfly.mjs";
import { makeHdhub4u, hdhub4u as defaultHdhub4u } from "./hdhub4u.mjs";
import { makeA111477, a111477 as defaultA111477 } from "./a111477.mjs";
import { makeCinextream, cinextream as defaultCinextream } from "./cinextream.mjs";
import { makePahe, pahe as defaultPahe } from "./pahe.mjs";
import { makeMovierulz, movierulz as defaultMovierulz } from "./movierulz.mjs";
import { make9jarocks, ninejarocks as default9jarocks } from "./9jarocks.mjs";
import { normalizeTitle } from "./base.mjs";
import { getDirectLinks } from "../nxsha.mjs";

// Point a provider at a different mirror without editing code:
//   FILMYFLY_DOMAINS="filmsay.com,another-mirror.com" node server.mjs
// The first reachable domain is used (mirrors die/rotate frequently).
function envDomains(name) {
  const raw = process.env[name];
  if (!raw) return null;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

const filmyflyDomains = envDomains("FILMYFLY_DOMAINS");
const hdhub4uDomains = envDomains("HDHUB4U_DOMAINS");
const a111477Domains = envDomains("A111477_DOMAINS");
const cinextreamDomains = envDomains("CINEXTREAM_DOMAINS");
const paheDomains = envDomains("PAHE_DOMAINS");
const movierulzDomains = envDomains("MOVIERULZ_DOMAINS");
const ninejarocksDomains = envDomains("9JAROCKS_DOMAINS");

export const registry = {
  filmyfly: filmyflyDomains ? makeFilmyfly({ domains: filmyflyDomains }) : defaultFilmyfly,
  hdhub4u: hdhub4uDomains ? makeHdhub4u({ domains: hdhub4uDomains }) : defaultHdhub4u,
  a111477: a111477Domains ? makeA111477({ domains: a111477Domains }) : defaultA111477,
  cinextream: cinextreamDomains ? makeCinextream({ domains: cinextreamDomains }) : defaultCinextream,
  pahe: paheDomains ? makePahe({ domains: paheDomains }) : defaultPahe,
  movierulz: movierulzDomains ? makeMovierulz({ domains: movierulzDomains }) : defaultMovierulz,
  ninejarocks: ninejarocksDomains ? make9jarocks({ domains: ninejarocksDomains }) : default9jarocks,
};

export function providerNames() {
  return Object.keys(registry);
}

// Friendly display names shown in the UI - the real source sites (pahe.ink,
// filmyfly mirrors, …) are internal implementation details, not user-facing
// brand names.
const FRIENDLY = {
  pahe: "Elite Server",
  movierulz: "Indian Server",
  cinextream: "Prime Server",
  a111477: "Index Server",
  filmyfly: "Swift Server",
  hdhub4u: "Nexus Server",
  ninejarocks: "Naija Server",
};

// UI ordering: Elite (pahe) leads the server list, then the rest.
const PROVIDER_ORDER = ["pahe", "movierulz", "cinextream", "a111477", "filmyfly", "hdhub4u", "ninejarocks"];

export function friendlyName(provider) {
  return FRIENDLY[provider] || provider;
}

// Sort a provider list so Elite-first, unknown providers trail at the end.
export function sortProviders(list) {
  return [...(list || [])].sort((a, b) => {
    const ia = PROVIDER_ORDER.indexOf(a.provider);
    const ib = PROVIDER_ORDER.indexOf(b.provider);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
}

// Public-facing provider entries must never expose where a server's links come
// from: drop the scrapers' internal `post` URL (the source-site page). The JSON
// and HTML layers render `name` only, so the friendly server names are all the
// client ever sees.
export function sanitizeProviders(list) {
  return (list || []).map((p) => {
    const { post, ...rest } = p;
    return rest;
  });
}

const TMDB_BASE = "https://api.themoviedb.org/3";

function tmdbKey() {
  return process.env.TMDB_API_KEY || null;
}

// Normalize a TMDB search result into our media shape.
function toMedia(j) {
  if (j.media_type === "tv") {
    return { tmdbId: String(j.id), type: "tv", title: j.name || j.original_name, year: (j.first_air_date || "").slice(0, 4) };
  }
  return { tmdbId: String(j.id), type: "movie", title: j.title || j.original_title, year: (j.release_date || "").slice(0, 4) };
}

// Search TMDB for a plain title. Returns normalized candidates across both
// movies and TV. Requires TMDB_API_KEY.
export async function tmdbSearch(q) {
  const key = tmdbKey();
  if (!key) return { error: "TMDB_API_KEY is not set." };
  const url = `${TMDB_BASE}/search/multi?api_key=${key}&query=${encodeURIComponent(q)}&language=en-US&page=1`;
  const res = await fetch(url);
  if (!res.ok) {
    return { error: `TMDB search returned HTTP ${res.status}` };
  }
  const j = await res.json();
  const results = (j.results || [])
    .filter((r) => (r.media_type === "movie" || r.media_type === "tv") && (r.title || r.name))
    .map(toMedia);
  return { results };
}

// Optional TMDB metadata lookup so routes can take a tmdbId instead of a raw
// title/year. Needs a free TMDB API key; without one, callers pass title/year.
async function tmdbTitleYear({ tmdbId, type, season }) {
  const key = tmdbKey();
  if (!key) return null;
  const kind = type === "tv" ? "tv" : "movie";
  const url = `${TMDB_BASE}/${kind}/${tmdbId}?api_key=${key}&language=en-US`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const j = await res.json();
  if (kind === "movie") return { title: j.title || j.original_title, year: (j.release_date || "").slice(0, 4) };
  return { title: j.name || j.original_name, year: (j.first_air_date || "").slice(0, 4) || null };
}

export async function resolveMetadata({ tmdbId, type, season, title, year }) {
  const carry = tmdbId ? { tmdbId: String(tmdbId) } : {};
  if (title && year) return { title, year: String(year), ...carry };
  if (title) return { title, year: null, ...carry };
  if (tmdbId) {
    const t = await tmdbTitleYear({ tmdbId, type, season });
    if (t) return { ...t, ...carry };
  }
  return null;
}

// Cap how long any single provider may spend so one dead/blocked site can't
// stall the whole response. Env-tunable: PROVIDER_TIMEOUT_MS (default 12 s).
function providerTimeoutMs() {
  return Number(process.env.PROVIDER_TIMEOUT_MS || 12_000);
}

// Resolve with `fallback` if `promise` hasn't settled within `ms`.
function withTimeout(promise, ms, fallback) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Run all providers in parallel so the response only waits for the slowest
// one. Lower via SCRAPE_CONCURRENCY if source sites rate-limit bursts.
function scrapeConcurrency() {
  return Number(process.env.SCRAPE_CONCURRENCY || 6);
}

// Scrape a movie from all registered providers. `opts` carries either
// { title, year } or { tmdbId, type } (the latter needs TMDB_API_KEY).
export async function scrapeMovie(opts, { concurrency = scrapeConcurrency() } = {}) {
  const meta = await resolveMetadata(opts);
  if (!meta) {
    return {
      error: "Need title/year, or a TMDB_API_KEY to resolve tmdbId → title/year.",
      providers: [],
    };
  }
  const names = providerNames();
  const results = new Array(names.length);
  let idx = 0;
  const timeoutMs = providerTimeoutMs();
  const worker = async () => {
    while (idx < names.length) {
      const i = idx++;
      const p = registry[names[i]];
      try {
        results[i] = await withTimeout(
          p.scrapeMovie({ ...meta, minQuality: opts.minQuality }),
          timeoutMs,
          { provider: p.name, error: `timed out after ${timeoutMs}ms`, sources: [], timedOut: true }
        );
      } catch (e) {
        results[i] = { provider: p.name, error: e.message, sources: [] };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, names.length) }, worker));
  return { providers: sanitizeProviders(sortProviders(results.map((r) => ({ ...r, name: friendlyName(r.provider) })))) };
}

// Scrape a single TV episode from all registered providers.
export async function scrapeEpisode(opts, { concurrency = scrapeConcurrency() } = {}) {
  const meta = await resolveMetadata(opts);
  if (!meta) {
    return {
      error: "Need title/year, or a TMDB_API_KEY to resolve tmdbId → title/year.",
      providers: [],
    };
  }
  const names = providerNames();
  const results = new Array(names.length);
  let idx = 0;
  const timeoutMs = providerTimeoutMs();
  const worker = async () => {
    while (idx < names.length) {
      const i = idx++;
      const p = registry[names[i]];
      try {
        results[i] = await withTimeout(
          p.scrapeEpisode({ title: meta.title, year: meta.year, season: opts.season, episode: opts.episode, tmdbId: meta.tmdbId, minQuality: opts.minQuality }),
          timeoutMs,
          { provider: p.name, error: `timed out after ${timeoutMs}ms`, sources: [], timedOut: true }
        );
      } catch (e) {
        results[i] = { provider: p.name, error: e.message, sources: [] };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, names.length) }, worker));
  return { providers: sanitizeProviders(sortProviders(results.map((r) => ({ ...r, name: friendlyName(r.provider) })))) };
}

// Score a search candidate against the query so we can pick the best match.
// Exact normalized-title match wins; year match and preferred media type nudge.
export function scoreCandidate(c, q, { wantTv, year }) {
  const nt = normalizeTitle(c.title);
  const nq = normalizeTitle(q);
  let s = 0;
  if (nt === nq) s += 100;
  else if (nt.includes(nq) || nq.includes(nt)) s += 50;
  if (year && c.year === String(year)) s += 20;
  if (wantTv) s += c.type === "tv" ? 10 : 0;
  else s += c.type === "movie" ? 10 : 0;
  return s;
}

// TMDB search + best-match pick, shared by findAndScrape and the merged flow
// so the merge can scrape once and run nxsha in parallel.
async function pickMatch(q, { season, episode, year }) {
  const { results, error } = await tmdbSearch(q);
  if (error) return { error, results: [] };
  if (!results?.length) return { error: `No TMDB matches for "${q}"`, results: [] };
  const wantTv = Boolean(season && episode);
  const scored = results
    .map((c) => ({ c, s: scoreCandidate(c, q, { wantTv, year }) }))
    .sort((a, b) => b.s - a.s);
  return { results, match: scored[0].c };
}

// Title -> tmdbId -> scrape. The convenience endpoint behind `/api/find`.
export async function findAndScrape({ q, season, episode, year, minQuality, concurrency = scrapeConcurrency() } = {}) {
  const { results, match, error } = await pickMatch(q, { season, episode, year });
  if (error) return { error, providers: [] };
  if (match.type === "tv" && !(season && episode)) {
    return {
      error: `"${match.title}" is a TV show - add ?season=&episode= to scrape an episode.`,
      match,
      results,
      providers: [],
    };
  }
  const providers = match.type === "tv"
    ? await scrapeEpisode({ tmdbId: match.tmdbId, type: "tv", season, episode, minQuality }, { concurrency })
    : await scrapeMovie({ tmdbId: match.tmdbId, type: "movie", minQuality }, { concurrency });
  return { match, results, ...providers };
}

// Unify provider entries from both backends into one list. Self-hosted modules
// get { source: "self", name } and nxsha servers get { source: "nxsha", name }
// (their display name) so same-named scrapers (e.g. hdhub4u) stay distinct.
export function mergeProviders(selfProviders, nxshaServers) {
  const self = sanitizeProviders((selfProviders || []).map((p) => ({ ...p, source: "self", name: friendlyName(p.provider) })));
  const nxsha = (nxshaServers || []).map((s) => ({
    source: "nxsha",
    provider: s.provider,
    name: s.server?.name || s.provider,
    sources: s.sources || [],
    error: s.error || null,
  }));
  return sortProviders([...self, ...nxsha]);
}

// Scrape a movie/TV entry by tmdbId alone, merging self-hosted scrapers and
// nxsha providers. This is what the bigreel stream site calls: it knows only
// the tmdb id, and the downloader resolves + fetches links. Requires
// TMDB_API_KEY (or title/year query params); without them it falls back to
// the nxsha proxy so /dl/* still returns results.
export async function scrapeMergedById({ tmdbId, type, season, episode, title, year, minQuality, includeNxsha = true, concurrency = scrapeConcurrency() } = {}, { dl = getDirectLinks } = {}) {
  let meta = await resolveMetadata({ tmdbId, type, season, title, year });
  if (!meta) {
    if (!includeNxsha) {
      return { error: "Need title/year, or a TMDB_API_KEY to resolve tmdbId → title/year.", providers: [] };
    }
    try {
      const media = { tmdbId: String(tmdbId), type, season: season || "1", episode: episode || "1" };
      const dlResult = await dl(media, { concurrency: 4 });
      return { match: null, providers: mergeProviders([], dlResult.servers) };
    } catch (e) {
      return { error: e.message, providers: [] };
    }
  }
  const selfTask = type === "tv"
    ? scrapeEpisode({ ...meta, season, episode, minQuality }, { concurrency })
    : scrapeMovie({ ...meta, minQuality }, { concurrency });
  if (!includeNxsha) return { ...(await selfTask), match: meta };
  // Run the nxsha proxy in parallel with the self scrapers so it never adds
  // to the critical path.
  const [selfRes, dlRes] = await Promise.allSettled([
    selfTask,
    dl({ tmdbId: meta.tmdbId, type, season, episode }, { concurrency: 4 }),
  ]);
  const selfResult = selfRes.status === "fulfilled" ? selfRes.value : { error: selfRes.reason?.message, providers: [] };
  const selfProviders = selfResult.providers || [];
  if (dlRes.status === "rejected") {
    return { ...selfResult, match: meta, providers: mergeProviders(selfProviders, []), nxshaError: dlRes.reason?.message };
  }
  return { ...selfResult, match: meta, providers: mergeProviders(selfProviders, dlRes.value.servers) };
}

// findAndScrape + nxsha proxy merged into one response. `includeNxsha: false`
// keeps the self-only behavior. `dl` is injectable for tests.
export async function findAndScrapeMerged({ q, season, episode, year, minQuality, includeNxsha = true, concurrency = scrapeConcurrency() } = {}, { dl = getDirectLinks } = {}) {
  const { results, match, error } = await pickMatch(q, { season, episode, year });
  if (error) return { error, providers: [] };
  if (match.type === "tv" && !(season && episode)) {
    return { error: `"${match.title}" is a TV show - add ?season=&episode= to scrape an episode.`, match, results, providers: [] };
  }
  const selfTask = match.type === "tv"
    ? scrapeEpisode({ tmdbId: match.tmdbId, type: "tv", season, episode, minQuality }, { concurrency })
    : scrapeMovie({ tmdbId: match.tmdbId, type: "movie", minQuality }, { concurrency });
  if (!includeNxsha) {
    const sr = await selfTask;
    return { ...sr, match, results };
  }
  // nxsha proxy runs in parallel with the self scrapers - it never adds to
  // the critical path.
  const media = match.type === "tv"
    ? { tmdbId: match.tmdbId, type: "tv", season, episode }
    : { tmdbId: match.tmdbId, type: "movie" };
  const [selfRes, dlRes] = await Promise.allSettled([selfTask, dl(media, { concurrency: 4 })]);
  const selfResult = selfRes.status === "fulfilled" ? selfRes.value : { error: selfRes.reason?.message, providers: [] };
  const merged = selfResult.providers || [];
  if (dlRes.status === "rejected") {
    return { ...selfResult, match, results, providers: mergeProviders(merged, []), nxshaError: dlRes.reason?.message };
  }
  return { ...selfResult, match, results, providers: mergeProviders(merged, dlRes.value.servers) };
}
