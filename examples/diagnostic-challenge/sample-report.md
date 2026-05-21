# TheCrawler Extraction Readiness Report

Generated: 2026-05-19

Contract: `real-estate-listing`

## Workflow Verdict

Verdict: `mixed`

Recommended next step: `extract-ready-subset`

Reason: 1 of 2 URLs was ready; handle blockers before expanding automation.

| Metric | Value |
|---|---:|
| Total URLs | 2 |
| Ready | 1 |
| Blocked | 1 |
| Failed | 0 |
| Needs review | 0 |
| Average score | 48 |

## URL Results

| URL | Verdict | Score | Next step | Blockers | Warnings |
|---|---|---:|---|---|---|
| https://www.rightmove.co.uk/property-for-sale/London.html | ready | 95 | run-contract-extraction | none | none |
| https://www.realtor.com/realestateandhomes-search/Austin_TX | blocked | 0 | retry-with-proxy-or-browser | rate-limit | none |

## Notes

- This report does not include raw extracted contact details or raw page evidence.
- A ready verdict means the source is a good candidate for contract extraction, not a guarantee that every page on the domain will work.
- A blocked verdict should be handled before spending LLM tokens on extraction.
