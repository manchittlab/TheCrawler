# TheCrawler Diagnostic Challenge Example

This folder shows the shape of a paid TheCrawler source-readiness diagnostic.

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

## Files

- `sample-input.json` — the workflow shape: public URLs plus target contract.
- `sample-report.md` — the report a buyer can read before committing engineering time.
- `sample-evidence-redacted.json` — compact machine-readable evidence with no raw page content or contact details.

## Commercial diagnostic scope

The paid $500 diagnostic covers up to 8 public URLs and one target output shape. It returns a report like this, plus compact evidence, within 24 hours after scope confirmation and payment.

Out of scope:

- login, paywall, private, credentialed, or user-specific pages,
- personal-data scraping,
- anti-bot bypass guarantees,
- a claim that every URL will extract cleanly.

If the target source is not a fit, the diagnostic says so.
