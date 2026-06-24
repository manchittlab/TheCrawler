import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const execFileAsync = promisify(execFile);

function runCli(args) {
    return execFileSync(process.execPath, ['dist/cli.js', ...args], {
        cwd: new URL('..', import.meta.url),
        encoding: 'utf8',
    });
}

async function runCliAsync(args) {
    const { stdout } = await execFileAsync(process.execPath, ['dist/cli.js', ...args], {
        cwd: new URL('..', import.meta.url),
        encoding: 'utf8',
    });
    return stdout;
}

test('CLI version matches package version', () => {
    assert.equal(runCli(['--version']).trim(), pkg.version);
});

test('CLI lists built-in extraction contracts', () => {
    const output = runCli(['extract', '--list-contracts']);
    assert.match(output, /docs-page/);
    assert.match(output, /real-estate-listing/);
    assert.match(output, /product-page/);
});

test('extract help exposes contract and evidence options', () => {
    const output = runCli(['extract', '--help']);
    assert.match(output, /--contract <name>/);
    assert.match(output, /--evidence-output <file>/);
});

test('diagnose help exposes contract readiness command', () => {
    const output = runCli(['diagnose', '--help']);
    assert.match(output, /contract extraction readiness/i);
    assert.match(output, /--contract <name>/);
    assert.match(output, /--report <file>/);
    assert.match(output, /<urls\.\.\.>/);
});

test('diagnose parses explicit numeric options that have defaults', async () => {
    const server = createServer((_req, res) => {
        res.setHeader('content-type', 'text/html; charset=utf-8');
        const details = 'Demo product with a clear title, price, stock status, SKU, and checkout action. '.repeat(12);
        res.end(`<html><title>Demo Product</title><body><h1>Demo Product</h1><p>${details}</p><p>Price: $19.99</p><p>In stock</p><p>SKU: DEMO-1</p><button>Add to cart</button></body></html>`);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        const { port } = server.address();
        const dir = mkdtempSync(join(tmpdir(), 'thecrawler-cli-'));
        const outputFile = join(dir, 'diagnose.json');
        await runCliAsync([
            'diagnose',
            `http://127.0.0.1:${port}/product`,
            '--contract',
            'product-page',
            '--timeout',
            '5',
            '--retries',
            '1',
            '--output',
            outputFile,
        ]);
        const payload = JSON.parse(readFileSync(outputFile, 'utf8'));
        assert.equal(payload.diagnostics.length, 1);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});
