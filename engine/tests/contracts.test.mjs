import test from 'node:test';
import assert from 'node:assert/strict';

import {
    getExtractionContract,
    listExtractionContracts,
    validateContractData,
} from '../dist/contracts.js';

test('real-estate contract is discoverable with required extraction fields', () => {
    assert.deepEqual(listExtractionContracts(), ['real-estate-listing']);

    const contract = getExtractionContract('real-estate-listing');
    assert.equal(contract.name, 'real-estate-listing');
    assert.equal(contract.domain, 'real-estate');
    assert.deepEqual(contract.requiredFields, ['title', 'price', 'location', 'sourceUrl']);
    assert.equal(contract.schema.properties.price.type, 'object');
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
