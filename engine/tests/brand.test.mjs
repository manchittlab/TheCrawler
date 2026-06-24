import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeColor, parseColor, buildPalette, rankLogos, collectCssColors,
    isPrivateIp, isBlockedBrandHost, sameSite, sanitizeInlineSvg,
} from '../dist/brand.js';

test('normalizeColor handles hex/rgb/hsl and rejects non-colors', () => {
    assert.equal(normalizeColor('#FFF'), '#ffffff');
    assert.equal(normalizeColor('#635bff'), '#635bff');
    assert.equal(normalizeColor('rgb(99, 91, 255)'), '#635bff');
    assert.equal(normalizeColor('rgb(99 91 255 / 0.8)'), '#635bff'); // modern slash syntax
    assert.equal(normalizeColor('hsl(250, 100%, 50%)'), '#2a00ff');
    assert.equal(normalizeColor('rgba(0,0,0,0)'), null);    // fully transparent → no signal
    assert.equal(normalizeColor('transparent'), null);
    assert.equal(normalizeColor('currentColor'), null);
    assert.equal(normalizeColor('var(--brand)'), null);
    assert.equal(normalizeColor('linear-gradient(#fff,#000)'), null);
    assert.equal(normalizeColor('teal'), '#008080');       // named color
});

test('normalizeColor rejects malformed channels/alpha and handles !important', () => {
    assert.equal(normalizeColor('rgb(foo, 0, 0)'), null);       // non-numeric channel
    assert.equal(normalizeColor('rgba(255,0,0,foo)'), null);    // non-numeric alpha
    assert.equal(normalizeColor('hsl(0 100% 50% / bar)'), null); // non-numeric alpha
    assert.equal(normalizeColor('#635bff !important'), '#635bff'); // !important stripped
});

test('sanitizeInlineSvg blocks unclosed scripts, external use/image, external href', () => {
    const a = sanitizeInlineSvg('<svg><script src="//evil/x.js"><path/></svg>');
    assert.ok(a && !/script/i.test(a), 'unclosed <script src> must be stripped');
    const b = sanitizeInlineSvg('<svg><use href="//evil/sprite.svg#x"/><path/></svg>');
    assert.ok(b && !/<use/i.test(b), 'external <use> must be stripped');
    const c = sanitizeInlineSvg('<svg><a href="javascript:alert(1)"><path/></a></svg>');
    assert.ok(c && !/javascript:/i.test(c), 'javascript: href must be stripped');
});

test('sameSite is eTLD+1 aware (co.uk not collapsed)', () => {
    assert.equal(sameSite('a.example.co.uk', 'b.example.co.uk'), true);
    assert.equal(sameSite('mybrand.co.uk', 'evil.co.uk'), false); // would be true under naive last-2-labels
    assert.equal(sameSite('www.stripe.com', 'assets.stripe.com'), true);
});

test('isPrivateIp blocks IPv6 multicast + documentation + hex-mapped v4', () => {
    assert.equal(isPrivateIp('ff02::1'), true);
    assert.equal(isPrivateIp('2001:db8::1'), true);
    assert.equal(isPrivateIp('::ffff:c0a8:0101'), true); // hex-form ::ffff:192.168.1.1 must not bypass
    assert.equal(isPrivateIp('::ffff:7f00:0001'), true); // hex-form ::ffff:127.0.0.1
    assert.equal(isPrivateIp('::ffff:0808:0808'), false); // hex-form ::ffff:8.8.8.8 (public)
});

test('buildPalette assigns a primary even when theme-color is filtered out', () => {
    // theme-color is gray (neutral) → dropped from palette, but a chromatic color exists.
    const { palette } = buildPalette([{ value: '#e11d48', source: 'css-var', weight: 0.4 }], '#808080');
    assert.ok(palette.length >= 1);
    assert.equal(palette.filter((p) => p.role === 'primary').length, 1, 'exactly one primary must be assigned');
});

test('buildPalette is deterministic for identical input', () => {
    const hits = [
        { value: '#635bff', source: 'style', weight: 0.12 },
        { value: '#0a2540', source: 'style', weight: 0.3 },
        { value: '#00d4ff', source: 'css-var', weight: 0.4 },
        { value: '#ffffff', source: 'style', weight: 0.9 },
        { value: '#f6f9fc', source: 'style', weight: 0.5 },
    ];
    const a = buildPalette(hits, '#635bff');
    const b = buildPalette([...hits].reverse(), '#635bff');
    assert.deepEqual(a, b, 'palette ordering must not depend on input order');
    assert.equal(a.themeColor, '#635bff');
    assert.ok(a.palette.length >= 1 && a.palette.length <= 5);
    // theme-color must be present and tagged primary
    const primary = a.palette.find((p) => p.role === 'primary');
    assert.equal(primary?.hex, '#635bff');
});

test('buildPalette drops near-white/black/gray unless theme-color', () => {
    const hits = [
        { value: '#ffffff', source: 'style', weight: 1 },   // near-white → dropped
        { value: '#010101', source: 'style', weight: 1 },   // near-black → dropped
        { value: '#808080', source: 'style', weight: 1 },   // gray → dropped
        { value: '#e11d48', source: 'css-var', weight: 0.4 }, // saturated → kept
    ];
    const { palette } = buildPalette(hits, null);
    const hexes = palette.map((p) => p.hex);
    assert.ok(hexes.includes('#e11d48'));
    assert.ok(!hexes.includes('#ffffff'));
    assert.ok(!hexes.includes('#808080'));
});

test('buildPalette keeps a neutral for monochrome brands (fallback)', () => {
    // Only neutrals present → should still surface dark + light as candidates.
    const hits = [
        { value: '#111111', source: 'style', weight: 0.8 },
        { value: '#fafafa', source: 'style', weight: 0.6 },
    ];
    const { palette } = buildPalette(hits, null);
    assert.ok(palette.length >= 1, 'monochrome brand should still get a palette');
});

test('collectCssColors resolves var() chains and weights brand vars higher', () => {
    const css = ':root{--primary:#635bff;--brand:var(--primary);--x:#123456} .a{color:#abcdef}';
    const hits = collectCssColors(css, 'style');
    const brandVarHit = hits.find((h) => h.source.includes('var--brand'));
    assert.ok(brandVarHit, 'resolved --brand should appear');
    assert.equal(brandVarHit.value, '#635bff');
    assert.ok(brandVarHit.weight >= 0.4);
});

test('rankLogos dedups, sorts by confidence desc, caps at 4', () => {
    const ranked = rankLogos([
        { url: 'a.png', source: 'icon', type: 'png', confidence: 0.65 },
        { url: 'b.svg', source: 'json-ld', type: 'svg', confidence: 0.9 },
        { url: 'a.png', source: 'icon', type: 'png', confidence: 0.7 }, // dup, higher conf wins
        { url: 'c.png', source: 'og:image', type: 'png', confidence: 0.3 },
        { url: 'd.ico', source: 'favicon-default', type: 'ico', confidence: 0.4 },
        { url: 'e.png', source: 'header-img', type: 'png', confidence: 0.8 },
    ]);
    assert.equal(ranked[0].url, 'b.svg');           // highest confidence first
    assert.ok(ranked.length <= 4);
    const a = ranked.find((l) => l.url === 'a.png');
    assert.equal(a?.confidence, 0.7);               // dedup kept the higher confidence
});

test('SSRF: private/loopback/metadata hosts are blocked', () => {
    for (const h of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1']) {
        assert.equal(isPrivateIp(h), true, `${h} should be private`);
    }
    for (const h of ['8.8.8.8', '1.1.1.1', '93.184.216.34']) {
        assert.equal(isPrivateIp(h), false, `${h} should be public`);
    }
    assert.equal(isBlockedBrandHost('localhost'), true);
    assert.equal(isBlockedBrandHost('foo.internal'), true);
    assert.equal(isBlockedBrandHost('metadata.google.internal'), true);
    assert.equal(isBlockedBrandHost('stripe.com'), false);
});

test('sameSite compares registrable domain', () => {
    assert.equal(sameSite('www.stripe.com', 'stripe.com'), true);
    assert.equal(sameSite('assets.stripe.com', 'stripe.com'), true);
    assert.equal(sameSite('evil.com', 'stripe.com'), false);
});

test('sanitizeInlineSvg strips scripts and caps size', () => {
    const ok = sanitizeInlineSvg('<svg><script>alert(1)</script><path d="M0 0"/></svg>');
    assert.ok(ok && !/script/i.test(ok));
    assert.equal(sanitizeInlineSvg('<svg>' + 'x'.repeat(30000) + '</svg>'), null); // over cap
    assert.equal(sanitizeInlineSvg('<div>not svg</div>'), null);
});
