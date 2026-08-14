// scrapers/index.mjs — provider registry + unified scrape API.
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
import { makeFzmovies, fzmovies as defaultFzmovies } from "./fzmovies.mjs";
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
const fzmoviesDomains = envDomains("FZMOVIES_DOMAINS");
const fzmoviesTvDomains = envDomains("FZMOVIES_TV_DOMAINS");

export const registry = {
  filmyfly: filmyflyDomains ? makeFilmyfly({ domains: filmyflyDomains }) : defaultFilmyfly,
  hdhub4u: hdhub4uDomains ? makeHdhub4u({ domains: hdhub4uDomains }) : defaultHdhub4u,
  a111477: a111477Domains ? makeA111477({ domains: a111477Domains }) : defaultA111477,
  fzmovies: fzmoviesDomains || fzmoviesTvDomains
    ? makeFzmovies({ domains: fzmoviesDomains || undefined, tvDomains: fzmoviesTvDomains || undefined })
    : defaultFzmovies,
};

export function providerNames() {
  return Object.keys(registry);
}

const TMDB_BASE = "https://api.themoviedb.org/3";

function tmdbKey() {
 return "b66176b4cb7084901bbeeb4214f4d688";
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
  return { title: j.name || j.original_name, year: null };
}

export async function resolveMetadata({ tmdbId, type, season, title, year }) {
  if (title && year) return { title, year: String(year) };
  if (title) return { title, year: null };
  if (tmdbId) {
    const t = await tmdbTitleYear({ tmdbId, type, season });
    if (t) return t;
  }
  return null;
}

// Scrape a movie from all registered providers. `opts` carries either
// { title, year } or { tmdbId, type } (the latter needs TMDB_API_KEY).
export async function scrapeMovie(opts, { concurrency = 2 } = {}) {
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
  const worker = async () => {
    while (idx < names.length) {
      const i = idx++;
      const p = registry[names[i]];
      try {
        results[i] = await p.scrapeMovie(meta);
      } catch (e) {
        results[i] = { provider: p.name, error: e.message, sources: [] };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, names.length) }, worker));
  return { providers: results };
}

// Scrape a single TV episode from all registered providers.
export async function scrapeEpisode(opts, { concurrency = 2 } = {}) {
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
  const worker = async () => {
    while (idx < names.length) {
      const i = idx++;
      const p = registry[names[i]];
      try {
        results[i] = await p.scrapeEpisode({ title: meta.title, season: opts.season, episode: opts.episode });
      } catch (e) {
        results[i] = { provider: p.name, error: e.message, sources: [] };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, names.length) }, worker));
  return { providers: results };
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

// Title -> tmdbId -> scrape. The convenience endpoint behind `/api/find`.
export async function findAndScrape({ q, season, episode, year, concurrency = 2 } = {}) {
  const { results, error } = await tmdbSearch(q);
  if (error) return { error, providers: [] };
  if (!results?.length) return { error: `No TMDB matches for "${q}"`, providers: [] };

  const wantTv = Boolean(season && episode);
  const scored = results
    .map((c) => ({ c, s: scoreCandidate(c, q, { wantTv, year }) }))
    .sort((a, b) => b.s - a.s);
  const match = scored[0].c;

  if (match.type === "tv" && !(season && episode)) {
    return {
      error: `"${match.title}" is a TV show — add ?season=&episode= to scrape an episode.`,
      match,
      results,
      providers: [],
    };
  }

  const providers = match.type === "tv"
    ? await scrapeEpisode({ tmdbId: match.tmdbId, type: "tv", season, episode }, { concurrency })
    : await scrapeMovie({ tmdbId: match.tmdbId, type: "movie" }, { concurrency });
  return { match, results, ...providers };
}

// Unify provider entries from both backends into one list. Self-hosted modules
// get { source: "self", name } and nxsha servers get { source: "nxsha", name }
// (their display name) so same-named scrapers (e.g. hdhub4u) stay distinct.
export function mergeProviders(selfProviders, nxshaServers) {
  const self = (selfProviders || []).map((p) => ({ ...p, source: "self", name: p.provider }));
  const nxsha = (nxshaServers || []).map((s) => ({
    source: "nxsha",
    provider: s.provider,
    name: s.server?.name || s.provider,
    sources: s.sources || [],
    error: s.error || null,
    post: null,
  }));
  return [...self, ...nxsha];
}

// findAndScrape + nxsha proxy merged into one response. `includeNxsha: false`
// keeps the self-only behavior. `dl` is injectable for tests.
export async function findAndScrapeMerged({ q, season, episode, year, includeNxsha = true, concurrency = 2 } = {}, { dl = getDirectLinks } = {}) {
  const base = await findAndScrape({ q, season, episode, year, concurrency });
  const selfProviders = base.providers || [];
  if (!base.match || !includeNxsha) {
    return { ...base, providers: mergeProviders(selfProviders, []) };
  }
  if (base.match.type === "tv" && !(season && episode)) {
    return { ...base, providers: mergeProviders(selfProviders, []) };
  }
  try {
    const media = base.match.type === "tv"
      ? { tmdbId: base.match.tmdbId, type: "tv", season, episode }
      : { tmdbId: base.match.tmdbId, type: "movie" };
    const dlResult = await dl(media, { concurrency: 4 });
    return { ...base, providers: mergeProviders(selfProviders, dlResult.servers) };
  } catch (e) {
    return { ...base, providers: mergeProviders(selfProviders, []), nxshaError: e.message };
  }
}
