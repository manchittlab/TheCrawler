# TheCrawler — AI-ready web scraper with validated extraction contracts

Scrape web pages, run LLM-powered structured extraction, or diagnose whether URLs are ready for a built-in extraction contract before spending LLM tokens. Open source engine (AGPL-3.0). $0.005 per successfully scraped page on Apify.

Start with a safe test: run one public URL with `dryRun: true` on Apify, or clone the current GitHub source and run the local CLI/MCP build from `engine/`. Need to know whether a real public source is worth automating? Open a public fit check in the [$500 extraction readiness sprint](https://github.com/manchittlab/TheCrawler/issues/1). A small proof pack is in [`examples/diagnostic-challenge`](examples/diagnostic-challenge).

## What makes this different

- **Validated extraction contracts**: select a built-in contract, get normalized data plus `validation.valid`, required fields, and missing-field evidence. Current contracts: `real-estate-listing`, `product-page`.
- **No-LLM diagnostics**: run `diagnoseMode` to score source readiness, identify blockers, and save a buyer-readable Markdown report before extraction.
- **LLM-powered extraction**: send a JSON Schema or use a contract, get parsed typed data back. Endpoint-agnostic — point at OpenAI, your own llama.cpp / vLLM / LM Studio / Ollama. You bring the LLM, no vendor lock-in.
- **Adaptive crawling**: Cheerio first (fast HTTP+parse), auto-fall-back to Playwright when an SPA shell is detected. Keeps browser rendering optional instead of mandatory for every page.
- **Structured errors**: `errorType` enum (`dns | timeout | rate-limit | blocked-bot | js-required | http-4xx | http-5xx | parse | network | unknown`) + `errorRetryable` boolean. Agents branch programmatically — no regex on error strings.
- **Anti-bot detection**: 200 OK responses with Cloudflare/WAF challenge bodies are flagged as `errorType: 'blocked-bot'` instead of returning the challenge HTML.
- **Out-of-box extractors**: JSON-LD, microdata, commerce data (price/SKU/rating), forms with field types, 16 analytics trackers detected (GA4, GTM, Meta Pixel, Hotjar, Segment, Mixpanel, etc.), hreflang, pagination, redirect chain.
- **Heading-aware RAG chunking**: markdown chunked at h1-h3 boundaries with overlap and per-chunk SHA. Feed straight to a vector DB.

## Three modes

### Safe first run

Use `dryRun: true` for an Apify smoke test. The actor crawls the page but does not emit a billing event.

```json
{
  "urls": ["https://example.com"],
  "extractMarkdown": true,
  "dryRun": true
}
```

For the current local MCP/CLI build:

```bash
git clone https://github.com/manchittlab/TheCrawler.git
cd TheCrawler/engine
npm install
npm run build
node dist/cli.js crawl https://example.com --markdown
```

### Plain crawl (default)

```json
{
  "urls": ["https://example.com"],
  "extractMarkdown": true,
  "rotateUserAgent": true,
  "requestRetries": 3
}
```

Returns rich `PageData` per URL: title, description, language, canonical URL, robots directives, full text, boilerplate-stripped markdown, links (with internal/external flag), images (with lazy-load src), meta tags, OG/Twitter Card, JSON-LD, microdata, commerce data, forms, analytics-detected, emails, phones, social links, hreflang, pagination, redirect chain, response headers + timing, plus structured `errorType` + `errorRetryable` on failure.

### LLM-powered extract mode

```json
{
  "urls": ["https://shop.example.com/products/123"],
  "extractMode": true,
  "extractJsonSchema": {
    "type": "object",
    "properties": {
      "productName": { "type": "string" },
      "price": { "type": "number" },
      "currency": { "type": "string" },
      "inStock": { "type": "boolean" }
    },
    "required": ["productName"]
  },
  "llmBaseUrl": "https://api.openai.com/v1/chat/completions",
  "llmModel": "gpt-4o-mini"
}
```

Crawls the URL → cleans to markdown → sends `(markdown + schema)` to your OpenAI-compatible chat-completions endpoint → returns parsed typed data per URL. Schema-backed extraction uses JSON Schema response format where supported, with fallbacks for endpoints that only support JSON-object or text output. Supports natural-language `extractPrompt` instead of/alongside the schema. The actor charges per page like normal; the LLM call cost is whatever your endpoint charges.

> **Note**: extract mode requires a publicly-reachable LLM endpoint. LAN URLs (e.g. `http://192.168.x.x`) are not reachable from Apify infrastructure. Use OpenAI, hosted vLLM, or expose your local server via a tunnel.

> Set `THECRAWLER_LLM_API_KEY` as an Actor environment variable so the LLM key never lands in run inputs (visible in run history).

### Contract diagnostic mode

```json
{
  "urls": ["https://example.com/listing-1", "https://example.com/listing-2"],
  "diagnoseMode": true,
  "extractContract": "real-estate-listing",
  "diagnosticReport": true
}
```

Runs crawl + readiness scoring without an LLM call. Dataset output includes per-URL `verdict`, `readyForExtraction`, `score`, `blockers`, `warnings`, and `recommendedNextStep`, plus a workflow summary. When `diagnosticReport` is true, the actor saves `contract-diagnostic-report` in the run key-value store as Markdown with a missing-readiness-signal summary. The report intentionally excludes raw extracted contact details.

### Contract extract mode

```json
{
  "urls": ["https://example.com/listing-1"],
  "extractMode": true,
  "extractContract": "product-page",
  "llmBaseUrl": "https://api.openai.com/v1/chat/completions",
  "llmModel": "gpt-4o-mini"
}
```

Uses the selected contract schema and prompt, then appends contract validation to the extraction result. Agents can branch on `validation.valid` and `validation.missingRequiredFields` instead of trusting loose markdown. Built-in contracts currently cover `real-estate-listing` and `product-page`.

## Reliability features

| Feature | Default | Why |
|---|---|---|
| `requestRetries` | 3 | Transient failures (5xx, network, timeout) auto-retried |
| `requestTimeoutSecs` | 30 | Cap on per-request time |
| `rotateUserAgent` | true | Cycles through 6 real-browser UA strings |
| `cacheEnabled` | false | Opt-in 5-min in-memory LRU per (URL + extract-flags) |
| Anti-bot challenge detection | always on | Flags Cloudflare/WAF challenge bodies as `errorType: 'blocked-bot'` |
| Adaptive crawl | opt-in | `adaptiveCrawling: true` tries Cheerio first, escalates to Playwright on SPA detection |

## Search → scrape

Top-N Google results crawled in one call. Optional SerpAPI key for reliable search.

```json
{ "searchQuery": "best CRM 2026", "searchLimit": 10, "extractMarkdown": true }
```

## Sitemap → scrape

Sitemap.xml + sitemap-index files resolved automatically.

```json
{ "sitemapUrl": "https://example.com/sitemap.xml", "maxPages": 50 }
```

## File extraction

PDF and DOCX URLs are auto-detected and parsed. Returns extracted text + (for PDFs) metadata, page count.

## Pricing

- **Crawl mode**: $0.005 per page successfully scraped (failed pages don't charge).
- **Extract mode / diagnostic mode**: still charged per successfully scraped page. LLM endpoint cost is paid by the endpoint owner, not by this actor.
- **Extraction readiness sprint**: $500 after fit confirmation for one public workflow, up to 25 public URLs, one target output shape, and a 24-hour ready / mixed / blocked report. If the workflow continues into setup or hosted usage, the $500 is credited toward that next step. If another stack is a better fit, the report says so.

## Beyond the Apify Store

The current open-source engine source for this actor build is in `engine/`; drop it into your own Node project, MCP server, CLI, or REST API server. The published npm package is older than this GitHub source until the next npm publish, so use the GitHub-source path below for current validated-contract and MCP tools. Self-hosting avoids Apify per-page charges, while your own infrastructure and LLM endpoint costs still apply.

```bash
# Current GitHub source build
cd engine
npm install
npm run build

# CLI
node dist/cli.js crawl https://example.com --markdown
node dist/cli.js extract https://example.com --schema '{...}'

# MCP server (Cline, Claude Code, Cursor, Windsurf)
node dist/mcp.js

# REST API server
THECRAWLER_API_KEY=local_test_key node dist/server.js --port 3000
curl -H "Authorization: Bearer local_test_key" \
  "http://localhost:3000/v1/contracts?includeSchema=true"
curl -X POST "http://localhost:3000/v1/scrape" \
  -H "Authorization: Bearer local_test_key" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/product","formats":["markdown","metadata","links","structuredData","commerceData"]}'
curl -X POST "http://localhost:3000/v1/diagnose" \
  -H "Authorization: Bearer local_test_key" \
  -H "Content-Type: application/json" \
  -d '{"contractName":"product-page","urls":["https://example.com/product"],"reportMarkdown":true}'
curl -X POST "http://localhost:3000/v1/map" \
  -H "Authorization: Bearer local_test_key" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com","maxPages":1}'
curl -X POST "http://localhost:3000/v1/extract-contract" \
  -H "Authorization: Bearer local_test_key" \
  -H "Content-Type: application/json" \
  -d '{"contractName":"product-page","urls":["https://example.com/product"],"llmBaseUrl":"http://localhost:1234/v1/chat/completions","llmModel":"qwen/qwen3.5-9b"}'

# Older npm package; use for plain crawl only until the next publish
npm install thecrawler
thecrawler crawl https://example.com --markdown
thecrawler extract https://example.com --schema '{...}'
```

For Cline setup from a GitHub clone, use [`llms-install.md`](llms-install.md). The current GitHub source is the review path for validated contracts and MCP tools until npm is updated.

GitHub: https://github.com/manchittlab/TheCrawler · License: AGPL-3.0
