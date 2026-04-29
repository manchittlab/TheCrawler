/**
 * Multi-event PPE pricing PUT for the-crawler actor.
 *
 * Adds a new pricingInfos entry with BOTH events:
 *   - page-scraped: $0.005 (plain crawl, current price)
 *   - page-extracted: $0.02 (LLM extract mode, ~5-10x compute)
 *
 * Constraints (verified empirically S11 2026-04-28):
 *   - Apify rejects PUTs unless body's pricingInfos[] starts with the
 *     existing entries unchanged (`incorrect-pricing-modifier-prefix`).
 *   - New entry's startedAt must be >=14 days from now
 *     (`cannot-modify-actor-pricing-with-immediate-effect`).
 *   - Pricing changes only every 30 days from the previous entry's
 *     createdAt (`cannot-modify-actor-pricing-too-frequently`).
 *     Current entry created 2026-04-16T14:46:36 -> unlock 2026-05-16T14:46:36.
 *   - Only ONE pending future pricing entry allowed at a time
 *     (`cannot-add-second-future-pricing-info`).
 *
 * Run on or after 2026-05-16T14:46:36 UTC.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ACTOR_ID = 'fQXoZkUYxWBk8szNd';
const PAGE_SCRAPED_USD = 0.005;
const PAGE_EXTRACTED_USD = 0.02;
const STARTED_AT_DAYS_FROM_NOW = 15;  // 14-day minimum + 1-day buffer

function loadToken() {
    const home = process.env.HOME || process.env.USERPROFILE;
    const p = path.join(home, '.apify', 'auth.json');
    return JSON.parse(fs.readFileSync(p, 'utf8')).token;
}

async function main() {
    const token = loadToken();

    // 1. Fetch current pricing.
    const r = await fetch(`https://api.apify.com/v2/acts/${ACTOR_ID}`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw new Error(`GET actor failed: HTTP ${r.status}`);
    const j = await r.json();
    const current = j.data.pricingInfos;
    console.log(`Current pricingInfos has ${current.length} entry/entries.`);

    // 2. Idempotency check — skip if a future entry already includes page-extracted.
    const future = current.filter(p => new Date(p.startedAt) > new Date());
    for (const f of future) {
        const events = Object.keys(f.pricingPerEvent?.actorChargeEvents || {});
        if (events.includes('page-extracted')) {
            console.log('A future pricing entry already includes page-extracted — nothing to do.');
            console.log('Existing future entry:', JSON.stringify(f, null, 2));
            return;
        }
    }

    // 3. Cooldown sanity check — Apify enforces this server-side, but warn early if obviously too soon.
    const lastCreatedAt = new Date(current[current.length - 1].createdAt);
    const cooldownEnd = new Date(lastCreatedAt.getTime() + 30 * 24 * 60 * 60 * 1000);
    const now = new Date();
    if (now < cooldownEnd) {
        console.warn(`WARNING: cooldown ends ${cooldownEnd.toISOString()}, now is ${now.toISOString()}. Apify will reject this PUT.`);
        console.warn('Run this script after the cooldown ends. Aborting.');
        process.exit(1);
    }

    // 4. Build the new entry.
    const startedAt = new Date(now.getTime() + STARTED_AT_DAYS_FROM_NOW * 24 * 60 * 60 * 1000).toISOString();
    const newEntry = {
        pricingModel: 'PAY_PER_EVENT',
        startedAt,
        pricingPerEvent: {
            actorChargeEvents: {
                'page-scraped': {
                    eventTitle: 'Page Scraped',
                    eventDescription: 'Charged per page successfully scraped (plain crawl mode).',
                    isOneTimeEvent: false,
                    eventPriceUsd: PAGE_SCRAPED_USD,
                    isPrimaryEvent: true,
                },
                'page-extracted': {
                    eventTitle: 'Page Extracted (LLM)',
                    eventDescription: 'Charged per page processed in extract mode (crawl + LLM call). Reflects ~5-10x compute vs plain crawl.',
                    isOneTimeEvent: false,
                    eventPriceUsd: PAGE_EXTRACTED_USD,
                    isPrimaryEvent: false,
                },
            },
        },
    };

    // 5. Build the PUT body — must start with existing entries unchanged.
    const body = { pricingInfos: [...current, newEntry] };

    console.log(`Submitting new entry, startedAt=${startedAt}`);
    console.log(`Events: page-scraped @ $${PAGE_SCRAPED_USD}, page-extracted @ $${PAGE_EXTRACTED_USD}`);

    const putR = await fetch(`https://api.apify.com/v2/acts/${ACTOR_ID}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const putText = await putR.text();
    console.log(`PUT status: ${putR.status}`);
    console.log(putText.substring(0, 1500));

    if (putR.ok) {
        console.log('\n✓ Pricing PUT accepted. New rate effective:', startedAt);
        console.log('Next: deploy main.ts code change to charge page-extracted for extract mode.');
        console.log('See PRICING-PLAN-MAY-16.md Step 2.');
    } else {
        console.error('\n✗ Pricing PUT rejected. See response above.');
        process.exit(1);
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
