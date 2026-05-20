/**
 * LLM-powered structured extraction for TheCrawler.
 *
 * Pipeline: crawl URL → clean markdown → send (markdown + schema/prompt) to an
 * OpenAI-compatible chat-completions endpoint → parse JSON response → return.
 *
 * Endpoint-agnostic: works with llama.cpp's `llama-server`, vLLM, LM Studio,
 * Ollama, OpenAI proper, and anything else exposing /v1/chat/completions.
 */

import { crawl } from './engine.js';
import type { CrawlOptions, CrawlErrorType } from './types.js';

export interface LlmConfig {
    /**
     * Full chat-completions URL, e.g. 'http://your-llm-host:8080/v1/chat/completions'
     * or 'https://api.openai.com/v1/chat/completions'.
     */
    baseUrl: string;
    /** Model name string the server expects (e.g. 'gpt-4o-mini' or a .gguf filename). */
    model: string;
    /** Optional Bearer token. */
    apiKey?: string;
    /** Default 0 (deterministic). Higher = more creative but less reliable for extraction. */
    temperature?: number;
    /** Cap on response length. Default 4000. */
    maxTokens?: number;
    /** Per-request LLM timeout in seconds. Default 120 (extraction can be slow on big models). */
    timeoutSecs?: number;
}

export interface ExtractOptions {
    /** URL(s) to extract from. Each becomes one LLM call. */
    urls: string[];
    /**
     * JSON Schema describing the desired output shape. The LLM is instructed to
     * return ONLY JSON matching this schema. Either `jsonSchema` or `prompt` (or
     * both) is required.
     */
    jsonSchema?: object;
    /**
     * Natural-language extraction instruction (e.g. "Extract the product name,
     * price, currency, availability"). Used alongside or instead of jsonSchema.
     */
    prompt?: string;
    /** OpenAI-compatible inference endpoint config. */
    llm: LlmConfig;
    /**
     * How much of the page markdown to send to the LLM. Default 30000 chars
     * (≈7.5k tokens). Bigger = more context but slower and more $$ on hosted APIs.
     */
    markdownCharLimit?: number;
    /**
     * Crawl options to forward to the underlying crawl. extractMarkdown is
     * always forced true regardless of this setting.
     */
    crawlOptions?: Omit<CrawlOptions, 'urls' | 'extractMarkdown'>;
}

export type ExtractErrorType =
    | CrawlErrorType                  // crawl failed before extraction could run
    | 'llm-timeout'
    | 'llm-network'
    | 'llm-http-error'
    | 'llm-empty-response'
    | 'json-parse-error'
    | 'no-page-content';

export interface ExtractResult {
    url: string;
    /** Parsed JSON object the LLM returned. Null on failure. */
    data: unknown | null;
    status: 'success' | 'error';
    error: string | null;
    errorType: ExtractErrorType | null;
    /** Raw LLM response text (helpful for debugging parse failures). */
    rawResponse: string | null;
    /** Token usage if the server reported it. */
    promptTokens: number | null;
    completionTokens: number | null;
    /** End-to-end milliseconds: crawl + LLM call. */
    responseTimeMs: number;
    crawlMs: number | null;
    llmMs: number | null;
}

function buildSystemMessage(opts: ExtractOptions): string {
    const parts: string[] = [];
    parts.push(
        'You extract structured data from web page content. Return ONLY a single JSON object — no prose, no markdown fences, no commentary. If a requested field cannot be determined from the content, set it to null.',
    );
    if (opts.jsonSchema) {
        parts.push('The JSON object must conform to this JSON Schema:');
        parts.push(JSON.stringify(opts.jsonSchema, null, 2));
    }
    if (opts.prompt) {
        parts.push('Additional extraction instruction:');
        parts.push(opts.prompt);
    }
    return parts.join('\n\n');
}

function buildUserMessage(url: string, markdown: string, charLimit: number): string {
    const trimmed = markdown.length > charLimit
        ? markdown.slice(0, charLimit) + `\n\n[content truncated at ${charLimit} chars]`
        : markdown;
    return `URL: ${url}\n\nPage content (markdown):\n\n${trimmed}`;
}

async function callLlm(
    llm: LlmConfig,
    systemMsg: string,
    userMsg: string,
    jsonSchema?: object,
): Promise<{ content: string; promptTokens: number | null; completionTokens: number | null }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), (llm.timeoutSecs ?? 120) * 1000);
    try {
        const responseFormatFor = (responseFormatType: 'json_schema' | 'json_object' | 'text') => {
            if (responseFormatType === 'json_schema') {
                return {
                    type: 'json_schema',
                    json_schema: {
                        name: 'extraction_schema',
                        schema: jsonSchema,
                    },
                };
            }
            return { type: responseFormatType };
        };
        const body = (responseFormatType: 'json_schema' | 'json_object' | 'text') => JSON.stringify({
            model: llm.model,
            messages: [
                { role: 'system', content: systemMsg },
                { role: 'user', content: userMsg },
            ],
            response_format: responseFormatFor(responseFormatType),
            temperature: llm.temperature ?? 0,
            max_tokens: llm.maxTokens ?? 4000,
        });
        const primaryFormat = jsonSchema ? 'json_schema' : 'json_object';

        let r = await fetch(llm.baseUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(llm.apiKey ? { Authorization: `Bearer ${llm.apiKey}` } : {}),
            },
            body: body(primaryFormat),
            signal: controller.signal,
        });
        if (!r.ok) {
            const txt = await r.text().catch(() => '');
            if (r.status === 400 && (txt.includes('response_format') || txt.includes('json_schema'))) {
                r = await fetch(llm.baseUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        ...(llm.apiKey ? { Authorization: `Bearer ${llm.apiKey}` } : {}),
                    },
                    body: body('text'),
                    signal: controller.signal,
                });
                if (r.ok) {
                    const j = await r.json() as any;
                    const content = j?.choices?.[0]?.message?.content ?? '';
                    return {
                        content,
                        promptTokens: j?.usage?.prompt_tokens ?? null,
                        completionTokens: j?.usage?.completion_tokens ?? null,
                    };
                }
                const retryTxt = await r.text().catch(() => '');
                throw new Error(`LLM HTTP ${r.status}: ${retryTxt.slice(0, 500)}`);
            }
            throw new Error(`LLM HTTP ${r.status}: ${txt.slice(0, 500)}`);
        }
        const j = await r.json() as any;
        const content = j?.choices?.[0]?.message?.content ?? '';
        return {
            content,
            promptTokens: j?.usage?.prompt_tokens ?? null,
            completionTokens: j?.usage?.completion_tokens ?? null,
        };
    } finally {
        clearTimeout(timer);
    }
}

function classifyLlmError(err: any): ExtractErrorType {
    const m = String(err?.message || err || '').toLowerCase();
    if (m.includes('aborted') || m.includes('timeout')) return 'llm-timeout';
    if (m.includes('http ')) return 'llm-http-error';
    if (m.includes('fetch failed') || m.includes('econnrefused') || m.includes('enotfound')) return 'llm-network';
    return 'llm-network';
}

/**
 * Extract structured data from one or more URLs using an LLM.
 *
 * @example
 * const r = await extract({
 *   urls: ['https://example.com/product/123'],
 *   jsonSchema: { type: 'object', properties: { name: {type:'string'}, price: {type:'number'} } },
 *   llm: { baseUrl: 'http://your-llm-host:8080/v1/chat/completions', model: 'qwen3.5-122b' },
 * });
 */
export async function extract(options: ExtractOptions): Promise<ExtractResult[]> {
    if (!options.jsonSchema && !options.prompt) {
        throw new Error('extract() requires either jsonSchema or prompt (or both).');
    }
    if (!options.urls?.length) {
        throw new Error('extract() requires non-empty urls array.');
    }
    if (!options.llm?.baseUrl || !options.llm?.model) {
        throw new Error('extract() requires llm.baseUrl and llm.model.');
    }

    const systemMsg = buildSystemMessage(options);
    const charLimit = options.markdownCharLimit ?? 30000;
    const results: ExtractResult[] = [];

    // Process URLs sequentially. Parallelizing would hammer the LLM and a slow
    // single model call already dominates total time per URL.
    for (const url of options.urls) {
        const startTotal = Date.now();
        let crawlMs: number | null = null;

        // 1. Crawl the URL to get clean markdown.
        const startCrawl = Date.now();
        const crawlRes = await crawl({
            ...(options.crawlOptions ?? {}),
            urls: [url],
            extractMarkdown: true,
        });
        crawlMs = Date.now() - startCrawl;
        const page = crawlRes.pages[0];

        if (!page) {
            results.push({
                url, data: null, status: 'error',
                error: 'crawl returned no result', errorType: 'unknown',
                rawResponse: null, promptTokens: null, completionTokens: null,
                responseTimeMs: Date.now() - startTotal, crawlMs, llmMs: null,
            });
            continue;
        }

        if (page.status === 'error' || !page.markdown) {
            results.push({
                url: page.url, data: null, status: 'error',
                error: page.error ?? 'no markdown extracted from page',
                errorType: page.markdown ? page.errorType : 'no-page-content',
                rawResponse: null, promptTokens: null, completionTokens: null,
                responseTimeMs: Date.now() - startTotal, crawlMs, llmMs: null,
            });
            continue;
        }

        // 2. Call the LLM with the page markdown.
        const userMsg = buildUserMessage(page.url, page.markdown, charLimit);
        const startLlm = Date.now();
        let raw = '';
        let promptTokens: number | null = null;
        let completionTokens: number | null = null;
        try {
            const llmResp = await callLlm(options.llm, systemMsg, userMsg, options.jsonSchema);
            raw = llmResp.content;
            promptTokens = llmResp.promptTokens;
            completionTokens = llmResp.completionTokens;
        } catch (err: any) {
            results.push({
                url: page.url, data: null, status: 'error',
                error: err?.message || String(err),
                errorType: classifyLlmError(err),
                rawResponse: null, promptTokens: null, completionTokens: null,
                responseTimeMs: Date.now() - startTotal, crawlMs, llmMs: Date.now() - startLlm,
            });
            continue;
        }
        const llmMs = Date.now() - startLlm;

        if (!raw.trim()) {
            results.push({
                url: page.url, data: null, status: 'error',
                error: 'LLM returned empty response',
                errorType: 'llm-empty-response',
                rawResponse: raw, promptTokens, completionTokens,
                responseTimeMs: Date.now() - startTotal, crawlMs, llmMs,
            });
            continue;
        }

        // 3. Parse the LLM's JSON response. Some servers wrap JSON in markdown fences
        // even with response_format set; strip those defensively.
        const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
        let parsed: unknown;
        try {
            parsed = JSON.parse(cleaned);
        } catch (err: any) {
            results.push({
                url: page.url, data: null, status: 'error',
                error: `JSON parse failed: ${err.message}`,
                errorType: 'json-parse-error',
                rawResponse: raw, promptTokens, completionTokens,
                responseTimeMs: Date.now() - startTotal, crawlMs, llmMs,
            });
            continue;
        }

        results.push({
            url: page.url, data: parsed, status: 'success',
            error: null, errorType: null, rawResponse: raw,
            promptTokens, completionTokens,
            responseTimeMs: Date.now() - startTotal, crawlMs, llmMs,
        });
    }

    return results;
}
