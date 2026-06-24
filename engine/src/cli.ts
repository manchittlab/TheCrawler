#!/usr/bin/env node

import { Command, InvalidArgumentError } from 'commander';
import { crawl, crawlStream, parseSitemap } from './engine.js';
import { extract } from './extract.js';
import { attachContractValidation, getExtractionContract, listExtractionContracts } from './contracts.js';
import { diagnoseContractReadiness, renderContractDiagnosticReport, summarizeContractDiagnostics } from './diagnostics.js';
import type { CrawlOptions } from './types.js';
import { writeFileSync, readFileSync } from 'node:fs';

const program = new Command();

function readPackageVersion(): string {
    try {
        const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
        return pkg.version ?? '0.0.0';
    } catch {
        return '0.0.0';
    }
}

function parseIntegerOption(value: string): number {
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) {
        throw new InvalidArgumentError(`Expected an integer, received "${value}".`);
    }
    return parsed;
}

program
    .name('thecrawler')
    .description('Web scraper, PDF/DOCX parser, LLM-ready markdown. Structured errors, UA rotation, retry, optional in-memory cache.')
    .version(readPackageVersion());

// --- crawl command ---
program
    .command('crawl')
    .description('Scrape one or more URLs')
    .argument('<urls...>', 'URLs to scrape (space-separated)')
    .option('-o, --output <file>', 'Write JSON output to file (default: stdout)')
    .option('--markdown', 'Extract markdown (Turndown + GFM)', false)
    .option('--chunks <size>', 'Enable LLM/RAG chunking with this char size', parseIntegerOption)
    .option('--playwright', 'Use Playwright for JS rendering', false)
    .option('--adaptive', 'Auto-detect SPAs, Playwright fallback', false)
    .option('--depth <n>', 'Follow links to this depth (0 = no follow)', parseIntegerOption, 0)
    .option('--max-pages <n>', 'Max pages to scrape', parseIntegerOption, 100)
    .option('--proxy <url>', 'Proxy URL (http://user:pass@host:port)')
    .option('--headers <json>', 'Custom headers as JSON string')
    .option('--css <selector>', 'Extract only content matching CSS selector')
    .option('--no-text', 'Skip text extraction')
    .option('--no-links', 'Skip link extraction')
    .option('--no-images', 'Skip image extraction')
    .option('--no-meta', 'Skip meta tag extraction')
    .option('--screenshot', 'Take full-page screenshot (Playwright only)', false)
    .option('--retries <n>', 'Retry transient failures (5xx, network, timeout) this many times', parseIntegerOption, 3)
    .option('--timeout <secs>', 'Per-request timeout in seconds', parseIntegerOption, 30)
    .option('--no-rotate-ua', 'Disable User-Agent rotation (uses default UA)')
    .option('--cache', 'Enable in-memory LRU cache (TTL 5min)', false)
    .option('--json-lines', 'Output one JSON object per line (streaming)', false)
    .action(async (urls: string[], opts) => {
        const options: CrawlOptions = {
            urls,
            extractText: opts.text !== false,
            extractLinks: opts.links !== false,
            extractImages: opts.images !== false,
            extractMeta: opts.meta !== false,
            extractMarkdown: opts.markdown,
            chunkSize: opts.chunks || 0,
            usePlaywright: opts.playwright,
            adaptiveCrawling: opts.adaptive,
            maxDepth: opts.depth,
            maxPages: opts.maxPages,
            proxyUrl: opts.proxy,
            customHeaders: opts.headers ? JSON.parse(opts.headers) : {},
            cssSelector: opts.css,
            screenshotFullPage: opts.screenshot,
            requestRetries: opts.retries,
            requestTimeoutSecs: opts.timeout,
            rotateUserAgent: opts.rotateUa,
            cache: opts.cache ? { enabled: true } : undefined,
            onStoreValue: async (key, buffer, _ct) => {
                const path = `${key}.png`;
                writeFileSync(path, buffer);
                console.error(`Screenshot saved: ${path}`);
                return path;
            },
        };

        if (opts.jsonLines) {
            await crawlStream(options, (page) => {
                process.stdout.write(JSON.stringify(page) + '\n');
            });
        } else {
            const result = await crawl(options);
            const output = JSON.stringify(result, null, 2);
            if (opts.output) {
                writeFileSync(opts.output, output);
                console.error(`Output written to ${opts.output} (${result.totalScraped} pages, ${result.durationMs}ms)`);
            } else {
                process.stdout.write(output + '\n');
            }
        }
    });

// --- search command ---
program
    .command('search')
    .description('Search Google and scrape the results')
    .argument('<query>', 'Search query')
    .option('-n, --limit <n>', 'Number of results to scrape', parseIntegerOption, 10)
    .option('-o, --output <file>', 'Write JSON output to file')
    .option('--markdown', 'Extract markdown', false)
    .option('--serpapi <key>', 'SerpAPI key for reliable results')
    .option('--json-lines', 'One JSON per line', false)
    .action(async (query: string, opts) => {
        const options: CrawlOptions = {
            searchQuery: query,
            searchLimit: opts.limit,
            serpApiKey: opts.serpapi,
            extractMarkdown: opts.markdown,
        };

        if (opts.jsonLines) {
            await crawlStream(options, (page) => { process.stdout.write(JSON.stringify(page) + '\n'); });
        } else {
            const result = await crawl(options);
            const output = JSON.stringify(result, null, 2);
            if (opts.output) { writeFileSync(opts.output, output); console.error(`Output: ${opts.output}`); }
            else { process.stdout.write(output + '\n'); }
        }
    });

// --- sitemap command ---
program
    .command('sitemap')
    .description('Crawl URLs from a sitemap.xml')
    .argument('<url>', 'Sitemap URL')
    .option('-n, --max-pages <n>', 'Max pages to scrape', parseIntegerOption, 100)
    .option('-o, --output <file>', 'Write JSON output to file')
    .option('--markdown', 'Extract markdown', false)
    .option('--list-only', 'Only list URLs without scraping', false)
    .option('--json-lines', 'One JSON per line', false)
    .action(async (url: string, opts) => {
        if (opts.listOnly) {
            const urls = await parseSitemap(url);
            for (const u of urls) console.log(u);
            console.error(`\n${urls.length} URLs found`);
            return;
        }

        const options: CrawlOptions = {
            sitemapUrl: url,
            maxPages: opts.maxPages,
            extractMarkdown: opts.markdown,
        };

        if (opts.jsonLines) {
            await crawlStream(options, (page) => { process.stdout.write(JSON.stringify(page) + '\n'); });
        } else {
            const result = await crawl(options);
            const output = JSON.stringify(result, null, 2);
            if (opts.output) { writeFileSync(opts.output, output); console.error(`Output: ${opts.output}`); }
            else { process.stdout.write(output + '\n'); }
        }
    });

// --- markdown command (shortcut) ---
program
    .command('md')
    .description('Extract markdown from a URL (shortcut for crawl --markdown)')
    .argument('<url>', 'URL to extract markdown from')
    .option('--chunks <size>', 'Enable chunking', parseIntegerOption)
    .option('--playwright', 'Use Playwright', false)
    .action(async (url: string, opts) => {
        const result = await crawl({
            urls: [url],
            extractMarkdown: true,
            extractText: false, extractLinks: false, extractImages: false,
            extractHeadings: false, extractTables: false, extractEmails: false, extractPhones: false,
            chunkSize: opts.chunks || 0,
            usePlaywright: opts.playwright,
        });
        const page = result.pages[0];
        if (page?.markdown) {
            process.stdout.write(page.markdown + '\n');
        } else {
            console.error(`Error: ${page?.error || 'No markdown output'}`);
            process.exit(1);
        }
    });

// --- extract command (LLM-powered structured extraction) ---
program
    .command('extract')
    .description('LLM-powered structured extraction. Crawls each URL, sends the markdown to an OpenAI-compatible LLM, returns parsed typed JSON matching your schema or prompt.')
    .argument('[urls...]', 'URLs to extract from (space-separated)')
    .option('--schema <json>', 'JSON Schema as inline JSON string (use --schema-file for a file)')
    .option('--schema-file <path>', 'Read JSON Schema from this file path')
    .option('--prompt <text>', 'Natural-language extraction instruction (alternative or supplement to --schema)')
    .option('--contract <name>', `Use a built-in extraction contract (${listExtractionContracts().join(', ')})`)
    .option('--list-contracts', 'List built-in extraction contracts and exit', false)
    .option('--llm-base-url <url>', 'OpenAI-compatible chat-completions URL (default: $THECRAWLER_LLM_BASEURL)')
    .option('--llm-model <name>', 'Model name (default: $THECRAWLER_LLM_MODEL)')
    .option('--llm-api-key <key>', 'Optional bearer token (default: $THECRAWLER_LLM_API_KEY)')
    .option('--temperature <n>', 'LLM temperature (0 = deterministic)', parseFloat, 0)
    .option('--max-tokens <n>', 'Max LLM response tokens', parseIntegerOption, 4000)
    .option('--markdown-char-limit <n>', 'Max chars of page markdown sent to the LLM', parseIntegerOption, 30000)
    .option('--playwright', 'Use Playwright for JS rendering during crawl', false)
    .option('-o, --output <file>', 'Write JSON output to file (default: stdout)')
    .option('--evidence-output <file>', 'Write contract evidence JSON with validation results')
    .action(async (urls: string[] = [], opts) => {
        if (opts.listContracts) {
            process.stdout.write(JSON.stringify(listExtractionContracts(), null, 2) + '\n');
            return;
        }
        if (!urls.length) {
            console.error('Error: extract requires at least one URL unless --list-contracts is used.');
            process.exit(1);
        }
        if (opts.evidenceOutput && !opts.contract) {
            console.error('Error: --evidence-output requires --contract so validation evidence has a contract to check against.');
            process.exit(1);
        }
        const contract = opts.contract ? getExtractionContract(opts.contract) : null;
        const baseUrl = opts.llmBaseUrl || process.env.THECRAWLER_LLM_BASEURL;
        const model = opts.llmModel || process.env.THECRAWLER_LLM_MODEL;
        if (!baseUrl || !model) {
            console.error('Error: missing LLM endpoint config. Set --llm-base-url + --llm-model, or env vars THECRAWLER_LLM_BASEURL + THECRAWLER_LLM_MODEL.');
            process.exit(1);
        }
        let jsonSchema: object | undefined;
        if (opts.schemaFile) {
            try { jsonSchema = JSON.parse(readFileSync(opts.schemaFile, 'utf8')); }
            catch (e: any) { console.error(`Error reading --schema-file: ${e.message}`); process.exit(1); }
        } else if (opts.schema) {
            try { jsonSchema = JSON.parse(opts.schema); }
            catch (e: any) { console.error(`Error parsing --schema JSON: ${e.message}`); process.exit(1); }
        }
        if (contract && jsonSchema) {
            console.error('Error: --contract supplies its own schema. Remove --schema/--schema-file or run without --contract.');
            process.exit(1);
        }
        if (!jsonSchema && contract) {
            jsonSchema = contract.schema;
        }
        const prompt = contract && opts.prompt
            ? `${contract.prompt}\n\nAdditional user instruction:\n${opts.prompt}`
            : contract?.prompt ?? opts.prompt;
        if (!jsonSchema && !prompt) {
            console.error('Error: extract requires either --schema, --schema-file, or --prompt.');
            process.exit(1);
        }
        const results = await extract({
            urls,
            jsonSchema,
            prompt,
            markdownCharLimit: opts.markdownCharLimit,
            crawlOptions: { usePlaywright: opts.playwright },
            llm: {
                baseUrl,
                model,
                apiKey: opts.llmApiKey || process.env.THECRAWLER_LLM_API_KEY || undefined,
                temperature: opts.temperature,
                maxTokens: opts.maxTokens,
            },
        });
        const finalResults = contract ? attachContractValidation(contract, results) : results;
        const output = JSON.stringify(finalResults, null, 2);
        if (opts.output) {
            writeFileSync(opts.output, output);
            console.error(`Output: ${opts.output} (${finalResults.length} results)`);
        } else {
            process.stdout.write(output + '\n');
        }
        if (opts.evidenceOutput && contract) {
            const evidence = {
                generatedAt: new Date().toISOString(),
                contract: {
                    name: contract.name,
                    domain: contract.domain,
                    version: contract.version,
                    requiredFields: contract.requiredFields,
                },
                results: finalResults,
            };
            writeFileSync(opts.evidenceOutput, JSON.stringify(evidence, null, 2));
            console.error(`Evidence: ${opts.evidenceOutput}`);
        }
    });

// --- diagnose command (no-LLM contract readiness) ---
program
    .command('diagnose')
    .description('Diagnose contract extraction readiness for one or more URLs without calling an LLM.')
    .argument('<urls...>', 'URLs to diagnose')
    .option('--contract <name>', `Built-in extraction contract (${listExtractionContracts().join(', ')})`, 'real-estate-listing')
    .option('--playwright', 'Use Playwright for JS rendering during crawl', false)
    .option('--adaptive', 'Auto-detect SPAs, Playwright fallback', true)
    .option('--timeout <secs>', 'Per-request timeout in seconds', parseIntegerOption, 30)
    .option('--retries <n>', 'Retry transient failures this many times', parseIntegerOption, 1)
    .option('-o, --output <file>', 'Write diagnostic JSON to file (default: stdout)')
    .option('--report <file>', 'Write buyer-readable Markdown diagnostic report')
    .action(async (urls: string[], opts) => {
        const contract = getExtractionContract(opts.contract);
        const result = await crawl({
            urls,
            extractMarkdown: true,
            adaptiveCrawling: opts.adaptive,
            usePlaywright: opts.playwright,
            requestTimeoutSecs: opts.timeout,
            requestRetries: opts.retries,
        });
        if (result.pages.length === 0) {
            console.error('Error: crawl returned no page results.');
            process.exit(1);
        }
        const diagnostics = result.pages.map((page) => diagnoseContractReadiness(contract, page));
        const generatedAt = new Date().toISOString();
        const summary = summarizeContractDiagnostics(diagnostics);
        const payload = {
            generatedAt,
            contract: {
                name: contract.name,
                domain: contract.domain,
                version: contract.version,
            },
            summary,
            diagnostics,
        };
        const output = JSON.stringify(payload, null, 2);
        if (opts.output) {
            writeFileSync(opts.output, output);
            console.error(`Diagnostic: ${opts.output}`);
        } else {
            process.stdout.write(output + '\n');
        }
        if (opts.report) {
            const report = renderContractDiagnosticReport({
                generatedAt,
                contract,
                summary,
                diagnostics,
            });
            writeFileSync(opts.report, report);
            console.error(`Report: ${opts.report}`);
        }
    });

program.parse();
