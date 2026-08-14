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
{
  const body = await getServers({ tmdbId: "969681", type: "movie" });
  check("getServers returns server list", Array.isArray(body.servers) && body.servers.length > 0);
}
{
  const { servers } = await getServers({ tmdbId: "969681", type: "movie" });
  let found = false;
  for (const s of servers.slice(0, 4)) {
    const body = await getSources({ tmdbId: "969681", type: "movie" }, s.scraper || String(s.id));
    if (body.sources?.length) { found = true; break; }
  }
  check("getSources returns urls from at least one provider", found);
}
{
  const { servers } = await getDirectLinks({ tmdbId: "1396", type: "tv", season: "1", episode: "1" }, { concurrency: 4 });
  check("getDirectLinks covers all providers", servers.length > 0);
}

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
  const { posts } = await hdhub4u.searchPosts(SPIDER.title, SPIDER.year);
  check("hdhub4u search finds post", posts.length > 0, JSON.stringify(posts).slice(0, 150));
  if (posts.length) {
    const r = await hdhub4u.scrapeMovie(SPIDER);
    console.log(`INFO  hdhub4u: ${r.sources.length} sources (locked: ${r.sources.filter((s) => s.locked).length})`);
    check("hdhub4u extracts quality links from post", r.sources.length > 0);
  }
}

{
  // a111477: indexer — use a movie that is known to be listed (No Way Home).
  const r = await a111477.scrapeMovie({ title: "Spider-Man: No Way Home", year: "2021" });
  console.log(`INFO  a111477: ${r.sources.length} sources (locked: ${r.sources.filter((s) => s.locked).length})`);
  check("a111477 indexes movie files with size/quality", r.sources.length > 0 && r.sources[0].size !== undefined);
  const e = await a111477.scrapeEpisode({ title: "Bad Blood", season: "1", episode: "1" });
  console.log(`INFO  a111477 tv: ${e.sources.length} sources`);
  check("a111477 finds tv episodes by S/E", e.sources.length > 0);
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
