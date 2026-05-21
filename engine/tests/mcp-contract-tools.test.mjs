import test from 'node:test';
import assert from 'node:assert/strict';

import {
    getMcpToolDefinitions,
    handleMcpToolCall,
} from '../dist/mcp-tools.js';

test('MCP exposes validated extraction contract tools for agent clients', () => {
    const names = getMcpToolDefinitions().map((tool) => tool.name);

    assert.ok(names.includes('list_extraction_contracts'));
    assert.ok(names.includes('diagnose_extraction_contract'));
    assert.ok(names.includes('extract_extraction_contract'));
});

test('MCP contract list returns discoverable contract metadata', async () => {
    const response = await handleMcpToolCall('list_extraction_contracts', {});
    const payload = JSON.parse(response.content[0].text);

    assert.deepEqual(payload.contracts.map((contract) => contract.name), ['real-estate-listing']);
    assert.equal(payload.contracts[0].domain, 'real-estate');
    assert.deepEqual(payload.contracts[0].requiredFields, ['title', 'price', 'location', 'sourceUrl']);
});

test('MCP contract extraction reports LLM configuration before crawling', async () => {
    const response = await handleMcpToolCall('extract_extraction_contract', {
        urls: ['https://example.com/listing/1'],
        contractName: 'real-estate-listing',
    });
    const payload = JSON.parse(response.content[0].text);

    assert.equal(response.isError, true);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /LLM not configured/);
});
