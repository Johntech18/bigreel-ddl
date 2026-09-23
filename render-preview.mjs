// render-preview.mjs - render real routes through the shared handler and
// write static preview files (with API data injected) for visual review.
import { handleRequest } from "./lib/app.mjs";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";

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
  return res.body || "";
}

// 1. Home page (fully server-rendered)
writeFileSync("preview-home.html", await get("/"));
console.log("wrote preview-home.html");

// 2. Results page: shell + live API JSON injected as INITIAL
const shell = await get("/dl/movie/533535");
const json = await get("/api/dl/movie/533535");
const withData = shell.replace(
  "const INITIAL = null;",
  "const INITIAL = " + JSON.stringify(JSON.parse(json)) + ";"
);
if (withData === shell) console.log("WARN: INITIAL marker not found in results shell");
writeFileSync("preview-results.html", withData);
console.log("wrote preview-results.html");
