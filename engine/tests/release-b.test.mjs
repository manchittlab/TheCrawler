import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { crawl } from '../dist/engine.js';

const HTML = `<!doctype html><html lang="en"><head><title>T</title></head><body>
<nav>NAVLINK menu home</nav>
<main><h1>Main Title</h1><p class="keep">KEEPME content here</p><p class="drop">DROPME advertisement</p></main>
<footer>FOOTERTEXT copyright 2026</footer>
</body></html>`;

let server, base;
before(async () => {
    server = http.createServer((_q, r) => { r.writeHead(200, { 'Content-Type': 'text/html' }); r.end(HTML); });
    await new Promise((res) => server.listen(0, res));
    base = 'http://127.0.0.1:' + server.address().port + '/';
});
after(() => server.close());

test('rawHtml = full document, html = cleaned main content', async () => {
    const p = (await crawl({ urls: [base], extractRawHtml: true, extractHtml: true })).pages[0];
    assert.ok(p.rawHtml && p.rawHtml.includes('NAVLINK'), 'rawHtml keeps everything');
    assert.ok(p.html && p.html.includes('Main Title'), 'html has main content');
    assert.ok(!p.html.includes('<nav'), 'html strips nav (main-content scoped)');
});

test('onlyMainContent drops nav/footer from text', async () => {
    const p = (await crawl({ urls: [base], onlyMainContent: true, extractText: true })).pages[0];
    assert.ok(p.text.includes('Main Title'));
    assert.ok(!p.text.includes('NAVLINK'), 'nav dropped');
    assert.ok(!p.text.includes('FOOTERTEXT'), 'footer dropped');
});

test('excludeTags removes matching selectors', async () => {
    const p = (await crawl({ urls: [base], excludeTags: ['.drop', 'nav', 'footer'], extractText: true })).pages[0];
    assert.ok(p.text.includes('KEEPME'));
    assert.ok(!p.text.includes('DROPME'), '.drop removed');
    assert.ok(!p.text.includes('NAVLINK'), 'nav removed');
});

test('includeTags keeps only matching subtrees', async () => {
    const p = (await crawl({ urls: [base], includeTags: ['.keep'], extractText: true })).pages[0];
    assert.ok(p.text.includes('KEEPME'));
    assert.ok(!p.text.includes('Main Title'), 'non-matching dropped');
    assert.ok(!p.text.includes('DROPME'));
});

test('no content controls = unchanged behavior (regression guard)', async () => {
    const p = (await crawl({ urls: [base], extractText: true })).pages[0];
    assert.ok(p.text.includes('NAVLINK') && p.text.includes('Main Title') && p.text.includes('FOOTERTEXT'),
        'default keeps full DOM text');
    assert.equal(p.rawHtml, null, 'rawHtml absent unless requested');
    assert.equal(p.html, null, 'html absent unless requested');
});

test('waitFor is accepted as alias (no throw, cheerio path)', async () => {
    const p = (await crawl({ urls: [base], waitFor: 100, extractText: true })).pages[0];
    assert.equal(p.status, 'success');
});
