# TheCrawler vs Firecrawl vs Apify Web Scraper

Last updated 2026-05-19. Capabilities originally verified 2026-04-28 against Firecrawl public docs and the official `apify/web-scraper` actor's input schema. **Do not claim MCP is exclusive to TheCrawler**: Firecrawl now documents MCP support, so TheCrawler positioning should lead on open source + self-hostable local use + structured errors + validated extraction contracts, not "MCP moat." **Real scraping capabilities only** — marketing features (SDKs, dashboards, billing) excluded.

## Capability matrix (28 rows)

| # | Capability | Firecrawl | Apify Web Scraper | TheCrawler 0.3.1 |
|---|---|---|---|---|
| 1 | Single-page scrape | ✓ | ✓ | ✓ |
| 2 | Multi-URL batch | ✓ `/batch/scrape` | ✓ `startUrls` | ✓ `urls[]` |
| 3 | Recursive crawl (depth/limit) | ✓ | ✓ | ✓ |
| 4 | Sitemap discovery | ✓ include/skip/only | ~ user-coded | ✓ `sitemapUrl`, sitemap-index resolution |
| 5 | Include/exclude URL patterns | ✓ regex | ✓ globs | ✓ globs |
| 6 | JS rendering / headless browser | ✓ default | ✓ Chromium | ✓ `usePlaywright` |
| 7 | **Adaptive (HTTP first, JS fallback)** | ✗ always JS | ✗ always JS | **✓ unique** |
| 8 | Markdown output (boilerplate-stripped) | ✓ `formats:markdown` | ✗ user-coded | ✓ `extractMarkdown` + `stripBoilerplate` |
| 9 | JSON-LD / microdata | ~ via formats:json+schema | ✗ user-coded | **✓ extractStructuredData + microdata + commerce + forms + analytics-detected** |
| 10 | **LLM-powered extraction (prompt+schema → typed JSON)** | ✓ `/extract` | ✗ | **✓ `extract()` (S11)** |
| 11 | Search → scrape | ✓ | ✗ | ✓ (with optional SerpAPI) |
| 12 | Browser actions (click/fill/wait/scroll) | ✓ | ✓ via pageFunction | ~ types defined, limited execution |
| 13 | Screenshot full-page | ✓ | ✓ | ~ flag exists |
| 14 | PDF parsing | ✓ | ~ user-coded | ✓ |
| 15 | DOCX / office docs | ? unverified | ✗ | ✓ |
| 16 | Stealth / proxy tiers (auto-escalate on block) | ✓ basic/auto/enhanced | ✓ via Apify Proxy + sessionPool | ~ single `proxyUrl`, no tiers |
| 17 | UA rotation | ~ implicit | ~ via session pool | **✓ explicit `rotateUserAgent`** |
| 18 | Anti-bot challenge page detection | ~ implicit in stealth | ✗ | **✓ `errorType: 'blocked-bot'`** |
| 19 | Retry / timeout config | ✓ | ✓ | ✓ `requestRetries`, `requestTimeoutSecs` |
| 20 | **Caching (TTL)** | ✓ `cacheMaxAge`, snapshots | ✗ | ✓ in-memory LRU |
| 21 | **Structured error taxonomy + retryable hint** | ~ string + status | ~ string + reason | **✓ `errorType` + `errorRetryable` + `fromCache`** |
| 22 | Change tracking / diff snapshots | ✓ | ✗ (separate Apify actor) | ✗ (separate Website Change Monitor actor) |
| 23 | Webhooks (async events) | ✓ | ~ via Apify platform | ✗ |
| 24 | Geo / location targeting | ✓ | ~ via proxy country | ✗ |
| 25 | Custom headers | ? | ✓ | ✓ `customHeaders` |
| 26 | **RAG-friendly chunking output** | ✗ | ✗ | **✓ `chunkSize` heading-aware** |
| 27 | **Out-of-box commerce/forms/analytics extractors** | ✗ | ✗ | **✓ unique** |
| 28 | Open source / self-hostable / zero per-call cost | ✓ AGPL hosted SaaS | ✗ closed | ✓ AGPL, agent-internal use is free |

**Sources:**
- Firecrawl: `docs.firecrawl.dev` — `/api-reference/v1-introduction`, `/features/scrape`, `/features/crawl`, `/features/batch-scrape`, `/features/extract`, `/features/search`, `/features/stealth-mode`, `/features/change-tracking`.
- Apify Web Scraper: `apify.com/apify/web-scraper/api`, `apify.com/apify/web-scraper/input-schema`.
- TheCrawler: this repository's `src/types.ts` (CrawlOptions = the public surface), `src/extract.ts`, `src/mcp.ts`, `src/server.ts`.

## Where TheCrawler **already beats** both

1. **Adaptive crawling (Cheerio→Playwright auto-fallback).** Firecrawl always JS-renders; Apify Web Scraper always uses Chromium. TheCrawler saves real cost on static sites — only escalates when an SPA shell is detected.

2. **Out-of-box domain extractors.** Commerce data (price/SKU/rating from JSON-LD Product), forms with field types, 16 analytics trackers detected (GA4, GTM, Meta Pixel, Hotjar, Segment, Mixpanel, Amplitude, Heap, Plausible, Matomo, Clarity, LinkedIn, Twitter, Pinterest, TikTok, etc.), microdata, hreflang, pagination, social links. Both competitors require user-written extraction code.

3. **Agent-friendly error contract.** `errorType` enum + `errorRetryable` boolean + `fromCache` boolean. Agents can `if (err.errorType === 'rate-limit' && err.retryable) backoff()` instead of regex-matching strings. Neither competitor exposes this from their public docs.

4. **RAG chunking baked in.** Heading-aware markdown chunking with overlap and per-chunk hash. Neither competitor.

5. **Open source + self-hostable + free internal use.** Firecrawl's hosted API charges per call; Apify charges per event. Calling `import { crawl } from 'thecrawler'` from your own agents has zero per-request cost.

## Where TheCrawler **trails**

1. **Stealth/proxy tiers.** Firecrawl auto-escalates basic→enhanced on block; Apify rotates `sessionPool` IPs. TheCrawler accepts a single `proxyUrl` — enough for friendly sites, falls behind on adversarial targets.
2. **Change tracking with diff snapshots.** Firecrawl persists prior crawl, returns `new|same|changed|removed`. TheCrawler delegates to a separate actor (Website Change Monitor) — different shape.
3. **Webhooks / async job model.** Firecrawl + Apify both support fire-and-forget jobs with event callbacks. TheCrawler is sync-only.
4. **Browser-action depth.** `executeJavascript` + PDF-from-action sequence (Firecrawl) and full Puppeteer (Apify) both go further than TheCrawler's `click/fill/scroll/wait/screenshot` types.
5. **Geo / location targeting.** Firecrawl exposes `location.country` + `languages`; TheCrawler relies on proxy country.

## Strategic note for future work

The five gaps above are operational concerns for adversarial-scale or platform-scale workloads. For open-source-agent-internal use (the primary positioning), they rarely matter. Stealth tiers and webhooks may even be overkill — flag them as deferred unless a real workload hits the limit.

The single highest-leverage feature added in S11 was **LLM-powered structured extraction** — that's the capability that flipped Firecrawl from "scraper" to "agent data-source," and it was the gap most likely to push agents to a competitor. Now closed.
