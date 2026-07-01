import { crawl, parseSitemap } from './engine.js';
import { extract } from './extract.js';
import {
    attachContractValidation,
    getExtractionContract,
    listExtractionContracts,
} from './contracts.js';
import {
    diagnoseContractReadiness,
    renderContractDiagnosticReport,
    summarizeContractDiagnostics,
} from './diagnostics.js';
import type { CrawlOptions, PageData } from './types.js';

type ToolResponse = {
    content: { type: 'text'; text: string }[];
    isError?: boolean;
};

const silentLogger = {
    info: () => undefined,
    error: () => undefined,
};

// Default LLM config from env (set in the MCP client's settings).
// Per-call args still override these.
const DEFAULT_LLM_BASE_URL = process.env.THECRAWLER_LLM_BASEURL || '';
const DEFAULT_LLM_MODEL = process.env.THECRAWLER_LLM_MODEL || '';
const DEFAULT_LLM_API_KEY = process.env.THECRAWLER_LLM_API_KEY || '';

function jsonResponse(payload: unknown, isError = false): ToolResponse {
    return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        ...(isError ? { isError: true } : {}),
    };
}

/**
 * Wrap an error PageData into the structured MCP error response so the LLM
 * can read errorType + retryable instead of grep-ing the message text.
 */
function errorResponse(page: PageData): ToolResponse {
    return jsonResponse({
        ok: false,
        url: page.url,
        error: page.error,
        errorType: page.errorType,
        retryable: page.errorRetryable,
        statusCode: page.statusCode || null,
    }, true);
}

function baseCrawlOptions(args: Record<string, unknown>): Omit<CrawlOptions, 'urls'> {
    return {
        usePlaywright: args.usePlaywright as boolean ?? false,
        adaptiveCrawling: args.adaptiveCrawling as boolean ?? false,
        proxyUrl: args.proxyUrl as string | undefined,
        requestRetries: args.requestRetries as number ?? 3,
        requestTimeoutSecs: args.requestTimeoutSecs as number ?? 30,
        rotateUserAgent: args.rotateUserAgent as boolean ?? true,
        waitForSelector: args.waitForSelector as string | undefined,
        waitForMs: args.waitForMs as number | undefined,
        actions: args.actions as CrawlOptions['actions'] | undefined,
        screenshotFullPage: args.screenshotFullPage as boolean ?? false,
        includeGlobs: args.includeGlobs as string[] | undefined,
        excludeGlobs: args.excludeGlobs as string[] | undefined,
        extractEmails: args.extractEmails as boolean ?? false,
        extractPhones: args.extractPhones as boolean ?? false,
        logger: silentLogger,
    };
}

// --- Tool definitions ---
export function getMcpToolDefinitions() {
    return [
        {
            name: 'crawl',
            description: 'Scrape one or more URLs. Returns rich structured data: title, description, text, markdown, links, images, meta, OG/Twitter cards, JSON-LD, microdata, headings, tables, forms, redirect chain, hreflang, pagination links, commerce data (price/rating/sku from JSON-LD), analytics tracker detection (16 trackers), and optional email-like/phone-like public text fields when explicitly enabled. Auto-handles PDF and DOCX URLs. Default Cheerio (fast HTTP+parse); set usePlaywright=true for JS rendering, or adaptiveCrawling=true to auto-detect SPAs and re-crawl them with Playwright. On failure, returns structured error with errorType (dns|timeout|rate-limit|blocked-bot|js-required|http-4xx|http-5xx|parse|network|unknown) and retryable flag.',
            inputSchema: {
                type: 'object' as const,
                properties: {
                    urls: { type: 'array', items: { type: 'string' }, description: 'URLs to scrape (HTTP/HTTPS). Can include .pdf and .docx URLs.' },
                    extractMarkdown: { type: 'boolean', description: 'Convert main content to clean markdown (Turndown + GFM). Strips nav/footer/cookie banners.', default: false },
                    extractText: { type: 'boolean', description: 'Extract visible text (scripts/styles removed)', default: true },
                    extractLinks: { type: 'boolean', description: 'Extract all <a href> with anchor text + internal/external flag', default: true },
                    extractImages: { type: 'boolean', description: 'Extract <img> + lazy-loaded data-src', default: true },
                    extractMeta: { type: 'boolean', description: 'Extract <meta>, OG, Twitter Card', default: true },
                    extractStructuredData: { type: 'boolean', description: 'Extract JSON-LD scripts (parsed)', default: true },
                    extractEmails: { type: 'boolean', description: 'Extract email-like strings from public page HTML when your workflow is allowed to process contact fields.', default: false },
                    extractPhones: { type: 'boolean', description: 'Extract phone-like strings from public page HTML when your workflow is allowed to process contact fields.', default: false },
                    cssSelector: { type: 'string', description: 'Extract only content matching this CSS selector (returned as selectedContent)' },
                    chunkSize: { type: 'number', description: 'LLM/RAG chunk size in chars (0 = no chunking). Heading-aware chunking.', default: 0 },
                    maxDepth: { type: 'number', description: 'Follow internal links to this depth (0 = no follow)', default: 0 },
                    maxPages: { type: 'number', description: 'Hard cap on total pages scraped per call', default: 10 },
                    includeGlobs: { type: 'array', items: { type: 'string' }, description: 'Only crawl URLs matching these glob patterns when following links.' },
                    excludeGlobs: { type: 'array', items: { type: 'string' }, description: 'Skip URLs matching these glob patterns when following links.' },
                    usePlaywright: { type: 'boolean', description: 'Force Playwright (real Chromium with JS execution). Slower but handles SPAs.', default: false },
                    adaptiveCrawling: { type: 'boolean', description: 'Try Cheerio first; auto-fall-back to Playwright if SPA detected (text < 200 chars or known SPA root div)', default: false },
                    waitForSelector: { type: 'string', description: 'Playwright-only selector to wait for before extracting content.' },
                    waitForMs: { type: 'number', description: 'Playwright-only fixed wait in milliseconds before extracting content.' },
                    actions: {
                        type: 'array',
                        description: 'Playwright-only browser actions before extraction: click, fill, scroll, wait, screenshot.',
                        items: {
                            type: 'object',
                            properties: {
                                type: { type: 'string', enum: ['click', 'fill', 'scroll', 'wait', 'screenshot'] },
                                selector: { type: 'string' },
                                value: { type: 'string' },
                                pixels: { type: 'number' },
                                ms: { type: 'number' },
                            },
                            required: ['type'],
                        },
                    },
                    screenshotFullPage: { type: 'boolean', description: 'Playwright-only: capture a full-page screenshot reference in the result.', default: false },
                    proxyUrl: { type: 'string', description: 'Proxy URL (http://user:pass@host:port)' },
                    requestRetries: { type: 'number', description: 'Retry transient failures (5xx, network, timeout) this many times before giving up', default: 3 },
                    requestTimeoutSecs: { type: 'number', description: 'Per-request timeout in seconds', default: 30 },
                    rotateUserAgent: { type: 'boolean', description: 'Rotate among standard browser User-Agent strings for compatibility. This does not override access controls.', default: true },
                    cacheEnabled: { type: 'boolean', description: 'Use in-memory LRU cache (TTL 5min) — same URL+flags within TTL returns cached results with fromCache:true', default: false },
                },
                required: ['urls'],
            },
        },
        {
            name: 'crawl_markdown',
            description: 'Extract clean markdown for a single URL. Strips boilerplate (nav/header/footer/cookie banners). Returns markdown text only — no surrounding metadata. Ideal for feeding a single page to an LLM. For multi-URL or structured output, use `crawl`, `extract_structured`, or `extract_extraction_contract` instead.',
            inputSchema: {
                type: 'object' as const,
                properties: {
                    url: { type: 'string', description: 'URL to extract markdown from' },
                    chunkSize: { type: 'number', description: 'Heading-aware chunk size in chars (0 = no chunking)', default: 0 },
                    usePlaywright: { type: 'boolean', description: 'Use Playwright for JS rendering (slower; needed for SPAs)', default: false },
                    adaptiveCrawling: { type: 'boolean', description: 'Try Cheerio first; auto-fall-back to Playwright if SPA detected', default: false },
                    waitForSelector: { type: 'string', description: 'Playwright-only selector to wait for before extracting content.' },
                    waitForMs: { type: 'number', description: 'Playwright-only fixed wait in milliseconds before extracting content.' },
                },
                required: ['url'],
            },
        },
        {
            name: 'search_and_crawl',
            description: 'Search Google for a query, then scrape the top N results. Returns structured data per result page. Without a SerpAPI key, falls back to scraping Google\'s HTML — fragile, can break when Google updates their HTML. For production agent use, supply serpApiKey.',
            inputSchema: {
                type: 'object' as const,
                properties: {
                    query: { type: 'string', description: 'Google search query' },
                    limit: { type: 'number', description: 'How many top results to scrape', default: 5 },
                    extractMarkdown: { type: 'boolean', description: 'Also extract markdown for each result', default: false },
                    serpApiKey: { type: 'string', description: 'SerpAPI key (recommended for reliable search). Without it, falls back to fragile HTML scrape.' },
                },
                required: ['query'],
            },
        },
        {
            name: 'crawl_sitemap',
            description: 'Fetch URL list from a sitemap.xml (supports sitemap-index files), then optionally scrape them. Use scrape=false to just get the URL list (cheap), scrape=true to also extract content from each.',
            inputSchema: {
                type: 'object' as const,
                properties: {
                    sitemapUrl: { type: 'string', description: 'Sitemap URL (e.g., https://example.com/sitemap.xml). Sitemap index files (multiple <sitemap> entries) are auto-resolved.' },
                    scrape: { type: 'boolean', description: 'true = scrape each URL; false = return URL list only', default: false },
                    maxPages: { type: 'number', description: 'Max pages to scrape (only when scrape=true)', default: 10 },
                    extractMarkdown: { type: 'boolean', description: 'Also extract markdown for each page', default: false },
                },
                required: ['sitemapUrl'],
            },
        },
        {
            name: 'extract_structured',
            description: 'LLM-powered structured extraction. Crawls each URL → cleans to markdown → asks an OpenAI-compatible LLM (llama.cpp / vLLM / LM Studio / Ollama / OpenAI) to return ONLY a JSON object matching your jsonSchema or prompt. Returns parsed typed data, not raw markdown. LLM endpoint configurable per-call or via env vars (THECRAWLER_LLM_BASEURL, THECRAWLER_LLM_MODEL, THECRAWLER_LLM_API_KEY).',
            inputSchema: {
                type: 'object' as const,
                properties: {
                    urls: { type: 'array', items: { type: 'string' }, description: 'URLs to extract from. Each becomes one LLM call.' },
                    jsonSchema: { type: 'object', description: 'JSON Schema for the desired output shape. The LLM is instructed to return JSON matching this. Either jsonSchema or prompt (or both) is required.' },
                    prompt: { type: 'string', description: 'Natural-language extraction instruction (e.g., "Extract product name, price, currency, availability"). Used alongside or instead of jsonSchema.' },
                    llmBaseUrl: { type: 'string', description: 'OpenAI-compatible chat-completions URL. Overrides THECRAWLER_LLM_BASEURL env var.' },
                    llmModel: { type: 'string', description: 'Model name. Overrides THECRAWLER_LLM_MODEL env var.' },
                    llmApiKey: { type: 'string', description: 'Optional bearer token. Overrides THECRAWLER_LLM_API_KEY env var.' },
                    temperature: { type: 'number', description: 'LLM temperature (0 = deterministic). Default 0.', default: 0 },
                    maxTokens: { type: 'number', description: 'Max LLM response tokens. Default 4000.', default: 4000 },
                    markdownCharLimit: { type: 'number', description: 'Max chars of page markdown sent to the LLM. Default 30000.', default: 30000 },
                    usePlaywright: { type: 'boolean', description: 'Use Playwright for JS rendering during the crawl phase', default: false },
                    adaptiveCrawling: { type: 'boolean', description: 'Try Cheerio first; auto-fall-back to Playwright if SPA detected', default: false },
                    waitForSelector: { type: 'string', description: 'Playwright-only selector to wait for before extracting content.' },
                    waitForMs: { type: 'number', description: 'Playwright-only fixed wait in milliseconds before extracting content.' },
                },
                required: ['urls'],
            },
        },
        {
            name: 'list_extraction_contracts',
            description: 'List built-in extraction contracts agents can use for validated schema extraction. Use this before diagnose_extraction_contract or extract_extraction_contract.',
            inputSchema: {
                type: 'object' as const,
                properties: {},
            },
        },
        {
            name: 'diagnose_extraction_contract',
            description: 'Run a no-LLM readiness diagnostic for one extraction contract before spending LLM tokens. Returns per-URL verdicts, scores, blockers, branchable error types, missing readiness signals, and a workflow-level recommended next step. This does not claim a site will work; it tells the agent whether to extract, retry with browser/proxy, review manually, or stop.',
            inputSchema: {
                type: 'object' as const,
                properties: {
                    urls: { type: 'array', items: { type: 'string' }, description: 'Public URLs to test against the selected extraction contract.' },
                    contractName: { type: 'string', description: 'Built-in contract name. Use list_extraction_contracts to discover names.', default: 'real-estate-listing' },
                    reportMarkdown: { type: 'boolean', description: 'Include a buyer-readable Markdown report without raw extracted contact evidence.', default: false },
                    maxPages: { type: 'number', description: 'Hard cap on pages for this diagnostic run.', default: 10 },
                    usePlaywright: { type: 'boolean', description: 'Force Playwright for JS-heavy pages.', default: false },
                    adaptiveCrawling: { type: 'boolean', description: 'Try Cheerio first; auto-fall-back to Playwright if SPA detected.', default: true },
                    waitForSelector: { type: 'string', description: 'Playwright-only selector to wait for before extracting content.' },
                    waitForMs: { type: 'number', description: 'Playwright-only fixed wait in milliseconds before extracting content.' },
                    proxyUrl: { type: 'string', description: 'Proxy URL (http://user:pass@host:port)' },
                    requestRetries: { type: 'number', description: 'Retry transient failures this many times before giving up.', default: 3 },
                    requestTimeoutSecs: { type: 'number', description: 'Per-request timeout in seconds.', default: 30 },
                    rotateUserAgent: { type: 'boolean', description: 'Rotate among standard browser User-Agent strings for compatibility. This does not override access controls.', default: true },
                },
                required: ['urls'],
            },
        },
        {
            name: 'extract_extraction_contract',
            description: 'Crawl URLs and extract against a built-in validated extraction contract with an OpenAI-compatible LLM. Returns parsed data plus required-field validation and missingRequiredFields evidence. Use diagnose_extraction_contract first when the source is unknown.',
            inputSchema: {
                type: 'object' as const,
                properties: {
                    urls: { type: 'array', items: { type: 'string' }, description: 'URLs to extract from. Each becomes one LLM call.' },
                    contractName: { type: 'string', description: 'Built-in contract name. Use list_extraction_contracts to discover names.', default: 'real-estate-listing' },
                    llmBaseUrl: { type: 'string', description: 'OpenAI-compatible chat-completions URL. Overrides THECRAWLER_LLM_BASEURL env var.' },
                    llmModel: { type: 'string', description: 'Model name. Overrides THECRAWLER_LLM_MODEL env var.' },
                    llmApiKey: { type: 'string', description: 'Optional bearer token. Overrides THECRAWLER_LLM_API_KEY env var.' },
                    temperature: { type: 'number', description: 'LLM temperature. Default 0.', default: 0 },
                    maxTokens: { type: 'number', description: 'Max LLM response tokens. Default 4000.', default: 4000 },
                    markdownCharLimit: { type: 'number', description: 'Max chars of page markdown sent to the LLM. Default 30000.', default: 30000 },
                    usePlaywright: { type: 'boolean', description: 'Force Playwright for JS-heavy pages.', default: false },
                    adaptiveCrawling: { type: 'boolean', description: 'Try Cheerio first; auto-fall-back to Playwright if SPA detected.', default: false },
                    waitForSelector: { type: 'string', description: 'Playwright-only selector to wait for before extracting content.' },
                    waitForMs: { type: 'number', description: 'Playwright-only fixed wait in milliseconds before extracting content.' },
                },
                required: ['urls'],
            },
        },
    ];
}

// --- Tool handlers ---
export async function handleMcpToolCall(name: string, args: Record<string, unknown> = {}): Promise<ToolResponse> {
    try {
        switch (name) {
            case 'crawl': {
                const opts: CrawlOptions = {
                    urls: args.urls as string[] ?? [],
                    extractMarkdown: args.extractMarkdown as boolean ?? false,
                    extractText: args.extractText as boolean ?? true,
                    extractLinks: args.extractLinks as boolean ?? true,
                    extractImages: args.extractImages as boolean ?? true,
                    extractMeta: args.extractMeta as boolean ?? true,
                    extractStructuredData: args.extractStructuredData as boolean ?? true,
                    cssSelector: args.cssSelector as string | undefined,
                    chunkSize: args.chunkSize as number ?? 0,
                    maxDepth: args.maxDepth as number ?? 0,
                    maxPages: args.maxPages as number ?? 10,
                    ...baseCrawlOptions(args),
                    cache: { enabled: (args.cacheEnabled as boolean) ?? false },
                };
                const result = await crawl(opts);
                return jsonResponse(result);
            }

            case 'crawl_markdown': {
                const result = await crawl({
                    urls: [args.url as string],
                    extractMarkdown: true,
                    extractText: false, extractLinks: false, extractImages: false,
                    extractHeadings: false, extractTables: false, extractEmails: false, extractPhones: false,
                    chunkSize: args.chunkSize as number ?? 0,
                    logger: silentLogger,
                    usePlaywright: args.usePlaywright as boolean ?? false,
                    adaptiveCrawling: args.adaptiveCrawling as boolean ?? false,
                    waitForSelector: args.waitForSelector as string | undefined,
                    waitForMs: args.waitForMs as number | undefined,
                });
                const page = result.pages[0];
                if (!page) {
                    return jsonResponse({ ok: false, error: 'no result returned from engine' }, true);
                }
                if (page.status === 'error' || !page.markdown) {
                    return errorResponse(page);
                }
                let text = page.markdown;
                if (page.chunks && page.chunks.length > 0) {
                    text += '\n\n---\n## Chunks\n' + page.chunks.map((c) =>
                        `### Chunk ${c.index} (${c.charCount} chars, section: ${c.section || 'none'})\n${c.text}`
                    ).join('\n\n');
                }
                return { content: [{ type: 'text', text }] };
            }

            case 'search_and_crawl': {
                const result = await crawl({
                    searchQuery: args.query as string,
                    searchLimit: args.limit as number ?? 5,
                    serperApiKey: args.serperKey as string | undefined, // env SERPER_API_KEY/THECRAWLER_SERPER_KEY used if unset
                    serpApiKey: args.serpApiKey as string | undefined,
                    extractMarkdown: args.extractMarkdown as boolean ?? false,
                    logger: silentLogger,
                });
                return jsonResponse(result);
            }

            case 'crawl_sitemap': {
                const sitemapUrl = args.sitemapUrl as string;
                const shouldScrape = args.scrape as boolean ?? false;

                if (!shouldScrape) {
                    const urls = await parseSitemap(sitemapUrl);
                    return jsonResponse({ sitemapUrl, urlCount: urls.length, urls });
                }

                const result = await crawl({
                    sitemapUrl,
                    maxPages: args.maxPages as number ?? 10,
                    extractMarkdown: args.extractMarkdown as boolean ?? false,
                    logger: silentLogger,
                });
                return jsonResponse(result);
            }

            case 'extract_structured': {
                const baseUrl = (args.llmBaseUrl as string) || DEFAULT_LLM_BASE_URL;
                const model = (args.llmModel as string) || DEFAULT_LLM_MODEL;
                if (!baseUrl || !model) {
                    return jsonResponse({ ok: false, error: 'LLM not configured. Provide llmBaseUrl + llmModel arguments, or set THECRAWLER_LLM_BASEURL + THECRAWLER_LLM_MODEL env vars in your MCP client config.' }, true);
                }
                if (!args.jsonSchema && !args.prompt) {
                    return jsonResponse({ ok: false, error: 'extract_structured requires either jsonSchema or prompt (or both).' }, true);
                }
                const results = await extract({
                    urls: args.urls as string[] ?? [],
                    jsonSchema: args.jsonSchema as object | undefined,
                    prompt: args.prompt as string | undefined,
                    markdownCharLimit: args.markdownCharLimit as number ?? 30000,
                    crawlOptions: {
                        ...baseCrawlOptions(args),
                    },
                    llm: {
                        baseUrl,
                        model,
                        apiKey: (args.llmApiKey as string) || DEFAULT_LLM_API_KEY || undefined,
                        temperature: args.temperature as number ?? 0,
                        maxTokens: args.maxTokens as number ?? 4000,
                    },
                });
                return jsonResponse(results);
            }

            case 'list_extraction_contracts': {
                const contracts = listExtractionContracts().map((contractName) => {
                    const contract = getExtractionContract(contractName);
                    return {
                        name: contract.name,
                        domain: contract.domain,
                        version: contract.version,
                        description: contract.description,
                        requiredFields: contract.requiredFields,
                    };
                });
                return jsonResponse({ contracts });
            }

            case 'diagnose_extraction_contract': {
                const urls = args.urls as string[] ?? [];
                if (urls.length === 0) {
                    return jsonResponse({ ok: false, error: 'diagnose_extraction_contract requires a non-empty urls array.' }, true);
                }
                const contract = getExtractionContract((args.contractName as string) || 'real-estate-listing');
                const result = await crawl({
                    urls,
                    extractMarkdown: true,
                    extractText: true,
                    extractLinks: true,
                    extractImages: true,
                    extractMeta: true,
                    extractStructuredData: true,
                    maxPages: args.maxPages as number ?? 10,
                    ...baseCrawlOptions({
                        adaptiveCrawling: true,
                        ...args,
                    }),
                });
                const diagnostics = result.pages.map((page) => diagnoseContractReadiness(contract, page));
                const summary = summarizeContractDiagnostics(diagnostics);
                const payload: Record<string, unknown> = {
                    contract: {
                        name: contract.name,
                        domain: contract.domain,
                        version: contract.version,
                    },
                    summary,
                    diagnostics,
                };
                if (args.reportMarkdown as boolean ?? false) {
                    payload.reportMarkdown = renderContractDiagnosticReport({
                        generatedAt: new Date().toISOString(),
                        contract,
                        summary,
                        diagnostics,
                    });
                }
                return jsonResponse(payload);
            }

            case 'extract_extraction_contract': {
                const baseUrl = (args.llmBaseUrl as string) || DEFAULT_LLM_BASE_URL;
                const model = (args.llmModel as string) || DEFAULT_LLM_MODEL;
                if (!baseUrl || !model) {
                    return jsonResponse({ ok: false, error: 'LLM not configured. Provide llmBaseUrl + llmModel arguments, or set THECRAWLER_LLM_BASEURL + THECRAWLER_LLM_MODEL env vars in your MCP client config.' }, true);
                }
                const urls = args.urls as string[] ?? [];
                if (urls.length === 0) {
                    return jsonResponse({ ok: false, error: 'extract_extraction_contract requires a non-empty urls array.' }, true);
                }
                const contract = getExtractionContract((args.contractName as string) || 'real-estate-listing');
                const extractionResults = await extract({
                    urls,
                    jsonSchema: contract.schema,
                    prompt: contract.prompt,
                    markdownCharLimit: args.markdownCharLimit as number ?? 30000,
                    crawlOptions: {
                        ...baseCrawlOptions(args),
                    },
                    llm: {
                        baseUrl,
                        model,
                        apiKey: (args.llmApiKey as string) || DEFAULT_LLM_API_KEY || undefined,
                        temperature: args.temperature as number ?? 0,
                        maxTokens: args.maxTokens as number ?? 4000,
                    },
                });
                return jsonResponse({
                    contract: {
                        name: contract.name,
                        domain: contract.domain,
                        version: contract.version,
                    },
                    results: attachContractValidation(contract, extractionResults),
                });
            }

            default:
                return jsonResponse({ ok: false, error: `Unknown tool: ${name}` }, true);
        }
    } catch (error: any) {
        return jsonResponse({
            ok: false,
            error: error.message,
            errorType: 'unknown',
            retryable: false,
        }, true);
    }
}
