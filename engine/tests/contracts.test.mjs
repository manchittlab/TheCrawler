import test from 'node:test';
import assert from 'node:assert/strict';

import {
    getExtractionContract,
    listExtractionContracts,
    validateContractData,
} from '../dist/contracts.js';

test('real-estate contract is discoverable with required extraction fields', () => {
    assert.deepEqual(listExtractionContracts(), ['docs-page', 'product-page', 'real-estate-listing']);

    const contract = getExtractionContract('real-estate-listing');
    assert.equal(contract.name, 'real-estate-listing');
    assert.equal(contract.domain, 'real-estate');
    assert.deepEqual(contract.requiredFields, ['title', 'price', 'location', 'sourceUrl']);
    assert.equal(contract.schema.properties.price.type, 'object');
});

test('docs-page contract is discoverable with public documentation fields', () => {
    const contract = getExtractionContract('docs-page');

    assert.equal(contract.name, 'docs-page');
    assert.equal(contract.domain, 'documentation');
    assert.deepEqual(contract.requiredFields, ['title', 'summary', 'sourceUrl']);
    assert.equal(contract.schema.properties.apiEndpoints.type, 'array');
    assert.equal(contract.schema.properties.codeExamples.type, 'array');
    assert.match(contract.prompt, /public documentation page/);
    assert.match(contract.prompt, /Do not extract contributor identities/);
});

test('product-page contract is discoverable with required extraction fields', () => {
    const contract = getExtractionContract('product-page');

    assert.equal(contract.name, 'product-page');
    assert.equal(contract.domain, 'ecommerce');
    assert.deepEqual(contract.requiredFields, ['name', 'price', 'sourceUrl']);
    assert.equal(contract.schema.properties.price.type, 'object');
});

test('contract validation accepts docs-page public summary evidence', () => {
    const contract = getExtractionContract('docs-page');

    const result = validateContractData(contract, {
        title: 'REST API issues documentation',
        summary: 'Explains public issue endpoints and request parameters.',
        sourceUrl: 'https://docs.example.com/rest/issues',
        headings: ['List issues', 'Create an issue'],
    });

    assert.equal(result.valid, true);
    assert.deepEqual(result.missingRequiredFields, []);
});

test('contract validation reports missing required fields without discarding data', () => {
    const contract = getExtractionContract('real-estate-listing');

    const result = validateContractData(contract, {
        title: '2 BHK apartment near metro',
        price: { amount: null, currency: null, raw: null },
        sourceUrl: 'https://example.com/listing/123',
    });

    assert.equal(result.valid, false);
    assert.deepEqual(result.missingRequiredFields, ['price', 'location']);
    assert.equal(result.data.title, '2 BHK apartment near metro');
});

test('contract validation accepts product price raw text when numeric amount is unavailable', () => {
    const contract = getExtractionContract('product-page');

    const result = validateContractData(contract, {
        name: 'Noise-cancelling headphones',
        price: { amount: null, currency: null, raw: '$299' },
        sourceUrl: 'https://example.com/products/headphones',
    });

    assert.equal(result.valid, true);
    assert.deepEqual(result.missingRequiredFields, []);
});

test('contract validation accepts nested price raw text when numeric amount is unavailable', () => {
    const contract = getExtractionContract('real-estate-listing');

    const result = validateContractData(contract, {
        title: 'Downtown loft',
        price: { amount: null, currency: null, raw: '$2,500/mo' },
        location: { raw: 'Austin, TX' },
        sourceUrl: 'https://example.com/listing/456',
    });

    assert.equal(result.valid, true);
    assert.deepEqual(result.missingRequiredFields, []);
});
