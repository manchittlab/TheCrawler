import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function runCli(args) {
    return execFileSync(process.execPath, ['dist/cli.js', ...args], {
        cwd: new URL('..', import.meta.url),
        encoding: 'utf8',
    });
}

test('CLI version matches package version', () => {
    assert.equal(runCli(['--version']).trim(), pkg.version);
});

test('CLI lists built-in extraction contracts', () => {
    const output = runCli(['extract', '--list-contracts']);
    assert.match(output, /real-estate-listing/);
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
