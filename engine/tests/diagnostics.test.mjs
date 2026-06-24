import test from 'node:test';
import assert from 'node:assert/strict';

import {
    diagnoseContractReadiness,
    getExtractionContract,
    renderContractDiagnosticReport,
    summarizeContractDiagnostics,
} from '../dist/index.js';

const contract = getExtractionContract('real-estate-listing');
const productContract = getExtractionContract('product-page');

test('diagnostic marks successful content with listing signals as ready', () => {
    const result = diagnoseContractReadiness(contract, {
        url: 'https://example.com/listing/1',
        title: '2 bed flat for sale in London',
        status: 'success',
        errorType: null,
        errorRetryable: false,
        markdown: '# 2 bed flat for sale\n\n£450,000\n\nLondon\n\n2 bedrooms\n1 bathroom\n\nThis bright apartment is close to transport, shops, parks, and schools. The listing includes a reception room, fitted kitchen, leasehold details, building amenities, nearby stations, viewing instructions, and agent notes. It is marketed as a property for sale with images, a guide price, and a full location description suitable for buyer research.',
        text: '2 bed flat for sale £450,000 London 2 bedrooms 1 bathroom This bright apartment is close to transport, shops, parks, and schools. The listing includes a reception room, fitted kitchen, leasehold details, building amenities, nearby stations, viewing instructions, and agent notes. It is marketed as a property for sale with images, a guide price, and a full location description suitable for buyer research.',
        images: [{ src: 'https://example.com/photo.jpg', alt: 'flat', width: null, height: null, dataSrc: null, loading: null }],
        structuredData: [],
        commerceData: [],
        forms: [],
        links: [],
        headings: [{ level: 1, text: '2 bed flat for sale' }],
        emails: [],
        phones: [],
    });

    assert.equal(result.verdict, 'ready');
    assert.equal(result.readyForExtraction, true);
    assert.equal(result.recommendedNextStep.action, 'run-contract-extraction');
    assert.ok(result.score >= 70);
    assert.deepEqual(result.blockers, []);
    assert.deepEqual(result.missingReadinessSignals, ['structured-data-signal', 'contact-signal']);
    assert.ok(result.signals.some((signal) => signal.name === 'price-signal'));
});

test('diagnostic marks successful product content as ready', () => {
    const result = diagnoseContractReadiness(productContract, {
        url: 'https://example.com/products/headphones',
        title: 'Noise-cancelling headphones with travel case',
        status: 'success',
        errorType: null,
        errorRetryable: false,
        markdown: '# Noise-cancelling headphones\n\n$299\n\nIn stock\n\nAdd to cart\n\nThis product page includes brand information, model details, Bluetooth features, battery life, active noise cancellation, shipping information, warranty details, customer review summaries, comparison notes, package contents, and product images. It is presented as a purchasable item with visible price and availability details for catalog extraction.',
        text: 'Noise-cancelling headphones $299 In stock Add to cart This product page includes brand information, model details, Bluetooth features, battery life, active noise cancellation, shipping information, warranty details, customer review summaries, comparison notes, package contents, and product images. It is presented as a purchasable item with visible price and availability details for catalog extraction.',
        images: [{ src: 'https://example.com/photo.jpg', alt: 'headphones', width: null, height: null, dataSrc: null, loading: null }],
        structuredData: [],
        commerceData: [{ name: 'Noise-cancelling headphones', price: '$299', currency: 'USD', availability: 'InStock', rating: '4.6', reviewCount: '120', brand: 'Example Audio', sku: 'HP-299' }],
        forms: [],
        links: [],
        headings: [{ level: 1, text: 'Noise-cancelling headphones' }],
        emails: [],
        phones: [],
    });

    assert.equal(result.verdict, 'ready');
    assert.equal(result.readyForExtraction, true);
    assert.equal(result.recommendedNextStep.action, 'run-contract-extraction');
    assert.ok(result.score >= 70);
    assert.ok(result.signals.some((signal) => signal.name === 'price-signal'));
    assert.ok(result.signals.some((signal) => signal.name === 'availability-signal'));
});

test('diagnostic marks blocked pages as not ready with branchable blocker', () => {
    const result = diagnoseContractReadiness(contract, {
        url: 'https://example.com/listing/blocked',
        title: null,
        status: 'error',
        errorType: 'blocked-bot',
        errorRetryable: false,
        markdown: null,
        text: null,
        images: [],
        structuredData: [],
        commerceData: [],
        forms: [],
        links: [],
        headings: [],
        emails: [],
        phones: [],
    });

    assert.equal(result.verdict, 'blocked');
    assert.equal(result.readyForExtraction, false);
    assert.equal(result.recommendedNextStep.action, 'do-not-automate');
    assert.deepEqual(result.blockers, ['blocked-bot']);
    assert.ok(result.score < 40);
});

test('diagnostic marks thin content as needs review', () => {
    const result = diagnoseContractReadiness(contract, {
        url: 'https://example.com/listing/thin',
        title: 'Listing',
        status: 'success',
        errorType: null,
        errorRetryable: false,
        markdown: 'Listing',
        text: 'Listing',
        images: [],
        structuredData: [],
        commerceData: [],
        forms: [],
        links: [],
        headings: [],
        emails: [],
        phones: [],
    });

    assert.equal(result.verdict, 'needs-review');
    assert.equal(result.readyForExtraction, false);
    assert.equal(result.recommendedNextStep.action, 'manual-review');
    assert.ok(result.warnings.includes('thin-content'));
});

test('diagnostic summary reports workflow readiness across multiple URLs', () => {
    const ready = diagnoseContractReadiness(contract, {
        url: 'https://example.com/listing/ready',
        title: '2 bed flat for sale in London',
        status: 'success',
        errorType: null,
        errorRetryable: false,
        markdown: '# 2 bed flat for sale\n\n£450,000\n\nLondon\n\n2 bedrooms\n1 bathroom\n\nThis bright apartment is close to transport, shops, parks, and schools. The listing includes a reception room, fitted kitchen, leasehold details, building amenities, nearby stations, viewing instructions, and agent notes. It is marketed as a property for sale with images, a guide price, and a full location description suitable for buyer research.',
        text: '2 bed flat for sale £450,000 London 2 bedrooms 1 bathroom This bright apartment is close to transport, shops, parks, and schools. The listing includes a reception room, fitted kitchen, leasehold details, building amenities, nearby stations, viewing instructions, and agent notes. It is marketed as a property for sale with images, a guide price, and a full location description suitable for buyer research.',
        images: [{ src: 'https://example.com/photo.jpg', alt: 'flat', width: null, height: null, dataSrc: null, loading: null }],
        structuredData: [],
        commerceData: [],
        forms: [],
        links: [],
        headings: [{ level: 1, text: '2 bed flat for sale' }],
        emails: [],
        phones: [],
    });
    const blocked = diagnoseContractReadiness(contract, {
        url: 'https://example.com/listing/blocked',
        title: null,
        status: 'error',
        errorType: 'rate-limit',
        errorRetryable: true,
        markdown: null,
        text: null,
        images: [],
        structuredData: [],
        commerceData: [],
        forms: [],
        links: [],
        headings: [],
        emails: [],
        phones: [],
    });

    const summary = summarizeContractDiagnostics([ready, blocked]);

    assert.equal(summary.totalUrls, 2);
    assert.equal(summary.readyUrls, 1);
    assert.equal(summary.blockedUrls, 1);
    assert.equal(summary.workflowVerdict, 'mixed');
    assert.equal(summary.recommendedNextStep.action, 'extract-ready-subset');
    assert.deepEqual(summary.blockersByType, { 'rate-limit': 1 });
    assert.equal(summary.missingReadinessSignals['content-volume'], 1);
    assert.equal(summary.missingReadinessSignals['title-signal'], 1);
    assert.equal(summary.missingReadinessSignals['contact-signal'], 2);
});

test('diagnostic report renders buyer-readable summary without raw signal evidence', () => {
    const ready = diagnoseContractReadiness(contract, {
        url: 'https://example.com/listing/ready',
        title: '2 bed flat for sale in London',
        status: 'success',
        errorType: null,
        errorRetryable: false,
        markdown: '# 2 bed flat for sale\n\n£450,000\n\nLondon\n\n2 bedrooms\n1 bathroom\n\nThis bright apartment is close to transport, shops, parks, and schools. The listing includes a reception room, fitted kitchen, leasehold details, building amenities, nearby stations, viewing instructions, and agent notes. It is marketed as a property for sale with images, a guide price, and a full location description suitable for buyer research.',
        text: '2 bed flat for sale £450,000 London 2 bedrooms 1 bathroom This bright apartment is close to transport, shops, parks, and schools. The listing includes a reception room, fitted kitchen, leasehold details, building amenities, nearby stations, viewing instructions, and agent notes. It is marketed as a property for sale with images, a guide price, and a full location description suitable for buyer research.',
        images: [{ src: 'https://example.com/photo.jpg', alt: 'flat', width: null, height: null, dataSrc: null, loading: null }],
        structuredData: [],
        commerceData: [],
        forms: [],
        links: [],
        headings: [{ level: 1, text: '2 bed flat for sale' }],
        emails: [],
        phones: [],
    });
    const summary = summarizeContractDiagnostics([ready]);
    const report = renderContractDiagnosticReport({
        generatedAt: '2026-05-20T00:00:00.000Z',
        contract,
        summary,
        diagnostics: [ready],
    });

    assert.match(report, /TheCrawler Extraction Readiness Report/);
    assert.match(report, /Workflow Verdict/);
    assert.match(report, /Readiness Gaps/);
    assert.match(report, /Missing readiness signals/);
    assert.match(report, /run-contract-extraction/);
    assert.match(report, /https:\/\/example\.com\/listing\/ready/);
    assert.doesNotMatch(report, /£450,000/);
});
