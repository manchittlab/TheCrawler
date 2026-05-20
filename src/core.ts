// REMOVED 2026-04-28 (S11): all scraping logic now lives in the `thecrawler` npm package
// (source snapshot in this repo: engine/src/engine.ts).
// This actor's src/main.ts imports `crawlStream` from `thecrawler` directly.
// To modify scraping behavior, edit the engine source, repack `thecrawler`,
// bump the local tarball in package.json, then redeploy this actor.
export {};
