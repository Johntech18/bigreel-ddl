// server.mjs - standalone server entrypoint (also satisfies Vercel's
// entrypoint detection alongside api/index.mjs).
//
// The real handler lives in lib/app.mjs so the standalone server and the
// Vercel serverless function (api/index.mjs) share one implementation:
// every route, cache, and scraper behaves identically in both.

export { handleRequest as default, handleRequest } from "./lib/app.mjs";
