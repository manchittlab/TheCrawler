import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

import {
    getMcpToolDefinitions,
    handleMcpToolCall,
} from '../dist/mcp-tools.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function listen(server) {
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve(server.address().port);
        });
    });
}

test('MCP exposes validated extraction contract tools for agent clients', () => {
    const names = getMcpToolDefinitions().map((tool) => tool.name);

    assert.ok(names.includes('list_extraction_contracts'));
    assert.ok(names.includes('diagnose_extraction_contract'));
    assert.ok(names.includes('extract_extraction_contract'));
});

test('MCP contract list returns discoverable contract metadata', async () => {
    const response = await handleMcpToolCall('list_extraction_contracts', {});
    const payload = JSON.parse(response.content[0].text);

    assert.deepEqual(payload.contracts.map((contract) => contract.name), ['docs-page', 'product-page', 'real-estate-listing']);
    assert.equal(payload.contracts[0].domain, 'documentation');
    assert.deepEqual(payload.contracts[0].requiredFields, ['title', 'summary', 'sourceUrl']);
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
    const fixture = createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><title>MCP fixture</title><main><h1>MCP fixture</h1><p>Local markdown fixture for stdio transport.</p></main>');
    });
    const fixturePort = await listen(fixture);
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

    const deadline = Date.now() + 30000;
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
            arguments: { url: `http://127.0.0.1:${fixturePort}/fixture` },
        },
    });

    while (Date.now() < deadline) {
        if (stdoutLines.some((line) => JSON.parse(line).id === 2)) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }

    child.kill();
    fixture.close();

    const parsed = stdoutLines.map((line) => JSON.parse(line));
    const initializeResponse = parsed.find((message) => message.id === 1);
    assert.ok(initializeResponse);
    assert.equal(initializeResponse.result.serverInfo.version, pkg.version);
    assert.ok(parsed.some((message) => message.id === 2));
    assert.ok(stdoutLines.every((line) => line.trim().startsWith('{')));
});
