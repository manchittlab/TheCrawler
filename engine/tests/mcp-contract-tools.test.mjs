import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

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

    assert.deepEqual(payload.contracts.map((contract) => contract.name), ['product-page', 'real-estate-listing']);
    assert.equal(payload.contracts[0].domain, 'ecommerce');
    assert.deepEqual(payload.contracts[0].requiredFields, ['name', 'price', 'sourceUrl']);
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

test('MCP stdio crawl response is not polluted by crawler log lines', async () => {
    const child = spawn(process.execPath, ['dist/mcp.js'], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            CRAWLEE_STORAGE_DIR: `./storage/test-mcp-${Date.now()}`,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdoutLines = [];
    let stdoutBuffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() ?? '';
        stdoutLines.push(...lines.filter(Boolean));
    });

    const send = (message) => {
        child.stdin.write(JSON.stringify(message) + '\n');
    };

    const deadline = Date.now() + 15000;
    send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'stdio-test', version: '0.0.0' },
        },
    });

    while (Date.now() < deadline) {
        if (stdoutLines.some((line) => JSON.parse(line).id === 1)) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }

    send({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: {},
    });
    send({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
            name: 'crawl_markdown',
            arguments: { url: 'https://example.com' },
        },
    });

    while (Date.now() < deadline) {
        if (stdoutLines.some((line) => JSON.parse(line).id === 2)) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }

    child.kill();

    const parsed = stdoutLines.map((line) => JSON.parse(line));
    assert.ok(parsed.some((message) => message.id === 1));
    assert.ok(parsed.some((message) => message.id === 2));
    assert.ok(stdoutLines.every((line) => line.trim().startsWith('{')));
});
