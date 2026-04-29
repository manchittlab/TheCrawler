# TheCrawler — AI-ready web scraper with LLM-powered structured extraction

Scrape any URL and get rich structured data, or extract typed JSON via your own LLM in one call. Open source (AGPL-3.0). $0.005 per page.

## What makes this different

- **LLM-powered extraction**: send a JSON Schema, get parsed typed data back. Endpoint-agnostic — point at OpenAI, your own llama.cpp / vLLM / LM Studio / Ollama. You bring the LLM, no vendor lock-in.
- **Adaptive crawling**: Cheerio first (fast HTTP+parse), auto-fall-back to Playwright when an SPA shell is detected. Saves real cost on static sites — competitors render JS on every page.
- **Structured errors**: `errorType` enum (`dns | timeout | rate-limit | blocked-bot | js-required | http-4xx | http-5xx | parse | network | unknown`) + `errorRetryable` boolean. Agents branch programmatically — no regex on error strings.
- **Anti-bot detection**: 200 OK responses with Cloudflare/WAF challenge bodies are flagged as `errorType: 'blocked-bot'` instead of returning the challenge HTML.
- **Out-of-box extractors**: JSON-LD, microdata, commerce data (price/SKU/rating), forms with field types, 16 analytics trackers detected (GA4, GTM, Meta Pixel, Hotjar, Segment, Mixpanel, etc.), hreflang, pagination, redirect chain. Both Firecrawl and the standard Apify Web Scraper require user-written code for any of these.
- **Heading-aware RAG chunking**: markdown chunked at h1-h3 boundaries with overlap and per-chunk SHA. Feed straight to a vector DB.

## Two modes

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

Crawls the URL → cleans to markdown → sends `(markdown + schema)` to your OpenAI-compatible chat-completions endpoint with `response_format: { type: 'json_object' }` → returns parsed typed data per URL. Supports natural-language `extractPrompt` instead of/alongside the schema. The actor charges per page like normal; the LLM call cost is whatever your endpoint charges.

> **Note**: extract mode requires a publicly-reachable LLM endpoint. LAN URLs (e.g. `http://192.168.x.x`) are not reachable from Apify infrastructure. Use OpenAI, hosted vLLM, or expose your local server via a tunnel.

> Set `THECRAWLER_LLM_API_KEY` as an Actor environment variable so the LLM key never lands in run inputs (visible in run history).

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
- **Extract mode**: $0.005 per page now; will become $0.02 per page on/after 2026-05-30 (separate event for the higher LLM-inference compute, gated by Apify's pricing-cooldown rules).

## Beyond the Apify Store

The same engine ships as the open-source `thecrawler` npm package — drop into your own Node project, MCP server, CLI, or REST API server. Self-hosted = $0 per call.

```bash
# Library
npm install thecrawler

# CLI
thecrawler crawl https://example.com --markdown
thecrawler extract https://example.com --schema '{...}'

# MCP server (Claude Code, Cursor, Windsurf)
npx -p thecrawler thecrawler-mcp

# REST API server
npx -p thecrawler thecrawler-api --port 3000
```

GitHub: https://github.com/manchittlab/TheCrawler · License: AGPL-3.0
