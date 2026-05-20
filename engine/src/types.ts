export interface BrowserAction {
    type: 'click' | 'fill' | 'scroll' | 'wait' | 'screenshot';
    selector?: string;
    value?: string;
    pixels?: number;
    ms?: number;
}

/**
 * Structured error classification. Agents can branch on `errorType` instead of
 * regex-matching the error message. `retryable` is the engine's recommendation;
 * the caller may still choose differently (e.g., upgrade to Playwright on
 * `js-required` instead of plain retry).
 */
export type CrawlErrorType =
    | 'dns'             // hostname does not resolve
    | 'timeout'         // request exceeded timeout
    | 'rate-limit'      // 429 or known rate-limit response
    | 'blocked-bot'     // 403 / Cloudflare / Akamai / WAF block
    | 'js-required'     // page is mostly empty without JS render
    | 'http-4xx'        // any other 4xx
    | 'http-5xx'        // any 5xx
    | 'parse'           // HTML/PDF/DOCX parsing failure
    | 'network'         // socket reset, ECONNRESET, EHOSTUNREACH, etc.
    | 'unknown';        // unclassified

/**
 * In-memory LRU cache configuration. When enabled, identical (url + extract-flag)
 * requests within `ttlSeconds` return cached results without re-fetching.
 * Disabled by default — opt-in for agent workloads where re-querying is common.
 */
export interface CacheOptions {
    enabled?: boolean;       // default false
    ttlSeconds?: number;     // default 300 (5 min)
    maxEntries?: number;     // default 500
}

export interface CrawlOptions {
    urls?: string[];
    searchQuery?: string;
    searchLimit?: number;
    serpApiKey?: string;
    sitemapUrl?: string;
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
    adaptiveCrawling?: boolean;
    waitForSelector?: string;
    waitForMs?: number;
    actions?: BrowserAction[];
    customHeaders?: Record<string, string>;
    screenshotFullPage?: boolean;
    /**
     * Number of retry attempts for transient failures (5xx, network errors,
     * timeouts). Permanent failures (404, parse errors) are not retried.
     * Default: 3.
     */
    requestRetries?: number;
    /**
     * Per-request timeout in seconds. Default: 30.
     */
    requestTimeoutSecs?: number;
    /**
     * Rotate User-Agent strings from a real-browser pool per request.
     * Reduces detection by basic anti-bot WAFs. Default: true.
     */
    rotateUserAgent?: boolean;
    /**
     * Optional in-memory cache config. See CacheOptions.
     */
    cache?: CacheOptions;
    /** Callback to store binary data (screenshots). Return the key/path. */
    onStoreValue?: (key: string, buffer: Buffer, contentType: string) => Promise<string>;
    /** Logger. Defaults to console. */
    logger?: { info: (msg: string, data?: any) => void; error: (msg: string, data?: any) => void };
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
    images: { src: string; alt: string; width: string | null; height: string | null; dataSrc: string | null; loading: string | null }[];
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
    pdf: { text: string | null; pages: number; metadata: Record<string, string> } | null;
    screenshots: string[];
    redirectChain: { url: string; statusCode: number }[];
    hreflangTags: { lang: string; href: string }[];
    paginationLinks: { rel: string; href: string }[];
    microdata: { type: string; properties: Record<string, string> }[];
    commerceData: { name: string | null; price: string | null; currency: string | null; availability: string | null; rating: string | null; reviewCount: string | null; brand: string | null; sku: string | null }[];
    forms: { action: string | null; method: string; fields: { name: string; type: string; required: boolean }[] }[];
    analyticsDetected: string[];
    scrapedAt: string;
    status: 'success' | 'error';
    /**
     * Human-readable error message. Kept for backwards compatibility with
     * pre-0.2.0 consumers (cli, server, mcp text output).
     */
    error: string | null;
    /**
     * Structured error type. Agents should branch on this instead of regex-matching `error`.
     * Set when `status === 'error'`. Null on success.
     */
    errorType: CrawlErrorType | null;
    /**
     * Engine's recommendation for whether the caller should retry. Permanent
     * failures (404, parse) are non-retryable. Transient (5xx, network, timeout)
     * are retryable.
     */
    errorRetryable: boolean;
    /** True if this PageData came from cache rather than a fresh fetch. */
    fromCache: boolean;
}

export interface CrawlResult {
    pages: PageData[];
    totalScraped: number;
    totalErrors: number;
    durationMs: number;
}
