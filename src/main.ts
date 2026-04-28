import { Actor, log } from 'apify';
import { crawlStream, extract, type CrawlOptions, type PageData, type ExtractResult } from 'thecrawler';

interface ActorInput extends CrawlOptions {
    dryRun?: boolean;
    // Apify-input convenience: flat boolean that the actor maps to
    // CrawlOptions.cache.enabled. Other cache settings (ttl, maxEntries) use defaults.
    cacheEnabled?: boolean;
    // Extract-mode fields (when extractMode=true, the actor runs LLM extraction
    // instead of plain crawl).
    extractMode?: boolean;
    extractJsonSchema?: object;
    extractPrompt?: string;
    llmBaseUrl?: string;
    llmModel?: string;
    llmTemperature?: number | string;
    llmMaxTokens?: number;
    llmMarkdownCharLimit?: number;
}

await Actor.init();

try {
    const input = (await Actor.getInput<ActorInput>()) ?? ({} as ActorInput);

    if (!input.urls?.length && !input.searchQuery && !input.sitemapUrl) {
        throw new Error('Input must contain "urls" (non-empty array), "searchQuery", or "sitemapUrl".');
    }

    const dryRun = input.dryRun ?? false;
    const FREE_TIER_LIMIT = 0;
    let succeeded = 0;
    let charged = 0;

    if (input.extractMode) {
        // LLM-powered structured extraction path.
        if (!input.extractJsonSchema && !input.extractPrompt) {
            throw new Error('extractMode requires either extractJsonSchema or extractPrompt (or both).');
        }
        const baseUrl = input.llmBaseUrl || process.env.THECRAWLER_LLM_BASEURL || '';
        const model = input.llmModel || process.env.THECRAWLER_LLM_MODEL || '';
        if (!baseUrl || !model) {
            throw new Error('extractMode requires llmBaseUrl + llmModel input fields, or THECRAWLER_LLM_BASEURL + THECRAWLER_LLM_MODEL Actor environment variables.');
        }
        const apiKey = process.env.THECRAWLER_LLM_API_KEY || undefined;

        if (!input.urls?.length) {
            throw new Error('extractMode currently requires explicit urls[]. Search/sitemap modes are crawl-only.');
        }

        log.info('Starting TheCrawler in extract mode', {
            urls: input.urls.length,
            llmBaseUrl: baseUrl,
            llmModel: model,
            apiKeyConfigured: Boolean(apiKey),
            dryRun,
        });

        const results: ExtractResult[] = await extract({
            urls: input.urls,
            jsonSchema: input.extractJsonSchema,
            prompt: input.extractPrompt,
            markdownCharLimit: input.llmMarkdownCharLimit ?? 30000,
            crawlOptions: {
                usePlaywright: input.usePlaywright ?? false,
                adaptiveCrawling: input.adaptiveCrawling ?? false,
                requestRetries: input.requestRetries ?? 3,
                requestTimeoutSecs: input.requestTimeoutSecs ?? 30,
                rotateUserAgent: input.rotateUserAgent ?? true,
                customHeaders: input.customHeaders,
                proxyUrl: input.proxyUrl,
            },
            llm: {
                baseUrl,
                model,
                apiKey,
                temperature: typeof input.llmTemperature === 'string' ? parseFloat(input.llmTemperature) || 0 : (input.llmTemperature ?? 0),
                maxTokens: input.llmMaxTokens ?? 4000,
                timeoutSecs: 120,
            },
        });

        for (const r of results) {
            await Actor.pushData(r);
            if (r.status === 'success') {
                succeeded++;
                if (!dryRun && succeeded > FREE_TIER_LIMIT) {
                    await Actor.charge({ eventName: 'page-scraped', count: 1 });
                    charged++;
                }
            }
        }

        log.info('Done (extract)', { processed: results.length, succeeded, charged });
    } else {
        // Standard crawl path.
        log.info('Starting TheCrawler', {
            urls: input.urls?.length ?? 0,
            searchQuery: input.searchQuery ?? null,
            sitemapUrl: input.sitemapUrl ?? null,
            maxDepth: input.maxDepth ?? 0,
            maxPages: input.maxPages ?? 100,
            usePlaywright: input.usePlaywright ?? false,
            adaptiveCrawling: input.adaptiveCrawling ?? false,
            dryRun,
        });

        const opts: CrawlOptions = {
            ...input,
            cache: input.cacheEnabled ? { enabled: true } : input.cache,
            onStoreValue: async (key, buffer, contentType) => {
                await Actor.setValue(key, buffer, { contentType });
                return key;
            },
            logger: {
                info: (m, d) => log.info(m, d),
                error: (m, d) => log.error(m, d),
            },
        };

        const pagesScraped = await crawlStream(opts, async (data: PageData) => {
            await Actor.pushData(data);
            if (data.status === 'success') {
                succeeded++;
                if (!dryRun && succeeded > FREE_TIER_LIMIT) {
                    await Actor.charge({ eventName: 'page-scraped', count: 1 });
                    charged++;
                }
            }
        });

        log.info('Done', { pagesScraped, succeeded, charged });
    }
} catch (error) {
    log.error('Actor failed', { error: error instanceof Error ? error.message : String(error) });
    await Actor.fail(error instanceof Error ? error.message : String(error));
}

await Actor.exit();
