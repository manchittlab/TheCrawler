import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { extract } from '../dist/index.js';

function listen(server) {
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
}

function close(server) {
    return new Promise((resolve, reject) => {
        server.close((err) => err ? reject(err) : resolve());
    });
}

test('extract retries with text response_format when LM Studio rejects json_object', async () => {
    let llmCalls = 0;
    const pageServer = createServer((_, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><head><title>Flat for sale</title></head><body><h1>2 bed flat for sale</h1><p>£450,000 in London.</p></body></html>');
    });
    const llmServer = createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        const parsed = JSON.parse(body);
        llmCalls += 1;

        if (parsed.response_format?.type === 'json_object') {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: "'response_format.type' must be 'json_schema' or 'text'" }));
            return;
        }

        assert.equal(parsed.response_format?.type, 'text');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ title: '2 bed flat for sale' }) } }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
        }));
    });

    const pagePort = await listen(pageServer);
    const llmPort = await listen(llmServer);
    try {
        const results = await extract({
            urls: [`http://127.0.0.1:${pagePort}/listing`],
            prompt: 'Extract the listing title as JSON.',
            llm: {
                baseUrl: `http://127.0.0.1:${llmPort}/v1/chat/completions`,
                model: 'qwen/qwen3.5-9b',
                timeoutSecs: 5,
            },
            crawlOptions: { requestTimeoutSecs: 5 },
        });

        assert.equal(llmCalls, 2);
        assert.equal(results[0].status, 'success');
        assert.deepEqual(results[0].data, { title: '2 bed flat for sale' });
    } finally {
        await close(pageServer);
        await close(llmServer);
    }
});

test('extract uses json_schema response_format when a schema is available', async () => {
    let requestedFormat = null;
    const pageServer = createServer((_, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><body><h1>2 bed flat for sale</h1><p>£450,000 in London.</p></body></html>');
    });
    const llmServer = createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        const parsed = JSON.parse(body);
        requestedFormat = parsed.response_format;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ title: '2 bed flat for sale' }) } }],
        }));
    });

    const pagePort = await listen(pageServer);
    const llmPort = await listen(llmServer);
    try {
        const schema = { type: 'object', properties: { title: { type: 'string' } } };
        const results = await extract({
            urls: [`http://127.0.0.1:${pagePort}/listing`],
            jsonSchema: schema,
            llm: {
                baseUrl: `http://127.0.0.1:${llmPort}/v1/chat/completions`,
                model: 'qwen/qwen3.5-9b',
                timeoutSecs: 5,
            },
            crawlOptions: { requestTimeoutSecs: 5 },
        });

        assert.equal(requestedFormat.type, 'json_schema');
        assert.deepEqual(requestedFormat.json_schema.schema, schema);
        assert.equal(results[0].status, 'success');
    } finally {
        await close(pageServer);
        await close(llmServer);
    }
});
