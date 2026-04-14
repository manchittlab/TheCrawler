import { CheerioCrawler, type CheerioCrawlingContext } from 'crawlee';

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
    cssSelector?: string;
    maxDepth?: number;
    maxPages?: number;
    includeGlobs?: string[];
    excludeGlobs?: string[];
    proxyUrl?: string;
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
        cssSelector,
        maxDepth = 0,
        maxPages = 100,
        includeGlobs = [],
        excludeGlobs = [],
        proxyUrl,
    } = input;

    let pagesScraped = 0;

    const crawler = new CheerioCrawler({
        maxRequestsPerCrawl: maxPages,
        ...(proxyUrl ? { proxyUrls: [proxyUrl] } : {}),
        async requestHandler({ request, $, response }: CheerioCrawlingContext) {
            const startTime = Date.now();
            const currentDepth = (request.userData?.depth as number) ?? 0;
            const pageUrl = request.loadedUrl ?? request.url;

            // Fix bug: read actual statusCode and contentType from response
            const actualStatus = response?.statusCode ?? 200;
            const actualContentType = response?.headers?.['content-type'] as string ?? null;

            // Collect response headers
            const respHeaders: Record<string, string> = {};
            if (response?.headers) {
                for (const [k, v] of Object.entries(response.headers)) {
                    if (typeof v === 'string') respHeaders[k] = v;
                    else if (Array.isArray(v)) respHeaders[k] = v.join(', ');
                }
            }

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
                $('meta').each((_i, el) => {
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
                $('script[type="application/ld+json"]').each((_i, el) => {
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

            // Markdown output — basic HTML to markdown before script removal
            if (extractMarkdown) {
                const html = $('body').html() ?? '';
                let md = html
                    .replace(/<script[\s\S]*?<\/script>/gi, '')
                    .replace(/<style[\s\S]*?<\/style>/gi, '')
                    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, l, t) => '#'.repeat(parseInt(l)) + ' ' + t.replace(/<[^>]+>/g, '').trim() + '\n\n')
                    .replace(/<a\s+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
                    .replace(/<strong>([\s\S]*?)<\/strong>/gi, '**$1**')
                    .replace(/<b>([\s\S]*?)<\/b>/gi, '**$1**')
                    .replace(/<em>([\s\S]*?)<\/em>/gi, '*$1*')
                    .replace(/<i>([\s\S]*?)<\/i>/gi, '*$1*')
                    .replace(/<code>([\s\S]*?)<\/code>/gi, '`$1`')
                    .replace(/<li>([\s\S]*?)<\/li>/gi, '- $1\n')
                    .replace(/<br\s*\/?>/gi, '\n')
                    .replace(/<p>([\s\S]*?)<\/p>/gi, '$1\n\n')
                    .replace(/<img\s+[^>]*src="([^"]*)"[^>]*alt="([^"]*)"[^>]*>/gi, '![$2]($1)')
                    .replace(/<img\s+[^>]*src="([^"]*)"[^>]*>/gi, '![]($1)')
                    .replace(/<[^>]+>/g, '')
                    .replace(/\n{3,}/g, '\n\n')
                    .trim();
                data.markdown = md.slice(0, 50000);
            }

            // Text content — removes scripts/styles, must be after JSON-LD and selector
            if (extractText) {
                $('script, style, noscript').remove();
                data.text = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 50000);
            }

            // Headings
            if (extractHeadings) {
                $('h1, h2, h3, h4, h5, h6').each((_i, el) => {
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

                $('a[href]').each((_i, el) => {
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
                $('img').each((_i, el) => {
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
                $('table').each((_i, table) => {
                    const headers: string[] = [];
                    $(table).find('th').each((_j, th) => {
                        headers.push($(th).text().trim());
                    });
                    const rows: string[][] = [];
                    $(table).find('tr').each((_j, tr) => {
                        const cells: string[] = [];
                        $(tr).find('td').each((_k, td) => {
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
                const html = $.html();
                const emailMatches = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
                if (emailMatches) {
                    data.emails = [...new Set(emailMatches)].slice(0, 50);
                }
            }

            // Phones
            if (extractPhones) {
                const html = $.html();
                const phoneMatches = html.match(/(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}/g);
                if (phoneMatches) {
                    data.phones = [...new Set(phoneMatches.filter(p => p.replace(/\D/g, '').length >= 7))].slice(0, 20);
                }
            }

            // Response time
            data.responseTimeMs = Date.now() - startTime;

            await pushData(data);
            pagesScraped++;

            // Follow internal links if depth allows, with URL filtering
            if (maxDepth > 0 && currentDepth < maxDepth) {
                const internalLinks = data.links.filter(l => !l.isExternal);
                for (const link of internalLinks.slice(0, 50)) {
                    // Apply include/exclude globs
                    if (excludeGlobs.length > 0 && excludeGlobs.some(g => matchGlob(link.href, g))) continue;
                    if (includeGlobs.length > 0 && !includeGlobs.some(g => matchGlob(link.href, g))) continue;

                    await crawler.addRequests([{
                        url: link.href,
                        userData: { depth: currentDepth + 1 },
                    }]);
                }
            }
        },

        async failedRequestHandler({ request }) {
            await pushData({
                url: request.url,
                title: null, description: null, language: null,
                canonicalUrl: null, robotsDirectives: null, text: null,
                headings: [], links: [], images: [], meta: {},
                openGraph: {}, twitterCard: {},
                tables: [], structuredData: [], emails: [], phones: [],
                socialLinks: [],
                markdown: null, selectedContent: null, statusCode: 0,
                contentType: null, responseTimeMs: null, pageSizeBytes: null,
                responseHeaders: {},
                scrapedAt: new Date().toISOString(),
                status: 'error',
                error: request.errorMessages?.slice(-1)[0] ?? 'Unknown error',
            });
        },
    });

    await crawler.run(urls.map(url => ({
        url: url.startsWith('http') ? url : `https://${url}`,
        userData: { depth: 0 },
    })));

    return pagesScraped;
}
