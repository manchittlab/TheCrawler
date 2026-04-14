import { Actor, log } from 'apify';
import { scrapeUrls, type ScraperInput, type PageData } from './core.js';

interface Input extends ScraperInput {
    dryRun?: boolean;
}

await Actor.init();

try {
    const input = (await Actor.getInput<Input>()) ?? {} as Input;

    if (!input.urls || !Array.isArray(input.urls) || input.urls.length === 0) {
        throw new Error('Input must contain a non-empty "urls" array.');
    }

    const dryRun = input.dryRun ?? false;
    log.info('Starting Web Scraper', {
        urls: input.urls.length,
        maxDepth: input.maxDepth ?? 0,
        maxPages: input.maxPages ?? 100,
        dryRun,
    });

    const FREE_TIER_LIMIT = 0;
    let succeeded = 0;
    let charged = 0;

    const pagesScraped = await scrapeUrls(input, async (data: PageData) => {
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
