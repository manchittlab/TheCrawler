/**
 * TheCrawler Engine — standalone scraping core, zero Apify dependencies.
 *
 * This is the single source of truth for all scraping logic.
 * The Apify actor, CLI, MCP server, and API server all wrap this engine.
 *
 * v0.2.0 changes (S11 2026-04-28):
 * - Structured error taxonomy (PageData.errorType, errorRetryable)
 * - Standard browser User-Agent rotation (rotateUserAgent option)
 * - Configurable retries + timeout (requestRetries, requestTimeoutSecs)
 * - Optional in-memory LRU cache (cache.enabled)
 */

import { CheerioCrawler, PlaywrightCrawler, ProxyConfiguration, RequestQueue, type CheerioCrawlingContext, type PlaywrightCrawlingContext } from 'crawlee';
import * as cheerioLib from 'cheerio';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import TurndownService from 'turndown';
// @ts-ignore — no types available
import { gfm } from 'turndown-plugin-gfm';

import type { CrawlOptions, PageData, CrawlResult, BrowserAction, CrawlErrorType } from './types.js';
import { CrawlCache, getDefaultCache } from './cache.js';
import {
    buildPalette, rankLogosByQuality, collectCssColors, normalizeColor, sanitizeInlineSvg,
    isBlockedBrandHost, sameSite, extractOrgFromJsonLd,
    quantizeDominantColor, dominantColorFromSvgMarkup, foldLogoColorIntoPalette,
    type ColorHit, type LogoEntry, type LogoProbe,
} from './brand.js';
import { safeFetch } from './ssrf.js';
import { PNG } from 'pngjs';

// Re-export types for consumers
export type { CrawlOptions, PageData, CrawlResult, BrowserAction, CrawlErrorType } from './types.js';
export { CrawlCache } from './cache.js';

const defaultLogger = {
    info: (msg: string, data?: any) => console.log(`[TheCrawler] ${msg}`, data ? JSON.stringify(data) : ''),
    error: (msg: string, data?: any) => console.error(`[TheCrawler] ${msg}`, data ? JSON.stringify(data) : ''),
};

// --- User-Agent pool (standard browser strings, rotated per request) ---
const USER_AGENT_POOL = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:130.0) Gecko/20100101 Firefox/130.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0',
];
function pickUserAgent(): string {
    return USER_AGENT_POOL[Math.floor(Math.random() * USER_AGENT_POOL.length)];
}

// SSRF guard for engine-internal fetches of UNTRUSTED, content-derived URLs
// (sitemap children, document downloads) that bypass the request-boundary check —
// a malicious sitemap can list http://169.254.169.254/… as a child. Default-protected
// via safeFetch (DNS-resolve + private-IP reject + manual redirect re-validation).
// The engine LIBRARY stays permissive when THECRAWLER_ALLOW_PRIVATE_HOSTS=1 (matches
// server.ts; lets 127.0.0.1 test fixtures + operator self-hosting through) — Lesson 22:
// enforce at the untrusted boundary, don't break the permissive library.
const ALLOW_PRIVATE_HOSTS = process.env.THECRAWLER_ALLOW_PRIVATE_HOSTS === '1';
async function guardedFetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal } = {}): Promise<Response> {
    if (ALLOW_PRIVATE_HOSTS) return fetch(url, init as RequestInit);
    return safeFetch(url, init);
}

// --- Error classification ---
const RETRYABLE_TYPES: CrawlErrorType[] = ['timeout', 'rate-limit', 'http-5xx', 'network'];

function classifyError(message: string | undefined, statusCode?: number): { type: CrawlErrorType; retryable: boolean } {
    const m = (message || '').toLowerCase();
    if (statusCode === 429 || m.includes('429') || m.includes('too many requests')) return { type: 'rate-limit', retryable: true };
    if (statusCode && statusCode >= 500 && statusCode < 600) return { type: 'http-5xx', retryable: true };
    // Anti-bot block. Crawlee surfaces exhausted blocks as "Request blocked - received 403 status code"
    // (statusCode is often not propagated to the failed handler), so match the message too — else a
    // real block gets misfiled as 'timeout'/'unknown'. Checked before the timeout branch so it wins.
    if (statusCode === 403 || m.includes('403') || m.includes('request blocked') || m.includes('blocked')
        || m.includes('cloudflare') || m.includes('access denied') || m.includes('attention required')
        || m.includes('akamai') || m.includes('perimeterx') || m.includes('datadome') || m.includes('captcha')) return { type: 'blocked-bot', retryable: false };
    if (statusCode && statusCode >= 400 && statusCode < 500) return { type: 'http-4xx', retryable: false };
    if (m.includes('enotfound') || m.includes('dns')) return { type: 'dns', retryable: false };
    if (m.includes('timeout') || m.includes('etimedout')) return { type: 'timeout', retryable: true };
    if (m.includes('econnreset') || m.includes('econnrefused') || m.includes('ehostunreach') || m.includes('socket') || m.includes('network') || m.includes('no page result emitted') || m.includes('skipped by the crawl queue')) return { type: 'network', retryable: true };
    if (m.includes('parse') || m.includes('invalid') || m.includes('malformed')) return { type: 'parse', retryable: false };
    return { type: 'unknown', retryable: false };
}

// --- Chunking ---
export function chunkText(text: string, chunkSize: number, overlap: number) {
    if (!text || chunkSize <= 0) return [];
    const chunks: { text: string; index: number; section: string | null; charCount: number; hash: string }[] = [];
    const sections = text.split(/(?=^#{1,3}\s)/m);
    let currentChunk = '';
    let chunkIndex = 0;
    let currentSection: string | null = null;

    for (const section of sections) {
        const headingMatch = section.match(/^(#{1,3})\s+(.+)/);
        if (headingMatch) currentSection = headingMatch[2].trim();
        if (currentChunk.length + section.length > chunkSize && currentChunk.length > 0) {
            const hash = createHash('md5').update(currentChunk).digest('hex').slice(0, 12);
            chunks.push({ text: currentChunk.trim(), index: chunkIndex++, section: currentSection, charCount: currentChunk.trim().length, hash });
            currentChunk = overlap > 0 ? currentChunk.slice(-overlap) + section : section;
        } else {
            currentChunk += section;
        }
    }
    if (currentChunk.trim()) {
        const hash = createHash('md5').update(currentChunk).digest('hex').slice(0, 12);
        chunks.push({ text: currentChunk.trim(), index: chunkIndex, section: currentSection, charCount: currentChunk.trim().length, hash });
    }
    return chunks;
}

function matchGlob(url: string, pattern: string): boolean {
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
    return regex.test(url);
}

// --- Search ---
/**
 * Resolve the top result URLs for a query. Provider precedence:
 *   1. Serper.dev (the project default — cheaper) — key from arg or
 *      SERPER_API_KEY / SERPER_DEV_KEY / THECRAWLER_SERPER_KEY env.
 *   2. SerpAPI — key from arg or SERPAPI_KEY / THECRAWLER_SERPAPI_KEY env.
 *   3. Fragile Google-HTML scrape (usually blocked now) — last resort.
 * Reading the key from env is what makes search work in MCP/CLI/server without
 * threading it through every call (the bug: the MCP passed no key → HTML scrape → 0).
 */
export async function searchGoogle(query: string, limit: number, keys?: { serpApiKey?: string; serperApiKey?: string }, log?: { info: any; error: any }): Promise<string[]> {
    const serper = keys?.serperApiKey || process.env.SERPER_API_KEY || process.env.SERPER_DEV_KEY || process.env.THECRAWLER_SERPER_KEY;
    if (serper) {
        try {
            const r = await fetch('https://google.serper.dev/search', {
                method: 'POST',
                headers: { 'X-API-KEY': serper, 'Content-Type': 'application/json' },
                body: JSON.stringify({ q: query, num: Math.min(limit + 2, 20) }),
                signal: AbortSignal.timeout(15000),
            });
            if (!r.ok) throw new Error(`Serper HTTP ${r.status}`);
            const data = await r.json() as { organic?: Array<{ link?: unknown }> };
            const urls: string[] = [];
            for (const item of data.organic || []) {
                if (typeof item.link === 'string' && /^https?:\/\//i.test(item.link)) urls.push(item.link);
                if (urls.length >= limit) break;
            }
            return urls;
        } catch (e: any) {
            log?.error?.(`Serper.dev search failed: ${e?.message || e}`);
            return [];
        }
    }
    const serpApiKey = keys?.serpApiKey || process.env.SERPAPI_KEY || process.env.THECRAWLER_SERPAPI_KEY;
    if (serpApiKey) {
        const require2 = createRequire(import.meta.url);
        const { getJson } = require2('google-search-results-nodejs');
        return new Promise((resolve) => {
            const client = new getJson(serpApiKey);
            client.json({ q: query, num: limit, engine: 'google' }, (data: any) => {
                resolve((data.organic_results || []).map((r: any) => r.link).filter(Boolean).slice(0, limit));
            });
        });
    }
    log?.info(`No search API key (set SERPER_API_KEY / THECRAWLER_SERPER_KEY, or SERPAPI_KEY) — falling back to Google HTML scrape (fragile, usually blocked)`);
    const encoded = encodeURIComponent(query);
    const res = await fetch(`https://www.google.com/search?q=${encoded}&num=${limit}`, {
        headers: { 'User-Agent': pickUserAgent() },
    });
    const html = await res.text();
    const urls: string[] = [];
    const regex = /href="\/url\?q=(https?:\/\/[^&"]+)/g;
    let match;
    while ((match = regex.exec(html)) !== null) {
        const url = decodeURIComponent(match[1]);
        if (!url.includes('google.com') && !url.includes('youtube.com/redirect')) urls.push(url);
    }
    return [...new Set(urls)].slice(0, limit);
}

// --- Sitemap ---
export async function parseSitemap(sitemapUrl: string): Promise<string[]> {
    const res = await guardedFetch(sitemapUrl, { headers: { 'User-Agent': pickUserAgent() } });
    const xml = await res.text();
    const urls: string[] = [];
    const locRegex = /<loc>\s*(https?:\/\/[^<]+)\s*<\/loc>/gi;
    let match;
    while ((match = locRegex.exec(xml)) !== null) urls.push(match[1].trim());

    if (xml.includes('<sitemapindex')) {
        const childUrls: string[] = [];
        for (const childUrl of urls) {
            if (childUrl.endsWith('.xml') || childUrl.includes('sitemap')) {
                try {
                    const childRes = await guardedFetch(childUrl, { headers: { 'User-Agent': pickUserAgent() } });
                    const childXml = await childRes.text();
                    const childLocRegex = /<loc>\s*(https?:\/\/[^<]+)\s*<\/loc>/gi;
                    let cm;
                    while ((cm = childLocRegex.exec(childXml)) !== null) childUrls.push(cm[1].trim());
                } catch { /* skip */ }
            }
        }
        return childUrls;
    }
    return urls;
}

// --- PDF ---
/**
 * Best-effort text recovery for PDFs that pdf-parse can't open (malformed,
 * truncated, or minimal/“dummy” files that throw "Invalid PDF structure").
 * Pulls text from uncompressed content streams: parenthesized string literals
 * inside BT/ET text blocks, plus hex strings. Not a full PDF renderer — it
 * recovers readable text where pdf-parse hard-fails, instead of crashing.
 * Returns '' if nothing legible is found (caller then emits a graceful error).
 */
export function recoverPdfTextLenient(buffer: Buffer): string {
    const raw = buffer.toString('latin1');
    const out: string[] = [];
    // 1. Parenthesized strings in text-show operators: (text) Tj  /  [(a)(b)] TJ
    const reParen = /\(((?:\\.|[^\\()])*)\)\s*(?:T[jJ]|')/g;
    let m: RegExpExecArray | null;
    while ((m = reParen.exec(raw)) !== null) {
        const s = m[1]
            .replace(/\\([()\\])/g, '$1')
            .replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t')
            .replace(/\\(\d{1,3})/g, (_x, o) => String.fromCharCode(parseInt(o, 8) & 0xff));
        if (s.trim()) out.push(s);
    }
    // 2. Fallback: array-show strings not caught above.
    if (out.length === 0) {
        const reArr = /\[((?:\([^)]*\)\s*-?\d*\s*)+)\]\s*TJ/g;
        while ((m = reArr.exec(raw)) !== null) {
            const parts = [...m[1].matchAll(/\(((?:\\.|[^\\()])*)\)/g)].map((p) => p[1]);
            if (parts.length) out.push(parts.join(''));
        }
    }
    return out.join(' ').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

async function extractPdf(url: string) {
    const require2 = createRequire(import.meta.url);
    const pdfParse = require2('pdf-parse');
    const res = await guardedFetch(url, { headers: { 'User-Agent': pickUserAgent() } });
    const buffer = Buffer.from(await res.arrayBuffer());
    try {
        const data = await pdfParse(buffer);
        const metadata: Record<string, string> = {};
        if (data.info) { for (const [k, v] of Object.entries(data.info)) { if (typeof v === 'string') metadata[k] = v; } }
        const text = (data.text || '').trim();
        // pdf-parse can "succeed" on a broken file but yield nothing — fall back.
        if (text.length > 0) return { text: text.slice(0, 100000), pages: data.numpages || 0, metadata, parser: 'pdf-parse' };
        const recovered = recoverPdfTextLenient(buffer);
        if (recovered) return { text: recovered.slice(0, 100000), pages: data.numpages || 0, metadata, parser: 'lenient-fallback' };
        return { text: '', pages: data.numpages || 0, metadata, parser: 'pdf-parse' };
    } catch (err: any) {
        // Malformed PDF: pdf-parse threw. Try lenient recovery before giving up.
        const recovered = recoverPdfTextLenient(buffer);
        if (recovered) return { text: recovered.slice(0, 100000), pages: 0, metadata: {}, parser: 'lenient-fallback' };
        throw err; // genuinely unreadable — caller emits a graceful PDF error page
    }
}

// --- DOCX ---
async function extractDocx(url: string) {
    const require2 = createRequire(import.meta.url);
    const mammoth = require2('mammoth');
    const res = await guardedFetch(url, { headers: { 'User-Agent': pickUserAgent() } });
    const buffer = Buffer.from(await res.arrayBuffer());
    const [textResult, mdResult] = await Promise.all([mammoth.extractRawText({ buffer }), mammoth.convertToMarkdown({ buffer })]);
    return { text: (textResult.value || '').slice(0, 100000), markdown: (mdResult.value || '').slice(0, 100000) };
}

// --- Browser actions ---
async function executeActions(page: any, actions: BrowserAction[], storeValue?: CrawlOptions['onStoreValue']): Promise<string[]> {
    const screenshots: string[] = [];
    for (const action of actions) {
        switch (action.type) {
            case 'click':
                if (action.selector) { try { await page.click(action.selector, { timeout: 5000 }); } catch {} await page.waitForTimeout(500); }
                break;
            case 'fill':
                if (action.selector && action.value !== undefined) { try { await page.fill(action.selector, action.value); } catch {} }
                break;
            case 'scroll':
                await page.evaluate((px: number) => window.scrollBy(0, px), action.pixels ?? 1000);
                await page.waitForTimeout(500);
                break;
            case 'wait':
                await page.waitForTimeout(action.ms ?? 2000);
                break;
            case 'screenshot': {
                const key = `screenshot-${Date.now()}`;
                const buf = await page.screenshot({ fullPage: false });
                if (storeValue) await storeValue(key, buf, 'image/png');
                screenshots.push(key);
                break;
            }
        }
    }
    return screenshots;
}

// --- Empty page data template ---
function emptyPage(url: string, overrides: Partial<PageData> = {}): PageData {
    return {
        url, title: null, description: null, language: null, canonicalUrl: null, robotsDirectives: null,
        text: null, headings: [], links: [], images: [], meta: {}, openGraph: {}, twitterCard: {},
        tables: [], structuredData: [], emails: [], phones: [], socialLinks: [],
        markdown: null, chunks: null, selectedContent: null, pdf: null, screenshots: [],
        redirectChain: [], hreflangTags: [], paginationLinks: [], microdata: [],
        commerceData: [], forms: [], analyticsDetected: [],
        statusCode: 0, contentType: null, responseTimeMs: null, pageSizeBytes: null,
        responseHeaders: {}, scrapedAt: new Date().toISOString(), status: 'error', error: null,
        errorType: null, errorRetryable: false, fromCache: false,
        engine: 'cheerio', usedPlaywright: false, themeColor: null, palette: [], logo: [], brandOrg: null,
        html: null, rawHtml: null,
        ...overrides,
    };
}

/** Build a PageData representing a failed fetch, with classified error fields. */
function errorPage(url: string, message: string, statusCode?: number): PageData {
    const { type, retryable } = classifyError(message, statusCode);
    // Make an anti-bot block ACTIONABLE instead of a bare 403: enterprise-protected sites
    // (Trustpilot, G2, Yelp, Glassdoor…) block plain fetch AND headless Chromium alike — the
    // real fix is a residential proxy. Lighter blocks often pass with a real browser.
    const error = type === 'blocked-bot'
        ? `${message} — blocked by anti-bot. Try usePlaywright:true for lighter protection; hard-protected sites (Trustpilot, G2, Yelp) need a residential proxy — pass proxyUrl.`
        : message;
    return emptyPage(url, {
        error,
        errorType: type,
        errorRetryable: retryable,
        statusCode: statusCode ?? 0,
    });
}

// --- Brand identity helpers ---

const LOGO_HINT_RE = /logo|brand/i;
// Social/share hosts: an <img> from these in a header is a share-icon, not the logo.
const SOCIAL_HOST_RE = /(facebook|twitter|x\.com|instagram|linkedin|youtube|youtu\.be|tiktok|pinterest|github|whatsapp|telegram|t\.me|reddit|discord)\./i;

/** Recursively collect logo URLs from JSON-LD (Organization/WebSite/publisher logo, @graph). */
function findJsonLdLogos(nodes: unknown[], depth = 0): string[] {
    const out: string[] = [];
    const visit = (v: any, d: number) => {
        if (!v || typeof v !== 'object' || d > 6) return;
        if (Array.isArray(v)) { for (const x of v) visit(x, d + 1); return; }
        if (v.logo) {
            if (typeof v.logo === 'string') out.push(v.logo);
            else if (Array.isArray(v.logo) && typeof v.logo[0]?.url === 'string') out.push(v.logo[0].url);
            else if (typeof v.logo === 'object' && typeof v.logo.url === 'string') out.push(v.logo.url);
        }
        for (const k of Object.keys(v)) {
            if (k === 'logo') continue;
            const child = v[k];
            if (child && typeof child === 'object') visit(child, d + 1);
        }
    };
    for (const n of nodes) visit(n, depth);
    return out;
}

function guessImageType(url: string): string | null {
    if (url.startsWith('data:image/svg')) return 'svg';
    const m = url.split('?')[0].toLowerCase().match(/\.(svg|png|jpe?g|webp|gif|ico|avif)$/);
    if (!m) return null;
    return m[1] === 'jpeg' ? 'jpg' : m[1];
}

/** Gather ranked logo candidates from the DOM + JSON-LD. */
function extractLogoCandidates($: any, pageUrl: string, structuredData: unknown[]): LogoEntry[] {
    const cands: LogoEntry[] = [];
    let origin = '';
    try { origin = new URL(pageUrl).origin; } catch {}
    const abs = (u: string | undefined | null): string | null => {
        if (!u) return null;
        try { return new URL(u, pageUrl).href; } catch { return null; }
    };

    for (const raw of findJsonLdLogos(structuredData)) {
        const u = abs(raw);
        if (u) cands.push({ url: u, source: 'json-ld', type: guessImageType(u), confidence: 0.9 });
    }

    $('header img, nav img, [role="banner"] img, .logo img, .brand img, a[class*="logo"] img, a[class*="brand"] img').each((_i: any, el: any) => {
        const hint = `${$(el).attr('class') || ''} ${$(el).attr('id') || ''} ${$(el).attr('alt') || ''} ${$(el).attr('src') || ''}`;
        if (!LOGO_HINT_RE.test(hint)) return;
        const u = abs($(el).attr('src') || $(el).attr('data-src'));
        if (u) cands.push({ url: u, source: 'header-img', type: guessImageType(u), confidence: 0.8 });
    });
    $('img[class*="logo" i], img[id*="logo" i], img[alt*="logo" i]').each((_i: any, el: any) => {
        const u = abs($(el).attr('src') || $(el).attr('data-src'));
        if (u) cands.push({ url: u, source: 'logo-img', type: guessImageType(u), confidence: 0.7 });
    });

    // Keyword-less logo (Kimi #1): the <img> inside the header/nav HOME link is almost
    // always the logo even without a logo/brand keyword (e.g. <a href="/"><img alt="Acme">).
    // Exclude social share-icons. Final rank is adjusted by fetched image quality later.
    $('header a img, nav a img, [role="banner"] a img').each((_i: any, el: any) => {
        const href = ($(el).closest('a').attr('href') || '').trim();
        const isHome = href === '/' || href === '#' || href === '' || href === origin || href === `${origin}/` || href === pageUrl;
        if (!isHome) return;
        const src = $(el).attr('src') || $(el).attr('data-src') || '';
        if (SOCIAL_HOST_RE.test(src)) return;
        const u = abs(src);
        if (u && !SOCIAL_HOST_RE.test(u)) cands.push({ url: u, source: 'home-link-img', type: guessImageType(u), confidence: 0.82 });
    });

    $('header svg, nav svg, [role="banner"] svg, .logo svg, [class*="logo"] svg, [class*="brand"] svg').each((_i: any, el: any) => {
        if (cands.some((c) => c.source === 'header-svg')) return;
        const safe = sanitizeInlineSvg($.html($(el)));
        if (safe) cands.push({ url: `data:image/svg+xml;utf8,${encodeURIComponent(safe)}`, source: 'header-svg', type: 'svg', confidence: 0.78 });
    });

    $('link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="apple-touch-icon-precomposed"], link[rel="mask-icon"]').each((_i: any, el: any) => {
        const rel = ($(el).attr('rel') || '').toLowerCase();
        const u = abs($(el).attr('href'));
        if (!u) return;
        const conf = rel.includes('apple-touch') ? 0.7 : rel.includes('mask') ? 0.6 : 0.65;
        cands.push({ url: u, source: rel || 'icon', type: guessImageType(u), confidence: conf });
    });
    if (origin) cands.push({ url: `${origin}/favicon.ico`, source: 'favicon-default', type: 'ico', confidence: 0.4 });

    const og = $('meta[property="og:image"]').attr('content') || $('meta[name="og:image"]').attr('content');
    const ogu = abs(og);
    if (ogu) cands.push({ url: ogu, source: 'og:image', type: guessImageType(ogu), confidence: 0.3 });

    return cands;
}

const LOGO_PROBE_TIMEOUT_MS = 6000;
const LOGO_PROBE_MAX = 6;

/** HEAD-probe one logo URL (SSRF-guarded via safeFetch) for bytes + content-type. Never throws. */
async function probeLogoMeta(url: string): Promise<LogoProbe> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), LOGO_PROBE_TIMEOUT_MS);
    try {
        let bytes: number | null = null;
        let contentType: string | null = null;
        let ok = false;
        try {
            const r = await safeFetch(url, { method: 'HEAD', signal: ctrl.signal });
            ok = r.ok;
            const cl = r.headers.get('content-length');
            if (cl) bytes = parseInt(cl, 10);
            contentType = r.headers.get('content-type');
        } catch { return { ok: false, bytes: null, contentType: null }; }
        // Some servers reject HEAD or omit length — a 1-byte ranged GET gets headers only.
        if (!ok || bytes == null) {
            try {
                const g = await safeFetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' }, signal: ctrl.signal });
                await g.body?.cancel().catch(() => {});
                const cr = g.headers.get('content-range');
                const m = cr ? cr.match(/\/(\d+)\s*$/) : null;
                if (m) bytes = parseInt(m[1], 10);
                else { const cl2 = g.headers.get('content-length'); if (cl2) bytes = parseInt(cl2, 10); }
                ok = ok || g.ok || (g.status >= 200 && g.status < 300);
                contentType = contentType || g.headers.get('content-type');
            } catch { /* keep the HEAD result */ }
        }
        return { ok, bytes: Number.isFinite(bytes as number) ? bytes : null, contentType };
    } finally { clearTimeout(t); }
}

/**
 * Probe the strongest logo candidates (bounded count + timeout) for real size/type,
 * then rank by confidence × fetched quality so a tiny favicon / dead URL / social
 * card can't outrank a real wordmark. Inline-SVG (data:) candidates score without a
 * fetch. Never throws — a failed probe just scores neutral.
 */
async function probeAndRankLogos(cands: LogoEntry[]): Promise<LogoEntry[]> {
    const byPrior = [...new Map(cands.map((c) => [c.url, c])).values()].sort((a, b) => b.confidence - a.confidence);
    const toProbe = byPrior.filter((c) => !c.url.startsWith('data:')).slice(0, LOGO_PROBE_MAX);
    const probes = new Map<string, LogoProbe>();
    await Promise.all(toProbe.map(async (c) => { try { probes.set(c.url, await probeLogoMeta(c.url)); } catch { /* neutral */ } }));
    return rankLogosByQuality(cands, probes);
}

/**
 * Fetch + parse a PWA web app manifest (SSRF-guarded) for icon candidates + theme/bg
 * colors. The manifest often holds the highest-res logo (512px). Never throws.
 */
async function fetchManifest(manifestUrl: string): Promise<{ icons: LogoEntry[]; themeColorRaw: string | null; bgColorRaw: string | null }> {
    const empty = { icons: [] as LogoEntry[], themeColorRaw: null as string | null, bgColorRaw: null as string | null };
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), LOGO_PROBE_TIMEOUT_MS);
    try {
        let r: Response;
        try { r = await safeFetch(manifestUrl, { signal: ctrl.signal }); } catch { return empty; }
        if (!r.ok) { await r.body?.cancel().catch(() => {}); return empty; }
        const ct = (r.headers.get('content-type') || '').toLowerCase();
        if (ct && !ct.includes('json') && !ct.includes('text')) { await r.body?.cancel().catch(() => {}); return empty; }
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.byteLength > 512_000) return empty; // manifests are tiny — bound pathological input
        let m: any;
        try { m = JSON.parse(buf.toString('utf8')); } catch { return empty; }
        const icons: LogoEntry[] = [];
        if (Array.isArray(m?.icons)) {
            for (const ic of m.icons) {
                if (!ic || typeof ic.src !== 'string') continue;
                let u: string;
                try { u = new URL(ic.src, manifestUrl).href; } catch { continue; }
                const maxDim = String(ic.sizes || '').split(/\s+/).map((s: string) => parseInt(s, 10) || 0).reduce((a: number, b: number) => Math.max(a, b), 0);
                const conf = maxDim >= 512 ? 0.88 : maxDim >= 192 ? 0.84 : 0.7;
                icons.push({ url: u, source: 'manifest', type: guessImageType(u), confidence: conf });
            }
        }
        return {
            icons,
            themeColorRaw: typeof m?.theme_color === 'string' ? m.theme_color : null,
            bgColorRaw: typeof m?.background_color === 'string' ? m.background_color : null,
        };
    } finally { clearTimeout(t); }
}

const LOGO_COLOR_MAX_BYTES = 2_000_000;

/**
 * L4: derive the logo's dominant brand color. Tries the top-ranked logo candidates
 * (bounded): inline/remote SVG → parse fill colors; PNG → pngjs-decode + quantize
 * (zero-native, deterministic). Other raster formats are skipped (no decoder).
 * SSRF-guarded fetch, size-capped. Returns a hex or null. Never throws.
 */
async function deriveLogoColor(logos: LogoEntry[], _pageUrl: string): Promise<string | null> {
    for (const cand of logos.slice(0, 3)) {
        try {
            if (cand.url.startsWith('data:image/svg')) {
                const svg = decodeURIComponent(cand.url.replace(/^data:image\/svg\+xml[^,]*,/i, ''));
                const c = dominantColorFromSvgMarkup(svg);
                if (c) return c;
                continue;
            }
            if (cand.url.startsWith('data:')) continue; // non-svg data URI — no decoder
            if (cand.type === 'svg') {
                const r = await guardedFetch(cand.url, { headers: { 'User-Agent': USER_AGENT_POOL[0] } });
                if (!r.ok) continue;
                const c = dominantColorFromSvgMarkup(await r.text());
                if (c) return c;
                continue;
            }
            if (cand.type && cand.type !== 'png') continue; // only PNG is decoded (pngjs)
            const r = await guardedFetch(cand.url, { headers: { 'User-Agent': USER_AGENT_POOL[0] } });
            if (!r.ok) continue;
            const ab = await r.arrayBuffer();
            if (ab.byteLength === 0 || ab.byteLength > LOGO_COLOR_MAX_BYTES) continue;
            const png = PNG.sync.read(Buffer.from(ab));
            const c = quantizeDominantColor(png.data, { channels: 4 });
            if (c) return c;
        } catch { /* try next candidate */ }
    }
    return null;
}

/** Sample rendered brand colors from a live Playwright page (computed styles). */
async function sampleComputedColors(page: any): Promise<ColorHit[]> {
    try {
        const raw: { v: string; role: string; w: number }[] = await page.evaluate(() => {
            const out: { v: string; role: string; w: number }[] = [];
            const push = (v: string | null, role: string, w: number) => { if (v) out.push({ v, role, w }); };
            const grabBg = (sel: string, role: string, w: number) => {
                const el = document.querySelector(sel) as HTMLElement | null;
                if (el) push(getComputedStyle(el).backgroundColor, role + '-bg', w);
            };
            grabBg('header', 'header', 0.45);
            grabBg('nav', 'nav', 0.4);
            const btn = document.querySelector('button, .btn, [class*="button"], a[class*="btn"]') as HTMLElement | null;
            if (btn) { const cs = getComputedStyle(btn); push(cs.backgroundColor, 'button-bg', 0.45); push(cs.color, 'button-fg', 0.3); }
            const link = document.querySelector('a[href]') as HTMLElement | null;
            if (link) push(getComputedStyle(link).color, 'link', 0.35);
            const logo = document.querySelector('[class*="logo"], [id*="logo"]') as HTMLElement | null;
            if (logo) push(getComputedStyle(logo).backgroundColor, 'logo-bg', 0.3);
            if (document.body) push(getComputedStyle(document.body).backgroundColor, 'body-bg', 0.2);
            return out;
        });
        return raw
            .filter((r) => r.v && r.v !== 'transparent' && !/rgba?\(\s*0,\s*0,\s*0,\s*0\s*\)/.test(r.v))
            .map((r) => ({ value: r.v, source: 'computed:' + r.role, weight: r.w }));
    } catch {
        return [];
    }
}

/** Fetch a bounded, SSRF-safe set of same-domain linked stylesheets; return concatenated CSS. */
async function fetchBrandStylesheets($: any, pageUrl: string): Promise<string> {
    let pageHost = '';
    try { pageHost = new URL(pageUrl).hostname; } catch { return ''; }
    const hrefs: string[] = [];
    $('link[rel~="stylesheet"][href]').each((_i: any, el: any) => {
        if (hrefs.length >= 3) return;
        const href = $(el).attr('href');
        if (!href) return;
        let u: URL;
        try { u = new URL(href, pageUrl); } catch { return; }
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
        if (isBlockedBrandHost(u.hostname)) return;
        if (!sameSite(u.hostname, pageHost)) return;
        if (!hrefs.includes(u.href)) hrefs.push(u.href);
    });
    if (hrefs.length === 0) return '';

    const MAX_SHEET_BYTES = 262144; // 256KB per sheet
    const fetchOne = async (u: string): Promise<string> => {
        try {
            const host = new URL(u).hostname;
            // Defense-in-depth vs DNS rebinding: resolve and reject private IPs.
            try { const a = await dnsLookup(host); if (isBlockedBrandHost(a.address)) return ''; } catch { return ''; }
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 2000);
            try {
                // redirect:'manual' — a same-site sheet that 3xx-redirects to a
                // private/metadata host would otherwise bypass the SSRF guards.
                const r = await fetch(u, { signal: ctrl.signal, headers: { 'User-Agent': USER_AGENT_POOL[0], Accept: 'text/css,*/*;q=0.1' }, redirect: 'manual' });
                if (r.status >= 300 && r.status < 400) return '';
                if (!r.ok) return '';
                const ct = r.headers.get('content-type') || '';
                if (ct && !ct.includes('css') && !ct.includes('text/plain')) return '';
                const buf = Buffer.from(await r.arrayBuffer());
                return (buf.byteLength > MAX_SHEET_BYTES ? buf.subarray(0, MAX_SHEET_BYTES) : buf).toString('utf8');
            } finally { clearTimeout(t); }
        } catch { return ''; }
    };
    const all = await Promise.all(hrefs.map(fetchOne));
    return all.join('\n').slice(0, 524288); // 512KB aggregate
}

/**
 * Core crawl function. Streams results via onPageData callback.
 * Returns total pages scraped.
 */
export async function crawlStream(
    options: CrawlOptions,
    onPageData: (data: PageData) => Promise<void> | void,
): Promise<number> {
    let pagesEmitted = 0;
    const emitPage = onPageData;
    onPageData = async (data: PageData) => {
        pagesEmitted++;
        await emitPage(data);
    };

    const {
        urls: inputUrls = [],
        searchQuery, searchLimit = 10, serpApiKey, serperApiKey,
        sitemapUrl,
        extractText = true, extractLinks = true, extractImages = true,
        extractMeta = true, extractHeadings = true, extractTables = true,
        extractStructuredData = true, extractEmails = false, extractPhones = false,
        extractBrand = false, brandFetchStylesheets = true,
        onlyMainContent = false, includeTags = [], excludeTags = [],
        extractHtml = false, extractRawHtml = false, waitFor,
        extractMarkdown = false, stripBoilerplate = true,
        chunkSize = 0, chunkOverlap = 200, cssSelector,
        maxDepth = 0, maxPages = 100,
        includeGlobs = [], excludeGlobs = [],
        customHeaders = {}, screenshotFullPage = false,
        proxyUrl, usePlaywright = false, adaptiveCrawling = false,
        waitForSelector, waitForMs = 0, actions = [],
        requestRetries = 3, requestTimeoutSecs = 30,
        rotateUserAgent = true,
        cache: cacheOpts,
        onStoreValue,
        logger: log = defaultLogger,
    } = options;

    // Firecrawl-compatible `waitFor` is an alias for `waitForMs`.
    const effectiveWaitMs = waitFor != null ? waitFor : waitForMs;

    // Cache setup
    const cacheEnabled = cacheOpts?.enabled ?? false;
    const cache = cacheEnabled
        ? getDefaultCache(cacheOpts?.maxEntries ?? 500, cacheOpts?.ttlSeconds ?? 300)
        : null;

    // Resolve URLs from search or sitemap
    let urls = [...inputUrls];
    if (searchQuery && urls.length === 0) {
        const serperEnv = serperApiKey || process.env.SERPER_API_KEY || process.env.SERPER_DEV_KEY || process.env.THECRAWLER_SERPER_KEY;
        const provider = serperEnv ? 'Serper.dev' : (serpApiKey || process.env.SERPAPI_KEY || process.env.THECRAWLER_SERPAPI_KEY) ? 'SerpAPI' : 'HTML-scrape(fragile)';
        log.info(`Searching: "${searchQuery}" (limit: ${searchLimit}) via ${provider}`);
        urls = await searchGoogle(searchQuery, searchLimit, { serpApiKey, serperApiKey }, log);
        log.info(`Found ${urls.length} URLs`);
        if (urls.length === 0) return 0;
    }
    if (sitemapUrl && urls.length === 0) {
        log.info(`Fetching sitemap: ${sitemapUrl}`);
        const sitemapUrls = await parseSitemap(sitemapUrl);
        log.info(`Found ${sitemapUrls.length} URLs in sitemap`);
        urls = sitemapUrls.slice(0, maxPages);
    }
    if (urls.length === 0) return 0;

    let pagesScraped = 0;

    // --- Cache pre-pass: serve any URL we already have ---
    const urlsNeedingFetch: string[] = [];
    if (cache) {
        for (const url of urls) {
            const fullUrl = url.startsWith('http') ? url : `https://${url}`;
            const key = CrawlCache.keyFor(fullUrl, options);
            const cached = cache.get(key);
            if (cached) {
                await onPageData(cached);
                pagesScraped++;
            } else {
                urlsNeedingFetch.push(url);
            }
        }
    } else {
        urlsNeedingFetch.push(...urls);
    }
    if (urlsNeedingFetch.length === 0) return pagesScraped;

    // --- Shared page handler ---
    async function handlePage(
        request: { url: string; loadedUrl?: string; userData?: Record<string, unknown> },
        $: any, responseHeaders: Record<string, string>,
        actualStatus: number, actualContentType: string | null, startTime: number,
        brandComputedHits: ColorHit[] = [], brandExtraCss = '',
    ) {
        const pageUrl = request.loadedUrl ?? request.url;
        const data: PageData = emptyPage(pageUrl, {
            statusCode: actualStatus, contentType: actualContentType,
            responseHeaders, status: 'success',
        });

        const html = $.html();
        data.pageSizeBytes = Buffer.byteLength(html, 'utf8');

        // Capture brand CSS + theme-color BEFORE extractText/markdown strip <style> from $.
        let brandCssText = '';
        let brandThemeColorRaw: string | null = null;
        if (extractBrand) {
            const styleBlocks: string[] = [];
            $('style').each((_i: any, el: any) => { const t = $(el).html(); if (t) styleBlocks.push(t); });
            const inlineStyles: string[] = [];
            $('[style]').each((_i: any, el: any) => { const s = $(el).attr('style'); if (s) inlineStyles.push(s); });
            brandCssText = styleBlocks.join('\n') + '\n' + inlineStyles.join(';\n');
            // theme-color may carry a media attr (e.g. dark mode); prefer the one without media.
            const themeNoMedia = $('meta[name="theme-color"]:not([media])').attr('content');
            brandThemeColorRaw = themeNoMedia || $('meta[name="theme-color"]').attr('content') || null;
        }

        if (extractRawHtml) data.rawHtml = html.slice(0, 500000);

        // Content view for text/markdown/links/html (Firecrawl-style controls). When
        // no content control is active, this is the original $ — zero behavior change.
        let $content: any = $;
        if (onlyMainContent || includeTags.length > 0 || excludeTags.length > 0) {
            $content = cheerioLib.load(html);
            if (excludeTags.length > 0) { try { $content(excludeTags.join(',')).remove(); } catch {} }
            if (includeTags.length > 0) {
                try {
                    const keep = $content(includeTags.join(',')).clone();
                    const body = $content('body').empty();
                    keep.each((_i: any, el: any) => { body.append(el); });
                } catch {}
            }
            if (onlyMainContent) {
                const main = $content('main, article, [role="main"]');
                if (main.length) {
                    const kept = main.clone();
                    const body = $content('body').empty();
                    kept.each((_i: any, el: any) => { body.append(el); });
                } else {
                    $content('nav, header, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"], .sidebar, .nav, .footer, .header, .cookie-banner, .cookie-notice, #cookie-notice').remove();
                }
            }
        }

        data.language = $('html').attr('lang') ?? null;
        data.canonicalUrl = $('link[rel="canonical"]').attr('href') ?? null;
        const robotsMeta = $('meta[name="robots"]').attr('content') ?? '';
        const robotsHeader = responseHeaders['x-robots-tag'] ?? '';
        data.robotsDirectives = [robotsMeta, robotsHeader].filter(Boolean).join(', ') || null;
        data.title = $('title').text().trim() || null;

        if (extractMeta) {
            $('meta').each((_i: any, el: any) => {
                const name = $(el).attr('name') || $(el).attr('property') || '';
                const content = $(el).attr('content') || '';
                if (name && content) {
                    data.meta[name] = content;
                    if (name.startsWith('og:')) data.openGraph[name.replace('og:', '')] = content;
                    if (name.startsWith('twitter:')) data.twitterCard[name.replace('twitter:', '')] = content;
                }
            });
            data.description = data.meta['description'] || data.meta['og:description'] || null;
        }

        if (extractStructuredData) {
            $('script[type="application/ld+json"]').each((_i: any, el: any) => {
                try { data.structuredData.push(JSON.parse($(el).html() ?? '')); } catch {}
            });
        }

        if (cssSelector) {
            const selected = $(cssSelector);
            data.selectedContent = selected.length > 0 ? selected.text().replace(/\s+/g, ' ').trim() : null;
        }

        if (extractMarkdown) {
            const $md = $content.root().clone();
            if (stripBoilerplate) {
                $md.find('nav, header, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"], .sidebar, .nav, .footer, .header, .cookie-banner, .cookie-notice, #cookie-notice').remove();
            }
            $md.find('script, style, noscript, iframe').remove();
            const mdHtml = $md.find('main, article, [role="main"]').html() || $md.find('body').html() || '';
            const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', emDelimiter: '*', strongDelimiter: '**' });
            turndown.use(gfm);
            turndown.addRule('removeEmptyLinks', { filter: (node) => node.nodeName === 'A' && !node.textContent?.trim(), replacement: () => '' });
            let md = turndown.turndown(mdHtml).replace(/\n{3,}/g, '\n\n').trim();
            data.markdown = md.slice(0, 100000);
            if (chunkSize > 0 && md.length > 0) data.chunks = chunkText(md, chunkSize, chunkOverlap);
        }

        if (extractHtml) {
            const $h = $content.root().clone();
            $h.find('script, style, noscript, iframe').remove();
            const root = $h.find('main, article, [role="main"]').html() || $h.find('body').html() || $h.html() || '';
            data.html = root.slice(0, 200000);
        }

        if (extractText) {
            $content('script, style, noscript').remove();
            data.text = $content('body').text().replace(/\s+/g, ' ').trim().slice(0, 50000);
        }

        if (extractHeadings) {
            $content('h1, h2, h3, h4, h5, h6').each((_i: any, el: any) => {
                const tag = (el as any).tagName ?? '';
                const level = parseInt(tag.replace('h', ''), 10);
                const text = $content(el).text().trim();
                if (text) data.headings.push({ level, text: text.slice(0, 200) });
            });
        }

        if (extractLinks) {
            const pageOrigin = new URL(pageUrl).origin;
            const socialDomains = ['facebook.com', 'twitter.com', 'x.com', 'linkedin.com', 'instagram.com', 'youtube.com', 'tiktok.com', 'github.com', 'pinterest.com'];
            const socialSet = new Set<string>();
            $content('a[href]').each((_i: any, el: any) => {
                const href = $content(el).attr('href') ?? '';
                const text = $content(el).text().trim();
                const rel = $content(el).attr('rel') ?? null;
                try {
                    const absolute = new URL(href, pageUrl).href;
                    if (absolute.startsWith('http')) {
                        const isExternal = new URL(absolute).origin !== pageOrigin;
                        data.links.push({ href: absolute, text: text.slice(0, 200), isExternal, rel });
                        const linkHost = new URL(absolute).hostname.replace('www.', '');
                        if (socialDomains.some(d => linkHost.includes(d))) socialSet.add(absolute);
                    }
                } catch {}
            });
            data.socialLinks = [...socialSet];
        }

        if (extractImages) {
            $('img').each((_i: any, el: any) => {
                const src = $(el).attr('src') ?? '';
                const dataSrc = $(el).attr('data-src') || $(el).attr('data-lazy') || $(el).attr('data-original') || null;
                const loading = $(el).attr('loading') || null;
                const effectiveSrc = src || dataSrc || '';
                if (!effectiveSrc) return;
                let absoluteSrc = effectiveSrc;
                try { absoluteSrc = new URL(effectiveSrc, pageUrl).href; } catch {}
                const resolvedDataSrc = dataSrc ? (() => { try { return new URL(dataSrc, pageUrl).href; } catch { return dataSrc; } })() : null;
                data.images.push({ src: absoluteSrc, alt: ($(el).attr('alt') ?? '').slice(0, 200), width: $(el).attr('width') ?? null, height: $(el).attr('height') ?? null, dataSrc: resolvedDataSrc, loading });
            });
        }

        if (extractTables) {
            $('table').each((_i: any, table: any) => {
                const headers: string[] = [];
                $(table).find('th').each((_j: any, th: any) => { headers.push($(th).text().trim()); });
                const rows: string[][] = [];
                $(table).find('tr').each((_j: any, tr: any) => {
                    const cells: string[] = [];
                    $(tr).find('td').each((_k: any, td: any) => { cells.push($(td).text().trim()); });
                    if (cells.length > 0) rows.push(cells);
                });
                if (headers.length > 0 || rows.length > 0) data.tables.push({ headers, rows: rows.slice(0, 100) });
            });
        }

        if (extractEmails) {
            const rawHtml = String($.html() ?? '');
            const emailMatches = rawHtml.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
            if (emailMatches) data.emails = [...new Set(emailMatches as string[])].slice(0, 50);
        }

        if (extractPhones) {
            const rawHtml = String($.html() ?? '');
            const phoneMatches = rawHtml.match(/(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}/g);
            if (phoneMatches) data.phones = [...new Set((phoneMatches as string[]).filter((p: string) => p.replace(/\D/g, '').length >= 7))].slice(0, 20);
        }

        $('link[rel="alternate"][hreflang]').each((_i: any, el: any) => {
            const lang = $(el).attr('hreflang') ?? ''; const href = $(el).attr('href') ?? '';
            if (lang && href) data.hreflangTags.push({ lang, href });
        });
        $('link[rel="next"], link[rel="prev"]').each((_i: any, el: any) => {
            const rel = $(el).attr('rel') ?? ''; const href = $(el).attr('href') ?? '';
            if (rel && href) { try { data.paginationLinks.push({ rel, href: new URL(href, pageUrl).href }); } catch { data.paginationLinks.push({ rel, href }); } }
        });
        $('[itemscope]').each((_i: any, el: any) => {
            const type = $(el).attr('itemtype') ?? '';
            const properties: Record<string, string> = {};
            $(el).find('[itemprop]').each((_j: any, prop: any) => {
                const name = $(prop).attr('itemprop') ?? '';
                const value = $(prop).attr('content') || $(prop).attr('href') || $(prop).attr('src') || $(prop).text().trim();
                if (name && value) properties[name] = value.slice(0, 500);
            });
            if (type || Object.keys(properties).length > 0) data.microdata.push({ type, properties });
        });
        data.microdata = data.microdata.slice(0, 50);

        for (const sd of data.structuredData) {
            const item = sd as any;
            const itemType = item?.['@type'];
            if (itemType === 'Product' || (Array.isArray(itemType) && itemType.includes('Product'))) {
                const offer = item.offers || item.offer || {};
                const o = Array.isArray(offer) ? offer[0] : offer;
                data.commerceData.push({
                    name: item.name || null, price: o?.price != null ? String(o.price) : (o?.lowPrice != null ? String(o.lowPrice) : null),
                    currency: o?.priceCurrency || null, availability: o?.availability || null,
                    rating: item.aggregateRating?.ratingValue != null ? String(item.aggregateRating.ratingValue) : null,
                    reviewCount: item.aggregateRating?.reviewCount != null ? String(item.aggregateRating.reviewCount) : null,
                    brand: typeof item.brand === 'string' ? item.brand : (item.brand?.name || null), sku: item.sku || null,
                });
            }
        }

        $('form').each((_i: any, el: any) => {
            const action = $(el).attr('action') || null;
            const method = ($(el).attr('method') || 'GET').toUpperCase();
            const fields: { name: string; type: string; required: boolean }[] = [];
            $(el).find('input, select, textarea').each((_j: any, field: any) => {
                const tagName = (field as any).tagName?.toLowerCase() ?? '';
                const name = $(field).attr('name') ?? '';
                const type = $(field).attr('type') || (tagName === 'select' ? 'select' : tagName === 'textarea' ? 'textarea' : 'text');
                const required = $(field).attr('required') !== undefined;
                if (name) fields.push({ name, type, required });
            });
            data.forms.push({ action, method, fields: fields.slice(0, 50) });
        });
        data.forms = data.forms.slice(0, 20);

        const analyticsHtml = $.html() ?? '';
        const analyticsPatterns: [string, RegExp][] = [
            ['Google Analytics (GA4)', /gtag\(|google-analytics\.com\/g\/|googletagmanager\.com.*gtag/i],
            ['Google Analytics (Universal)', /google-analytics\.com\/analytics\.js|ga\(\s*['"]create/i],
            ['Google Tag Manager', /googletagmanager\.com\/gtm\.js/i],
            ['Facebook Pixel', /connect\.facebook\.net\/.*\/fbevents\.js|fbq\(\s*['"]init/i],
            ['Hotjar', /static\.hotjar\.com|hj\(\s*['"]init/i],
            ['Segment', /cdn\.segment\.com\/analytics\.js/i],
            ['Mixpanel', /cdn\.mxpnl\.com|mixpanel\.init/i],
            ['Amplitude', /cdn\.amplitude\.com|amplitude\.getInstance/i],
            ['Heap', /heap-\d+\.js|heap\.load/i],
            ['Plausible', /plausible\.io\/js/i],
            ['Matomo', /matomo\.js|piwik\.js/i],
            ['Microsoft Clarity', /clarity\.ms\/tag/i],
            ['LinkedIn Insight', /snap\.licdn\.com\/li\.lms-analytics/i],
            ['Twitter Pixel', /static\.ads-twitter\.com\/uwt\.js/i],
            ['Pinterest Tag', /pintrk\(|s\.pinimg\.com\/ct\/core\.js/i],
            ['TikTok Pixel', /analytics\.tiktok\.com/i],
        ];
        for (const [name, pattern] of analyticsPatterns) {
            if (pattern.test(analyticsHtml)) data.analyticsDetected.push(name);
        }

        // Detect "blocked-bot" responses where the server returned 200 but the
        // body is an access-control or challenge page. Cheap heuristic — false positive risk on
        // tiny pages that legitimately have this exact text.
        if (actualStatus === 200 && data.text) {
            const t = data.text.toLowerCase();
            if (t.includes('attention required') || t.includes('access denied') || t.includes('cloudflare ray id') || t.includes('checking your browser')) {
                data.status = 'error';
                data.error = 'Access-control or challenge page detected.';
                data.errorType = 'blocked-bot';
                data.errorRetryable = false;
            }
        }

        // Brand identity — only on a real success page (never on blocked/challenge pages).
        if (extractBrand && data.status === 'success') {
            const hits: ColorHit[] = [];
            if (brandCssText) hits.push(...collectCssColors(brandCssText, 'style'));
            if (brandExtraCss) hits.push(...collectCssColors(brandExtraCss, 'stylesheet'));
            if (brandComputedHits.length) hits.push(...brandComputedHits);

            // PWA manifest: often the highest-res logo (512px) + an explicit theme/bg color.
            let manifestIcons: LogoEntry[] = [];
            let manifestThemeRaw: string | null = null;
            const manifestHref = $('link[rel="manifest"]').attr('href');
            if (manifestHref) {
                let manifestUrl: string | null = null;
                try { manifestUrl = new URL(manifestHref, pageUrl).href; } catch { /* ignore bad href */ }
                if (manifestUrl) {
                    const mf = await fetchManifest(manifestUrl);
                    manifestIcons = mf.icons;
                    manifestThemeRaw = mf.themeColorRaw;
                    if (mf.themeColorRaw) hits.push({ value: mf.themeColorRaw, source: 'manifest:theme_color', weight: 0.5 });
                    if (mf.bgColorRaw) hits.push({ value: mf.bgColorRaw, source: 'manifest:background_color', weight: 0.3 });
                }
            }

            const { themeColor, palette } = buildPalette(hits, brandThemeColorRaw || manifestThemeRaw);
            data.themeColor = themeColor;
            data.palette = palette;
            const domCands = extractLogoCandidates($, pageUrl, data.structuredData);
            data.logo = await probeAndRankLogos([...domCands, ...manifestIcons]);
            // Deterministic Organization JSON-LD prior (name/description/logo/socials) —
            // a reliable cross-check for the LLM brand-context contract.
            data.brandOrg = extractOrgFromJsonLd(data.structuredData);
            // L4: the logo's dominant color arbitrates `primary` when CSS signals are
            // ambiguous (logo = ground truth for the brand hue).
            const logoColor = await deriveLogoColor(data.logo, pageUrl);
            if (logoColor) data.palette = foldLogoColorIntoPalette(data.palette, logoColor);
        }

        data.responseTimeMs = Date.now() - startTime;
        return { data, internalLinks: data.links.filter(l => !l.isExternal) };
    }

    const failedHandler = async (request: { url: string; errorMessages?: string[]; statusCode?: number }) => {
        const message = request.errorMessages?.slice(-1)[0] ?? 'Unknown error';
        await onPageData(errorPage(request.url, message, request.statusCode));
    };

    // --- Document extraction (PDF, DOCX) ---
    const pdfUrls = urlsNeedingFetch.filter(u => u.toLowerCase().endsWith('.pdf'));
    const docxUrls = urlsNeedingFetch.filter(u => u.toLowerCase().endsWith('.docx'));
    const htmlUrls = urlsNeedingFetch.filter(u => !u.toLowerCase().endsWith('.pdf') && !u.toLowerCase().endsWith('.docx'));

    for (const pdfUrl of pdfUrls) {
        const fullUrl = pdfUrl.startsWith('http') ? pdfUrl : `https://${pdfUrl}`;
        const startTime = Date.now();
        try {
            const pdf = await extractPdf(fullUrl);
            const data = emptyPage(fullUrl, {
                title: pdf.metadata['Title'] || null, text: pdf.text, markdown: pdf.text,
                chunks: chunkSize > 0 && pdf.text ? chunkText(pdf.text, chunkSize, chunkOverlap) : null,
                pdf, statusCode: 200, contentType: 'application/pdf',
                responseTimeMs: Date.now() - startTime, status: 'success',
            });
            if (cache) cache.set(CrawlCache.keyFor(fullUrl, options), data);
            await onPageData(data);
            pagesScraped++;
        } catch (err: any) {
            await onPageData(errorPage(fullUrl, `PDF extraction failed: ${err.message}`));
        }
    }

    for (const docxUrl of docxUrls) {
        const fullUrl = docxUrl.startsWith('http') ? docxUrl : `https://${docxUrl}`;
        const startTime = Date.now();
        try {
            const docx = await extractDocx(fullUrl);
            const data = emptyPage(fullUrl, {
                text: docx.text, markdown: docx.markdown,
                chunks: chunkSize > 0 && docx.markdown ? chunkText(docx.markdown, chunkSize, chunkOverlap) : null,
                statusCode: 200, contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                responseTimeMs: Date.now() - startTime, status: 'success',
            });
            if (cache) cache.set(CrawlCache.keyFor(fullUrl, options), data);
            await onPageData(data);
            pagesScraped++;
        } catch (err: any) {
            await onPageData(errorPage(fullUrl, `DOCX extraction failed: ${err.message}`));
        }
    }

    if (htmlUrls.length === 0) return pagesScraped;

    const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let requestSeq = 0;
    const requestQueue = await RequestQueue.open(`thecrawler-${runId}`);
    const makeRequest = (url: string, depth = 0) => {
        const fullUrl = url.startsWith('http') ? url : `https://${url}`;
        return {
            url: fullUrl,
            uniqueKey: `${fullUrl}#thecrawler-${runId}-${requestSeq++}`,
            userData: { depth },
        };
    };
    const startUrls = htmlUrls.map(url => makeRequest(url, 0));
    const proxyConfiguration = proxyUrl ? new ProxyConfiguration({ proxyUrls: [proxyUrl] }) : undefined;

    // Build per-request header builder: rotates UA + applies customHeaders.
    // In brand mode, pin a fixed UA so rendered output (and thus the palette)
    // is deterministic across runs.
    const buildHeaders = (): Record<string, string> => {
        const headers: Record<string, string> = { ...customHeaders };
        if (!headers['User-Agent'] && !headers['user-agent']) {
            if (extractBrand) headers['User-Agent'] = USER_AGENT_POOL[0];
            else if (rotateUserAgent) headers['User-Agent'] = pickUserAgent();
        }
        return headers;
    };

    if (usePlaywright) {
        const crawler = new PlaywrightCrawler({
            maxRequestsPerCrawl: maxPages, proxyConfiguration,
            requestQueue,
            maxRequestRetries: requestRetries,
            requestHandlerTimeoutSecs: requestTimeoutSecs,
            preNavigationHooks: [async ({ page: pg }) => {
                const headers = buildHeaders();
                if (Object.keys(headers).length > 0) await pg.setExtraHTTPHeaders(headers);
                if (extractBrand) {
                    // Deterministic render env for stable brand colors.
                    try { await pg.emulateMedia({ colorScheme: 'light' }); } catch {}
                    try { await pg.setViewportSize({ width: 1280, height: 800 }); } catch {}
                }
            }],
            async requestHandler({ request, page, response }: PlaywrightCrawlingContext) {
                const startTime = Date.now();
                if (waitForSelector) { try { await page.waitForSelector(waitForSelector, { timeout: effectiveWaitMs || 10000 }); } catch {} }
                else if (effectiveWaitMs > 0) { await page.waitForTimeout(effectiveWaitMs); }

                let actionScreenshots: string[] = [];
                if (actions.length > 0) actionScreenshots = await executeActions(page, actions, onStoreValue);
                if (screenshotFullPage) {
                    const key = `page-screenshot-${Date.now()}`;
                    const buf = await page.screenshot({ fullPage: true });
                    if (onStoreValue) await onStoreValue(key, buf, 'image/png');
                    actionScreenshots.push(key);
                }

                // Sample rendered brand colors from the live page BEFORE serializing to HTML.
                const computedHits = extractBrand ? await sampleComputedColors(page) : [];

                const html = await page.content();
                const $ = cheerioLib.load(html);
                const respHeaders: Record<string, string> = {};
                for (const [k, v] of Object.entries(response?.headers() ?? {})) { respHeaders[k] = v; }

                const { data, internalLinks } = await handlePage(request, $, respHeaders, response?.status() ?? 200, respHeaders['content-type'] ?? null, startTime, computedHits);
                data.engine = 'playwright';
                data.usedPlaywright = true;
                data.screenshots = actionScreenshots;

                const redirectChain: { url: string; statusCode: number }[] = [];
                let rr = response?.request()?.redirectedFrom() ?? null;
                while (rr) { const rResp = await rr.response(); redirectChain.unshift({ url: rr.url(), statusCode: rResp?.status() ?? 301 }); rr = rr.redirectedFrom(); }
                data.redirectChain = redirectChain;

                if (cache && data.status === 'success') cache.set(CrawlCache.keyFor(data.url, options), data);
                await onPageData(data);
                pagesScraped++;

                if (maxDepth > 0 && (request.userData?.depth as number ?? 0) < maxDepth) {
                    for (const link of internalLinks.slice(0, 50)) {
                        if (excludeGlobs.length > 0 && excludeGlobs.some(g => matchGlob(link.href, g))) continue;
                        if (includeGlobs.length > 0 && !includeGlobs.some(g => matchGlob(link.href, g))) continue;
                        await crawler.addRequests([makeRequest(link.href, (request.userData?.depth as number ?? 0) + 1)]);
                    }
                }
            },
            async failedRequestHandler({ request }) { await failedHandler(request); },
        });
        await crawler.run(startUrls);
    } else {
        const spaUrls: { url: string; depth: number }[] = [];
        const crawler = new CheerioCrawler({
            maxRequestsPerCrawl: maxPages, proxyConfiguration,
            requestQueue,
            maxRequestRetries: requestRetries,
            requestHandlerTimeoutSecs: requestTimeoutSecs,
            additionalMimeTypes: ['application/xml', 'text/xml'],
            preNavigationHooks: [async ({ request: req }) => {
                const headers = buildHeaders();
                if (Object.keys(headers).length > 0) Object.assign(req.headers ?? (req.headers = {}), headers);
            }],
            async requestHandler({ request, $, response }: CheerioCrawlingContext) {
                const startTime = Date.now();
                const respHeaders: Record<string, string> = {};
                if (response?.headers) { for (const [k, v] of Object.entries(response.headers)) { if (typeof v === 'string') respHeaders[k] = v; else if (Array.isArray(v)) respHeaders[k] = v.join(', '); } }

                // In Cheerio (no-JS) mode, computed colors aren't available; mine a
                // bounded set of same-domain stylesheets instead.
                const extraCss = (extractBrand && brandFetchStylesheets)
                    ? await fetchBrandStylesheets($, request.loadedUrl ?? request.url)
                    : '';

                const { data, internalLinks } = await handlePage(request, $, respHeaders, response?.statusCode ?? 200, respHeaders['content-type'] ?? null, startTime, [], extraCss);
                if (request.loadedUrl && request.loadedUrl !== request.url) data.redirectChain = [{ url: request.url, statusCode: 301 }];

                if (adaptiveCrawling && data.status === 'success') {
                    const textLen = (data.text || '').length;
                    const hasSpaRoot = $('div#root, div#app, div#__next, div#__nuxt, div#__svelte').length > 0;
                    if (textLen < 200 || (hasSpaRoot && textLen < 500)) {
                        log.info(`Adaptive: SPA detected on ${request.url} (${textLen} chars), queuing for Playwright`);
                        spaUrls.push({ url: request.loadedUrl || request.url, depth: (request.userData?.depth as number ?? 0) });
                        return;
                    }
                }

                if (cache && data.status === 'success') cache.set(CrawlCache.keyFor(data.url, options), data);
                await onPageData(data);
                pagesScraped++;

                if (maxDepth > 0 && (request.userData?.depth as number ?? 0) < maxDepth) {
                    for (const link of internalLinks.slice(0, 50)) {
                        if (excludeGlobs.length > 0 && excludeGlobs.some(g => matchGlob(link.href, g))) continue;
                        if (includeGlobs.length > 0 && !includeGlobs.some(g => matchGlob(link.href, g))) continue;
                        await crawler.addRequests([makeRequest(link.href, (request.userData?.depth as number ?? 0) + 1)]);
                    }
                }
            },
            async failedRequestHandler({ request }) { await failedHandler(request); },
        });
        await crawler.run(startUrls);

        if (spaUrls.length > 0) {
            log.info(`Adaptive: re-scraping ${spaUrls.length} SPA page(s) with Playwright`);
            const playwrightQueue = await RequestQueue.open(`thecrawler-${runId}-playwright`);
            const pwCrawler = new PlaywrightCrawler({
                // Allow room beyond the SPA pages themselves so their links can be
                // followed (bounded overall by the pagesScraped < maxPages guard).
                maxRequestsPerCrawl: maxPages, proxyConfiguration,
                requestQueue: playwrightQueue,
                maxRequestRetries: requestRetries,
                requestHandlerTimeoutSecs: requestTimeoutSecs,
                preNavigationHooks: [async ({ page: pg }) => {
                    const headers = buildHeaders();
                    if (Object.keys(headers).length > 0) await pg.setExtraHTTPHeaders(headers);
                    if (extractBrand) {
                        try { await pg.emulateMedia({ colorScheme: 'light' }); } catch {}
                        try { await pg.setViewportSize({ width: 1280, height: 800 }); } catch {}
                    }
                }],
                async requestHandler({ request, page, response }: PlaywrightCrawlingContext) {
                    if (pagesScraped >= maxPages) return; // overall page budget (shared with the cheerio pass)
                    const startTime = Date.now();
                    if (waitForSelector) { try { await page.waitForSelector(waitForSelector, { timeout: effectiveWaitMs || 10000 }); } catch {} }
                    else { await page.waitForTimeout(effectiveWaitMs || 2000); }
                    const computedHits = extractBrand ? await sampleComputedColors(page) : [];
                    const html = await page.content();
                    const $ = cheerioLib.load(html);
                    const respHeaders: Record<string, string> = {};
                    for (const [k, v] of Object.entries(response?.headers() ?? {})) { respHeaders[k] = v; }
                    const { data, internalLinks } = await handlePage(request, $, respHeaders, response?.status() ?? 200, respHeaders['content-type'] ?? null, startTime, computedHits);
                    data.engine = 'playwright';
                    data.usedPlaywright = true;
                    const rc: { url: string; statusCode: number }[] = [];
                    let rr = response?.request()?.redirectedFrom() ?? null;
                    while (rr) { const rResp = await rr.response(); rc.unshift({ url: rr.url(), statusCode: rResp?.status() ?? 301 }); rr = rr.redirectedFrom(); }
                    data.redirectChain = rc;
                    if (cache && data.status === 'success') cache.set(CrawlCache.keyFor(data.url, options), data);
                    await onPageData(data);
                    pagesScraped++;
                    // Follow links discovered in the RENDERED SPA page (the cheerio
                    // pass saw none) so adaptive crawls reach every public page.
                    if (maxDepth > 0 && (request.userData?.depth as number ?? 0) < maxDepth) {
                        for (const link of internalLinks.slice(0, 50)) {
                            if (excludeGlobs.length > 0 && excludeGlobs.some(g => matchGlob(link.href, g))) continue;
                            if (includeGlobs.length > 0 && !includeGlobs.some(g => matchGlob(link.href, g))) continue;
                            await pwCrawler.addRequests([makeRequest(link.href, (request.userData?.depth as number ?? 0) + 1)]);
                        }
                    }
                },
                async failedRequestHandler({ request }) { await failedHandler(request); },
            });
            await pwCrawler.run(spaUrls.map(s => makeRequest(s.url, s.depth)));
        }
    }

    if (pagesEmitted === 0) {
        for (const url of urlsNeedingFetch.slice(0, maxPages)) {
            const fullUrl = url.startsWith('http') ? url : `https://${url}`;
            await onPageData(errorPage(fullUrl, 'No page result emitted by crawler. The request may have been skipped by the crawl queue or blocked before a response was available.'));
        }
    }

    return pagesScraped;
}

/**
 * Simple crawl function — returns all results as an array.
 * Use crawlStream() for streaming/callback-based processing.
 */
export async function crawl(options: CrawlOptions): Promise<CrawlResult> {
    const startTime = Date.now();
    const pages: PageData[] = [];

    const totalScraped = await crawlStream(options, (data) => { pages.push(data); });

    return {
        pages,
        totalScraped,
        totalErrors: pages.filter(p => p.status === 'error').length,
        durationMs: Date.now() - startTime,
    };
}
