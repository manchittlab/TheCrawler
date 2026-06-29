/**
 * In-memory LRU cache with TTL for crawl results.
 *
 * Key is a hash of the URL plus the relevant extract-flags subset of CrawlOptions
 * (different flag combinations produce different output, so each combination caches separately).
 *
 * Designed for agent workloads: an agent doing multi-step research often re-queries
 * the same URLs within seconds. Cache hits are returned instantly with `fromCache: true`.
 *
 * Disabled by default — opt-in via `CrawlOptions.cache.enabled`.
 */
import { createHash } from 'node:crypto';
import type { CrawlOptions, PageData } from './types.js';

/**
 * Bump when an engine change alters cached OUTPUT shape/content so stale entries
 * (in-memory OR a durable consumer-side store keyed by these helpers) are not
 * served. Travels in every cache key.
 */
export const ENGINE_CACHE_VERSION = 1;

/**
 * Deterministic JSON string with recursively sorted object keys, so two logically
 * equal inputs (e.g. a JSON Schema authored with different key order) hash to the
 * SAME cache key. Plain `JSON.stringify(o, keys.sort())` only sorts the top level —
 * insufficient for nested extraction schemas. Pure.
 */
export function stableStringify(v: unknown): string {
    if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
    if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
    const o = v as Record<string, unknown>;
    return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(o[k])).join(',') + '}';
}

interface CacheEntry {
    data: PageData;
    expiresAt: number;
}

export class CrawlCache {
    private store = new Map<string, CacheEntry>();
    constructor(private maxEntries: number = 500, private ttlMs: number = 5 * 60 * 1000) {}

    /**
     * Compute a deterministic key for (url, extract-flags). Flags are sorted
     * so option-key ordering doesn't fragment the cache.
     */
    static keyFor(url: string, opts: CrawlOptions): string {
        const flagSubset = {
            extractText: opts.extractText !== false,
            extractLinks: opts.extractLinks !== false,
            extractImages: opts.extractImages !== false,
            extractMeta: opts.extractMeta !== false,
            extractHeadings: opts.extractHeadings !== false,
            extractTables: opts.extractTables !== false,
            extractStructuredData: opts.extractStructuredData !== false,
            extractEmails: opts.extractEmails === true,
            extractPhones: opts.extractPhones === true,
            extractMarkdown: opts.extractMarkdown ?? false,
            stripBoilerplate: opts.stripBoilerplate !== false,
            cssSelector: opts.cssSelector ?? null,
            chunkSize: opts.chunkSize ?? 0,
            usePlaywright: opts.usePlaywright ?? false,
            extractBrand: opts.extractBrand === true,
            brandFetchStylesheets: opts.brandFetchStylesheets !== false,
            onlyMainContent: opts.onlyMainContent === true,
            includeTags: opts.includeTags || [],
            excludeTags: opts.excludeTags || [],
            extractHtml: opts.extractHtml === true,
            extractRawHtml: opts.extractRawHtml === true,
            waitFor: opts.waitFor ?? null,
        };
        const payload = ENGINE_CACHE_VERSION + '|' + url + '|' + JSON.stringify(flagSubset, Object.keys(flagSubset).sort());
        return createHash('sha256').update(payload).digest('hex').slice(0, 16);
    }

    /**
     * Deterministic cache key for an EXTRACTION result. Unlike `keyFor` (crawl
     * flags only), this folds in the extraction inputs that change the OUTPUT —
     * jsonSchema, prompt, contract, model, groundToSource, the markdown limit, and
     * the crawl-shape options that affect the source markdown. Without this, two
     * different extractions of the same URL (e.g. a product schema vs a brand
     * schema, or 30B vs GPT-4) would collide on a URL-only key and serve each
     * other's data (Codex Risk 3). Schema key-order is normalized (stableStringify)
     * so equivalent schemas share a key. Pure + deterministic.
     */
    static extractKeyFor(url: string, opts: {
        jsonSchema?: object;
        prompt?: string;
        contract?: string;
        model?: string;
        groundToSource?: boolean;
        markdownCharLimit?: number;
        crawlOptions?: Partial<CrawlOptions>;
    }): string {
        const c = opts.crawlOptions ?? {};
        // Only the crawl options that change the SOURCE markdown the model sees.
        const crawlShape = {
            usePlaywright: c.usePlaywright ?? false,
            adaptiveCrawling: c.adaptiveCrawling ?? false,
            onlyMainContent: c.onlyMainContent ?? false,
            stripBoilerplate: c.stripBoilerplate !== false,
            waitFor: c.waitFor ?? null,
            waitForMs: c.waitForMs ?? 0,
            // Keep arrays (not join(',')) so ['a,b','c'] vs ['a','b,c'] don't collide (Codex F1).
            includeTags: c.includeTags || [],
            excludeTags: c.excludeTags || [],
        };
        const payload = stableStringify({
            v: ENGINE_CACHE_VERSION,
            url,
            jsonSchema: opts.jsonSchema ?? null,
            prompt: opts.prompt ?? null,
            contract: opts.contract ?? null,
            model: opts.model ?? null,
            groundToSource: opts.groundToSource === true,
            markdownCharLimit: opts.markdownCharLimit ?? null,
            crawlShape,
        });
        return 'x' + createHash('sha256').update(payload).digest('hex').slice(0, 23);
    }

    get(key: string): PageData | null {
        const entry = this.store.get(key);
        if (!entry) return null;
        if (entry.expiresAt < Date.now()) {
            this.store.delete(key);
            return null;
        }
        // Refresh LRU position by re-inserting.
        this.store.delete(key);
        this.store.set(key, entry);
        return { ...entry.data, fromCache: true };
    }

    set(key: string, data: PageData): void {
        if (this.store.size >= this.maxEntries) {
            // Evict oldest (first inserted) — Map iteration is insertion-order.
            const oldestKey = this.store.keys().next().value;
            if (oldestKey !== undefined) this.store.delete(oldestKey);
        }
        this.store.set(key, { data: { ...data, fromCache: false }, expiresAt: Date.now() + this.ttlMs });
    }

    clear(): void {
        this.store.clear();
    }

    get size(): number {
        return this.store.size;
    }
}

/** Singleton — used by engine when caller doesn't supply their own. */
let defaultCache: CrawlCache | null = null;
export function getDefaultCache(maxEntries: number, ttlSeconds: number): CrawlCache {
    if (!defaultCache || defaultCache['maxEntries'] !== maxEntries || defaultCache['ttlMs'] !== ttlSeconds * 1000) {
        defaultCache = new CrawlCache(maxEntries, ttlSeconds * 1000);
    }
    return defaultCache;
}
