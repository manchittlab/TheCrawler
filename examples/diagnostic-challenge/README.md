# TheCrawler Extraction Readiness Sprint Example

This folder shows the shape of a paid TheCrawler extraction readiness sprint.

It is intentionally small and conservative:

- one public extraction workflow,
- two public URLs,
- one built-in contract, `real-estate-listing`,
- one buyer-readable report,
- one compact redacted evidence file.

The point is not to claim every site works. The point is to show the useful result of diagnosing before extraction:

- one URL was a good candidate for contract extraction,
- one URL was blocked by rate limiting,
- the workflow verdict was `mixed`,
- the recommended next step was `extract-ready-subset`.

## Proof matrix

| Proof | What passed | What it proves | Limitation |
|---|---|---|---|
| Public diagnostic challenge | Rightmove returned ready; Realtor returned rate-limited; workflow verdict was `mixed` | The diagnostic can separate usable sources from blocked sources before extraction work starts | It does not prove every real-estate site works |
| 5-category local validation | Rightmove, Apple, React.dev, and Framer returned crawl output with text, markdown, and metadata | TheCrawler can produce useful crawl output across real estate, ecommerce, docs, and JavaScript-heavy marketing pages | Raw markdown can be noisy and may need per-site cleanup |
| Blocked-site check | G2 returned a structured blocked result instead of a false success | A blocked target can be represented as evidence rather than hidden behind empty output | This is not an anti-bot bypass claim |
| Contract extraction proof | The built-in `real-estate-listing` contract returned required-field validation in local Qwen testing | Contract mode can validate whether required fields are present after extraction | Current npm is stale; use the GitHub source for current contract features |

## Files

- `sample-input.json` — the workflow shape: public URLs plus target contract.
- `sample-report.md` — the report a buyer can read before committing engineering time.
- `sample-evidence-redacted.json` — compact machine-readable evidence with no raw page content or contact details.

## Commercial sprint scope

The paid $500 sprint covers up to 25 public URLs and one target output shape. It returns a report like this, plus compact evidence, within 24 hours after scope confirmation and payment. If the workflow continues into setup or hosted usage, the $500 is credited toward that next step. If another stack is a better fit, the report says so.

Out of scope:

- login, paywall, private, credentialed, or user-specific pages,
- personal-data scraping,
- anti-bot bypass guarantees,
- a claim that every URL will extract cleanly.

If the target source is not a fit, the sprint says so.
