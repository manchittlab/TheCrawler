import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proposeFieldsFromPage, discoverFields } from '../dist/discover.js';

/** Minimal PageData with sane defaults; override the fields a case cares about. */
function mkPage(over = {}) {
    return {
        url: 'https://example.com/p/1', title: null, description: null, language: null,
        canonicalUrl: null, robotsDirectives: null, text: null, headings: [], links: [],
        images: [], meta: {}, openGraph: {}, twitterCard: {}, tables: [], structuredData: [],
        emails: [], phones: [], socialLinks: [], markdown: null, chunks: null, selectedContent: null,
        statusCode: 200, contentType: 'text/html', responseTimeMs: 10, pageSizeBytes: 100,
        responseHeaders: {}, pdf: null, screenshots: [], redirectChain: [], hreflangTags: [],
        paginationLinks: [], microdata: [], commerceData: [], forms: [], analyticsDetected: [],
        scrapedAt: '', status: 'success', error: null, errorType: null, errorRetryable: false,
        fromCache: false, engine: 'cheerio', usedPlaywright: false, themeColor: null, palette: [],
        logo: [], brandOrg: null, html: null, rawHtml: null, ...over,
    };
}

test('proposes commerce fields from a product page (single record)', () => {
    const page = mkPage({
        title: 'Acme Widget',
        markdown: 'Acme Widget — the best widget. '.repeat(20),
        commerceData: [{ name: 'Acme Widget', price: '19.99', currency: 'USD', availability: 'in stock', rating: '4.5', reviewCount: '120', brand: 'Acme', sku: 'AW-1' }],
    });
    const r = proposeFieldsFromPage(page);
    assert.equal(r.readable, true);
    assert.equal(r.recordType, 'single');
    const names = r.fields.map((f) => f.name);
    for (const n of ['price', 'currency', 'availability', 'rating', 'brand', 'sku']) {
        assert.ok(names.includes(n), `expected field "${n}" in ${names.join(', ')}`);
    }
    const price = r.fields.find((f) => f.name === 'price');
    assert.equal(price.sample, '19.99');
    assert.equal(price.source, 'commerce');
});

test('detects a listing from multiple commerce items', () => {
    const page = mkPage({
        markdown: 'catalog '.repeat(50),
        commerceData: [
            { name: 'A', price: '1', currency: null, availability: null, rating: null, reviewCount: null, brand: null, sku: null },
            { name: 'B', price: '2', currency: null, availability: null, rating: null, reviewCount: null, brand: null, sku: null },
            { name: 'C', price: '3', currency: null, availability: null, rating: null, reviewCount: null, brand: null, sku: null },
        ],
    });
    const r = proposeFieldsFromPage(page);
    assert.equal(r.recordType, 'listing');
    assert.equal(r.itemCount, 3);
});

test('proposes from JSON-LD @graph + microdata + opengraph + tables', () => {
    const page = mkPage({
        markdown: 'x'.repeat(300),
        structuredData: [{ '@graph': [{ '@type': 'Article', headline: 'Big News', author: 'Jane', datePublished: '2026-01-01' }] }],
        microdata: [{ type: 'Product', properties: { color: 'red', size: 'L' } }],
        openGraph: { title: 'OG Title', image: 'https://x/y.png' },
        tables: [{ headers: ['Spec', 'Value'], rows: [['Weight', '2kg'], ['Height', '10cm']] }],
    });
    const r = proposeFieldsFromPage(page);
    const names = r.fields.map((f) => f.name.toLowerCase());
    assert.ok(names.includes('headline'));
    assert.ok(names.includes('author'));
    assert.ok(names.includes('color'));
    assert.ok(names.includes('image'));
    assert.ok(names.includes('spec') || names.includes('value'));
    // A key/value spec table is NOT a listing — single record despite >1 row.
    assert.equal(r.recordType, 'single');
});

test('a multi-row spec table alone does NOT make a listing', () => {
    const page = mkPage({
        markdown: 'x'.repeat(300),
        tables: [{ headers: ['Attribute', 'Value'], rows: [['UPC', 'abc'], ['Tax', '0'], ['Stock', '12']] }],
    });
    const r = proposeFieldsFromPage(page);
    assert.equal(r.recordType, 'single');
});

test('never leaks a full record — samples are clipped to <=80 chars', () => {
    const long = 'A'.repeat(500);
    const page = mkPage({ title: long, description: long, markdown: long });
    const r = proposeFieldsFromPage(page);
    for (const f of r.fields) assert.ok(f.sample.length <= 80, `sample too long: ${f.sample.length}`);
});

test('error page → not readable + note', () => {
    const page = mkPage({ status: 'error', error: 'blocked-bot', errorType: 'blocked-bot' });
    const r = proposeFieldsFromPage(page);
    assert.equal(r.readable, false);
    assert.match(r.note, /read this page/i);
    assert.deepEqual(r.fields, []);
});

test('empty SPA (no content, no structure) → not readable', () => {
    const page = mkPage({ markdown: '', text: '', engine: 'cheerio' });
    const r = proposeFieldsFromPage(page);
    assert.equal(r.readable, false);
    assert.match(r.note, /empty|JS/i);
});

test('rendered flag reflects playwright', () => {
    const r = proposeFieldsFromPage(mkPage({ markdown: 'x'.repeat(300), engine: 'playwright', usedPlaywright: true }));
    assert.equal(r.rendered, true);
    assert.equal(r.engine, 'playwright');
});

test('discoverFields merges LLM fields, blanks invented samples, dedups', async () => {
    const page = mkPage({
        title: 'Widget',
        markdown: 'The widget weighs 2kg and ships from Berlin. Price is 19.99.',
        commerceData: [{ name: 'Widget', price: '19.99', currency: null, availability: null, rating: null, reviewCount: null, brand: null, sku: null }],
    });
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ fields: [
            { name: 'weight', sample: '2kg' },          // present on page → kept
            { name: 'ships from', sample: 'Berlin' },    // present → kept
            { name: 'discount', sample: '90% off' },     // NOT on page → sample blanked, field kept
            { name: 'price', sample: '19.99' },          // duplicate of deterministic → dropped
        ] }) } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    try {
        const r = await discoverFields(page, { llm: { baseUrl: 'http://box/v1/chat/completions', model: 'qwen' } });
        const byName = Object.fromEntries(r.fields.map((f) => [f.name.toLowerCase(), f]));
        assert.equal(byName['weight'].sample, '2kg');
        assert.equal(byName['weight'].source, 'llm');
        assert.equal(byName['ships from'].sample, 'Berlin');
        assert.equal(byName['discount'].sample, '');         // invented sample blanked
        assert.ok(byName['discount']);                        // but field name kept
        // price stays the deterministic commerce one, not duplicated
        assert.equal(r.fields.filter((f) => f.name.toLowerCase() === 'price').length, 1);
        assert.equal(byName['price'].source, 'commerce');
    } finally {
        globalThis.fetch = origFetch;
    }
});

test('discoverFields blanks a 1-char invented sample', async () => {
    const page = mkPage({ title: 'Widget', markdown: 'The widget is great.' });
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ fields: [{ name: 'grade', sample: 'Z' }] }) } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    try {
        const r = await discoverFields(page, { llm: { baseUrl: 'http://box/v1/chat/completions', model: 'q' } });
        const grade = r.fields.find((f) => f.name === 'grade');
        assert.ok(grade);                 // field kept
        assert.equal(grade.sample, '');    // invented 1-char sample blanked ('Z' not on page)
    } finally { globalThis.fetch = origFetch; }
});

test('LLM can upgrade single→listing when deterministic found no listing signal', async () => {
    const page = mkPage({ title: 'Shop', markdown: 'item one item two item three '.repeat(20) });
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ fields: [{ name: 'product', sample: 'item one' }], recordType: 'listing', itemCount: 3 }) } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    try {
        const r = await discoverFields(page, { llm: { baseUrl: 'http://box/v1/chat/completions', model: 'q' } });
        assert.equal(r.recordType, 'listing');
        assert.equal(r.itemCount, 3);
    } finally { globalThis.fetch = origFetch; }
});

test('LLM cannot downgrade a deterministic listing to single', async () => {
    const page = mkPage({
        markdown: 'x'.repeat(300),
        commerceData: [
            { name: 'A', price: '1', currency: null, availability: null, rating: null, reviewCount: null, brand: null, sku: null },
            { name: 'B', price: '2', currency: null, availability: null, rating: null, reviewCount: null, brand: null, sku: null },
        ],
    });
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ fields: [], recordType: 'single' }) } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    try {
        const r = await discoverFields(page, { llm: { baseUrl: 'http://box/v1/chat/completions', model: 'q' } });
        assert.equal(r.recordType, 'listing'); // deterministic commerce listing stays authoritative
    } finally { globalThis.fetch = origFetch; }
});

test('discoverFields degrades to deterministic base when the LLM errors', async () => {
    const page = mkPage({ title: 'Widget', markdown: 'x'.repeat(300), commerceData: [{ name: 'W', price: '5', currency: null, availability: null, rating: null, reviewCount: null, brand: null, sku: null }] });
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('box down'); };
    try {
        const r = await discoverFields(page, { llm: { baseUrl: 'http://box/v1/chat/completions', model: 'qwen' } });
        assert.ok(r.fields.some((f) => f.name === 'price'));
        assert.ok(r.fields.every((f) => f.source !== 'llm'));
    } finally {
        globalThis.fetch = origFetch;
    }
});

test('discoverFields skips the LLM entirely on an unreadable page', async () => {
    const page = mkPage({ status: 'error', error: 'dns' });
    let called = false;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => { called = true; return new Response('{}'); };
    try {
        const r = await discoverFields(page, { llm: { baseUrl: 'http://box/v1/chat/completions', model: 'qwen' } });
        assert.equal(r.readable, false);
        assert.equal(called, false);
    } finally {
        globalThis.fetch = origFetch;
    }
});
