// Smoke test - exercises the nxsha protocol and the self-hosted scrapers
// against live sites. Usage: npm test   (needs network access)

import { encodeData, decodeData, getServers, getSources, getDirectLinks } from "./nxsha.mjs";
import { searchQuery, normalizeTitle } from "./scrapers/base.mjs";
import { filmyfly } from "./scrapers/filmyfly.mjs";
import { hdhub4u } from "./scrapers/hdhub4u.mjs";
import { a111477 } from "./scrapers/a111477.mjs";
import { cinextream } from "./scrapers/cinextream.mjs";
import { pahe, resolveToken } from "./scrapers/pahe.mjs";
import { movierulz } from "./scrapers/movierulz.mjs";
import { mynetnaija } from "./scrapers/mynetnaija.mjs";
import { naijaprey } from "./scrapers/naijaprey.mjs";
import { movie02 } from "./scrapers/02movie.mjs";
import { scoreCandidate, mergeProviders } from "./scrapers/index.mjs";
import { resolveFilesdl } from "./scrapers/filesdl.mjs";
import http from "node:http";

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + extra}`);
  if (!cond) failures++;
};
const skip = (name, why) => console.log(`SKIP  ${name}  (${why})`);
// Live-upstream check: run fn; on a network failure report SKIP instead of
// crashing the whole suite (sandbox egress to nxsha.app is flaky).
const netCheck = async (name, fn, ok) => {
  try {
    const v = await fn();
    check(name, ok(v));
  } catch (err) {
    skip(name, err?.cause?.code || err?.code || err.message);
  }
};

// --- unit: helpers ------------------------------------------------------------
{
  check("searchQuery strips punctuation", searchQuery("Spider-Man: Brand New Day") === "spider man brand new day");
  check("normalizeTitle folds case/punct", normalizeTitle("Star Wars: Ep. IV - A New Hope") === "star wars ep iv a new hope");
  const exact = { tmdbId: "1", type: "movie", title: "Spider-Man: Brand New Day", year: "2026" };
  const other = { tmdbId: "2", type: "movie", title: "Spider-Man: No Way Home", year: "2021" };
  const tv = { tmdbId: "3", type: "tv", title: "Spider-Man: Brand New Day", year: "2026" };
  check("scoreCandidate: exact match beats partial",
    scoreCandidate(exact, "spider man brand new day", {}) > scoreCandidate(other, "spider man brand new day", {}));
  check("scoreCandidate: year nudge",
    scoreCandidate(exact, "spider man", { year: "2026" }) > scoreCandidate(other, "spider man", { year: "2026" }));
  check("scoreCandidate: tv preference when episode requested",
    scoreCandidate(tv, "spider man", { wantTv: true }) > scoreCandidate(exact, "spider man", { wantTv: true }));
}

// --- nxsha proxy --------------------------------------------------------------
{
  const enc = encodeData({ tmdbId: "969681", type: "movie", method: "dl" });
  check("encodeData/decodeData round trip", decodeData(enc)?.tmdbId === "969681");
}
await netCheck("getServers returns server list",
  () => getServers({ tmdbId: "969681", type: "movie" }),
  (body) => Array.isArray(body.servers) && body.servers.length > 0);
await netCheck("getSources returns urls from at least one provider",
  async () => {
    const { servers } = await getServers({ tmdbId: "969681", type: "movie" });
    for (const s of servers.slice(0, 4)) {
      const body = await getSources({ tmdbId: "969681", type: "movie" }, s.scraper || String(s.id));
      if (body.sources?.length) return true;
    }
    return false;
  },
  (v) => v === true);
await netCheck("getDirectLinks covers all providers",
  () => getDirectLinks({ tmdbId: "1396", type: "tv", season: "1", episode: "1" }, { concurrency: 4 }),
  ({ servers }) => servers.length > 0);

// --- merged providers (pure) --------------------------------------------------
{
  const self = [
    { provider: "filmyfly", sources: [{ url: "a" }], post: "p1" },
    { provider: "hdhub4u", sources: [], error: "x" },
  ];
  const nxsha = [
    { provider: "mbox", server: { name: "MbPly-[Multi-Lang]" }, sources: [{ url: "b" }], error: null },
    { provider: "hdhub4u", server: { name: "4k-bk" }, sources: [{ url: "c" }], error: null },
  ];
  const merged = mergeProviders(self, nxsha);
  check("mergeProviders: both sources present",
    merged.length === 4 && merged.filter((p) => p.source === "self").length === 2 && merged.filter((p) => p.source === "nxsha").length === 2);
  check("mergeProviders: same-named scrapers stay distinct via name",
    merged.filter((p) => p.provider === "hdhub4u").length === 2 &&
    merged.find((p) => p.source === "nxsha" && p.provider === "hdhub4u")?.name === "4k-bk");
}

// --- filesdl resolver (hermetic: mock flaresolverr, no network) ---------------
{
  const solvedHtml = `<!doctype html><html><body><h1>Spider-Man 1080p.mkv</h1>
    <a class="download" href="https://cdn.filesdl.top/files/x9Y2k1/Spider-Man.2026.1080p.mkv?token=abc">Download</a>
  </body></html>`;
  const mock = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const j = JSON.parse(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", solution: { status: 200, url: j.url, response: solvedHtml } }));
    });
  });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  const port = mock.address().port;
  const url = "https://new6.filesdl.top/cloud/t35ul8LQEF"; // real host; mock never touches it
  const solved = await resolveFilesdl(url, { flareSolverrUrl: `http://127.0.0.1:${port}` });
  check("filesdl: flaresolverr path extracts direct url",
    solved.locked === false && solved.via === "flaresolverr" && /1080p\.mkv/.test(solved.url));
  const unsolved = await resolveFilesdl(url, { flareSolverrUrl: null });
  check("filesdl: no solver -> locked with diagnostic",
    unsolved.locked === true && /cloudflare/i.test(unsolved.note || ""));
  mock.close();
}

// --- pahe shortlink token decoder (pure, no network) --------------------------
{
  check("resolveToken decodes a trailing-base64 token",
    resolveToken("a264ca36df7661c3fcb23ee7045a57e5a2a4befa2026cBtbFoKc1508aHR0cHM6Ly9tZWdhLm56L2ZpbGUvQ3hKV21BQUwjRWpQZVpQNkhyNGtta05UT2xLdmN3bmxWeU5yNm5qQzVVa3B0QjR5T3pJOA==") === "https://mega.nz/file/CxJWmAAL#EjPeZP6Hr4kmkNTOlKvcwnlVyNr6njC5UkptB4yOzI8");
  check("resolveToken handles a second token shape (gdflix)",
    resolveToken("837a59e55cfe935aefe694f93b987a445287e74320260fS7wXxRBj61508aHR0cHM6Ly9nZGZsaXguZGV2L2ZpbGUvQlhqb1o0Y20wamdtbFJD") === "https://gdflix.dev/file/BXjoZ4cm0jgmlRC");
  check("resolveToken returns null for junk", resolveToken("not-a-token") === null && resolveToken("") === null);
}

// --- self-hosted scrapers -----------------------------------------------------
const SPIDER = { title: "Spider-Man: Brand New Day", year: "2026" };

{
  const { posts } = await filmyfly.searchPosts(SPIDER.title, SPIDER.year);
  check("filmyfly search finds post", posts.length > 0, JSON.stringify(posts).slice(0, 150));
  if (posts.length) {
    const r = await filmyfly.scrapeMovie(SPIDER);
    console.log(`INFO  filmyfly: ${r.sources.length} sources, ${(r.errors || []).length} errors`);
    check("filmyfly resolves some direct links", r.sources.length > 0,
      `errors: ${(r.errors || []).slice(0, 3).join(" | ")}`);
  }
}

{
  // hdhub4u mirrors rotate and often block datacenter IPs; use a title that is
  // guaranteed to be in their catalog (Jurassic World: Rebirth is currently
  // listed on hdhub4u.world). If every mirror is down/blocked -> SKIP, not FAIL.
  const JW = { title: "Jurassic World: Rebirth", year: "2025" };
  const r = await hdhub4u.searchPosts(JW.title, JW.year);
  if (r.error) {
    skip("hdhub4u search finds post", r.error);
  } else {
    check("hdhub4u search finds post", r.posts.length > 0, JSON.stringify(r.posts).slice(0, 150));
    if (r.posts.length) {
      const m = await hdhub4u.scrapeMovie(JW);
      console.log(`INFO  hdhub4u: ${m.sources.length} sources (locked: ${m.sources.filter((s) => s.locked).length})`);
      check("hdhub4u extracts quality links from post", m.sources.length > 0);
    }
  }
}

{
  // a111477: indexer - use a movie that is known to be listed (No Way Home).
  const r = await a111477.scrapeMovie({ title: "Spider-Man: No Way Home", year: "2021" });
  console.log(`INFO  a111477: ${r.sources.length} sources (locked: ${r.sources.filter((s) => s.locked).length})`);
  check("a111477 indexes movie files with size/quality", r.sources.length > 0 && r.sources[0].size !== undefined);
  // The indexer 429s on bursts; retry with a pause before giving up.
  let e = null;
  for (let attempt = 1; attempt <= 3 && !e; attempt++) {
    try {
      e = await a111477.scrapeEpisode({ title: "Bad Blood", season: "1", episode: "1" });
    } catch (err) {
      e = { sources: [], error: err.message, attempt };
    }
    if (e?.error && attempt < 3) {
      console.log(`INFO  a111477 tv attempt ${attempt} failed (${e.error}); retrying…`);
      e = null;
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }
  console.log(`INFO  a111477 tv: ${e.sources.length} sources ${e.error ? `(retry needed: ${e.error})` : ""}`);
  check("a111477 finds tv episodes by S/E", e.sources.length > 0, e.error || "");
}

{
  // pahe: metadata-only provider - search + download box extraction. Every
  // source is a locked external shortener by design (no direct files).
  const m = await pahe.scrapeMovie({ title: "Deadpool & Wolverine", year: "2024" });
  if (m.error) {
    skip("pahe finds post and extracts download box", m.error);
  } else {
    console.log(`INFO  pahe: ${m.sources.length} sources (locked: ${m.sources.filter((s) => s.locked).length})`);
    check("pahe extracts quality/mirror metadata", m.sources.length > 0 && m.sources[0].quality !== undefined && m.sources[0].host !== undefined);
    // Every source is either an unresolved locked shortener or a resolved
    // file-host URL - never a bare shortener with locked:false.
    const bad = m.sources.filter((s) => !s.locked && /tpi\.li|oii\.la|tei\.ai|uii\.io|ouo\.io|exe\.io|aylink/.test(s.url || ""));
    check("pahe resolved sources point at real file hosts", bad.length === 0);
    const f = await pahe.scrapeMovie({ title: "Deadpool & Wolverine", year: "2024", minQuality: "1080p" });
    if (f.error) {
      skip("pahe min_quality filters sources", f.error);
    } else {
      console.log(`INFO  pahe min_quality=1080p: ${f.sources.length} sources (unfiltered: ${m.sources.length})`);
      check("pahe min_quality keeps only 1080p+",
        f.sources.length > 0 && f.sources.length < m.sources.length && f.sources.every((s) => /1080p|2160p|4k/i.test(s.quality || "")));
    }
  }
}

{
  // pahe shortlink resolution (live): a current post's tpi.li links should
  // decode to real file hosts (mega.nz / gdflix.dev / send.now …).
  const a = await pahe.scrapeMovie({ title: "Animal Farm", year: "2026" });
  if (a.error) {
    skip("pahe resolves shortener tokens to file hosts", a.error);
  } else {
    const open = a.sources.filter((s) => !s.locked);
    console.log(`INFO  pahe shortlinks: ${open.length}/${a.sources.length} resolved (${[...new Set(open.map((s) => new URL(s.url).hostname))].join(", ")})`);
    check("pahe unlocks at least one shortener token", open.length > 0 && open.every((s) => /^https?:\/\//.test(s.url)));
  }
}

{
  // cinextream: TMDB-id API with wasm-decrypted responses pointing at
  // a.111477.xyz files (same indexer, better frontend).
  const m = await cinextream.scrapeMovie({ tmdbId: "533535", title: "Deadpool & Wolverine" });
  if (m.error) {
    skip("cinextream movie resolves files", m.error);
  } else {
    console.log(`INFO  cinextream: ${m.sources.length} sources (locked: ${m.sources.filter((s) => s.locked).length})`);
    check("cinextream movie resolves wasm-decrypted files", m.sources.length > 0 && !!m.sources[0].quality);
    const e = await cinextream.scrapeEpisode({ tmdbId: "1396", season: "1", episode: "1" });
    if (e.error) {
      skip("cinextream tv resolves episode", e.error);
    } else {
      check("cinextream tv resolves episode files", e.sources.length > 0);
    }
  }
}

{
  // movierulz: Indian site (5movierulz.watch). Search is unavailable
  // server-side (?s= is Cloudflare-gated, ?search= ignores the query), so
  // discovery walks category pages. Torrent magnets are direct links; the
  // streaming mirror cards are external file hosts -> locked.
  const m = await movierulz.scrapeMovie({ title: "Vadala", year: "2026" });
  if (m.error) {
    skip("movierulz finds post and extracts links", m.error);
  } else {
    console.log(`INFO  movierulz: ${m.sources.length} sources (locked: ${m.sources.filter((s) => s.locked).length})`);
    check("movierulz extracts torrent magnets", m.sources.some((s) => s.url.startsWith("magnet:")));
    check("movierulz magnets carry quality + size",
      m.sources.filter((s) => s.url.startsWith("magnet:")).every((s) => s.quality && s.size));
    const streaming = m.sources.filter((s) => !s.url.startsWith("magnet:"));
    check("movierulz streaming mirrors are locked file hosts",
      streaming.every((s) => s.locked === true));
    const f = await movierulz.scrapeMovie({ title: "Vadala", year: "2026", minQuality: "1080p" });
    if (f.error) {
      skip("movierulz min_quality filters sources", f.error);
    } else {
      check("movierulz min_quality keeps 1080p+ magnets",
        f.sources.filter((s) => s.url.startsWith("magnet:")).every((s) => /1080p|2160p|4k/i.test(s.quality || "")));
    }
  }
  const e = await movierulz.scrapeEpisode({ title: "The Legend of Karna", year: "2026", season: 1, episode: 1 });
  if (e.error) {
    skip("movierulz finds tv season pack", e.error);
  } else {
    console.log(`INFO  movierulz tv: ${e.sources.length} sources (locked: ${e.sources.filter((s) => s.locked).length})`);
    check("movierulz tv finds season-pack magnets", e.sources.some((s) => s.url.startsWith("magnet:")));
  }
}

{
  // mynetnaija: WordPress site with WP REST API. Movies only, downloads via
  // meetdownload.com links extracted from /episode-download/ pages (which
  // return HTTP 404 but still serve valid content).
  const m = await mynetnaija.scrapeMovie({ title: "Ghost In The Cell", year: "2026" });
  if (m.error) {
    skip("mynetnaija finds post and extracts links", m.error);
  } else {
    console.log(`INFO  mynetnaija: ${m.sources.length} sources (locked: ${m.sources.filter((s) => s.locked).length})`);
    check("mynetnaija finds post via WP REST API", m.sources.length > 0);
    check("mynetnaija extracts meetdownload links",
      m.sources.some((s) => /meetdownload\.com/.test(s.url)));
    check("mynetnaija resolves direct links from kissorgrab",
      m.sources.some((s) => /kissorgrab\.com/.test(s.url) && !s.locked));
    check("mynetnaija extracts waploaded links",
      m.sources.some((s) => /waploaded/.test(s.label || s.url)));
    check("mynetnaija sources carry file size",
      m.sources.some((s) => s.size !== null && s.size !== undefined));
  }
  // Also test search
  const posts = await mynetnaija.searchPosts("Mutiny", "2026");
  check("mynetnaija search finds posts", posts.length > 0, JSON.stringify(posts).slice(0, 100));
}

{
  // naijaprey: WordPress site with download chain: naijaprey -> np-downloader -> wildshare.net
  const m = await naijaprey.scrapeMovie({ title: "Mutiny", year: "2026" });
  if (m.error) {
    skip("naijaprey finds post and extracts links", m.error);
  } else {
    console.log(`INFO  naijaprey: ${m.sources.length} sources (locked: ${m.sources.filter((s) => s.locked).length})`);
    check("naijaprey finds post via WP REST API", m.sources.length > 0);
    check("naijaprey extracts wildshare.net links",
      m.sources.some((s) => /wildshare\.net/.test(s.url)));
    check("naijaprey sources carry file size",
      m.sources.some((s) => s.size !== null && s.size !== undefined));
  }
  // Also test series
  const e = await naijaprey.scrapeEpisode({ title: "Deep Revenge", season: 1, episode: 1 });
  if (e.error) {
    skip("naijaprey finds series episodes", e.error);
  } else {
    check("naijaprey series finds episode links",
      e.sources.length > 0 && e.sources.some((s) => /wildshare\.net/.test(s.url)));
  }
}

{
  // 02movie: TMDB-ID-based encrypted API + download server. Movies only.
  const m = await movie02.scrapeMovie({ tmdbId: "533535", title: "Deadpool & Wolverine" });
  if (m.error) {
    skip("02movie movie resolves links", m.error);
  } else {
    console.log(`INFO  02movie: ${m.sources.length} sources (locked: ${m.sources.filter((s) => s.locked).length})`);
    check("02movie movie finds direct links", m.sources.length > 0 && m.sources[0].url);
    check("02movie movie sources carry quality",
      m.sources.some((s) => s.quality !== undefined && s.quality !== null));
  }
  // TV test: Breaking Bad S01E01
  const e = await movie02.scrapeEpisode({ tmdbId: "1396", season: "1", episode: "1", title: "Breaking Bad" });
  if (e.error) {
    skip("02movie tv resolves episode", e.error);
  } else {
    check("02movie tv finds episode links", e.sources.length > 0);
  }
}

// --- merged find (live, needs TMDB_API_KEY) -----------------------------------
if (process.env.TMDB_API_KEY) {
  const { findAndScrapeMerged } = await import("./scrapers/index.mjs");
  const r = await findAndScrapeMerged({ q: "spider-man brand new day" });
  console.log(`INFO  merged find: match=${r.match?.title || "?"}, providers=${(r.providers || []).length} (self=${(r.providers || []).filter((p) => p.source === "self").length}, nxsha=${(r.providers || []).filter((p) => p.source === "nxsha").length})`);
  check("merged find includes self + nxsha providers",
    (r.providers || []).some((p) => p.source === "self") && (r.providers || []).some((p) => p.source === "nxsha"));
} else {
  console.log("SKIP  merged-find live test (set TMDB_API_KEY to enable)");
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
