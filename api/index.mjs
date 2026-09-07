// api/index.mjs - Vercel serverless function.
//
// Reuses the exact same request handler as the standalone server (server.mjs)
// so the deployed behavior matches `node server.mjs`. All routes are rewritten
// to this one function via vercel.json.
//
// Note: scrapes hit live source sites and can take 10-30 s, so maxDuration is
// set in vercel.json (60 s - the Hobby plan ceiling; raise it if on Pro).
// The in-memory cache lives per serverless instance, so cold starts re-scrape;
// environment variables (TMDB_API_KEY etc.) must be set in the Vercel project.

import handleRequest from "../lib/app.mjs";

export default handleRequest;
