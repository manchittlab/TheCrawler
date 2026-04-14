# Universal Web Scraper — Extract Everything from Any Page

Scrape any webpage and extract every data point: text content, links, images, meta tags, headings (h1-h6), HTML tables, JSON-LD structured data, email addresses, and phone numbers. CSS selector targeting for specific content. Recursive crawling to follow internal links. $0.003/page.

---

## What it extracts per page

| Data | Description |
|------|-------------|
| **Text** | All visible text (scripts/styles stripped), up to 50K chars |
| **Links** | Every `<a>` tag — href, anchor text, internal/external flag |
| **Images** | Every `<img>` — src, alt text, width, height |
| **Meta tags** | All `<meta>` — description, og:title, keywords, robots, etc |
| **Headings** | All h1-h6 with level and text |
| **Tables** | HTML tables as structured arrays (headers + rows) |
| **JSON-LD** | Schema.org structured data from `<script type="application/ld+json">` |
| **Emails** | Email addresses found anywhere in the HTML |
| **Phones** | Phone numbers (7+ digits) found in the HTML |
| **Selected** | Content matching your CSS selector |

Every extraction type can be toggled on/off.

---

## Quick start

Scrape a single page:
```json
{
    "urls": ["https://example.com"]
}
```

Crawl a site (follow links):
```json
{
    "urls": ["https://example.com"],
    "maxDepth": 2,
    "maxPages": 50
}
```

Target specific content:
```json
{
    "urls": ["https://example.com"],
    "cssSelector": ".main-content"
}
```

---

## Input

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `urls` | array | _(required)_ | URLs to scrape |
| `extractText` | boolean | `true` | Visible text content |
| `extractLinks` | boolean | `true` | All links with anchor text |
| `extractImages` | boolean | `true` | All images with alt/dimensions |
| `extractMeta` | boolean | `true` | Meta tags |
| `extractHeadings` | boolean | `true` | h1-h6 headings |
| `extractTables` | boolean | `true` | HTML tables as arrays |
| `extractStructuredData` | boolean | `true` | JSON-LD schema.org data |
| `extractEmails` | boolean | `true` | Email addresses |
| `extractPhones` | boolean | `true` | Phone numbers |
| `cssSelector` | string | _(optional)_ | Target specific element |
| `maxDepth` | integer | `0` | 0 = listed URLs only. 1+ = follow links |
| `maxPages` | integer | `100` | Max pages to scrape total |
| `dryRun` | boolean | `false` | Scrape without charges |

---

## Pricing

**$0.003 per page scraped** (pay-per-event pricing).

- Errors and dry runs are never charged.
- 100 pages = $0.30
- 1,000 pages = $3.00

---

## Performance

- Uses CheerioCrawler — pure HTTP, no headless browser
- Fast: 100-500 pages/minute depending on target site
- Low memory: 256MB handles most scraping jobs

---

## Limitations

- **No JavaScript rendering.** This scraper reads the initial HTML response. Content injected by JavaScript (React, Vue, Angular SPAs) won't be captured. For JS-heavy sites, use a Playwright-based scraper.
- **Email/phone extraction** uses regex — may include false positives from code snippets or malformed patterns.
- **Tables** are extracted as flat text arrays. Complex nested tables may not parse correctly.
- **Rate limiting.** Crawlee handles basic rate limiting, but aggressive crawling may trigger bot protection.

---

## Related Tools by manchittlab

- **[Broken Link Checker](https://apify.com/accurate_pouch/broken-link-checker)** — Find broken links across your website.
- **[Email Validator Pro](https://apify.com/accurate_pouch/email-validator)** — Validate extracted emails with SMTP check.
- **[Tech Stack Detector](https://apify.com/accurate_pouch/tech-stack-detector)** — Detect what technology a site uses.
- **[Lighthouse Auditor](https://apify.com/accurate_pouch/lighthouse-auditor)** — Performance and SEO audits.
- **[Sitemap Analyzer](https://apify.com/accurate_pouch/sitemap-analyzer)** — Parse and validate XML sitemaps.
- **[DNS/WHOIS Suite](https://apify.com/accurate_pouch/dns-whois-suite)** — DNS records + RDAP domain lookup.
