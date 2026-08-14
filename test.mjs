// Smoke test — exercises the nxsha protocol against the live site.
// Usage: npm test   (needs network access)

import { encodeData, decodeData, getServers, getSources, getDirectLinks } from "./nxsha.mjs";

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + extra}`);
  if (!cond) failures++;
};

// 1. encodeData -> decodeData round trip
{
  const enc = encodeData({ tmdbId: "969681", type: "movie", method: "dl" });
  const dec = decodeData(enc);
  check("encodeData/decodeData round trip", dec?.tmdbId === "969681" && dec?.method === "dl");
}

// 2. live: fetch servers for a movie
{
  const body = await getServers({ tmdbId: "969681", type: "movie" });
  check("getServers returns server list", Array.isArray(body.servers) && body.servers.length > 0,
    JSON.stringify(body).slice(0, 200));
}

// 3. live: fetch sources from first working provider
{
  const { servers } = await getServers({ tmdbId: "969681", type: "movie" });
  let found = false;
  for (const s of servers.slice(0, 4)) {
    const provider = s.scraper || String(s.id);
    const body = await getSources({ tmdbId: "969681", type: "movie" }, provider);
    if (body.sources?.length) {
      check(`getSources from "${provider}" returns urls`, typeof body.sources[0].url === "string" && body.sources[0].url.startsWith("http"));
      found = true;
      break;
    }
  }
  if (!found) check("at least one provider has sources", false, "no provider returned links");
}

// 4. live: combined endpoint (concurrency + error handling)
{
  const { servers } = await getDirectLinks({ tmdbId: "1396", type: "tv", season: "1", episode: "1" }, { concurrency: 4 });
  check("getDirectLinks covers all providers", servers.length > 0, "no servers");
  const any = servers.some((s) => s.sources.length > 0);
  console.log(`INFO  providers probed: ${servers.length}, with links: ${servers.filter((s) => s.sources.length).length}`);
  check("getDirectLinks finds some tv links", any, "none found for Breaking Bad S1E1");
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
