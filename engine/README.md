# TheCrawler

Web scraper + validated extraction contracts for AI agents. PDF/DOCX, markdown, JSON-LD/microdata/commerce/forms/analytics detection, no-LLM readiness diagnostics, structured errors, standard User-Agent compatibility, retry/timeout, optional in-memory cache. Adaptive Cheerio→Playwright. Open source, AGPL-3.0.

## Install

Current validated-contract, MCP, and REST API features should be installed from this GitHub source until the next npm publish lands:

```bash
git clone https://github.com/manchittlab/TheCrawler.git
cd TheCrawler/engine
npm install
npm run build
node dist/cli.js --version  # expect 0.3.3 for this source build
```

The published npm package exists, but may lag this source build:

```bash
npm install thecrawler
```

Or from a local checkout:

```bash
npm install file:/path/to/TheCrawler/engine
```

## Library use

```js
import { crawl, extract } from 'thecrawler';

// Plain crawl
const r = await crawl({
    urls: ['https://example.com'],
    extractMarkdown: true,
});
console.log(r.pages[0].markdown);

// Multi-URL with reliability options
const r2 = await crawl({
    urls: ['https://...', 'https://...'],
    extractMarkdown: true,
    requestRetries: 3,           // retry transient failures
    requestTimeoutSecs: 30,
    rotateUserAgent: true,       // rotate from real-browser UA pool
    cache: { enabled: true, ttlSeconds: 300 },
});

// Errors are structured. Branch on errorType + retryable.
for (const p of r2.pages) {
    if (p.status === 'error') {
        console.log(p.errorType, p.errorRetryable, p.error);
        // errorType ∈ 'dns'|'timeout'|'rate-limit'|'blocked-bot'|
        // 'js-required'|'http-4xx'|'http-5xx'|'parse'|'network'|'unknown'
    }
}
```

## LLM-powered structured extraction

Crawls a URL, sends the cleaned markdown to an OpenAI-compatible LLM endpoint with a JSON schema or natural-language prompt, returns parsed typed data. Endpoint-agnostic: works against `llama.cpp`'s `llama-server`, `vLLM`, `LM Studio`, `Ollama`, OpenAI proper, and compatible `/v1/chat/completions` endpoints. Schema-backed extraction uses JSON Schema response format where supported, with fallbacks for endpoints that only support JSON-object or text output.

```js
import { extract } from 'thecrawler';

const r = await extract({
    urls: ['https://shop.example.com/products/123'],
    jsonSchema: {
        type: 'object',
        properties: {
            productName: { type: 'string' },
            price: { type: 'number' },
            currency: { type: 'string' },
            inStock: { type: 'boolean' },
        },
        required: ['productName'],
    },
    llm: {
        baseUrl: 'http://your-llm-host:8080/v1/chat/completions',
        model: 'your-model-name',
        // apiKey: 'optional',
        // temperature: 0,
        // maxTokens: 4000,
        // timeoutSecs: 120,
    },
});

console.log(r[0].data);
// { productName: '...', price: 49.99, currency: 'USD', inStock: true }
```

`ExtractResult` includes parsed `data`, `status`, structured `errorType`, `rawResponse` (for debugging), token usage, and timing breakdown (`crawlMs`, `llmMs`, `responseTimeMs`).

## CLI

```bash
# From this source checkout, use the local CLI until npm catches up.
node dist/cli.js --version  # expect 0.3.3 for this source build

# Crawl
node dist/cli.js crawl https://example.com --markdown
node dist/cli.js crawl https://example.com --retries 5 --timeout 60 --cache

# Search Google + scrape top results
node dist/cli.js search "your query" --markdown

# Sitemap-driven crawl
node dist/cli.js sitemap https://example.com/sitemap.xml --markdown

# Markdown shortcut
node dist/cli.js md https://example.com

# Built-in extraction contract with validation evidence
node dist/cli.js extract https://example.com/listing \
  --contract real-estate-listing \
  --llm-base-url http://localhost:1234/v1/chat/completions \
  --llm-model local-model \
  --evidence-output real-estate-evidence.json

# No-LLM contract readiness diagnostic
node dist/cli.js diagnose https://example.com/listing-1 https://example.com/listing-2 \
  --contract real-estate-listing \
  --output real-estate-workflow-diagnostic.json \
  --report real-estate-workflow-report.md
```

## Extraction contracts

Contracts turn a crawl into a repeatable, validated output shape for agent workflows. Current built-in contracts are `real-estate-listing`, which extracts normalized property listing fields, and `product-page`, which extracts normalized product catalog fields such as name, price, availability, brand, SKU, rating, source URL, confidence, and evidence notes.

Use `node dist/cli.js extract --list-contracts` to list available contracts from a current source checkout. Contract mode returns the normal `ExtractResult` plus a `validation` object with `valid`, `requiredFields`, and `missingRequiredFields`, so an agent can branch on extraction quality instead of trusting loose markdown.

Use `node dist/cli.js diagnose <url...> --contract real-estate-listing` or `--contract product-page` before LLM extraction to score whether a source or workflow is ready for contract extraction. The diagnostic does not call an LLM; it crawls each page, checks source signals, and returns per-URL `verdict`, `readyForExtraction`, `score`, `blockers`, `warnings`, `recommendedNextStep`, and signal evidence plus an aggregate workflow summary (`readyUrls`, `blockedUrls`, `workflowVerdict`, `blockersByType`, `recommendedNextStep`). Add `--report report.md` to produce a buyer-readable Markdown report with missing readiness signals, without raw extracted contact details or page evidence.

## MCP server

Eight tools: `crawl`, `crawl_markdown`, `search_and_crawl`, `crawl_sitemap`, `extract_structured`, `list_extraction_contracts`, `diagnose_extraction_contract`, `extract_extraction_contract`.

Add to your MCP client config (Claude Code / Cursor / Windsurf):

```json
{
    "mcpServers": {
        "thecrawler": {
            "command": "node",
            "args": ["/path/to/TheCrawler/engine/dist/mcp.js"],
            "env": {
                "THECRAWLER_LLM_BASEURL": "http://your-llm-host:8080/v1/chat/completions",
                "THECRAWLER_LLM_MODEL": "your-model-name"
            }
        }
    }
}
```

The contract tools let an MCP client discover built-in contracts, run a no-LLM readiness diagnostic, and extract with required-field validation:

```json
{
    "tool": "diagnose_extraction_contract",
    "arguments": {
        "urls": ["https://example.com/listing"],
        "contractName": "real-estate-listing",
        "reportMarkdown": true
    }
}
```

The env vars set defaults for `extract_structured` and `extract_extraction_contract`; per-call args override.

## REST API server

```bash
THECRAWLER_API_KEY=local_test_key node dist/server.js --port 3000
```

Endpoints:

- `POST /v1/crawl`
- `POST /v1/scrape`
- `POST /v1/markdown`
- `POST /v1/search`
- `POST /v1/map`
- `POST /v1/sitemap`
- `POST /v1/extract`
- `GET /v1/contracts?includeSchema=true`
- `POST /v1/diagnose`
- `POST /v1/extract-contract`
- `GET /v1/health`

Contract endpoints mirror the CLI/MCP contract flow for API-first buyers:

```bash
curl -H "Authorization: Bearer $THECRAWLER_API_KEY" \
  http://localhost:3000/v1/contracts?includeSchema=true

curl -X POST http://localhost:3000/v1/diagnose \
  -H "Authorization: Bearer $THECRAWLER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"contractName":"product-page","urls":["https://example.com/product"],"reportMarkdown":true}'

curl -X POST http://localhost:3000/v1/scrape \
  -H "Authorization: Bearer $THECRAWLER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/product","formats":["markdown","metadata","links","structuredData","commerceData"]}'

curl -X POST http://localhost:3000/v1/map \
  -H "Authorization: Bearer $THECRAWLER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com","maxPages":1}'

curl -X POST http://localhost:3000/v1/extract-contract \
  -H "Authorization: Bearer $THECRAWLER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"contractName":"product-page","urls":["https://example.com/product"],"llmBaseUrl":"http://localhost:1234/v1/chat/completions","llmModel":"qwen/qwen3.5-9b"}'
```

`/v1/scrape` is the one-page API path for selected output formats. `/v1/diagnose` does not call an LLM. `/v1/extract-contract` uses the selected contract schema and returns required-field validation evidence. All extraction claims still depend on the tested URLs and the configured LLM; blocked pages are reported as blockers, not false successes.

## What it extracts (out of the box, no extra code)

Per page: title, description, language, canonical URL, robots directives, full text (50K cap), markdown (boilerplate-stripped, GFM), heading-aware chunks, headings (h1-h6), links (with internal/external + rel), images (with lazy-load src), meta tags (incl. OG + Twitter Card), tables, JSON-LD, microdata (itemscope/itemprop), commerce data (price/currency/SKU/rating from JSON-LD Product), forms (action/method/fields), 16 analytics trackers detected (GA4, GTM, Facebook Pixel, Hotjar, Segment, Mixpanel, Amplitude, Heap, Plausible, Matomo, Clarity, LinkedIn, Twitter, Pinterest, TikTok, etc.), optional email-like and phone-like public text fields, social links, hreflang tags, pagination links, redirect chain, response timing, page size.

PDF and DOCX URLs are auto-detected and parsed (text + metadata for PDFs; text + markdown for DOCX).

## Adaptive crawling

Default Cheerio (fast HTTP+parse) — set `usePlaywright: true` for full JS rendering, or `adaptiveCrawling: true` to try Cheerio first and auto-fall-back to Playwright when an SPA shell is detected (text < 200 chars or known SPA root div).

## Blocked/challenge handling

Optional User-Agent rotation uses standard browser User-Agent strings for compatibility; it does not override access controls. Challenge-page detection: when a 200 response carries an access-control or challenge body ("checking your browser", "attention required", "cloudflare ray id"), the page is marked `errorType: 'blocked-bot'` rather than silently returning challenge HTML.

If your workflow legitimately uses a proxy, supply `proxyUrl` (any Crawlee-compatible HTTP(S) proxy URL).

## License

AGPL-3.0-or-later. Commercial licensing available — contact through the GitHub repo.
