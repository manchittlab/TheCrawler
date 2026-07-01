/**
 * Discover-then-extract: propose the fields a page actually offers, so a no-code
 * user picks from real headers instead of guessing field names blind.
 *
 * Two layers:
 *  - proposeFieldsFromPage(page): DETERMINISTIC — fields from JSON-LD / microdata /
 *    commerce data / OpenGraph / meta / table headers already parsed by the engine.
 *    No LLM, no network. Pure + unit-testable.
 *  - discoverFields(page, {llm}): deterministic + an optional bounded LLM pass that
 *    proposes additional fields the structured data missed, each with a SHORT sample.
 *
 * PRIVACY RULE (anti-farming): we return field NAMES + SHORT truncated samples only,
 * never a full extracted record — otherwise free discovery would be a free one-page
 * dataset. Samples are clipped and LLM-proposed samples are verified against the page
 * (a sample the LLM invented is blanked, the field name is kept).
 */

import type { PageData } from './types.js';
import type { LlmConfig } from './extract.js';

export type FieldSource = 'json-ld' | 'microdata' | 'commerce' | 'opengraph' | 'meta' | 'table' | 'llm';

export interface DiscoveredField {
    /** Field key the user can extract (lowercase-ish label). */
    name: string;
    /** SHORT sample value (clipped) so the user sees it's real — never a full record. */
    sample: string;
    /** Where the candidate came from. */
    source: FieldSource;
}

export interface DiscoverResult {
    url: string;
    /** Whether the page is one record (a product) or a list of items (a catalog). */
    recordType: 'single' | 'listing';
    /** For a listing: how many items were detected on the page (best-effort). */
    itemCount: number | null;
    fields: DiscoveredField[];
    /** Which engine actually rendered the page ('playwright' = JS executed → SPA-safe). */
    engine: 'cheerio' | 'playwright';
    /** Convenience mirror: did we render with a headless browser? */
    rendered: boolean;
    /** False when the page couldn't be read usefully (blocked / empty SPA / error). */
    readable: boolean;
    /** Human-readable reason when not readable, else null. */
    note: string | null;
}

const SAMPLE_MAX = 80;
const MAX_FIELDS = 24;

/** Clip a sample to SAMPLE_MAX chars (collapse whitespace first). Never throws, never returns a full record. */
function clip(value: unknown, max = SAMPLE_MAX): string {
    if (value === null || value === undefined) return '';
    let s: string;
    try { s = typeof value === 'object' ? JSON.stringify(value) : String(value); }
    catch { return ''; } // circular / un-stringifiable → no sample
    if (typeof s !== 'string') return ''; // JSON.stringify can return undefined (e.g. a function)
    s = s.replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** Normalize a field name for de-duplication (lowercase, collapse spaces/underscores). */
function normName(name: string): string {
    return name.toLowerCase().replace(/[_\s]+/g, ' ').trim();
}

/** Add a candidate if its (normalized) name isn't already present. First writer wins. */
function addField(map: Map<string, DiscoveredField>, name: string, sample: unknown, source: FieldSource): void {
    const clean = name.replace(/[_]+/g, ' ').trim();
    if (!clean) return;
    const key = normName(clean);
    if (key === '@context' || key === '@type' || key.startsWith('@')) return;
    if (map.has(key)) {
        // Upgrade an empty sample if a later source has one (keeps the original source tag).
        const existing = map.get(key)!;
        if (!existing.sample) {
            const s = clip(sample);
            if (s) existing.sample = s;
        }
        return;
    }
    map.set(key, { name: clean, sample: clip(sample), source });
}

/** Flatten a JSON-LD value into the object(s) that carry extractable scalar props. */
function jsonLdObjects(node: unknown, out: Record<string, unknown>[], depth = 0): void {
    if (!node || depth > 4) return;
    if (Array.isArray(node)) { for (const n of node) jsonLdObjects(n, out, depth + 1); return; }
    if (typeof node === 'object') {
        const obj = node as Record<string, unknown>;
        if (Array.isArray(obj['@graph'])) { jsonLdObjects(obj['@graph'], out, depth + 1); return; }
        out.push(obj);
    }
}

const COMMERCE_FIELDS: { key: keyof PageData['commerceData'][number]; label: string }[] = [
    { key: 'name', label: 'name' },
    { key: 'price', label: 'price' },
    { key: 'currency', label: 'currency' },
    { key: 'availability', label: 'availability' },
    { key: 'rating', label: 'rating' },
    { key: 'reviewCount', label: 'review count' },
    { key: 'brand', label: 'brand' },
    { key: 'sku', label: 'sku' },
];

const OG_LABELS: Record<string, string> = {
    title: 'title', description: 'description', image: 'image', site_name: 'site name',
    type: 'type', url: 'url', price: 'price', 'price:amount': 'price', 'price:currency': 'currency',
};

/**
 * Deterministic field proposal from already-parsed structured signals. No LLM.
 */
export function proposeFieldsFromPage(page: PageData): DiscoverResult {
    const engine = page.engine ?? 'cheerio';
    const rendered = page.usedPlaywright === true || engine === 'playwright';

    if (page.status === 'error') {
        return {
            url: page.url, recordType: 'single', itemCount: null, fields: [],
            engine, rendered, readable: false,
            note: page.error ? `Couldn't read this page: ${page.error}` : "Couldn't read this page.",
        };
    }

    const map = new Map<string, DiscoveredField>();
    let recordType: 'single' | 'listing' = 'single';
    let itemCount: number | null = null;
    const markListing = (n: number) => { recordType = 'listing'; itemCount = Math.max(itemCount ?? 0, n); };

    // 1. Commerce data (highest-signal for products) — first-class fields.
    const commerce = page.commerceData ?? [];
    if (commerce.length > 1) markListing(commerce.length);
    for (const item of commerce) {
        for (const { key, label } of COMMERCE_FIELDS) {
            const v = item[key];
            if (v !== null && v !== undefined && String(v).trim()) addField(map, label, v, 'commerce');
        }
    }

    // 2. JSON-LD (schema.org) — flatten @graph / arrays, propose scalar props.
    const ldObjects: Record<string, unknown>[] = [];
    jsonLdObjects(page.structuredData ?? [], ldObjects);
    for (const obj of ldObjects) {
        const list = obj['itemListElement'];
        if (Array.isArray(list) && list.length > 1) markListing(list.length);
        for (const [k, v] of Object.entries(obj)) {
            if (k.startsWith('@')) continue;
            if (v === null || v === undefined) continue;
            if (Array.isArray(v)) {
                if (v.length > 1 && k.toLowerCase().includes('item')) markListing(v.length);
                continue; // arrays of nested objects are noisy — skip in the deterministic pass
            }
            if (typeof v === 'object') continue; // one level only
            if (String(v).trim()) addField(map, k, v, 'json-ld');
        }
    }

    // 3. Microdata — property keys.
    const micro = page.microdata ?? [];
    if (micro.length > 1) markListing(micro.length);
    for (const m of micro) {
        for (const [k, v] of Object.entries(m.properties ?? {})) {
            if (v && String(v).trim()) addField(map, k, v, 'microdata');
        }
    }

    // 4. OpenGraph — friendly-named common fields.
    for (const [k, v] of Object.entries(page.openGraph ?? {})) {
        if (!v || !String(v).trim()) continue;
        const label = OG_LABELS[k.toLowerCase()] ?? k;
        addField(map, label, v, 'opengraph');
    }

    // 5. Meta (description/author/keywords) — only if not already covered.
    const meta = page.meta ?? {};
    for (const k of ['description', 'author', 'keywords']) {
        if (meta[k] && String(meta[k]).trim()) addField(map, k, meta[k], 'meta');
    }

    // 6. Table headers (catalog/spec tables) — each header is a candidate field.
    // NB: row count is NOT a listing signal — a 2-column key/value spec table has
    // many rows but describes ONE record. Listing is decided only by commerce /
    // JSON-LD ItemList / microdata item counts above.
    for (const table of page.tables ?? []) {
        const headers = table.headers ?? [];
        const firstRow = table.rows?.[0] ?? [];
        headers.forEach((h, i) => { if (h && h.trim()) addField(map, h, firstRow[i], 'table'); });
    }

    // 7. Always-useful fallbacks from basic page metadata (concrete, not vague).
    if (page.title && page.title.trim()) addField(map, 'title', page.title, 'meta');
    if (page.description && page.description.trim()) addField(map, 'description', page.description, 'meta');

    const fields = [...map.values()].slice(0, MAX_FIELDS);

    // Readable = we got real content to work with (some fields OR substantive text).
    const textLen = (page.markdown?.length ?? 0) + (page.text?.length ?? 0);
    const readable = fields.length > 0 || textLen >= 200;
    const note = readable ? null
        : 'This page looks empty or JS-only — we couldn’t read usable content from it.';

    return { url: page.url, recordType, itemCount, fields, engine, rendered, readable, note };
}

// --- LLM augmentation -------------------------------------------------------

interface ProposeLlmResult {
    fields: { name: string; sample?: string }[];
    recordType?: 'single' | 'listing';
    itemCount?: number;
}

/** Minimal chat-completions call for field proposal (operator endpoint — plain fetch). */
async function callProposeLlm(llm: LlmConfig, systemMsg: string, userMsg: string): Promise<ProposeLlmResult | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), (llm.timeoutSecs ?? 60) * 1000);
    const schema = {
        type: 'object',
        properties: {
            fields: {
                type: 'array',
                items: { type: 'object', properties: { name: { type: 'string' }, sample: { type: 'string' } }, required: ['name'] },
            },
            recordType: { type: 'string', enum: ['single', 'listing'] },
            itemCount: { type: 'number' },
        },
        required: ['fields'],
    };
    const post = (responseFormat: object) => fetch(llm.baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(llm.apiKey ? { Authorization: `Bearer ${llm.apiKey}` } : {}) },
        body: JSON.stringify({
            model: llm.model,
            messages: [{ role: 'system', content: systemMsg }, { role: 'user', content: userMsg }],
            response_format: responseFormat,
            temperature: llm.temperature ?? 0,
            max_tokens: llm.maxTokens ?? 1200,
        }),
        signal: controller.signal,
    });
    try {
        let r = await post({ type: 'json_schema', json_schema: { name: 'discover_fields', schema } });
        if (!r.ok) {
            const txt = await r.text().catch(() => '');
            if (r.status === 400 && (txt.includes('response_format') || txt.includes('json_schema'))) {
                r = await post({ type: 'json_object' });
            }
            if (!r.ok) return null;
        }
        const j = await r.json() as { choices?: { message?: { content?: string } }[] };
        const content = j?.choices?.[0]?.message?.content ?? '';
        const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
        if (!cleaned) return null;
        const parsed = JSON.parse(cleaned) as ProposeLlmResult;
        if (!parsed || !Array.isArray(parsed.fields)) return null;
        return parsed;
    } catch {
        return null; // discovery degrades to the deterministic fields — never throws
    } finally {
        clearTimeout(timer);
    }
}

/** NFKD-deaccent + lowercase + collapse whitespace (for the sample-grounding check). */
function norm(s: string): string {
    return s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Full discovery: deterministic fields + an optional LLM pass that proposes more.
 * The LLM never overrides deterministic fields; its samples are verified against the
 * page (an invented sample is blanked, the field kept). Degrades gracefully — if the
 * LLM is absent or errors, you still get the deterministic fields.
 */
export async function discoverFields(
    page: PageData,
    opts: { llm?: LlmConfig; markdownCharLimit?: number } = {},
): Promise<DiscoverResult> {
    const base = proposeFieldsFromPage(page);
    if (!base.readable || !opts.llm || !page.markdown) return base;

    const charLimit = opts.markdownCharLimit ?? 12000;
    const md = page.markdown.length > charLimit ? page.markdown.slice(0, charLimit) : page.markdown;
    const existing = base.fields.map((f) => f.name).join(', ');
    const systemMsg =
        'You inspect web page content and list the distinct data fields a user could extract from it. '
        + 'Return ONLY JSON: {"fields":[{"name":"<short lowercase field label>","sample":"<the actual short value from the page, max 80 chars, or empty>"}],"recordType":"single|listing","itemCount":<number>}. '
        + 'Propose at most 12 fields. Only fields whose value is actually present in the content. '
        + 'Use the real value from the page as the sample — never invent one. Do not repeat fields already known. '
        + 'Set recordType to "listing" only if the page is clearly a list/catalog of multiple comparable items (with itemCount = how many), else "single".';
    const userMsg =
        `Already-known fields (do not repeat): ${existing || '(none)'}\n\n`
        + `Page URL: ${page.url}\n\nPage content (markdown):\n\n${md}`;

    const llmRes = await callProposeLlm(opts.llm, systemMsg, userMsg);
    if (!llmRes) return base;

    // Source text for sample grounding (page the model saw + title/description).
    const srcNorm = norm([page.title, page.description, md].filter(Boolean).join(' '));
    const map = new Map<string, DiscoveredField>();
    for (const f of base.fields) map.set(normName(f.name), f);
    for (const f of llmRes.fields) {
        if (!f?.name || typeof f.name !== 'string') continue;
        const key = normName(f.name);
        if (!key || key.startsWith('@') || map.has(key)) continue;
        let sample = clip(f.sample ?? '');
        // Anti-hallucination: blank ANY non-empty sample we can't find on the page
        // (incl. a 1-char invention) — keep the field name, drop the unverifiable sample.
        if (sample) {
            const ns = norm(sample.replace(/…$/, ''));
            if (!ns || !srcNorm.includes(ns)) sample = '';
        }
        map.set(key, { name: f.name.replace(/[_]+/g, ' ').trim(), sample, source: 'llm' });
        if (map.size >= MAX_FIELDS) break;
    }

    // The LLM may upgrade the record type ONLY when the deterministic pass found no
    // listing signal (a real catalog with no structured data). A confident commerce /
    // ItemList / microdata listing from the deterministic pass stays authoritative.
    let recordType = base.recordType;
    let itemCount = base.itemCount;
    if (recordType === 'single' && llmRes.recordType === 'listing') {
        recordType = 'listing';
        itemCount = typeof llmRes.itemCount === 'number' && llmRes.itemCount > 1 ? Math.floor(llmRes.itemCount) : null;
    }
    return { ...base, recordType, itemCount, fields: [...map.values()].slice(0, MAX_FIELDS) };
}
