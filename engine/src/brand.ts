/**
 * Brand-identity extraction helpers — deterministic palette, theme-color, and
 * logo ranking. Pure functions only: no DOM library, no network, no LLM.
 *
 * The engine (engine.ts) gathers raw inputs (meta theme-color, <style>/inline
 * CSS text, fetched stylesheet text, Playwright computed colors, candidate logo
 * URLs) and passes them here for normalization + ranking. Keeping this module
 * cheerio-free and side-effect-free makes it unit-testable and deterministic:
 * the same inputs always produce the same ordered output.
 */

export interface PaletteEntry {
    hex: string;
    role: string | null;
    source: string;
    weight: number;
}

export interface LogoEntry {
    url: string;
    source: string;
    type: string | null;
    /** Source-heuristic prior (stable across runs). NOT mutated by quality ranking. */
    confidence: number;
    /** Combined confidence × fetched-quality score after probing (set by rankLogosByQuality). Array is ordered by this. */
    score?: number;
}

/** One observed color before normalization/grouping. */
export interface ColorHit {
    /** Raw or normalized color string. */
    value: string;
    /** Where it came from (theme-color, css-var, inline, style-block, stylesheet, computed). */
    source: string;
    /** Base signal weight for this source. */
    weight: number;
}

interface RGBA { r: number; g: number; b: number; a: number; }
interface HSL { h: number; s: number; l: number; }

// Small named-color map limited to names that plausibly appear as brand colors.
// Full CSS named-color support is intentionally omitted (low value, large table).
const NAMED_COLORS: Record<string, string> = {
    black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000',
    blue: '#0000ff', yellow: '#ffff00', orange: '#ffa500', purple: '#800080',
    pink: '#ffc0cb', gray: '#808080', grey: '#808080', cyan: '#00ffff',
    magenta: '#ff00ff', teal: '#008080', navy: '#000080', maroon: '#800000',
    silver: '#c0c0c0', gold: '#ffd700', indigo: '#4b0082', violet: '#ee82ee',
};

// Sentinel keywords that are NOT real colors — never treat as brand colors.
const NON_COLOR_KEYWORDS = new Set([
    'transparent', 'currentcolor', 'inherit', 'initial', 'unset', 'none', 'revert', 'auto',
]);

function clamp(n: number, min: number, max: number): number {
    return n < min ? min : n > max ? max : n;
}

function round(n: number): number { return Math.round(n); }

function parseHexColor(s: string): RGBA | null {
    let h = s.trim().replace(/^#/, '');
    if (!/^[0-9a-fA-F]+$/.test(h)) return null;
    if (h.length === 3 || h.length === 4) {
        h = h.split('').map((c) => c + c).join('');
    }
    if (h.length !== 6 && h.length !== 8) return null;
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return { r, g, b, a };
}

function parseChannel(raw: string): number {
    const t = raw.trim();
    if (t.endsWith('%')) return clamp(round((parseFloat(t) / 100) * 255), 0, 255);
    return clamp(round(parseFloat(t)), 0, 255);
}

function parseAlpha(raw: string | undefined): number {
    if (raw == null) return 1;
    const t = raw.trim();
    if (t.endsWith('%')) return clamp(parseFloat(t) / 100, 0, 1);
    return clamp(parseFloat(t), 0, 1);
}

function parseRgbColor(s: string): RGBA | null {
    const m = s.trim().match(/^rgba?\(\s*([^)]+)\)$/i);
    if (!m) return null;
    // Support both comma syntax `rgb(1,2,3)` / `rgba(1,2,3,0.5)` and modern
    // slash syntax `rgb(1 2 3 / 0.5)`.
    const inner = m[1].replace(/\//g, ' / ');
    const slashParts = inner.split('/');
    const main = slashParts[0].trim().split(/[\s,]+/).filter(Boolean);
    const alphaRaw = slashParts[1] !== undefined ? slashParts[1] : main[3];
    if (main.length < 3) return null;
    const out = {
        r: parseChannel(main[0]),
        g: parseChannel(main[1]),
        b: parseChannel(main[2]),
        a: parseAlpha(alphaRaw),
    };
    if (![out.r, out.g, out.b, out.a].every(Number.isFinite)) return null;
    return out;
}

function hslToRgb(h: number, s: number, l: number): RGBA {
    h = ((h % 360) + 360) % 360 / 360;
    s = clamp(s, 0, 1);
    l = clamp(l, 0, 1);
    if (s === 0) {
        const v = round(l * 255);
        return { r: v, g: v, b: v, a: 1 };
    }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const hue = (t: number) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
    };
    return {
        r: round(hue(h + 1 / 3) * 255),
        g: round(hue(h) * 255),
        b: round(hue(h - 1 / 3) * 255),
        a: 1,
    };
}

function parseHslColor(s: string): RGBA | null {
    const m = s.trim().match(/^hsla?\(\s*([^)]+)\)$/i);
    if (!m) return null;
    const inner = m[1].replace(/\//g, ' / ');
    const slashParts = inner.split('/');
    const main = slashParts[0].trim().split(/[\s,]+/).filter(Boolean);
    const alphaRaw = slashParts[1] !== undefined ? slashParts[1] : main[3];
    if (main.length < 3) return null;
    const h = parseFloat(main[0]);
    const sv = parseFloat(main[1]) / 100;
    const lv = parseFloat(main[2]) / 100;
    if (!Number.isFinite(h) || !Number.isFinite(sv) || !Number.isFinite(lv)) return null;
    const alpha = parseAlpha(alphaRaw);
    if (!Number.isFinite(alpha)) return null;
    const rgb = hslToRgb(h, sv, lv);
    rgb.a = alpha;
    return rgb;
}

/**
 * Parse any supported CSS color into RGBA, or null if unparseable / not a real
 * color (var(), gradients, currentColor, transparent, etc. are rejected).
 */
export function parseColor(raw: string): RGBA | null {
    if (!raw) return null;
    const s = raw.trim().toLowerCase();
    if (!s || NON_COLOR_KEYWORDS.has(s)) return null;
    if (s.includes('var(') || s.includes('gradient(') || s.includes('url(')) return null;
    if (s.startsWith('#')) return parseHexColor(s);
    if (s.startsWith('rgb')) return parseRgbColor(s);
    if (s.startsWith('hsl')) return parseHslColor(s);
    if (NAMED_COLORS[s]) return parseHexColor(NAMED_COLORS[s]);
    return null;
}

function toHex(c: RGBA): string {
    const h = (n: number) => clamp(round(n), 0, 255).toString(16).padStart(2, '0');
    return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

function rgbToHsl(c: RGBA): HSL {
    const r = c.r / 255, g = c.g / 255, b = c.b / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let h = 0, s = 0;
    if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r: h = (g - b) / d + (g < b ? 6 : 0); break;
            case g: h = (b - r) / d + 2; break;
            default: h = (r - g) / d + 4; break;
        }
        h *= 60;
    }
    return { h, s, l };
}

/** Normalize any CSS color string to a 6-digit lowercase hex, or null. */
export function normalizeColor(raw: string): string | null {
    const cleaned = raw ? raw.replace(/\s*!\s*important\s*$/i, '').trim() : raw;
    const rgba = parseColor(cleaned);
    if (!rgba) return null;
    // Fully/mostly transparent colors carry no brand signal.
    if (rgba.a < 0.1) return null;
    return toHex(rgba);
}

/** RGB distance for near-duplicate merging (0..~441). */
function rgbDistance(a: RGBA, b: RGBA): number {
    return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}

const COLOR_TOKEN_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]{0,200}\)|hsla?\([^)]{0,200}\)/gi;
const ANY_VAR_DECL_RE = /(--[\w-]+)\s*:\s*([^;}{]{1,400})/gi;
const BRAND_VAR_RE = /^--(?:brand|primary|accent|theme|color|bg|background|surface|fg|foreground)[\w-]*$/i;
const VAR_REF_RE = /var\(\s*(--[\w-]+)\s*(?:,\s*([^)]{0,200}))?\)/i;

// Hard cap on CSS text we will scan, to bound work and avoid pathological input.
const MAX_CSS_SCAN_CHARS = 2_000_000;

/**
 * Build a custom-property map from CSS text, then resolve `var(--x[, fallback])`
 * references up to a few passes so `--brand: var(--primary)` resolves to a real
 * color. Returns the resolved name→value map.
 */
function buildCssVarMap(cssText: string): Map<string, string> {
    const map = new Map<string, string>();
    ANY_VAR_DECL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ANY_VAR_DECL_RE.exec(cssText)) !== null) {
        // Last declaration wins (closest to cascade end). Deterministic given input.
        map.set(m[1], m[2].trim());
    }
    // Resolve var() references, bounded passes to avoid cycles.
    for (let pass = 0; pass < 4; pass++) {
        let changed = false;
        for (const [k, v] of map) {
            const ref = v.match(VAR_REF_RE);
            if (ref) {
                const resolved = map.get(ref[1]) ?? (ref[2] ? ref[2].trim() : '');
                if (resolved && resolved !== v) { map.set(k, v.replace(VAR_REF_RE, resolved)); changed = true; }
            }
        }
        if (!changed) break;
    }
    return map;
}

/**
 * Scan a blob of CSS text for color tokens. CSS custom properties whose name
 * suggests a brand role are weighted higher than incidental color tokens, and
 * `var()` references are resolved first. Returns normalized hits.
 */
export function collectCssColors(cssText: string, sourceLabel: string, varWeight = 0.4, tokenWeight = 0.12): ColorHit[] {
    if (!cssText) return [];
    const css = cssText.length > MAX_CSS_SCAN_CHARS ? cssText.slice(0, MAX_CSS_SCAN_CHARS) : cssText;
    const hits: ColorHit[] = [];

    // High-signal: resolved brand-named custom properties.
    const varMap = buildCssVarMap(css);
    for (const [name, value] of varMap) {
        if (!BRAND_VAR_RE.test(name)) continue;
        const hex = normalizeColor(value);
        if (hex) hits.push({ value: hex, source: `${sourceLabel}:var${name}`, weight: varWeight });
    }

    // Lower-signal: every color token in the sheet.
    COLOR_TOKEN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = COLOR_TOKEN_RE.exec(css)) !== null) {
        const hex = normalizeColor(m[0]);
        if (hex) hits.push({ value: hex, source: sourceLabel, weight: tokenWeight });
    }
    return hits;
}

function isNeutral(hsl: HSL): boolean {
    return hsl.l > 0.93 || hsl.l < 0.07 || hsl.s < 0.12;
}

/**
 * Build a deterministic, ranked brand palette from observed color hits + the
 * theme-color. Drops near-white/black/gray (unless they equal the theme-color),
 * merges near-identical hexes (summing weight), and ranks by saturation × weight
 * with a stable hex tie-break. Returns { themeColor, palette(top 5) }.
 */
export function buildPalette(hits: ColorHit[], themeColorRaw: string | null): { themeColor: string | null; palette: PaletteEntry[] } {
    const themeColor = themeColorRaw ? normalizeColor(themeColorRaw) : null;

    // Group by exact normalized hex, summing weight, keeping the strongest source.
    const groups = new Map<string, { hex: string; weight: number; source: string; sourceWeight: number }>();
    const add = (hex: string, weight: number, source: string) => {
        const g = groups.get(hex);
        if (g) {
            g.weight += weight;
            // Deterministic source: higher weight wins; ties broken lexicographically.
            if (weight > g.sourceWeight || (weight === g.sourceWeight && source < g.source)) { g.source = source; g.sourceWeight = weight; }
        } else {
            groups.set(hex, { hex, weight, source, sourceWeight: weight });
        }
    };
    for (const hit of hits) {
        const hex = normalizeColor(hit.value);
        if (hex) add(hex, hit.weight, hit.source);
    }
    if (themeColor) add(themeColor, 0.5, 'theme-color');

    // Merge near-identical hexes into the higher-weight representative.
    const merged: { hex: string; weight: number; source: string; rgba: RGBA; hsl: HSL }[] = [];
    const sortedGroups = [...groups.values()].sort((a, b) => (b.weight - a.weight) || a.hex.localeCompare(b.hex));
    for (const g of sortedGroups) {
        const rgba = parseColor(g.hex)!;
        let mergedInto = false;
        for (const e of merged) {
            if (rgbDistance(rgba, e.rgba) < 16) {
                e.weight += g.weight;
                mergedInto = true;
                break;
            }
        }
        if (!mergedInto) merged.push({ hex: g.hex, weight: g.weight, source: g.source, rgba, hsl: rgbToHsl(rgba) });
    }

    // Per spec: drop near-white/black/gray unless they ARE the theme-color. But
    // keep neutrals aside so a monochrome brand (few/no chromatic colors) can
    // still surface a dark background + light surface candidate (Codex review).
    const isTheme = (hex: string) => hex === themeColor;
    const chromatic = merged.filter((e) => isTheme(e.hex) || !isNeutral(e.hsl));
    const neutrals = merged.filter((e) => !isTheme(e.hex) && isNeutral(e.hsl));

    // Rank: saturation × weight, descending; tie-break by hex ascending (stable).
    chromatic.sort((a, b) => {
        const sa = a.hsl.s * a.weight;
        const sb = b.hsl.s * b.weight;
        if (sb !== sa) return sb - sa;
        return a.hex.localeCompare(b.hex);
    });

    const top = chromatic.slice(0, 5);
    // Monochrome-brand fallback: ONLY when there is no chromatic brand color at
    // all, surface the strongest dark + light neutral as background/surface.
    if (top.length === 0 && neutrals.length) {
        const byWeight = (a: typeof neutrals[number], b: typeof neutrals[number]) => (b.weight - a.weight) || a.hex.localeCompare(b.hex);
        const dark = neutrals.filter((e) => e.hsl.l < 0.5).sort(byWeight)[0];
        const light = neutrals.filter((e) => e.hsl.l >= 0.5).sort(byWeight)[0];
        for (const n of [dark, light]) {
            if (n && !top.includes(n) && top.length < 5) top.push(n);
        }
    }

    // Best-effort role assignment.
    const palette: PaletteEntry[] = top.map((e) => ({
        hex: e.hex,
        role: null as string | null,
        source: e.source,
        weight: Number(e.weight.toFixed(3)),
    }));
    if (palette.length) {
        // Primary by INTENT, not raw chroma — a bright marketing accent (e.g. a cyan
        // badge) must not out-rank the real brand color (e.g. a deep indigo). Priority:
        //   1) theme-color  — an explicit brand declaration
        //   2) a --brand / --primary CSS custom property — named brand intent
        //   3) the top-ranked color (saturation × weight) — fallback when no signal
        // Only an EXPLICIT signal overrides the top-ranked pick, so sites that already
        // resolved correctly (theme-color/top-ranked) are unaffected.
        let primaryIdx = themeColor ? palette.findIndex((p) => p.hex === themeColor) : -1;
        if (primaryIdx < 0) primaryIdx = palette.findIndex((p) => /:var--(brand|primary)/i.test(p.source));
        if (primaryIdx < 0) primaryIdx = 0;
        palette[primaryIdx].role = 'primary';
        // background = darkest remaining; accent = most saturated remaining.
        let darkest = -1, darkestL = 2, accent = -1, accentS = -1;
        for (let i = 0; i < top.length; i++) {
            if (palette[i].role === 'primary') continue;
            if (top[i].hsl.l < darkestL) { darkestL = top[i].hsl.l; darkest = i; }
            if (top[i].hsl.s > accentS) { accentS = top[i].hsl.s; accent = i; }
        }
        if (darkest >= 0 && !palette[darkest].role) palette[darkest].role = 'background';
        if (accent >= 0 && !palette[accent].role) palette[accent].role = 'accent';
    }

    return { themeColor, palette };
}

/**
 * De-duplicate and rank logo candidates by confidence (desc), with a stable
 * tie-break on URL so re-runs are deterministic. Returns top 4.
 */
export function rankLogos(cands: LogoEntry[]): LogoEntry[] {
    const seen = new Map<string, LogoEntry>();
    for (const c of cands) {
        if (!c.url) continue;
        const existing = seen.get(c.url);
        if (!existing || c.confidence > existing.confidence) seen.set(c.url, c);
    }
    return [...seen.values()]
        .sort((a, b) => (b.confidence - a.confidence) || a.url.localeCompare(b.url))
        .slice(0, 4);
}

/** Fetched metadata for a logo candidate (null = unknown; probe may have failed). */
export interface LogoProbe {
    ok: boolean;
    bytes: number | null;
    contentType: string | null;
}

/**
 * Quality multiplier for a logo candidate from its fetched metadata, so the
 * source-confidence prior can't let a 16×16 favicon, a dead URL, or a non-image
 * outrank a real wordmark. Unknown metadata → near-neutral (never punish a failed
 * probe hard). Pure + deterministic.
 */
export function scoreLogoQuality(entry: LogoEntry, probe: LogoProbe | undefined): number {
    // data: URI (inline SVG) is vector + already in hand — strongest, no fetch needed.
    if (entry.url.startsWith('data:')) return 1.3;
    // A REMOTE svg/vector link earns the vector bonus ONLY if it actually probed OK —
    // a dead .svg must not outrank a live raster wordmark (Kimi catch).
    if (entry.type === 'svg') return (probe && probe.ok) ? 1.3 : 0.85;
    if (!probe || !probe.ok) return 0.85; // probe failed/skipped → mild discount, keep the prior
    const ct = (probe.contentType || '').toLowerCase();
    if (ct && !ct.startsWith('image/')) return 0.2; // HTML/redirect page, not an image
    let f = 1.0;
    const b = probe.bytes;
    if (b != null) {
        if (b < 300) f *= 0.3;            // favicon-tiny / 1×1 tracking pixel
        else if (b < 1000) f *= 0.7;
        else if (b <= 500_000) f *= 1.25; // healthy logo size
        else if (b <= 2_000_000) f *= 0.9;
        else f *= 0.5;                     // too big — likely a photo/hero, not a logo
    }
    if (ct.includes('svg')) f *= 1.3;
    else if (ct.includes('png') || ct.includes('webp')) f *= 1.15;
    else if (ct.includes('x-icon') || ct.includes('vnd.microsoft.icon')) f *= 0.6;
    return f;
}

/**
 * Final logo ranking: confidence × fetched-quality, dedupe by URL, top 4. The
 * returned `confidence` is the combined score so consumers see the adjusted order.
 */
export function rankLogosByQuality(cands: LogoEntry[], probes: Map<string, LogoProbe>): LogoEntry[] {
    const deduped = new Map<string, LogoEntry>();
    for (const c of cands) {
        if (!c.url) continue;
        const ex = deduped.get(c.url);
        if (!ex || c.confidence > ex.confidence) deduped.set(c.url, c);
    }
    return [...deduped.values()]
        .map((c) => ({ c, score: c.confidence * scoreLogoQuality(c, probes.get(c.url)) }))
        .sort((a, b) => (b.score - a.score) || a.c.url.localeCompare(b.c.url))
        .slice(0, 4)
        // Preserve source `confidence`; expose the combined ranking value as `score`.
        .map((x) => ({ ...x.c, score: Number(x.score.toFixed(3)) }));
}

// --- JSON-LD Organization prior (deterministic brand facts) ---

export interface BrandOrg {
    name: string | null;
    description: string | null;
    logo: string | null;
    socialLinks: string[];
}

// Known social hosts for sameAs → socialLinks (registrable host, www-stripped).
const ORG_SOCIAL_HOSTS = new Set([
    'twitter.com', 'x.com', 'linkedin.com', 'facebook.com', 'instagram.com',
    'youtube.com', 'youtu.be', 'github.com', 'tiktok.com', 'threads.net', 'bsky.app',
]);

/**
 * Deterministic brand profile from Organization/WebSite/Brand JSON-LD: name,
 * description, logo, and sameAs social links. A reliable PRIOR/validation for the
 * LLM brand-context contract (the model can hallucinate a name; schema.org can't).
 * Flattens `@graph`, prefers an Organization/Brand node, falls back to WebSite.
 * Returns null when no org-like node yields any field. Pure + deterministic.
 */
export function extractOrgFromJsonLd(structuredData: unknown[]): BrandOrg | null {
    if (!Array.isArray(structuredData) || structuredData.length === 0) return null;
    const nodes: Record<string, unknown>[] = [];
    const visit = (v: unknown, d: number) => {
        if (!v || typeof v !== 'object' || d > 6) return;
        if (Array.isArray(v)) { for (const x of v) visit(x, d + 1); return; }
        const o = v as Record<string, unknown>;
        nodes.push(o);
        if (Array.isArray(o['@graph'])) for (const g of o['@graph']) visit(g, d + 1);
    };
    for (const s of structuredData) visit(s, 0);

    const typeOf = (n: Record<string, unknown>): string[] => {
        const t = n['@type'];
        return Array.isArray(t) ? t.map(String) : (t ? [String(t)] : []);
    };
    const isOrg = (n: Record<string, unknown>) => typeOf(n).some((t) => /(?:^|.)Organization$|^(Corporation|LocalBusiness|NGO|Brand)$/i.test(t));
    const isWebSite = (n: Record<string, unknown>) => typeOf(n).some((t) => /^WebSite$/i.test(t));
    const org = nodes.find(isOrg) || nodes.find(isWebSite);
    if (!org) return null;

    const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
    const name = str(org.name) || str(org.alternateName) || str(org.legalName);
    const description = str(org.description) || str(org.disambiguatingDescription);

    let logo: string | null = null;
    const lg = (org.logo ?? org.image) as unknown;
    if (typeof lg === 'string') logo = str(lg);
    else if (Array.isArray(lg)) { const f = lg[0]; logo = typeof f === 'string' ? str(f) : str((f as Record<string, unknown>)?.url) || str((f as Record<string, unknown>)?.contentUrl); }
    else if (lg && typeof lg === 'object') logo = str((lg as Record<string, unknown>).url) || str((lg as Record<string, unknown>).contentUrl);

    const socials = new Set<string>();
    const sa = org.sameAs;
    const arr = Array.isArray(sa) ? sa : (typeof sa === 'string' ? [sa] : []);
    for (const u of arr) {
        if (typeof u !== 'string') continue;
        try { const h = new URL(u).hostname.toLowerCase().replace(/^www\./, ''); if (ORG_SOCIAL_HOSTS.has(h)) socials.add(u); } catch { /* skip bad url */ }
    }

    if (!name && !description && !logo && socials.size === 0) return null;
    return { name, description, logo, socialLinks: [...socials] };
}

// --- L4: logo pixel-color (dominant brand color from the logo image) ---

/**
 * Dominant chromatic color from decoded RGBA pixels (deterministic fixed-bin
 * counting): bins each pixel to 5 bits/channel, skips (semi-)transparent and
 * near-neutral pixels, returns the average hex of the most-populated bin (ties by
 * lowest bin key). Pure — the caller decodes the image and passes raw pixels.
 * Returns null when no chromatic pixel is found (e.g. a black/white wordmark).
 */
export function quantizeDominantColor(
    data: Uint8Array | Uint8ClampedArray | number[],
    opts: { channels?: number; alphaThreshold?: number } = {},
): string | null {
    const ch = opts.channels ?? 4;
    const aMin = opts.alphaThreshold ?? 200;
    const counts = new Map<number, { count: number; r: number; g: number; b: number }>();
    for (let i = 0; i + ch - 1 < data.length; i += ch) {
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const a = ch >= 4 ? data[i + 3] : 255;
        if (a < aMin) continue;                       // skip (semi-)transparent
        if (isNeutral(rgbToHsl({ r, g, b, a: 1 }))) continue; // skip white/black/gray
        const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
        const e = counts.get(key);
        if (e) { e.count++; e.r += r; e.g += g; e.b += b; }
        else counts.set(key, { count: 1, r, g, b });
    }
    if (counts.size === 0) return null;
    let best: { count: number; r: number; g: number; b: number } | null = null;
    let bestKey = Number.MAX_SAFE_INTEGER;
    for (const [k, v] of counts) {
        if (!best || v.count > best.count || (v.count === best.count && k < bestKey)) { best = v; bestKey = k; }
    }
    if (!best) return null;
    return toHex({ r: Math.round(best.r / best.count), g: Math.round(best.g / best.count), b: Math.round(best.b / best.count), a: 1 });
}

const SVG_COLOR_RE = /(?:fill|stop-color|stroke|color)\s*[:=]\s*["']?(#[0-9a-fA-F]{3,8}|rgba?\([^)]{0,80}\)|hsla?\([^)]{0,80}\))/gi;

/**
 * Dominant chromatic color from raw SVG markup (deterministic): counts fill/
 * stop-color/stroke/color values, skips neutrals, returns the most-frequent hex
 * (ties by hex ascending). Best-effort — class-based SVG coloring is not resolved.
 */
export function dominantColorFromSvgMarkup(svg: string): string | null {
    if (!svg) return null;
    SVG_COLOR_RE.lastIndex = 0;
    const counts = new Map<string, number>();
    let m: RegExpExecArray | null;
    while ((m = SVG_COLOR_RE.exec(svg)) !== null) {
        const hex = normalizeColor(m[1]);
        if (!hex) continue;
        const rgba = parseColor(hex);
        if (!rgba || isNeutral(rgbToHsl(rgba))) continue;
        counts.set(hex, (counts.get(hex) || 0) + 1);
    }
    if (counts.size === 0) return null;
    let best: string | null = null, bestN = -1;
    for (const [hex, n] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        if (n > bestN) { best = hex; bestN = n; }
    }
    return best;
}

/** Circular hue distance (0..180°) between two colors, or null if unparseable. */
function hueDistance(a: string, b: string): number | null {
    const ca = parseColor(a), cb = parseColor(b);
    if (!ca || !cb) return null;
    const d = Math.abs(rgbToHsl(ca).h - rgbToHsl(cb).h) % 360;
    return d > 180 ? 360 - d : d;
}

/**
 * Fold the logo's dominant color into a built palette — the logo is ground truth for
 * the brand hue, so it arbitrates `primary` when CSS signals are ambiguous (the
 * undeclared-brand case C1 can't catch, e.g. a bright UI accent out-ranking the real
 * brand). If a palette color is within HUE_TOL° of the logo color, promote it to
 * primary; otherwise inject the logo color as primary. Deterministic; returns a new
 * palette (caps at 6). No-op on a null/neutral logo color.
 */
export function foldLogoColorIntoPalette(palette: PaletteEntry[], logoColor: string | null): PaletteEntry[] {
    if (!logoColor) return palette;
    const lc = normalizeColor(logoColor);
    if (!lc) return palette;
    const HUE_TOL = 20;
    const out = palette.map((p) => ({ ...p }));
    let matchIdx = -1;
    for (let i = 0; i < out.length; i++) {
        const d = hueDistance(out[i].hex, lc);
        if (d !== null && d <= HUE_TOL) { matchIdx = i; break; }
    }
    for (const p of out) if (p.role === 'primary') p.role = null; // clear old primary
    if (matchIdx >= 0) { out[matchIdx].role = 'primary'; return out; }
    out.unshift({ hex: lc, role: 'primary', source: 'logo-pixel', weight: 0 });
    return out.slice(0, 6);
}

// --- SSRF guards (used before fetching linked stylesheets / brand assets) ---

/**
 * True if an IPv4/IPv6 literal is private, loopback, link-local, or otherwise
 * reserved (cloud metadata, CGNAT, etc.). Hostnames are not resolved here — the
 * caller should DNS-resolve and re-check the resolved IPs to defeat rebinding.
 */
export function isPrivateIp(host: string): boolean {
    const h = host.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
    // IPv4-mapped IPv6: dotted (::ffff:1.2.3.4) AND hex (::ffff:c0a8:0101) forms.
    const mapped = h.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    const hexMapped = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    let target = h;
    if (mapped) target = mapped[1];
    else if (hexMapped) {
        const hi = parseInt(hexMapped[1], 16), lo = parseInt(hexMapped[2], 16);
        target = `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
    }
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(target)) {
        const p = target.split('.').map(Number);
        if (p.some((n) => n > 255)) return true; // malformed → treat as unsafe
        const [a, b] = p;
        if (a === 0 || a === 127 || a === 10) return true;
        if (a === 169 && b === 254) return true;       // link-local + 169.254.169.254 metadata
        if (a === 172 && b >= 16 && b <= 31) return true;
        if (a === 192 && b === 168) return true;
        if (a === 192 && b === 0) return true;          // 192.0.0/24, 192.0.2/24 (test-net)
        if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
        if (a === 198 && (b === 18 || b === 19)) return true;
        if (a >= 224) return true;                       // multicast + reserved + broadcast
        return false;
    }
    // IPv6 literals
    if (h.includes(':')) {
        if (h === '::1' || h === '::') return true;
        if (h.startsWith('fe80') || h.startsWith('fc') || h.startsWith('fd')) return true; // link-local + ULA
        if (h.startsWith('ff')) return true;          // multicast ff00::/8
        if (h.startsWith('2001:db8')) return true;    // documentation
        return false;
    }
    return false;
}

/** True if a hostname must never be fetched (loopback/internal names + private IP literals). */
export function isBlockedBrandHost(hostname: string): boolean {
    const h = hostname.trim().toLowerCase().replace(/\.$/, '');
    if (!h) return true;
    if (h === 'localhost' || h.endsWith('.localhost')) return true;
    if (h.endsWith('.internal') || h.endsWith('.local') || h.endsWith('.lan')) return true;
    if (h === 'metadata.google.internal' || h === 'metadata') return true;
    return isPrivateIp(h);
}

// Common two-level public suffixes, so co.uk-style TLDs don't collapse to the
// suffix itself. Not a full PSL, but covers the cases that would otherwise let
// any a.co.uk fetch from b.co.uk.
const TWO_LEVEL_SUFFIXES = new Set([
    'co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'me.uk', 'ltd.uk', 'plc.uk',
    'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'co.nz', 'org.nz',
    'co.in', 'net.in', 'org.in', 'co.jp', 'or.jp', 'ne.jp', 'com.br', 'net.br',
    'com.cn', 'net.cn', 'org.cn', 'co.za', 'org.za', 'com.sg', 'com.mx',
    'co.kr', 'or.kr', 'com.tr', 'com.hk', 'com.tw',
]);

/** Registrable domain (eTLD+1) using a small known-two-level-suffix list. */
function registrableDomain(host: string): string {
    const labels = host.toLowerCase().replace(/\.$/, '').split('.');
    if (labels.length <= 2) return labels.join('.');
    const last2 = labels.slice(-2).join('.');
    return TWO_LEVEL_SUFFIXES.has(last2) ? labels.slice(-3).join('.') : last2;
}

/** True if two hosts share a registrable domain (eTLD+1). */
export function sameSite(a: string, b: string): boolean {
    return registrableDomain(a) === registrableDomain(b);
}

/**
 * Strip an inline <svg> to a safe, size-bounded string suitable for a data URI.
 * Removes scripts, event handlers, foreignObject, and external references.
 * Returns null if it exceeds maxBytes after cleaning.
 */
export function sanitizeInlineSvg(svg: string, maxBytes = 24576): string | null {
    if (!svg) return null;
    let s = svg
        .replace(/<script[\s\S]*?<\/script>/gi, '')   // paired script
        .replace(/<script\b[^>]*\/?>/gi, '')          // unclosed/self-closing script
        .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
        .replace(/<(use|image)\b[^>]*>/gi, '')        // elements that pull external resources
        .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '') // event handlers
        // Strip every href/xlink:href except internal fragment refs (#id).
        .replace(/\s(?:xlink:)?href\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, (m, val: string) => {
            const v = val.replace(/^["']|["']$/g, '').trim();
            return v.startsWith('#') ? m : '';
        });
    s = s.trim();
    if (!s.toLowerCase().startsWith('<svg')) return null;
    if (Buffer.byteLength(s, 'utf8') > maxBytes) return null;
    return s;
}
