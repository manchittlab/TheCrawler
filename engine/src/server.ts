#!/usr/bin/env node

/**
 * TheCrawler REST API Server
 *
 * Standalone HTTP API wrapping the crawl engine.
 * Run: node dist/server.js --port 3000
 * Or:  thecrawler-api --port 3000
 *
 * Endpoints:
 *   POST /v1/crawl      — scrape URLs
 *   POST /v1/markdown    — extract markdown from a URL
 *   POST /v1/search      — search Google + scrape results
 *   POST /v1/sitemap     — crawl from sitemap.xml
 *   POST /v1/extract     — LLM-powered structured extraction
 *   GET  /v1/health      — health check
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { crawl, parseSitemap } from './engine.js';
import { extract } from './extract.js';
import type { CrawlOptions, CrawlResult } from './types.js';

const DEFAULT_LLM_BASEURL = process.env.THECRAWLER_LLM_BASEURL || '';
const DEFAULT_LLM_MODEL = process.env.THECRAWLER_LLM_MODEL || '';
const DEFAULT_LLM_API_KEY = process.env.THECRAWLER_LLM_API_KEY || '';

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

    const url = req.url?.split('?')[0] || '';

    try {
        // Health check
        if (url === '/v1/health' && req.method === 'GET') {
            json(res, 200, { status: 'ok', version: '0.2.0', engine: 'thecrawler' });
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
            const opts: CrawlOptions = {
                urls: body.urls,
                extractText: body.extractText ?? true,
                extractLinks: body.extractLinks ?? true,
                extractImages: body.extractImages ?? true,
                extractMeta: body.extractMeta ?? true,
                extractHeadings: body.extractHeadings ?? true,
                extractTables: body.extractTables ?? true,
                extractStructuredData: body.extractStructuredData ?? true,
                extractEmails: body.extractEmails ?? true,
                extractPhones: body.extractPhones ?? true,
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

        // POST /v1/markdown
        if (url === '/v1/markdown') {
            const targetUrl = body.url;
            if (!targetUrl) {
                json(res, 400, { error: 'Missing required field: url (string)' });
                return;
            }
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
                serpApiKey: body.serpApiKey,
                extractMarkdown: body.extractMarkdown ?? false,
            });
            json(res, 200, result);
            return;
        }

        // POST /v1/sitemap
        if (url === '/v1/sitemap') {
            if (!body.sitemapUrl) {
                json(res, 400, { error: 'Missing required field: sitemapUrl (string)' });
                return;
            }
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

        json(res, 404, { error: 'Not found. Available endpoints: /v1/crawl, /v1/markdown, /v1/search, /v1/sitemap, /v1/extract, /v1/health' });
    } catch (err: any) {
        json(res, 500, { error: err.message || 'Internal server error' });
    }
});

server.listen(PORT, () => {
    console.log(`TheCrawler API server running on http://localhost:${PORT}`);
    console.log(`Auth: ${API_KEY ? 'API key required (THECRAWLER_API_KEY)' : 'open access (set THECRAWLER_API_KEY to secure)'}`);
    console.log('Endpoints: POST /v1/crawl, /v1/markdown, /v1/search, /v1/sitemap, /v1/extract | GET /v1/health');
});
