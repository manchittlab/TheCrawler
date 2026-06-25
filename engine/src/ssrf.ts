/**
 * SSRF guard for user-supplied URLs reaching the engine's own fetch() calls.
 *
 * Unlike the hosted path (where page fetches run inside Apify's network-isolated
 * sandbox), the engine server (`server.ts`) and the LAN extraction worker fetch
 * BOTH target URLs and a user-supplied `llmBaseUrl` directly on our own network.
 * That makes a host guard mandatory here: without it, a caller can point a target
 * URL or `llmBaseUrl` at loopback, RFC-1918, link-local (169.254.169.254 cloud
 * metadata), or an internal hostname and read internal services.
 *
 * This is a deliberate, documented MIRROR of `miaibot-site/src/lib/ssrf.ts`
 * (the two live in separate packages — the Next.js site and this npm engine — so
 * a shared dependency isn't worth it; keep the two byte-equivalent in logic when
 * either changes).
 *
 * Two layers (per the Codex SSRF review):
 *   1. `assertPublicHttpUrl` — cheap hostname/IP-literal classification at the
 *      request boundary. Blocks the obvious "point it at localhost/metadata".
 *   2. `safeFetch` — fetch-time enforcement for DIRECT, unsandboxed fetches of
 *      attacker-controlled URLs (above all `llmBaseUrl`): it RESOLVES DNS and
 *      rejects if any resolved address is private (defeats DNS-rebind by a public
 *      name), and follows redirects MANUALLY with `redirect:'manual'`,
 *      re-validating + re-resolving each hop (defeats 302-to-metadata).
 *
 * This is a deliberate, documented MIRROR of `miaibot-site/src/lib/ssrf.ts`
 * (the two live in separate packages — the Next.js site and this npm engine — so
 * a shared dependency isn't worth it; keep the two equivalent in logic when
 * either changes).
 *
 * Documented residual: `safeFetch` resolves-then-connects, leaving a narrow
 * connect-time TOCTOU rebind window (resolve returns public, the OS re-resolves
 * to private at connect). Closing it fully needs connection-level IP pinning
 * (custom undici dispatcher). Accepted for now because (a) the pre-resolve check
 * defeats the realistic attack and (b) the live hosted page-fetch runs inside
 * Apify's network-isolated sandbox. The Crawlee target-page pipeline
 * (auto-redirect/link-follow) is NOT wrapped by safeFetch — same sandbox
 * mitigation on the hosted path; self-hosters get boundary checks as first line.
 */

import { lookup as dnsLookup } from 'node:dns/promises';

/** True if `host` is a private/loopback/link-local/reserved IP literal. */
export function isPrivateIp(host: string): boolean {
    const h = host.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
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
        if (p.some((n) => n > 255)) return true;
        const [a, b] = p;
        if (a === 0 || a === 127 || a === 10) return true;
        if (a === 169 && b === 254) return true;
        if (a === 172 && b >= 16 && b <= 31) return true;
        if (a === 192 && b === 168) return true;
        if (a === 192 && b === 0) return true;
        if (a === 100 && b >= 64 && b <= 127) return true;
        if (a === 198 && (b === 18 || b === 19)) return true;
        if (a >= 224) return true;
        return false;
    }
    if (h.includes(':')) {
        if (h === '::1' || h === '::') return true;
        if (h.startsWith('fe80') || h.startsWith('fc') || h.startsWith('fd')) return true;
        if (h.startsWith('ff')) return true;          // multicast ff00::/8
        if (h.startsWith('2001:db8')) return true;    // documentation
        return false;
    }
    return false;
}

/** True if a hostname must never be fetched (loopback/internal names + private IPs). */
export function isBlockedHost(hostname: string): boolean {
    const h = hostname.trim().toLowerCase().replace(/\.$/, '');
    if (!h) return true;
    if (h === 'localhost' || h.endsWith('.localhost')) return true;
    if (h.endsWith('.internal') || h.endsWith('.local') || h.endsWith('.lan')) return true;
    if (h === 'metadata.google.internal' || h === 'metadata') return true;
    return isPrivateIp(h);
}

export type UrlGuardResult =
    | { ok: true; href: string; hostname: string }
    | { ok: false; reason: string };

/**
 * Validate a user-supplied URL for direct fetching: must parse, must be
 * http/https, and its host must not be blocked. Returns the normalized href on
 * success or a caller-surfaceable reason on rejection.
 */
export function assertPublicHttpUrl(raw: unknown): UrlGuardResult {
    if (typeof raw !== 'string' || raw.trim().length === 0) {
        return { ok: false, reason: 'url must be a non-empty string' };
    }
    let u: URL;
    try {
        u = new URL(raw);
    } catch {
        return { ok: false, reason: 'url must be an absolute HTTP or HTTPS URL' };
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return { ok: false, reason: 'url must use the http or https scheme' };
    }
    if (isBlockedHost(u.hostname)) {
        return { ok: false, reason: 'url host is not allowed (private, loopback, or internal address)' };
    }
    return { ok: true, href: u.href, hostname: u.hostname };
}

/**
 * Resolve a hostname and reject if ANY resolved address is private/reserved.
 * Defeats DNS-rebind by a public name that maps to a private IP. If the host is
 * already an IP literal, `dns.lookup` returns it unchanged and we just classify.
 * On resolution failure we reject (fail-closed) — an unresolvable host can't be
 * a legitimate fetch target anyway.
 */
async function resolvesToPublicOnly(hostname: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    let addrs: { address: string }[];
    try {
        addrs = await dnsLookup(hostname, { all: true });
    } catch {
        return { ok: false, reason: `host ${hostname} did not resolve` };
    }
    if (addrs.length === 0) return { ok: false, reason: `host ${hostname} resolved to no addresses` };
    for (const a of addrs) {
        if (isPrivateIp(a.address)) {
            return { ok: false, reason: `host ${hostname} resolves to a private address (${a.address})` };
        }
    }
    return { ok: true };
}

export class SsrfBlockedError extends Error {
    constructor(reason: string) {
        super(`SSRF blocked: ${reason}`);
        this.name = 'SsrfBlockedError';
    }
}

export interface SafeFetchOptions {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
    /** Max redirect hops to follow manually (each re-validated). Default 5. */
    maxRedirects?: number;
}

/**
 * Fetch an untrusted URL with SSRF enforcement: validate host (boundary) +
 * resolve DNS and reject private resolved IPs (anti-rebind) + follow redirects
 * MANUALLY, re-running the full check on every hop (anti 302-to-metadata).
 * Throws `SsrfBlockedError` if any hop is blocked. Use this for every DIRECT,
 * unsandboxed server-side fetch of a user-controlled URL (e.g. `llmBaseUrl`,
 * sitemap children, document downloads).
 */
export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<Response> {
    const maxRedirects = opts.maxRedirects ?? 5;
    let current = rawUrl;
    for (let hop = 0; hop <= maxRedirects; hop++) {
        const guard = assertPublicHttpUrl(current);
        if (!guard.ok) throw new SsrfBlockedError(guard.reason);
        const resolved = await resolvesToPublicOnly(guard.hostname);
        if (!resolved.ok) throw new SsrfBlockedError(resolved.reason);

        const res = await fetch(guard.href, {
            method: opts.method ?? 'GET',
            headers: opts.headers,
            body: opts.body,
            signal: opts.signal,
            redirect: 'manual',
        });
        // 3xx with a Location → validate the next hop ourselves, never auto-follow.
        if (res.status >= 300 && res.status < 400) {
            const loc = res.headers.get('location');
            if (!loc) return res; // 3xx without Location — hand back as-is
            if (hop === maxRedirects) throw new SsrfBlockedError(`too many redirects (>${maxRedirects})`);
            try {
                current = new URL(loc, guard.href).href;
            } catch {
                throw new SsrfBlockedError(`invalid redirect target: ${loc.slice(0, 120)}`);
            }
            continue;
        }
        return res;
    }
    // Unreachable (loop returns/throws), but satisfies the type checker.
    throw new SsrfBlockedError('redirect loop exhausted');
}

/**
 * Headers a client must never be allowed to set on an outbound fetch: host
 * overrides (routing/SSRF bypass), forwarding spoofs, and hop-by-hop/framing
 * headers that can desync the connection. Used to sanitize user `customHeaders`
 * on the hosted boundary.
 */
const FORBIDDEN_HEADER_PREFIXES = ['x-forwarded-', 'proxy-'];
const FORBIDDEN_HEADERS = new Set([
    'host', ':authority', 'forwarded', 'connection', 'content-length',
    'transfer-encoding', 'te', 'upgrade', 'keep-alive', 'trailer',
]);

/** Drop host-override / forwarding / hop-by-hop headers from user-supplied headers. */
export function sanitizeHeaders(headers: unknown): { clean: Record<string, string>; dropped: string[] } {
    const clean: Record<string, string> = {};
    const dropped: string[] = [];
    if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
        for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
            const lk = k.trim().toLowerCase();
            if (FORBIDDEN_HEADERS.has(lk) || FORBIDDEN_HEADER_PREFIXES.some((p) => lk.startsWith(p))) {
                dropped.push(lk);
                continue;
            }
            if (typeof v === 'string') clean[k] = v;
        }
    }
    return { clean, dropped };
}
