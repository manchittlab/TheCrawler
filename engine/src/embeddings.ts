/**
 * RAG embeddings plumbing (S10 F5) — chunk → OpenAI-compatible /v1/embeddings requests
 * → ordered vectors. The shapers (`buildEmbeddingRequests` / `parseEmbeddingResponse`) are
 * PURE; `embedTexts` / `embedMarkdown` take an injectable `fetchImpl` so the whole path is
 * unit-tested WITHOUT a real endpoint. The actual embedding RUN against the on-prem box is
 * operator-gated — nothing here auto-runs it.
 */
import { chunkText } from './engine.js';

export interface EmbeddingConfig {
    /** OpenAI-compatible embeddings URL, e.g. http://host:8080/v1/embeddings */
    baseUrl: string;
    model: string;
    apiKey?: string;
    /** Texts per request. Default 16. */
    batchSize?: number;
    /** Per-request timeout seconds. Default 60. */
    timeoutSecs?: number;
}

export interface EmbeddingRequest { model: string; input: string[]; }
export interface EmbedResult { vectors: number[][]; model: string; dims: number; count: number; }

/** Split texts into batched OpenAI-compatible embedding request bodies. Pure. */
export function buildEmbeddingRequests(texts: string[], model: string, batchSize = 16): EmbeddingRequest[] {
    const bs = Math.max(1, Math.floor(batchSize) || 1);
    const reqs: EmbeddingRequest[] = [];
    for (let i = 0; i < texts.length; i += bs) reqs.push({ model, input: texts.slice(i, i + bs) });
    return reqs;
}

/** Extract ordered embedding vectors from an OpenAI-compatible response. Respects each
 *  item's `index` (OpenAI returns it) so order is preserved regardless of array order. Pure. */
export function parseEmbeddingResponse(json: unknown): number[][] {
    const data = (json as { data?: unknown } | null)?.data;
    if (!Array.isArray(data)) return [];
    return data
        .map((d, i) => {
            const o = (d ?? {}) as { embedding?: unknown; index?: number };
            return { index: typeof o.index === 'number' ? o.index : i, embedding: Array.isArray(o.embedding) ? (o.embedding as number[]) : [] };
        })
        .sort((a, b) => a.index - b.index)
        .map((r) => r.embedding);
}

/** Embed texts via an OpenAI-compatible endpoint. `fetchImpl` is injectable (tests pass a
 *  fake — never hits the box). Batches, preserves order, throws on a non-OK batch. */
export async function embedTexts(config: EmbeddingConfig, texts: string[], fetchImpl: typeof fetch = fetch): Promise<EmbedResult> {
    const reqs = buildEmbeddingRequests(texts, config.model, config.batchSize ?? 16);
    const vectors: number[][] = [];
    for (const body of reqs) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), (config.timeoutSecs ?? 60) * 1000);
        try {
            const res = await fetchImpl(config.baseUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
                body: JSON.stringify(body),
                signal: ctrl.signal,
            });
            if (!res.ok) throw new Error(`embeddings endpoint returned ${res.status}`);
            const batchVecs = parseEmbeddingResponse(await res.json());
            // A 200 with a missing/short `data` array would otherwise silently yield fewer
            // vectors than inputs (partial success). Enforce 1:1 → malformed = hard error (Codex F5).
            if (batchVecs.length !== body.input.length) {
                throw new Error(`embeddings response had ${batchVecs.length} vectors for ${body.input.length} inputs (malformed)`);
            }
            vectors.push(...batchVecs);
        } finally { clearTimeout(t); }
    }
    return { vectors, model: config.model, dims: vectors[0]?.length ?? 0, count: vectors.length };
}

/** Convenience: chunk markdown (engine `chunkText`) then embed each chunk. */
export async function embedMarkdown(
    config: EmbeddingConfig,
    markdown: string,
    opts: { chunkSize?: number; chunkOverlap?: number } = {},
    fetchImpl: typeof fetch = fetch,
): Promise<EmbedResult & { chunks: { text: string; index: number; section: string | null }[] }> {
    const chunks = chunkText(markdown, opts.chunkSize ?? 1200, opts.chunkOverlap ?? 200);
    const r = await embedTexts(config, chunks.map((c) => c.text), fetchImpl);
    return { ...r, chunks: chunks.map((c) => ({ text: c.text, index: c.index, section: c.section })) };
}
