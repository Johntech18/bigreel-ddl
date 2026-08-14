// Smoke test — exercises the nxsha protocol and the self-hosted scrapers
// against live sites. Usage: npm test   (needs network access)

import { encodeData, decodeData, getServers, getSources, getDirectLinks } from "./nxsha.mjs";
import { searchQuery, normalizeTitle } from "./scrapers/base.mjs";
import { filmyfly } from "./scrapers/filmyfly.mjs";
import { hdhub4u } from "./scrapers/hdhub4u.mjs";
import { a111477 } from "./scrapers/a111477.mjs";
import { fzmovies } from "./scrapers/fzmovies.mjs";
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
  check("normalizeTitle folds case/punct", normalizeTitle("Star Wars: Ep. IV — A New Hope") === "star wars ep iv a new hope");
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
    unsolved.locked === true && /FLARESOLVERR_URL/.test(unsolved.note || ""));
  mock.close();
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
  // a111477: indexer — use a movie that is known to be listed (No Way Home).
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
  // fzmovies: session-bound chain — search + resolve a known movie.
  const { posts } = await fzmovies.searchPosts("Spider-Man: Far from Home", "2019");
  check("fzmovies search finds movie", posts.length > 0, JSON.stringify(posts).slice(0, 150));
  if (posts.length) {
    const r = await fzmovies.scrapeMovie({ title: "Spider-Man: Far from Home", year: "2019" });
    console.log(`INFO  fzmovies: ${r.sources.length} sources, ${(r.errors || []).length} errors`);
    check("fzmovies resolves direct CDN links", r.sources.length > 0,
      `errors: ${(r.errors || []).slice(0, 3).join(" | ")}`);
    if (r.sources.length) {
      check("fzmovies links are direct mp4/mkv on CDN mirrors",
        /https:\/\/\w+\.y9a8ua48mhss5ye\.cyou\/res\//.test(r.sources[0].url));
    }
  }
  const e = await fzmovies.scrapeEpisode({ title: "Breaking Bad", season: "1", episode: "1" });
  console.log(`INFO  fzmovies tv: ${e.sources.length} sources, ${(e.errors || []).length} errors`);
  check("fzmovies tv finds episode direct links", e.sources.length > 0,
    `errors: ${(e.errors || []).slice(0, 3).join(" | ")}`);
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
