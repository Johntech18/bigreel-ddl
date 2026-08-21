// scrapers/fzmovies.mjs — scraper for FzMovies (fzmovies.xyz / .live / .host)
// and its TV-show sibling FzTVseries (mobiletvshows.site / fztvseries.live).
//
// Verified chains (Aug 2026, live sites + the 21toffy/Fzmovies_scraper_script
// GitHub repo which documents the older fzmovies.net flow):
//
// MOVIES (fzmovies.*):
//   1. Session:  GET /index.php                      -> sets PHPSESSID
//   2. Search:   POST /csearch.php (searchname=...)  -> `mainbox` result rows
//   3. Movie:    GET /movie-<Title>--hmp4.htm        -> per-quality links
//                `download1.php?downloadoptionskey=<key>` (label = filename,
//                size in <dcounter> (344 MB))
//   4. Resolve:  POST /download1.php?...&pt=<pt>     -> `<a id='downloadlink'
//                href='download.php?downloadkey=<key2>'>`
//   5. Final:    GET  /download.php?downloadkey=<key2> (WITH the session cookie
//                and referer — without the cookie the site answers
//                "Your download keys have expired") -> `<input name='download1'
//                value='https://<mirror>.cyou/res/<id>/<file>'>` direct URLs,
//                several mirrors, active for 12 hours.
//
// TV (mobiletvshows.site / fztvseries.live — same template):
//   1. Session:  GET /index.php                      -> sets PHPSESSID
//   2. Search:   GET /search.php?search=<q>&beginsearch=Search
//                -> `subfolder-<Show>.htm` links
//   3. Show:     GET /subfolder-<Show>.htm           -> `files-<Show>--<id>.htm`
//                season links (`Season 1`..`Season 5`)
//   4. Season:   GET /files-<Show>--<id>.htm         -> episode rows
//                `S01E01 - Title` with `episode.php?fileid=<id>&ftype=2`
//                (High MP4) / `ftype=3` (WEBM) links
//   5. Episode:  GET /episode.php?fileid=<id>&ftype=2 -> `downloadmp4.php?
//                fileid=<id>&dkey=<hash>` links
//   6. Resolve:  GET /downloadmp4.php?fileid=<id>&dkey=<hash> (WITH the session
//                cookie + referer — otherwise "Download key not present or
//                session expired") -> `filelink.php?sn=<mirror>.cyou&id=
//                /rlink_t/...` mirror links
//   7. Final:    GET /filelink.php?...               -> JS redirect to
//                `https://<sn>.y9a8ua48mhss5ye.cyou/rlink_t/...` direct URL
//
// All final URLs are served by the site's own CDN mirrors (.cyou hosts) — no
// Cloudflare challenge on the files (only a session check), so these chains
// resolve to real, downloadable direct links. Mirrors rotate (the page itself
// says "if the first link doesn't work, try the one below"), so we return
// every mirror per quality.

import { fetchChain, CookieJar, extractLinks, titleMatches, searchQuery, absolute, normalizeTitle, UA } from "./base.mjs";

const DEFAULT_DOMAINS = ["fzmovies.xyz", "fzmovies.live", "fzmovies.host"];
const DEFAULT_TV_DOMAINS = ["mobiletvshows.site", "fztvseries.live"];

export function makeFzmovies({
  domains = DEFAULT_DOMAINS,
  tvDomains = DEFAULT_TV_DOMAINS,
  name = "fzmovies",
  label = "FzMovies",
  paceMs = 250,
} = {}) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function paced() {
    if (paceMs) await sleep(paceMs);
  }

  // Keep one session jar per domain — the whole resolution chain depends on it.
  const sessions = new Map(); // domain -> CookieJar

  function sessionFor(domain) {
    if (!sessions.has(domain)) sessions.set(domain, new CookieJar());
    return sessions.get(domain);
  }

  // Ensure we have a PHPSESSID for the domain.
  async function ensureSession(domain) {
    const jar = sessionFor(domain);
    if (jar.header().includes("PHPSESSID=")) return jar;
    const { status } = await fetchChain(`https://${domain}/index.php`, { jar });
    if (status !== 200) throw new Error(`Homepage returned HTTP ${status}`);
    return jar;
  }

  function post(domain, path, body, { jar, referer, headers = {} } = {}) {
    return fetch(`https://${domain}/${path}`, {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/x-www-form-urlencoded",
        ...(jar && jar.header() ? { Cookie: jar.header() } : {}),
        ...(referer ? { Referer: referer } : {}),
        ...headers,
      },
      body: new URLSearchParams(body).toString(),
      redirect: "manual",
    });
  }

  // Search all configured domains; first one with results wins (mirrors die /
  // rotate frequently).
  async function searchPosts(title, year) {
    const q = searchQuery(title);
    for (const domain of domains) {
      try {
        const jar = await ensureSession(domain);
        const res = await post(domain, "csearch.php", { searchname: q }, { jar, referer: `https://${domain}/index.php` });
        const text = await res.text();
        const posts = parseResults(text, domain);
        if (!posts.length) continue;
        if (year) {
          const withYear = posts.filter((p) => p.title.includes(`(${year})`));
          if (withYear.length) return { posts: withYear, base: `https://${domain}`, jar };
        }
        return { posts, base: `https://${domain}`, jar };
      } catch (e) {
        // unreachable/error — try the next mirror
        continue;
      }
    }
    return { posts: [], base: domains[0] ? `https://${domains[0]}` : null, jar: null };
  }

  // Parse `mainbox` result rows: <b>Title</b> <small>(2019)</small> <small>(BluRay)</small>
  // with the first movie link `href='movie-...--hmp4.htm'`.
  function parseResults(html, domain) {
    const posts = [];
    const boxRe = /class='mainbox'[\s\S]*?(?=class='mainbox'|class='mainbox3'|<br>\s*<script|<\/body>)/gi;
    for (const box of html.matchAll(boxRe)) {
      const row = box[0];
      const link = row.match(/href='(movie-[^']+\.htm)'/i);
      if (!link) continue;
      const b = row.match(/<b>(.*?)<\/b>/i);
      const year = row.match(/<small>\((\d{4})\)<\/small>/);
      const quality = row.match(/<small>\(([^)]*)\)<\/small>/g);
      const q = quality ? quality[quality.length - 1].replace(/<\/?small>|\(|\)/g, "") : "";
      posts.push({
        url: absolute(`https://${domain}`, link[1]),
        title: `${(b ? b[1] : "").trim()}${year ? ` (${year[1]})` : ""}`,
        year: year ? year[1] : null,
        quality: q,
      });
    }
    return posts;
  }

  // Movie page -> per-quality download links: `download1.php?downloadoptionskey=K`
  // with the `&pt=` suffix from the onclick handler, plus the size from <dcounter>.
  // Mirrors serve the same markup two ways: plain double-quoted onclick (.xyz)
  // and Cloudflare-transformed (`&quot;` entities + data-cf-modified attr) on
  // .live/.host — handle both by scanning the raw attribute text for `&pt=`.
  function parseDownloadOptions(html, baseUrl) {
    const out = [];
    const re = /<a([^>]*?)href='(download1\.php\?downloadoptionskey=[^']+)'([^>]*)>([\s\S]*?)<\/a>\s*(?:<br>\s*<dcounter>\s*\(([^)]*)\))?/gi;
    for (const m of html.matchAll(re)) {
      const tagAttrs = (m[1] || "") + (m[3] || "");
      const href = m[2];
      const label = m[4].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      const size = (m[5] || "").trim();
      // the onclick handler (before or after href) carries &pt=<token>; handle
      // plain quotes and Cloudflare's &quot; entity escaping
      const pt = tagAttrs.match(/pt=([^&"'\\]+)/);
      const full = href + (pt ? `&pt=${pt[1]}` : "");
      out.push({ url: absolute(baseUrl, full), label, size });
    }
    return out;
  }

  // Resolve one quality to its direct URLs:
  //   POST download1.php?downloadoptionskey=K&pt=P  ->  download.php?downloadkey=K2
  //   GET  download.php?downloadkey=K2 (with session) ->  <input name='download1' value='...'>
  async function resolveQuality(dl, jar, referer) {
    // step 4 — POST to download1.php to mint the downloadkey
    const res = await fetch(dl.url, {
      method: "POST",
      headers: {
        "User-Agent": UA,
        ...(jar.header() ? { Cookie: jar.header() } : {}),
        ...(referer ? { Referer: referer } : {}),
      },
      redirect: "manual",
    });
    const html = await res.text();
    const dk = html.match(/download\.php\?downloadkey=([^'"&]+)/);
    if (!dk) return [];
    const base = new URL(dl.url).origin;

    // step 5 — GET download.php with session cookie + referer. fetchChain
    // absorbs cookies but doesn't *send* the jar, so pass Cookie explicitly.
    const final = await fetchChain(`${base}/download.php?downloadkey=${dk[1]}`, {
      jar,
      headers: { referer: dl.url, cookie: jar.header() },
    });
    if (final.status !== 200 || /keys have expired/.test(final.text)) return [];

    // multiple mirrors: each is <input name='download1' value='https://...'>
    const mirrors = [...final.text.matchAll(/name=['"]download1['"][^>]*value=['"]([^'"]+)['"]/gi)].map((m) => m[1]);
    return mirrors;
  }

  async function scrapeMovie({ title, year }) {
    if (!domains.length) return { provider: name, error: "no domains configured" };
    const { posts, base: activeBase, jar } = await searchPosts(title, year);
    if (!posts.length) return { provider: name, error: `No results for "${title}" on fzmovies`, sources: [] };

    const post = posts[0];
    const { status, text } = await fetchChain(post.url, { jar });
    if (status !== 200) return { provider: name, error: `Movie page returned HTTP ${status}`, sources: [] };

    const options = parseDownloadOptions(text, activeBase);
    if (!options.length) return { provider: name, post: post.url, error: "No download options on movie page", sources: [] };

    const sources = [];
    const errors = [];
    for (const dl of options) {
      await paced();
      try {
        const mirrors = await resolveQuality(dl, jar, post.url);
        if (!mirrors.length) {
          errors.push(`No links for ${dl.label || dl.url}`);
          continue;
        }
        for (const m of mirrors) {
          sources.push({
            provider: name,
            url: m,
            label: dl.label,
            quality: dl.label,
            size: dl.size,
            isEmbed: false,
          });
        }
      } catch (e) {
        errors.push(`${dl.label || "quality"}: ${e.message}`);
      }
    }
    return { provider: name, post: post.url, sources, errors };
  }

  // ---- TV (FzTVseries: mobiletvshows.site / fztvseries.live) ----------------

  // Show pages follow a predictable URL — `subfolder-<Show>.htm` — so we try
  // that directly first (the site's search.php returns a fixed popular-shows
  // carousel for any query, so it's useless for discovery). Fall back to
  // parsing search results if the direct URL 404s.
  async function searchShows(title) {
    const t = normalizeTitle(title);
    for (const domain of tvDomains) {
      try {
        const jar = await ensureSession(domain);
        const base = `https://${domain}`;
        // attempt 1: direct subfolder URL
        const directUrl = `${base}/subfolder-${encodeURIComponent(searchQuery(title))}.htm`;
        const direct = await fetchChain(directUrl, { jar });
        if (direct.status === 200 && /files-[^']+\.htm/.test(direct.text)) {
          return { show: { url: directUrl, title: searchQuery(title) }, base, jar };
        }
        // attempt 2: parse search.php results
        const url = `${base}/search.php?search=${encodeURIComponent(searchQuery(title))}&beginsearch=Search`;
        const res = await fetch(url, { headers: { "User-Agent": UA, ...(jar.header() ? { Cookie: jar.header() } : {}) }, redirect: "manual" });
        const text = await res.text();
        const shows = [];
        for (const m of text.matchAll(/href='(subfolder-[^']+\.htm)'/gi)) {
          const url2 = absolute(base, m[1]);
          const title2 = decodeURIComponent(m[1].replace(/^subfolder-/, "").replace(/\.htm$/, "")).trim();
          shows.push({ url: url2, title: title2 });
        }
        if (!shows.length) continue;
        const exact = shows.find((s) => normalizeTitle(s.title) === t) || shows.find((s) => normalizeTitle(s.title).includes(t));
        if (exact) return { show: exact, base, jar };
      } catch (e) {
        continue;
      }
    }
    return { show: null, base: tvDomains[0] ? `https://${tvDomains[0]}` : null, jar: null };
  }

  // Show page -> the `files-<Show>--<id>.htm` season link matching "Season N".
  async function findSeasonPage(showUrl, jar, season) {
    const { status, text } = await fetchChain(showUrl, { jar });
    if (status !== 200) throw new Error(`Show page returned HTTP ${status}`);
    const seasonRe = new RegExp(`href='(files-[^']+\.htm)'[^>]*>[\\s\\S]*?Season\\s*${season}(?!\\d)`, "i");
    const m = text.match(seasonRe) || text.match(new RegExp(`Season\\s*${season}(?!\\d)[\\s\\S]{0,200}?href='(files-[^']+\.htm)'`, "i"));
    if (m) return absolute(new URL(showUrl).origin, m[1]);
    // fallback: any season link and pick by number in the id suffix
    const links = [...text.matchAll(/href='(files-[^']+\.htm)'/gi)].map((x) => x[1]);
    return null;
  }

  // Season page -> episode rows matching SxxEyy with their episode.php links.
  async function findEpisodeLinks(seasonUrl, jar, season, episode) {
    const { status, text } = await fetchChain(seasonUrl, { jar });
    if (status !== 200) throw new Error(`Season page returned HTTP ${status}`);
    const want = new RegExp(`S${String(season).padStart(2, "0")}\\s*E${String(episode).padStart(2, "0")}`, "i");
    const out = [];
    const rowRe = /class='mainbox'[\s\S]*?(?=class='mainbox'|<\/body>)/gi;
    for (const row of text.matchAll(rowRe)) {
      const rowText = row[0];
      if (!want.test(rowText)) continue;
      // episode title is `<small><b>Breaking Bad - S01E01 - Pilot</b></small>`
      // (the show title appears as a plain `<b>Show</b>` link earlier in the row)
      const b = rowText.match(/<small>\s*<b>(.*?)<\/b>/i) || rowText.match(/<b>(.*?)<\/b>/i);
      const eps = [...rowText.matchAll(/href='(episode\.php\?fileid=\d+&ftype=\d+)'/gi)].map((x) => x[1]);
      if (eps.length) {
        out.push({ title: (b ? b[1] : "").trim(), links: eps });
      }
    }
    return out;
  }

  // episode.php -> the downloadmp4.php links (with dkey).
  async function episodeDownloadLinks(episodeUrl, jar) {
    const { status, text } = await fetchChain(episodeUrl, { jar });
    if (status !== 200) throw new Error(`Episode page returned HTTP ${status}`);
    return [...text.matchAll(/href='(downloadmp4\.php\?fileid=\d+&dkey=[a-f0-9]+)'/gi)].map((x) => x[1]);
  }

  // downloadmp4.php (session cookie + referer required) -> filelink.php mirrors,
  // each resolving to the direct .cyou URL via a JS redirect.
  async function resolveEpisode(dlPath, jar, referer) {
    const base = new URL(referer).origin;
    const dlUrl = `${base}/${dlPath}`;
    const res = await fetch(dlUrl, {
      headers: { "User-Agent": UA, ...(jar.header() ? { Cookie: jar.header() } : {}), ...(referer ? { Referer: referer } : {}) },
      redirect: "manual",
    });
    const text = await res.text();
    if (res.status !== 200 || /session expired|not present/.test(text)) return [];
    const flinks = [...text.matchAll(/href='(filelink\.php\?[^']+)'/gi)].map((x) => x[1]);
    const mirrors = [];
    for (const fl of flinks) {
      await paced();
      try {
        const fRes = await fetch(`${base}/${fl}`, {
          headers: { "User-Agent": UA, ...(jar.header() ? { Cookie: jar.header() } : {}), Referer: dlUrl },
          redirect: "manual",
        });
        const fText = await fRes.text();
        const target = fText.match(/location\s*\.\s*(?:href|replace)\s*=\s*['"]([^'"]+)/);
        if (target) mirrors.push(target[1]);
      } catch (e) {
        // one bad mirror shouldn't kill the episode
      }
    }
    return mirrors;
  }

  async function scrapeEpisode({ title, season, episode }) {
    if (!tvDomains.length) return { provider: name, error: "no TV domains configured" };
    const { show, base: activeBase, jar } = await searchShows(title);
    if (!show) return { provider: name, error: `No TV show found for "${title}" on FzTVseries`, sources: [] };

    const seasonUrl = await findSeasonPage(show.url, jar, season);
    if (!seasonUrl) return { provider: name, post: show.url, error: `Season ${season} not found`, sources: [] };

    const episodes = await findEpisodeLinks(seasonUrl, jar, season, episode);
    if (!episodes.length) {
      return { provider: name, post: seasonUrl, error: `Episode S${season}E${episode} not found`, sources: [] };
    }

    const sources = [];
    const errors = [];
    for (const ep of episodes) {
      for (const epLink of ep.links) {
        const epUrl = `${activeBase}/${epLink}`;
        await paced();
        try {
          const dls = await episodeDownloadLinks(epUrl, jar);
          for (const dl of dls) {
            const mirrors = await resolveEpisode(dl, jar, epUrl);
            const isWebm = /ftype=3/.test(epLink);
            const label = `${ep.title}${isWebm ? " (WEBM)" : " (High MP4)"}`;
            for (const m of mirrors) {
              sources.push({ provider: name, url: m, label, quality: label, size: "", isEmbed: false });
            }
          }
        } catch (e) {
          errors.push(`${ep.title}: ${e.message}`);
        }
      }
    }
    return { provider: name, post: show.url, sources, errors };
  }

  return {
    name,
    label,
    domains,
    tvDomains,
    searchPosts,
    scrapeMovie,
    scrapeEpisode,
  };
}

export const fzmovies = makeFzmovies();
export default fzmovies;
