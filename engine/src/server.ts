#!/usr/bin/env node

/**
 * TheCrawler REST API Server
 *
 * Standalone HTTP API wrapping the crawl engine.
 * Run from a current source checkout: node dist/server.js --port 3000
 * Avoid the global `thecrawler-api` binary until npm/global publish catches up.
 *
 * Endpoints:
 *   POST /v1/crawl      — scrape URLs
 *   POST /v1/scrape     — scrape one URL into selected formats
 *   POST /v1/markdown    — extract markdown from a URL
 *   POST /v1/search      — search Google + scrape results
 *   POST /v1/map         — discover links from a URL
 *   POST /v1/sitemap     — crawl from sitemap.xml
 *   POST /v1/extract     — LLM-powered structured extraction
 *   GET  /v1/contracts   — list built-in extraction contracts
 *   POST /v1/diagnose    — diagnose contract readiness without an LLM
 *   POST /v1/extract-contract — extract with a built-in contract + validation
 *   GET  /v1/health      — health check
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { crawl, parseSitemap } from './engine.js';
import { extract } from './extract.js';
import { attachContractValidation, getExtractionContract, listExtractionContracts } from './contracts.js';
import { diagnoseContractReadiness, renderContractDiagnosticReport, summarizeContractDiagnostics } from './diagnostics.js';
import { assertPublicHttpUrl } from './ssrf.js';
import type { CrawlOptions, CrawlResult } from './types.js';

const DEFAULT_LLM_BASEURL = process.env.THECRAWLER_LLM_BASEURL || '';
const DEFAULT_LLM_MODEL = process.env.THECRAWLER_LLM_MODEL || '';
const DEFAULT_LLM_API_KEY = process.env.THECRAWLER_LLM_API_KEY || '';

// SSRF protection. HTTP callers of this server are untrusted, so by default we
// reject target URLs / user-supplied llmBaseUrls that point at private, loopback,
// or internal hosts. Self-host / trusted deployments (and the test harness, which
// crawls 127.0.0.1 fixtures) opt out with THECRAWLER_ALLOW_PRIVATE_HOSTS=1.
const ALLOW_PRIVATE_HOSTS = process.env.THECRAWLER_ALLOW_PRIVATE_HOSTS === '1';

/** Returns an SSRF rejection reason if any provided URL is blocked, else null. */
function blockedUrl(urls: unknown): string | null {
    if (ALLOW_PRIVATE_HOSTS) return null;
    const list = Array.isArray(urls) ? urls : [urls];
    for (const u of list) {
        if (typeof u !== 'string' || u.length === 0) continue;
        const g = assertPublicHttpUrl(u);
        if (!g.ok) return `Blocked URL "${u.slice(0, 80)}": ${g.reason}`;
    }
    return null;
}

const PORT = parseInt(process.argv.find((_a, i, arr) => arr[i - 1] === '--port') || '3000', 10);
const API_KEY = process.env.THECRAWLER_API_KEY || '';

function json(res: ServerResponse, status: number, data: unknown) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(data));
}

async function readBody(req: IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            try { resolve(JSON.parse(body || '{}')); }
            catch { reject(new Error('Invalid JSON body')); }
        });
        req.on('error', reject);
    });
}

function checkAuth(req: IncomingMessage, res: ServerResponse): boolean {
    if (!API_KEY) return true; // No key configured = open access
    const auth = req.headers.authorization;
    if (auth === `Bearer ${API_KEY}`) return true;
    json(res, 401, { error: 'Invalid or missing API key. Set Authorization: Bearer <key>' });
    return false;
}

function mapDiscoveredLinks(result: CrawlResult) {
    const seen = new Map<string, { url: string; text: string; isExternal: boolean; sourceUrl: string }>();
    for (const page of result.pages) {
        if (page.status !== 'success') continue;
        for (const link of page.links ?? []) {
            let absoluteUrl: string;
            try {
                absoluteUrl = new URL(link.href, page.url).href;
            } catch {
                continue;
            }
            if (!seen.has(absoluteUrl)) {
                seen.set(absoluteUrl, {
                    url: absoluteUrl,
                    text: link.text,
                    isExternal: link.isExternal,
                    sourceUrl: page.url,
                });
            }
        }
    }
    const links = [...seen.values()].sort((a, b) => a.url.localeCompare(b.url));
    return {
        urlCount: links.length,
        links,
    };
}

const SCRAPE_FORMATS = new Set([
    'markdown',
    'text',
    'html',
    'rawHtml',
    'metadata',
    'links',
    'images',
    'structuredData',
    'commerceData',
    'tables',
    'forms',
    'analytics',
    'emails',
    'phones',
    'socialLinks',
    'chunks',
]);

function parseScrapeFormats(value: unknown): { formats: Set<string>; unknown: string[]; invalid: boolean } {
    if (value === undefined) return { formats: new Set(['markdown', 'metadata']), unknown: [], invalid: false };
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        return { formats: new Set(), unknown: [], invalid: true };
    }
    const formats = new Set(value.length > 0 ? value : ['markdown', 'metadata']);
    const unknown = [...formats].filter((format) => !SCRAPE_FORMATS.has(format));
    return { formats, unknown, invalid: false };
}

function buildScrapePayload(page: CrawlResult['pages'][number], formats: Set<string>) {
    const data: Record<string, unknown> = {
        url: page.url,
        status: page.status,
        statusCode: page.statusCode,
        contentType: page.contentType,
        responseTimeMs: page.responseTimeMs,
        scrapedAt: page.scrapedAt,
    };

    if (formats.has('metadata')) {
        data.metadata = {
            title: page.title,
            description: page.description,
            language: page.language,
            canonicalUrl: page.canonicalUrl,
            robotsDirectives: page.robotsDirectives,
            meta: page.meta,
            openGraph: page.openGraph,
            twitterCard: page.twitterCard,
            headings: page.headings,
            hreflangTags: page.hreflangTags,
            paginationLinks: page.paginationLinks,
            redirectChain: page.redirectChain,
        };
    }
    if (formats.has('markdown')) data.markdown = page.markdown;
    if (formats.has('html')) data.html = page.html;
    if (formats.has('rawHtml')) data.rawHtml = page.rawHtml;
    if (formats.has('text')) data.text = page.text;
    if (formats.has('links')) data.links = page.links;
    if (formats.has('images')) data.images = page.images;
    if (formats.has('structuredData')) data.structuredData = page.structuredData;
    if (formats.has('commerceData')) data.commerceData = page.commerceData;
    if (formats.has('tables')) data.tables = page.tables;
    if (formats.has('forms')) data.forms = page.forms;
    if (formats.has('analytics')) data.analyticsDetected = page.analyticsDetected;
    if (formats.has('emails')) data.emails = page.emails;
    if (formats.has('phones')) data.phones = page.phones;
    if (formats.has('socialLinks')) data.socialLinks = page.socialLinks;
    if (formats.has('chunks')) data.chunks = page.chunks;

    return data;
}

const server = createServer(async (req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        });
        res.end();
        return;
    }

    const requestUrl = new URL(req.url ?? '/', 'http://localhost');
    const url = requestUrl.pathname;

    try {
        // Health check
        if (url === '/v1/health' && req.method === 'GET') {
            json(res, 200, { status: 'ok', version: '0.3.3', engine: 'thecrawler' });
            return;
        }

        // GET /v1/contracts
        if (url === '/v1/contracts' && req.method === 'GET') {
            if (!checkAuth(req, res)) return;
            const includeSchema = requestUrl.searchParams.get('includeSchema') === 'true';
            const contracts = listExtractionContracts().map((contractName) => {
                const contract = getExtractionContract(contractName);
                return {
                    name: contract.name,
                    domain: contract.domain,
                    version: contract.version,
                    description: contract.description,
                    requiredFields: contract.requiredFields,
                    ...(includeSchema ? { schema: contract.schema } : {}),
                };
            });
            json(res, 200, { contracts });
            return;
        }

        if (req.method !== 'POST') {
            json(res, 405, { error: 'Method not allowed. Use POST.' });
            return;
        }

        if (!checkAuth(req, res)) return;

        const body = await readBody(req);

        // POST /v1/crawl
        if (url === '/v1/crawl') {
            if (!body.urls || !Array.isArray(body.urls) || body.urls.length === 0) {
                json(res, 400, { error: 'Missing required field: urls (string array)' });
                return;
            }
            const crawlBlk = blockedUrl(body.urls);
            if (crawlBlk) { json(res, 400, { error: crawlBlk, code: 'ssrf-blocked' }); return; }
            const opts: CrawlOptions = {
                urls: body.urls,
                extractText: body.extractText ?? true,
                extractLinks: body.extractLinks ?? true,
                extractImages: body.extractImages ?? true,
                extractMeta: body.extractMeta ?? true,
                extractHeadings: body.extractHeadings ?? true,
                extractTables: body.extractTables ?? true,
                extractStructuredData: body.extractStructuredData ?? true,
                extractEmails: body.extractEmails ?? false,
                extractPhones: body.extractPhones ?? false,
                extractMarkdown: body.extractMarkdown ?? false,
                stripBoilerplate: body.stripBoilerplate ?? true,
                chunkSize: body.chunkSize ?? 0,
                chunkOverlap: body.chunkOverlap ?? 200,
                cssSelector: body.cssSelector,
                maxDepth: body.maxDepth ?? 0,
                maxPages: body.maxPages ?? 100,
                includeGlobs: body.includeGlobs,
                excludeGlobs: body.excludeGlobs,
                proxyUrl: body.proxyUrl,
                usePlaywright: body.usePlaywright ?? false,
                adaptiveCrawling: body.adaptiveCrawling ?? false,
                waitForSelector: body.waitForSelector,
                waitForMs: body.waitForMs ?? 0,
                customHeaders: body.customHeaders,
                screenshotFullPage: body.screenshotFullPage ?? false,
                actions: body.actions,
                requestRetries: body.requestRetries ?? 3,
                requestTimeoutSecs: body.requestTimeoutSecs ?? 30,
                rotateUserAgent: body.rotateUserAgent ?? true,
                cache: body.cache,
            };
            const result = await crawl(opts);
            json(res, 200, result);
            return;
        }

        // POST /v1/scrape
        if (url === '/v1/scrape') {
            if (!body.url) {
                json(res, 400, { error: 'Missing required field: url (string)' });
                return;
            }
            const scrapeBlk = blockedUrl(body.url);
            if (scrapeBlk) { json(res, 400, { error: scrapeBlk, code: 'ssrf-blocked' }); return; }
            const { formats, unknown, invalid } = parseScrapeFormats(body.formats);
            if (invalid) {
                json(res, 400, { error: 'formats must be an array of strings', allowedFormats: [...SCRAPE_FORMATS].sort() });
                return;
            }
            if (unknown.length > 0) {
                json(res, 400, { error: `Unknown scrape format(s): ${unknown.join(', ')}`, allowedFormats: [...SCRAPE_FORMATS].sort() });
                return;
            }
            const needsMetadata = formats.has('metadata');
            const needsStructuredData = formats.has('structuredData') || formats.has('commerceData');
            const result = await crawl({
                urls: [body.url],
                extractMarkdown: formats.has('markdown') || formats.has('chunks'),
                extractText: formats.has('text'),
                extractLinks: formats.has('links'),
                extractImages: formats.has('images'),
                extractMeta: needsMetadata,
                extractHeadings: needsMetadata,
                extractTables: formats.has('tables'),
                extractStructuredData: needsStructuredData,
                extractEmails: formats.has('emails'),
                extractPhones: formats.has('phones'),
                extractHtml: formats.has('html'),
                extractRawHtml: formats.has('rawHtml'),
                onlyMainContent: body.onlyMainContent ?? false,
                includeTags: body.includeTags,
                excludeTags: body.excludeTags,
                stripBoilerplate: body.stripBoilerplate ?? true,
                chunkSize: body.chunkSize ?? (formats.has('chunks') ? 2000 : 0),
                chunkOverlap: body.chunkOverlap ?? 200,
                cssSelector: body.cssSelector,
                maxPages: 1,
                usePlaywright: body.usePlaywright ?? false,
                adaptiveCrawling: body.adaptiveCrawling ?? false,
                waitForSelector: body.waitForSelector,
                waitForMs: body.waitForMs ?? 0,
                waitFor: body.waitFor,
                actions: body.actions,
                customHeaders: body.customHeaders,
                proxyUrl: body.proxyUrl,
                requestRetries: body.requestRetries ?? 3,
                requestTimeoutSecs: body.requestTimeoutSecs ?? 30,
                rotateUserAgent: body.rotateUserAgent ?? true,
                cache: body.cache,
            });
            const page = result.pages[0];
            if (!page) {
                json(res, 502, { success: false, error: 'No page result emitted by crawler' });
                return;
            }
            const data = buildScrapePayload(page, formats);
            json(res, page.status === 'success' ? 200 : 422, {
                success: page.status === 'success',
                data,
                ...(page.status === 'error' ? { error: page.error, errorType: page.errorType, errorRetryable: page.errorRetryable } : {}),
            });
            return;
        }

        // POST /v1/markdown
        if (url === '/v1/markdown') {
            const targetUrl = body.url;
            if (!targetUrl) {
                json(res, 400, { error: 'Missing required field: url (string)' });
                return;
            }
            const mdBlk = blockedUrl(targetUrl);
            if (mdBlk) { json(res, 400, { error: mdBlk, code: 'ssrf-blocked' }); return; }
            const result = await crawl({
                urls: [targetUrl],
                extractMarkdown: true,
                extractText: false, extractLinks: false, extractImages: false,
                extractHeadings: false, extractTables: false, extractEmails: false, extractPhones: false,
                chunkSize: body.chunkSize ?? 0,
                usePlaywright: body.usePlaywright ?? false,
            });
            const page = result.pages[0];
            if (page?.markdown) {
                json(res, 200, {
                    url: page.url,
                    title: page.title,
                    markdown: page.markdown,
                    chunks: page.chunks,
                    statusCode: page.statusCode,
                    responseTimeMs: page.responseTimeMs,
                });
            } else {
                json(res, 422, { error: page?.error || 'No markdown output', url: page?.url });
            }
            return;
        }

        // POST /v1/search
        if (url === '/v1/search') {
            if (!body.query) {
                json(res, 400, { error: 'Missing required field: query (string)' });
                return;
            }
            const result = await crawl({
                searchQuery: body.query,
                searchLimit: body.limit ?? 5,
                serperApiKey: body.serperKey, // env SERPER_API_KEY/THECRAWLER_SERPER_KEY used if unset
                serpApiKey: body.serpApiKey,
                extractMarkdown: body.extractMarkdown ?? false,
            });
            json(res, 200, result);
            return;
        }

        // POST /v1/map
        if (url === '/v1/map') {
            if (!body.url) {
                json(res, 400, { error: 'Missing required field: url (string)' });
                return;
            }
            const mapBlk = blockedUrl(body.url);
            if (mapBlk) { json(res, 400, { error: mapBlk, code: 'ssrf-blocked' }); return; }
            const result = await crawl({
                urls: [body.url],
                extractText: false,
                extractLinks: true,
                extractImages: false,
                extractMeta: false,
                extractHeadings: false,
                extractTables: false,
                extractEmails: false,
                extractPhones: false,
                extractMarkdown: false,
                maxDepth: body.maxDepth ?? 0,
                maxPages: body.maxPages ?? 1,
                includeGlobs: body.includeGlobs,
                excludeGlobs: body.excludeGlobs,
                usePlaywright: body.usePlaywright ?? false,
                adaptiveCrawling: body.adaptiveCrawling ?? false,
                waitForSelector: body.waitForSelector,
                waitForMs: body.waitForMs ?? 0,
                customHeaders: body.customHeaders,
                proxyUrl: body.proxyUrl,
                requestRetries: body.requestRetries ?? 3,
                requestTimeoutSecs: body.requestTimeoutSecs ?? 30,
                rotateUserAgent: body.rotateUserAgent ?? true,
            });
            json(res, 200, {
                sourceUrl: body.url,
                crawledPages: result.totalScraped,
                durationMs: result.durationMs,
                ...mapDiscoveredLinks(result),
            });
            return;
        }

        // POST /v1/sitemap
        if (url === '/v1/sitemap') {
            if (!body.sitemapUrl) {
                json(res, 400, { error: 'Missing required field: sitemapUrl (string)' });
                return;
            }
            const sitemapBlk = blockedUrl(body.sitemapUrl);
            if (sitemapBlk) { json(res, 400, { error: sitemapBlk, code: 'ssrf-blocked' }); return; }
            if (body.listOnly) {
                const urls = await parseSitemap(body.sitemapUrl);
                json(res, 200, { sitemapUrl: body.sitemapUrl, urlCount: urls.length, urls });
                return;
            }
            const result = await crawl({
                sitemapUrl: body.sitemapUrl,
                maxPages: body.maxPages ?? 10,
                extractMarkdown: body.extractMarkdown ?? false,
            });
            json(res, 200, result);
            return;
        }

        // POST /v1/diagnose — no-LLM extraction contract readiness
        if (url === '/v1/diagnose') {
            if (!body.urls || !Array.isArray(body.urls) || body.urls.length === 0) {
                json(res, 400, { error: 'Missing required field: urls (string array)' });
                return;
            }
            const diagnoseBlk = blockedUrl(body.urls);
            if (diagnoseBlk) { json(res, 400, { error: diagnoseBlk, code: 'ssrf-blocked' }); return; }
            const contract = getExtractionContract(body.contractName || 'real-estate-listing');
            const result = await crawl({
                urls: body.urls,
                extractMarkdown: true,
                extractText: true,
                extractLinks: true,
                extractImages: true,
                extractMeta: true,
                extractStructuredData: true,
                maxPages: body.maxPages ?? 10,
                usePlaywright: body.usePlaywright ?? false,
                adaptiveCrawling: body.adaptiveCrawling ?? true,
                waitForSelector: body.waitForSelector,
                waitForMs: body.waitForMs ?? 0,
                customHeaders: body.customHeaders,
                proxyUrl: body.proxyUrl,
                requestRetries: body.requestRetries ?? 3,
                requestTimeoutSecs: body.requestTimeoutSecs ?? 30,
                rotateUserAgent: body.rotateUserAgent ?? true,
            });
            const diagnostics = result.pages.map((page) => diagnoseContractReadiness(contract, page));
            const summary = summarizeContractDiagnostics(diagnostics);
            const generatedAt = new Date().toISOString();
            const payload: Record<string, unknown> = {
                generatedAt,
                contract: {
                    name: contract.name,
                    domain: contract.domain,
                    version: contract.version,
                    requiredFields: contract.requiredFields,
                },
                summary,
                diagnostics,
            };
            if (body.reportMarkdown) {
                payload.reportMarkdown = renderContractDiagnosticReport({
                    generatedAt,
                    contract,
                    summary,
                    diagnostics,
                });
            }
            json(res, 200, payload);
            return;
        }

        // POST /v1/extract-contract — contract extraction + required-field validation
        if (url === '/v1/extract-contract') {
            if (!body.urls || !Array.isArray(body.urls) || body.urls.length === 0) {
                json(res, 400, { error: 'Missing required field: urls (string array)' });
                return;
            }
            const ecUrlBlk = blockedUrl(body.urls);
            if (ecUrlBlk) { json(res, 400, { error: ecUrlBlk, code: 'ssrf-blocked' }); return; }
            const ecLlmUserSupplied = typeof body.llmBaseUrl === 'string' && body.llmBaseUrl.length > 0;
            const ecLlmBlk = ecLlmUserSupplied ? blockedUrl(body.llmBaseUrl) : null;
            if (ecLlmBlk) { json(res, 400, { error: `Blocked llmBaseUrl — ${ecLlmBlk}`, code: 'ssrf-blocked' }); return; }
            const baseUrl = body.llmBaseUrl || DEFAULT_LLM_BASEURL;
            const model = body.llmModel || DEFAULT_LLM_MODEL;
            if (!baseUrl || !model) {
                json(res, 400, { error: 'Missing LLM config. Provide llmBaseUrl + llmModel in the body, or set THECRAWLER_LLM_BASEURL + THECRAWLER_LLM_MODEL env vars on the server.' });
                return;
            }
            const contract = getExtractionContract(body.contractName || 'real-estate-listing');
            const prompt = body.additionalPrompt
                ? `${contract.prompt}\n\nAdditional user instruction:\n${body.additionalPrompt}`
                : contract.prompt;
            const results = await extract({
                urls: body.urls,
                jsonSchema: contract.schema,
                prompt,
                guardLlmUrl: ecLlmUserSupplied && !ALLOW_PRIVATE_HOSTS,
                markdownCharLimit: body.markdownCharLimit ?? 30000,
                crawlOptions: {
                    usePlaywright: body.usePlaywright ?? false,
                    adaptiveCrawling: body.adaptiveCrawling ?? false,
                    requestRetries: body.requestRetries ?? 3,
                    requestTimeoutSecs: body.requestTimeoutSecs ?? 30,
                    rotateUserAgent: body.rotateUserAgent ?? true,
                    customHeaders: body.customHeaders,
                    proxyUrl: body.proxyUrl,
                },
                llm: {
                    baseUrl,
                    model,
                    apiKey: body.llmApiKey || DEFAULT_LLM_API_KEY || undefined,
                    temperature: body.temperature ?? 0,
                    maxTokens: body.maxTokens ?? 4000,
                    timeoutSecs: body.llmTimeoutSecs ?? 120,
                },
            });
            json(res, 200, {
                contract: {
                    name: contract.name,
                    domain: contract.domain,
                    version: contract.version,
                    requiredFields: contract.requiredFields,
                },
                results: attachContractValidation(contract, results),
            });
            return;
        }

        // POST /v1/extract — LLM-powered structured extraction
        if (url === '/v1/extract') {
            if (!body.urls || !Array.isArray(body.urls) || body.urls.length === 0) {
                json(res, 400, { error: 'Missing required field: urls (string array)' });
                return;
            }
            if (!body.jsonSchema && !body.prompt) {
                json(res, 400, { error: 'extract requires either jsonSchema or prompt (or both)' });
                return;
            }
            const exUrlBlk = blockedUrl(body.urls);
            if (exUrlBlk) { json(res, 400, { error: exUrlBlk, code: 'ssrf-blocked' }); return; }
            const exLlmUserSupplied = typeof body.llmBaseUrl === 'string' && body.llmBaseUrl.length > 0;
            const exLlmBlk = exLlmUserSupplied ? blockedUrl(body.llmBaseUrl) : null;
            if (exLlmBlk) { json(res, 400, { error: `Blocked llmBaseUrl — ${exLlmBlk}`, code: 'ssrf-blocked' }); return; }
            const baseUrl = body.llmBaseUrl || DEFAULT_LLM_BASEURL;
            const model = body.llmModel || DEFAULT_LLM_MODEL;
            if (!baseUrl || !model) {
                json(res, 400, { error: 'Missing LLM config. Provide llmBaseUrl + llmModel in the body, or set THECRAWLER_LLM_BASEURL + THECRAWLER_LLM_MODEL env vars on the server.' });
                return;
            }
            const results = await extract({
                urls: body.urls,
                jsonSchema: body.jsonSchema,
                prompt: body.prompt,
                guardLlmUrl: exLlmUserSupplied && !ALLOW_PRIVATE_HOSTS,
                markdownCharLimit: body.markdownCharLimit ?? 30000,
                crawlOptions: {
                    usePlaywright: body.usePlaywright ?? false,
                    adaptiveCrawling: body.adaptiveCrawling ?? false,
                    requestRetries: body.requestRetries ?? 3,
                    requestTimeoutSecs: body.requestTimeoutSecs ?? 30,
                    rotateUserAgent: body.rotateUserAgent ?? true,
                    customHeaders: body.customHeaders,
                    proxyUrl: body.proxyUrl,
                },
                llm: {
                    baseUrl,
                    model,
                    apiKey: body.llmApiKey || DEFAULT_LLM_API_KEY || undefined,
                    temperature: body.temperature ?? 0,
                    maxTokens: body.maxTokens ?? 4000,
                    timeoutSecs: body.llmTimeoutSecs ?? 120,
                },
            });
            json(res, 200, { results });
            return;
        }

        json(res, 404, { error: 'Not found. Available endpoints: /v1/crawl, /v1/scrape, /v1/markdown, /v1/search, /v1/map, /v1/sitemap, /v1/extract, /v1/contracts, /v1/diagnose, /v1/extract-contract, /v1/health' });
    } catch (err: any) {
        json(res, 500, { error: err.message || 'Internal server error' });
    }
});

server.listen(PORT, () => {
    console.log(`TheCrawler API server running on http://localhost:${PORT}`);
    console.log(`Auth: ${API_KEY ? 'API key required (THECRAWLER_API_KEY)' : 'open access (set THECRAWLER_API_KEY to secure)'}`);
    console.log('Endpoints: POST /v1/crawl, /v1/scrape, /v1/markdown, /v1/search, /v1/map, /v1/sitemap, /v1/extract, /v1/diagnose, /v1/extract-contract | GET /v1/contracts, /v1/health');
});
