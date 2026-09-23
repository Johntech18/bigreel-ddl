// smoke-probe.mjs - hit the shared handler with a fake request and grep the HTML.
import { handleRequest } from "./lib/app.mjs";
import { EventEmitter } from "node:events";

function makeRes() {
  const r = new EventEmitter();
  r.headers = {};
  r.writeHead = (s, h) => { r.status = s; Object.assign(r.headers, h || {}); };
  r.end = (b) => { r.body = (r.body || "") + (b || ""); };
  return r;
}

async function get(path) {
  const req = { url: path, headers: { host: "localhost" } };
  const res = makeRes();
  await handleRequest(req, res);
  return { path, status: res.status, body: res.body || "" };
}

const probes = [
  ["/", ["FILE A REQUEST", "Anton", "IBM Plex Mono", "Carriers on file", "NAIJA PLUS", "How a request moves", "--paper:#F4F2EA"]],
  ["/find", ["What do you want to pull", "FILE A REQUEST"]],
  ["/dl/movie/533535", ["Printing manifest", "MANIFEST", "END OF MANIFEST"]],
  ["/find?q=deadpool", ["Printing manifest"]],
  ["/api/dl/movie/533535", []],
  ["/healthz", []],
];

let fail = 0;
for (const [path, markers] of probes) {
  const { status, body } = await get(path);
  const missing = markers.filter((m) => !body.includes(m));
  const ok = (status === undefined || status === 200) && missing.length === 0;
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${path}  (${status}, ${body.length}b)${missing.length ? "  missing: " + missing.join(", ") : ""}`);
}

// dark-theme leftovers must be gone
const home = (await get("/")).body;
for (const leftover of ["#0b1020", "#2196f3", "Fetching links from all servers", "Every server."]) {
  const gone = !home.includes(leftover);
  if (!gone) fail++;
  console.log(`${gone ? "PASS" : "FAIL"}  home has no "${leftover}"`);
}

console.log(fail === 0 ? "\nAll probes passed." : `\n${fail} probe(s) failed.`);
process.exit(fail === 0 ? 0 : 1);
