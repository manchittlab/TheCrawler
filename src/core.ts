import { CheerioCrawler, PlaywrightCrawler, type CheerioCrawlingContext, type PlaywrightCrawlingContext } from 'crawlee';
import * as cheerioLib from 'cheerio';

export interface ScraperInput {
    urls: string[];
    extractText?: boolean;
    extractLinks?: boolean;
    extractImages?: boolean;
    extractMeta?: boolean;
    extractHeadings?: boolean;
    extractTables?: boolean;
    extractStructuredData?: boolean;
    extractEmails?: boolean;
    extractPhones?: boolean;
    extractMarkdown?: boolean;
    stripBoilerplate?: boolean;
    chunkSize?: number;
    chunkOverlap?: number;
    cssSelector?: string;
    maxDepth?: number;
    maxPages?: number;
    includeGlobs?: string[];
    excludeGlobs?: string[];
    proxyUrl?: string;
    usePlaywright?: boolean;
    waitForSelector?: string;
    waitForMs?: number;
}

export interface PageData {
    url: string;
    title: string | null;
    description: string | null;
    language: string | null;
    canonicalUrl: string | null;
    robotsDirectives: string | null;
    text: string | null;
    headings: { level: number; text: string }[];
    links: { href: string; text: string; isExternal: boolean; rel: string | null }[];
    images: { src: string; alt: string; width: string | null; height: string | null }[];
    meta: Record<string, string>;
    openGraph: Record<string, string>;
    twitterCard: Record<string, string>;
    tables: { headers: string[]; rows: string[][] }[];
    structuredData: unknown[];
    emails: string[];
    phones: string[];
    socialLinks: string[];
    markdown: string | null;
    chunks: { text: string; index: number; section: string | null; charCount: number; hash: string }[] | null;
    selectedContent: string | null;
    statusCode: number;
    contentType: string | null;
    responseTimeMs: number | null;
    pageSizeBytes: number | null;
    responseHeaders: Record<string, string>;
    scrapedAt: string;
    status: 'success' | 'error';
    error: string | null;
}

import { createHash } from 'node:crypto';

function chunkText(text: string, chunkSize: number, overlap: number): { text: string; index: number; section: string | null; charCount: number; hash: string }[] {
    if (!text || chunkSize <= 0) return [];
    const chunks: { text: string; index: number; section: string | null; charCount: number; hash: string }[] = [];

    // Split by heading boundaries for heading-aware chunking
    const sections = text.split(/(?=^#{1,3}\s)/m);
    let currentChunk = '';
    let chunkIndex = 0;
    let currentSection: string | null = null;

    for (const section of sections) {
        // Extract section heading
        const headingMatch = section.match(/^(#{1,3})\s+(.+)/);
        if (headingMatch) currentSection = headingMatch[2].trim();

        if (currentChunk.length + section.length > chunkSize && currentChunk.length > 0) {
            // Emit current chunk
            const hash = createHash('md5').update(currentChunk).digest('hex').slice(0, 12);
            chunks.push({ text: currentChunk.trim(), index: chunkIndex++, section: currentSection, charCount: currentChunk.trim().length, hash });

            // Keep overlap from end of current chunk
            currentChunk = overlap > 0 ? currentChunk.slice(-overlap) + section : section;
        } else {
            currentChunk += section;
        }
    }

    // Emit remaining
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

export async function scrapeUrls(input: ScraperInput, pushData: (data: PageData) => Promise<void>): Promise<number> {
    const {
        urls,
        extractText = true,
        extractLinks = true,
        extractImages = true,
        extractMeta = true,
        extractHeadings = true,
        extractTables = true,
        extractStructuredData = true,
        extractEmails = true,
        extractPhones = true,
        extractMarkdown = false,
        stripBoilerplate = true,
        chunkSize = 0,
        chunkOverlap = 200,
        cssSelector,
        maxDepth = 0,
        maxPages = 100,
        includeGlobs = [],
        excludeGlobs = [],
        proxyUrl,
        usePlaywright = false,
        waitForSelector,
        waitForMs = 0,
    } = input;

    let pagesScraped = 0;

    // Shared handler logic — works with Cheerio $ from either crawler
    async function handlePage(
        request: { url: string; loadedUrl?: string; userData?: Record<string, unknown>; errorMessages?: string[] },
        $: any, // CheerioAPI — using any to avoid version mismatch between crawlee's cheerio and ours
        responseHeaders: Record<string, string>,
        actualStatus: number,
        actualContentType: string | null,
        startTime: number,
    ) {
            const currentDepth = (request.userData?.depth as number) ?? 0;
            const pageUrl = request.loadedUrl ?? request.url;
            const respHeaders = responseHeaders;

            const data: PageData = {
                url: pageUrl,
                title: null,
                description: null,
                language: null,
                canonicalUrl: null,
                robotsDirectives: null,
                text: null,
                headings: [],
                links: [],
                images: [],
                meta: {},
                openGraph: {},
                twitterCard: {},
                tables: [],
                structuredData: [],
                emails: [],
                phones: [],
                socialLinks: [],
                markdown: null,
                chunks: null,
                selectedContent: null,
                statusCode: actualStatus,
                contentType: actualContentType,
                responseTimeMs: null,
                pageSizeBytes: null,
                responseHeaders: respHeaders,
                scrapedAt: new Date().toISOString(),
                status: 'success',
                error: null,
            };

            // Page size
            const html = $.html();
            data.pageSizeBytes = Buffer.byteLength(html, 'utf8');

            // Page language
            data.language = $('html').attr('lang') ?? null;

            // Canonical URL
            const canonical = $('link[rel="canonical"]').attr('href');
            data.canonicalUrl = canonical ?? null;

            // Robots directives (meta + header)
            const robotsMeta = $('meta[name="robots"]').attr('content') ?? '';
            const robotsHeader = respHeaders['x-robots-tag'] ?? '';
            const robotsCombined = [robotsMeta, robotsHeader].filter(Boolean).join(', ');
            data.robotsDirectives = robotsCombined || null;

            // Title
            data.title = $('title').text().trim() || null;

            // Meta tags + Open Graph + Twitter Card
            if (extractMeta) {
                $('meta').each((_i: any, el: any) => {
                    const name = $(el).attr('name') || $(el).attr('property') || '';
                    const content = $(el).attr('content') || '';
                    if (name && content) {
                        data.meta[name] = content;
                        // Split into dedicated OG and Twitter objects
                        if (name.startsWith('og:')) data.openGraph[name.replace('og:', '')] = content;
                        if (name.startsWith('twitter:')) data.twitterCard[name.replace('twitter:', '')] = content;
                    }
                });
                data.description = data.meta['description'] || data.meta['og:description'] || null;
            }

            // JSON-LD structured data — MUST run BEFORE text extraction removes script tags
            if (extractStructuredData) {
                $('script[type="application/ld+json"]').each((_i: any, el: any) => {
                    try {
                        const json = JSON.parse($(el).html() ?? '');
                        data.structuredData.push(json);
                    } catch { /* skip invalid */ }
                });
            }

            // CSS selector — run before script removal too
            if (cssSelector) {
                const selected = $(cssSelector);
                data.selectedContent = selected.length > 0 ? selected.text().replace(/\s+/g, ' ').trim() : null;
            }

            // Markdown output with boilerplate stripping + optional chunking
            if (extractMarkdown) {
                // Strip boilerplate elements before conversion
                const $md = $.root().clone();
                if (stripBoilerplate) {
                    $md.find('nav, header, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"], .sidebar, .nav, .footer, .header, .cookie-banner, .cookie-notice, #cookie-notice').remove();
                }
                $md.find('script, style, noscript, iframe').remove();

                const mdHtml = $md.find('main, article, [role="main"]').html() || $md.find('body').html() || '';
                let md = mdHtml
                    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m: string, l: string, t: string) => '#'.repeat(parseInt(l)) + ' ' + t.replace(/<[^>]+>/g, '').trim() + '\n\n')
                    .replace(/<a\s+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
                    .replace(/<strong>([\s\S]*?)<\/strong>/gi, '**$1**')
                    .replace(/<b>([\s\S]*?)<\/b>/gi, '**$1**')
                    .replace(/<em>([\s\S]*?)<\/em>/gi, '*$1*')
                    .replace(/<i>([\s\S]*?)<\/i>/gi, '*$1*')
                    .replace(/<pre><code>([\s\S]*?)<\/code><\/pre>/gi, '```\n$1\n```\n')
                    .replace(/<code>([\s\S]*?)<\/code>/gi, '`$1`')
                    .replace(/<li>([\s\S]*?)<\/li>/gi, '- $1\n')
                    .replace(/<br\s*\/?>/gi, '\n')
                    .replace(/<p>([\s\S]*?)<\/p>/gi, '$1\n\n')
                    .replace(/<blockquote>([\s\S]*?)<\/blockquote>/gi, '> $1\n\n')
                    .replace(/<hr\s*\/?>/gi, '---\n\n')
                    .replace(/<img\s+[^>]*src="([^"]*)"[^>]*alt="([^"]*)"[^>]*>/gi, '![$2]($1)')
                    .replace(/<img\s+[^>]*src="([^"]*)"[^>]*>/gi, '![]($1)')
                    .replace(/<[^>]+>/g, '')
                    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
                    .replace(/\n{3,}/g, '\n\n')
                    .trim();
                data.markdown = md.slice(0, 100000);

                // Heading-aware chunking for LLM/RAG
                if (chunkSize > 0 && md.length > 0) {
                    data.chunks = chunkText(md, chunkSize, chunkOverlap);
                }
            }

            // Text content — removes scripts/styles, must be after JSON-LD and selector
            if (extractText) {
                $('script, style, noscript').remove();
                data.text = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 50000);
            }

            // Headings
            if (extractHeadings) {
                $('h1, h2, h3, h4, h5, h6').each((_i: any, el: any) => {
                    const tag = (el as { tagName?: string }).tagName ?? '';
                    const level = parseInt(tag.replace('h', ''), 10);
                    const text = $(el).text().trim();
                    if (text) data.headings.push({ level, text: text.slice(0, 200) });
                });
            }

            // Links
            if (extractLinks) {
                const pageOrigin = new URL(pageUrl).origin;
                const socialDomains = ['facebook.com', 'twitter.com', 'x.com', 'linkedin.com', 'instagram.com', 'youtube.com', 'tiktok.com', 'github.com', 'pinterest.com'];
                const socialSet = new Set<string>();

                $('a[href]').each((_i: any, el: any) => {
                    const href = $(el).attr('href') ?? '';
                    const text = $(el).text().trim();
                    const rel = $(el).attr('rel') ?? null;
                    try {
                        const absolute = new URL(href, pageUrl).href;
                        if (absolute.startsWith('http')) {
                            const isExternal = new URL(absolute).origin !== pageOrigin;
                            data.links.push({ href: absolute, text: text.slice(0, 200), isExternal, rel });

                            // Detect social media links
                            const linkHost = new URL(absolute).hostname.replace('www.', '');
                            if (socialDomains.some(d => linkHost.includes(d))) {
                                socialSet.add(absolute);
                            }
                        }
                    } catch { /* skip malformed */ }
                });

                data.socialLinks = [...socialSet];
            }

            // Images
            if (extractImages) {
                $('img').each((_i: any, el: any) => {
                    const src = $(el).attr('src') ?? '';
                    if (!src) return;
                    let absoluteSrc = src;
                    try { absoluteSrc = new URL(src, pageUrl).href; } catch { /* keep relative */ }
                    data.images.push({
                        src: absoluteSrc,
                        alt: ($(el).attr('alt') ?? '').slice(0, 200),
                        width: $(el).attr('width') ?? null,
                        height: $(el).attr('height') ?? null,
                    });
                });
            }

            // Tables
            if (extractTables) {
                $('table').each((_i: any, table: any) => {
                    const headers: string[] = [];
                    $(table).find('th').each((_j: any, th: any) => {
                        headers.push($(th).text().trim());
                    });
                    const rows: string[][] = [];
                    $(table).find('tr').each((_j: any, tr: any) => {
                        const cells: string[] = [];
                        $(tr).find('td').each((_k: any, td: any) => {
                            cells.push($(td).text().trim());
                        });
                        if (cells.length > 0) rows.push(cells);
                    });
                    if (headers.length > 0 || rows.length > 0) {
                        data.tables.push({ headers, rows: rows.slice(0, 100) });
                    }
                });
            }

            // JSON-LD already extracted above (before script removal)

            // Emails
            if (extractEmails) {
                const rawHtml = String($.html() ?? '');
                const emailMatches = rawHtml.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
                if (emailMatches) {
                    data.emails = [...new Set(emailMatches as string[])].slice(0, 50);
                }
            }

            // Phones
            if (extractPhones) {
                const rawHtml2 = String($.html() ?? '');
                const phoneMatches = rawHtml2.match(/(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}/g);
                if (phoneMatches) {
                    data.phones = [...new Set((phoneMatches as string[]).filter((p: string) => p.replace(/\D/g, '').length >= 7))].slice(0, 20);
                }
            }

            // Response time
            data.responseTimeMs = Date.now() - startTime;

            return { data, internalLinks: data.links.filter(l => !l.isExternal) };
    }

    const failedHandler = async (request: { url: string; errorMessages?: string[] }) => {
        await pushData({
            url: request.url,
            title: null, description: null, language: null,
            canonicalUrl: null, robotsDirectives: null, text: null,
            headings: [], links: [], images: [], meta: {},
            openGraph: {}, twitterCard: {},
            tables: [], structuredData: [], emails: [], phones: [],
            socialLinks: [],
            markdown: null, chunks: null, selectedContent: null, statusCode: 0,
            contentType: null, responseTimeMs: null, pageSizeBytes: null,
            responseHeaders: {},
            scrapedAt: new Date().toISOString(),
            status: 'error',
            error: request.errorMessages?.slice(-1)[0] ?? 'Unknown error',
        });
    };

    const startUrls = urls.map(url => ({
        url: url.startsWith('http') ? url : `https://${url}`,
        userData: { depth: 0 },
    }));

    if (usePlaywright) {
        // Playwright mode — full JS rendering
        const crawler = new PlaywrightCrawler({
            maxRequestsPerCrawl: maxPages,
            async requestHandler({ request, page, response }: PlaywrightCrawlingContext) {
                const startTime = Date.now();

                // Wait for content if configured
                if (waitForSelector) {
                    try { await page.waitForSelector(waitForSelector, { timeout: waitForMs || 10000 }); } catch { /* continue */ }
                } else if (waitForMs > 0) {
                    await page.waitForTimeout(waitForMs);
                }

                const html = await page.content();
                const $ = cheerioLib.load(html);

                const respHeaders: Record<string, string> = {};
                const headers = response?.headers() ?? {};
                for (const [k, v] of Object.entries(headers)) {
                    respHeaders[k] = v;
                }

                const { data, internalLinks } = await handlePage(
                    request, $, respHeaders,
                    response?.status() ?? 200,
                    respHeaders['content-type'] ?? null,
                    startTime,
                );
                await pushData(data);
                pagesScraped++;

                // Follow links
                if (maxDepth > 0 && (request.userData?.depth as number ?? 0) < maxDepth) {
                    for (const link of internalLinks.slice(0, 50)) {
                        if (excludeGlobs.length > 0 && excludeGlobs.some(g => matchGlob(link.href, g))) continue;
                        if (includeGlobs.length > 0 && !includeGlobs.some(g => matchGlob(link.href, g))) continue;
                        await crawler.addRequests([{ url: link.href, userData: { depth: (request.userData?.depth as number ?? 0) + 1 } }]);
                    }
                }
            },
            async failedRequestHandler({ request }) { await failedHandler(request); },
        });
        await crawler.run(startUrls);
    } else {
        // Cheerio mode — fast HTTP only
        const crawler = new CheerioCrawler({
            maxRequestsPerCrawl: maxPages,
            async requestHandler({ request, $, response }: CheerioCrawlingContext) {
                const startTime = Date.now();

                const respHeaders: Record<string, string> = {};
                if (response?.headers) {
                    for (const [k, v] of Object.entries(response.headers)) {
                        if (typeof v === 'string') respHeaders[k] = v;
                        else if (Array.isArray(v)) respHeaders[k] = v.join(', ');
                    }
                }

                const { data, internalLinks } = await handlePage(
                    request, $, respHeaders,
                    response?.statusCode ?? 200,
                    respHeaders['content-type'] ?? null,
                    startTime,
                );
                await pushData(data);
                pagesScraped++;

                // Follow links
                if (maxDepth > 0 && (request.userData?.depth as number ?? 0) < maxDepth) {
                    for (const link of internalLinks.slice(0, 50)) {
                        if (excludeGlobs.length > 0 && excludeGlobs.some(g => matchGlob(link.href, g))) continue;
                        if (includeGlobs.length > 0 && !includeGlobs.some(g => matchGlob(link.href, g))) continue;
                        await crawler.addRequests([{ url: link.href, userData: { depth: (request.userData?.depth as number ?? 0) + 1 } }]);
                    }
                }
            },
            async failedRequestHandler({ request }) { await failedHandler(request); },
        });
        await crawler.run(startUrls);
    }

    return pagesScraped;
}
