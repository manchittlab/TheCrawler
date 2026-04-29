# Multi-event PPE pricing — May 16 execution plan

**Goal:** charge `$0.005/page` for plain crawl mode and `$0.02/page` for extract mode (LLM-powered structured extraction). Reflects the ~5–10× compute differential — extract mode runs an LLM call per URL on top of the crawl.

**Why May 16+ specifically:** Apify locks pricing for 30 days from `pricingInfos[].createdAt`. Current pricing was created `2026-04-16T14:46:36.915Z` → cooldown unlocks `2026-05-16T14:46:36.915Z`. Earliest a new entry can be added.

**Why effective ~May 30:** Apify additionally requires `startedAt` ≥14 days from the time of PUT. So PUT on May 16 → effective May 30.

---

## Step 1 — Fire the pricing PUT (May 16+)

Run the script:

```bash
cd D:/Apify_Actors/the-crawler
node scripts/apply-may16-pricing.mjs
```

What it does:
- Reads the Apify token from `~/.apify/auth.json`.
- Fetches current `pricingInfos[]` from Apify (uses it as the unchanged prefix — Apify rejects PUTs that modify existing entries).
- Appends ONE new entry with BOTH events:
  - `page-scraped` at $0.005 (primary)
  - `page-extracted` at $0.02
- `startedAt` set to `now + 15 days` (14d minimum + 1d buffer).
- PUT to `https://api.apify.com/v2/acts/fQXoZkUYxWBk8szNd`.
- Logs the response. On success, the new pricing is queued.

The script is idempotent in the sense that it checks if `page-extracted` already exists in the LATEST entry — if so, it exits early without re-PUT.

---

## Step 2 — Update main.ts to charge the right event (deploy on May 30 OR use date gate)

### The actual code diff

In `D:/Apify_Actors/the-crawler/src/main.ts`, find the extract-mode branch (around line 80-90, the `for (const r of results)` loop). Change:

```diff
 for (const r of results) {
     await Actor.pushData(r);
     if (r.status === 'success') {
         succeeded++;
         if (!dryRun && succeeded > FREE_TIER_LIMIT) {
-            await Actor.charge({ eventName: 'page-scraped', count: 1 });
+            await Actor.charge({ eventName: 'page-extracted', count: 1 });
             charged++;
         }
     }
 }
```

The plain-crawl branch (the `else` block) keeps `page-scraped` unchanged.

### Two ways to deploy this change

**Option A — Deploy on May 30 (simplest):**

```bash
cd D:/Apify_Actors/the-crawler
# apply the diff above to src/main.ts
git add src/main.ts
git commit -m "Charge page-extracted for extract mode (May 30 pricing live)"
git push origin main
# CI auto-deploys, OR direct: npx apify-cli push --force
```

Risk: if deployed *before* May 30, runs in extract mode will fail because the `page-extracted` event doesn't exist on Apify's pricing yet. Safe choice = deploy ON May 30 same-day.

**Option B — Date-gated deploy (deploy whenever, runtime decides):**

Replace the diff with:

```ts
const PAGE_EXTRACTED_LIVE_FROM = new Date('2026-05-30T00:00:00Z');
const eventName = (input.extractMode && Date.now() >= PAGE_EXTRACTED_LIVE_FROM.getTime())
    ? 'page-extracted'
    : 'page-scraped';
await Actor.charge({ eventName, count: 1 });
```

Slightly more code; deploys today, switches automatically. Recommended if you don't want to touch the repo on May 30.

---

## Step 3 — Verify on Apify Console (within 24h of PUT)

1. Open https://console.apify.com/actors/fQXoZkUYxWBk8szNd → Publication → Monetization. Confirm two pricing entries: current ($0.005 only) + future ($0.005 + $0.02 starting `2026-05-30 ...`).
2. The actor's listing on the Apify Store will show the upcoming price change banner per Apify's standard 14-day notice rule.

## Step 4 — Smoke test on May 30 (or shortly after)

Run a billed test from the API:
```js
// One run in extract mode = $0.02 charge expected
fetch('https://api.apify.com/v2/acts/fQXoZkUYxWBk8szNd/run-sync?token=...', {
  method: 'POST',
  body: JSON.stringify({
    urls: ['https://example.com'],
    extractMode: true,
    extractJsonSchema: { type: 'object', properties: { name: { type: 'string' } } },
    llmBaseUrl: '<a-public-llm-endpoint>',
    llmModel: '<model>',
  }),
});
```

Check Apify billing dashboard — should show one `page-extracted` event at $0.02 (minus 20% Apify margin).

---

## Rollback

If the new pricing causes problems, you cannot simply revert (cooldown applies to the change too — once May 30 lands, you're locked in for another 30 days). Best mitigation:
- Quickly raise `page-extracted` to a much lower price via another future entry, OR
- Communicate to existing users via the actor's Apify Store description.

There is no "delete pending pricing entry" API — once PUT, the entry is committed.
