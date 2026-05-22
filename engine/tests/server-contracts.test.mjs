import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

function listen(server) {
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve(server.address().port);
        });
    });
}

function getFreePort() {
    const server = createServer();
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            server.close(() => resolve(port));
        });
    });
}

async function waitForHealth(port, apiKey) {
    const deadline = Date.now() + 15000;
    let lastError;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`http://127.0.0.1:${port}/v1/health`, {
                headers: { Authorization: `Bearer ${apiKey}` },
            });
            if (response.ok) return;
        } catch (error) {
            lastError = error;
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw lastError ?? new Error('API server did not become ready');
}

async function postJson(port, path, apiKey, body) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });
    return { response, payload: await response.json() };
}

test('REST API exposes contract discovery and diagnostic-first contract flow', async () => {
    const apiKey = 'server-contract-test-key';
    const productHtml = `<!doctype html>
        <html>
        <head>
            <title>Noise-cancelling headphones with travel case</title>
            <script type="application/ld+json">
            {
                "@context": "https://schema.org",
                "@type": "Product",
                "name": "Noise-cancelling headphones",
                "brand": {"@type": "Brand", "name": "Example Audio"},
                "sku": "HP-299",
                "offers": {"@type": "Offer", "price": "299", "priceCurrency": "USD", "availability": "https://schema.org/InStock"},
                "aggregateRating": {"@type": "AggregateRating", "ratingValue": "4.6", "reviewCount": "120"}
            }
            </script>
        </head>
        <body>
            <h1>Noise-cancelling headphones</h1>
            <p>$299</p>
            <p>In stock. Add to cart for checkout.</p>
            <p>Brand: Example Audio. Model HP-299. This product page includes Bluetooth features,
            active noise cancellation, battery life, shipping details, warranty notes, customer review
            summaries, comparison notes, package contents, product images, and other catalog content
            suitable for product-page extraction workflows. The page repeats enough buyer-facing
            product information for the readiness diagnostic to avoid thin-content behavior.</p>
            <img src="/headphones.jpg" alt="Noise-cancelling headphones">
        </body>
        </html>`;
    const fixtureServer = createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(productHtml);
    });
    const fixturePort = await listen(fixtureServer);

    const apiPort = await getFreePort();
    const api = spawn(process.execPath, ['dist/server.js', '--port', String(apiPort)], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            THECRAWLER_API_KEY: apiKey,
            CRAWLEE_STORAGE_DIR: `./storage/test-server-${Date.now()}`,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
        await waitForHealth(apiPort, apiKey);

        const unauthenticated = await fetch(`http://127.0.0.1:${apiPort}/v1/contracts`);
        assert.equal(unauthenticated.status, 401);

        const contractsResponse = await fetch(`http://127.0.0.1:${apiPort}/v1/contracts?includeSchema=true`, {
            headers: { Authorization: `Bearer ${apiKey}` },
        });
        assert.equal(contractsResponse.status, 200);
        const contracts = await contractsResponse.json();
        assert.deepEqual(contracts.contracts.map((contract) => contract.name), ['product-page', 'real-estate-listing']);
        assert.equal(contracts.contracts[0].schema.type, 'object');

        const { response: missingLlmResponse, payload: missingLlmPayload } = await postJson(
            apiPort,
            '/v1/extract-contract',
            apiKey,
            { urls: [`http://127.0.0.1:${fixturePort}/product`], contractName: 'product-page' },
        );
        assert.equal(missingLlmResponse.status, 400);
        assert.match(missingLlmPayload.error, /Missing LLM config/);

        const { response: diagnoseResponse, payload: diagnostic } = await postJson(
            apiPort,
            '/v1/diagnose',
            apiKey,
            {
                urls: [`http://127.0.0.1:${fixturePort}/product`],
                contractName: 'product-page',
                reportMarkdown: true,
            },
        );
        assert.equal(diagnoseResponse.status, 200);
        assert.equal(diagnostic.contract.name, 'product-page');
        assert.equal(diagnostic.summary.totalUrls, 1);
        assert.equal(diagnostic.summary.workflowVerdict, 'ready');
        assert.equal(diagnostic.diagnostics[0].readyForExtraction, true);
        assert.match(diagnostic.reportMarkdown, /TheCrawler Extraction Readiness Report/);
        assert.doesNotMatch(diagnostic.reportMarkdown, /HP-299/);
    } finally {
        api.kill();
        fixtureServer.close();
    }
});
