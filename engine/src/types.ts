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
    | 'blocked-bot'     // 403 / known access-control or challenge-page response
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
    /** SerpAPI key (legacy). Prefer serperApiKey (Serper.dev — the cheaper default). */
    serpApiKey?: string;
    /** Serper.dev API key for Google search. Overrides the SERPER_API_KEY / SERPER_DEV_KEY / THECRAWLER_SERPER_KEY env vars. */
    serperApiKey?: string;
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
     * Rotate among standard browser User-Agent strings per request.
     * Uses varied standard browser User-Agent strings for compatibility with
     * sites that treat missing or unusual user agents differently. Default: true.
     */
    rotateUserAgent?: boolean;
    /**
     * Extract brand identity: ranked color `palette`, `themeColor`, and `logo`
     * candidates on each PageData. Reads <meta theme-color>, CSS custom
     * properties, inline/<style>/linked-stylesheet colors, and — in Playwright
     * mode — rendered getComputedStyle colors. Default: false (opt-in).
     */
    extractBrand?: boolean;
    /**
     * When extractBrand is on and running in Cheerio mode, fetch a bounded set
     * of linked stylesheets (<link rel=stylesheet>) to mine brand colors.
     * Bounded for latency + SSRF safety. Default: true. Ignored in Playwright
     * mode, where computed colors are the primary signal.
     */
    brandFetchStylesheets?: boolean;
    /**
     * Restrict text/markdown/links/html output to the main content, dropping
     * nav/header/footer/aside/cookie banners. Firecrawl-compatible. Default false.
     */
    onlyMainContent?: boolean;
    /** Keep ONLY elements matching these CSS selectors in content output. */
    includeTags?: string[];
    /** Remove elements matching these CSS selectors from content output. */
    excludeTags?: string[];
    /** Include processed/cleaned HTML in output (PageData.html). Default false. */
    extractHtml?: boolean;
    /** Include raw, unprocessed serialized HTML in output (PageData.rawHtml). Default false. */
    extractRawHtml?: boolean;
    /** Firecrawl-compatible alias for waitForMs (ms to wait after load; Playwright only). */
    waitFor?: number;
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
    /**
     * Which engine actually rendered this page. 'playwright' means Chromium
     * executed the page's JS (so computed colors / SPA content are reliable);
     * 'cheerio' is a plain HTTP fetch + static HTML parse. Reflects the real
     * path taken, including an adaptive Cheerio→Playwright upgrade.
     */
    engine: 'cheerio' | 'playwright';
    /** Convenience mirror of `engine === 'playwright'`. */
    usedPlaywright: boolean;
    /**
     * `<meta name="theme-color">` normalized to a 6-digit lowercase hex, or null.
     * Only populated when extractBrand is on. Often the single highest-signal
     * brand color.
     */
    themeColor: string | null;
    /**
     * Ranked brand color palette (top ~5), highest signal first. Only populated
     * when extractBrand is on. `hex` is the minimum guarantee; role/source/weight
     * are best-effort. Ordering is deterministic for a given page.
     */
    palette: { hex: string; role: string | null; source: string; weight: number }[];
    /**
     * Ranked best-guess logo candidates (top ~4), highest confidence first. Only
     * populated when extractBrand is on. Suggestions only — never auto-applied.
     * Absolute URLs; SVG/transparent-PNG preferred.
     */
    logo: { url: string; source: string; type: string | null; confidence: number }[];
    /**
     * Deterministic brand facts from Organization/WebSite/Brand JSON-LD (name,
     * description, logo, social links). Populated when extractBrand is on; a reliable
     * prior/validation for the LLM brand-context contract. Null when no org JSON-LD.
     */
    brandOrg: { name: string | null; description: string | null; logo: string | null; socialLinks: string[] } | null;
    /** Processed/cleaned HTML (main content when onlyMainContent). Populated when extractHtml. */
    html: string | null;
    /** Raw, unprocessed serialized HTML. Populated when extractRawHtml. */
    rawHtml: string | null;
}

export interface CrawlResult {
    pages: PageData[];
    totalScraped: number;
    totalErrors: number;
    durationMs: number;
}
