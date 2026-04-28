import { Actor, log } from 'apify';
import { crawlStream, type CrawlOptions, type PageData } from 'thecrawler';

await Actor.init();

try {
    const input = (await Actor.getInput<CrawlOptions & { dryRun?: boolean }>()) ?? ({} as CrawlOptions);

    if (!input.urls?.length && !input.searchQuery && !input.sitemapUrl) {
        throw new Error('Input must contain "urls" (non-empty array), "searchQuery", or "sitemapUrl".');
    }

    const dryRun = (input as any).dryRun ?? false;
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

    const FREE_TIER_LIMIT = 0;
    let succeeded = 0;
    let charged = 0;

    const opts: CrawlOptions = {
        ...input,
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
} catch (error) {
    log.error('Actor failed', { error: error instanceof Error ? error.message : String(error) });
    await Actor.fail(error instanceof Error ? error.message : String(error));
}

await Actor.exit();
