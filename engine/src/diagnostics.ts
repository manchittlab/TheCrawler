import type { ExtractionContract } from './contracts.js';
import type { PageData } from './types.js';

export type ContractDiagnosticVerdict = 'ready' | 'needs-review' | 'blocked' | 'failed';

export interface ContractDiagnosticSignal {
    name: string;
    present: boolean;
    weight: number;
    evidence: string | number | null;
}

export type ContractRecommendedAction =
    | 'run-contract-extraction'
    | 'extract-ready-subset'
    | 'retry-with-proxy-or-browser'
    | 'manual-review'
    | 'fix-access-first'
    | 'do-not-automate';

export interface ContractRecommendedNextStep {
    action: ContractRecommendedAction;
    reason: string;
}

export interface ContractDiagnosticResult {
    contract: {
        name: string;
        domain: string;
        version: string;
    };
    url: string;
    verdict: ContractDiagnosticVerdict;
    readyForExtraction: boolean;
    score: number;
    blockers: string[];
    warnings: string[];
    missingReadinessSignals: string[];
    recommendedNextStep: ContractRecommendedNextStep;
    signals: ContractDiagnosticSignal[];
    crawl: {
        status: PageData['status'];
        errorType: PageData['errorType'];
        errorRetryable: boolean;
        title: string | null;
        markdownChars: number;
        textChars: number;
        imageCount: number;
        structuredDataCount: number;
        commerceDataCount: number;
        formCount: number;
        linkCount: number;
        emailCount: number;
        phoneCount: number;
    };
}

export type ContractWorkflowVerdict = 'ready' | 'mixed' | 'blocked' | 'failed' | 'needs-review';

export interface ContractDiagnosticSummary {
    totalUrls: number;
    readyUrls: number;
    blockedUrls: number;
    failedUrls: number;
    needsReviewUrls: number;
    averageScore: number;
    workflowVerdict: ContractWorkflowVerdict;
    recommendedNextStep: ContractRecommendedNextStep;
    blockersByType: Record<string, number>;
    missingReadinessSignals: Record<string, number>;
}

function compactText(page: PageData): string {
    return [
        page.title,
        page.description,
        page.markdown,
        page.text,
        (page.headings ?? []).map((heading) => heading.text).join(' '),
    ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function hasPattern(text: string, pattern: RegExp): boolean {
    return pattern.test(text);
}

function makeSignal(name: string, present: boolean, weight: number, evidence: string | number | null): ContractDiagnosticSignal {
    return { name, present, weight, evidence };
}

function missingSignalNamesFromSignals(signals: ContractDiagnosticSignal[]): string[] {
    return signals
        .filter((signal) => !signal.present)
        .map((signal) => signal.name);
}

function realEstateSignals(page: PageData): ContractDiagnosticSignal[] {
    const text = compactText(page);
    const lower = text.toLowerCase();
    const pricePattern = /(?:[$£€₹]\s?\d[\d,.]*|\d[\d,.]*\s?(?:usd|gbp|eur|inr|aed|cad|aud|dollars?|pounds?|lakhs?|crores?))/i;
    const locationPattern = /\b(?:street|st\.|road|rd\.|avenue|ave\.|lane|ln\.|drive|dr\.|court|ct\.|boulevard|blvd\.|london|new york|san francisco|austin|tx|ca|uk|usa)\b/i;
    const bedBathPattern = /\b(?:bed|beds|bedroom|bedrooms|bhk|bath|baths|bathroom|bathrooms)\b/i;
    const listingPattern = /\b(?:for sale|for rent|rent|sale|lease|apartment|flat|house|villa|condo|property|listing|real estate)\b/i;

    return [
        makeSignal('content-volume', text.length >= 500, 20, text.length),
        makeSignal('title-signal', Boolean(page.title && page.title.trim().length > 8), 10, page.title),
        makeSignal('price-signal', hasPattern(text, pricePattern), 20, (text.match(pricePattern)?.[0] ?? null)),
        makeSignal('location-signal', hasPattern(text, locationPattern), 15, (text.match(locationPattern)?.[0] ?? null)),
        makeSignal('bed-bath-signal', hasPattern(text, bedBathPattern), 10, (text.match(bedBathPattern)?.[0] ?? null)),
        makeSignal('listing-language', hasPattern(lower, listingPattern), 10, (text.match(listingPattern)?.[0] ?? null)),
        makeSignal('image-signal', (page.images ?? []).length > 0, 5, (page.images ?? []).length),
        makeSignal('structured-data-signal', (page.structuredData ?? []).length > 0 || (page.microdata ?? []).length > 0, 5, (page.structuredData ?? []).length + (page.microdata ?? []).length),
        makeSignal('contact-signal', (page.phones ?? []).length > 0 || (page.emails ?? []).length > 0 || (page.forms ?? []).length > 0, 5, (page.phones ?? []).length + (page.emails ?? []).length + (page.forms ?? []).length),
    ];
}

function productPageSignals(page: PageData): ContractDiagnosticSignal[] {
    const text = compactText(page);
    const lower = text.toLowerCase();
    const pricePattern = /(?:[$£€₹]\s?\d[\d,.]*|\d[\d,.]*\s?(?:usd|gbp|eur|inr|aed|cad|aud|dollars?|pounds?))/i;
    const productPattern = /\b(?:product|sku|model|brand|item|buy now|add to cart|shopping cart|checkout)\b/i;
    const availabilityPattern = /\b(?:in stock|out of stock|sold out|available|unavailable|pre[- ]?order|backorder|ships?|delivery|add to cart)\b/i;
    const ratingPattern = /\b(?:\d(?:\.\d)?\s?(?:stars?|\/5)|reviews?|ratings?)\b/i;

    return [
        makeSignal('content-volume', text.length >= 500, 20, text.length),
        makeSignal('title-signal', Boolean(page.title && page.title.trim().length > 8), 10, page.title),
        makeSignal('price-signal', hasPattern(text, pricePattern) || (page.commerceData ?? []).some((item) => Boolean(item.price)), 20, (text.match(pricePattern)?.[0] ?? (page.commerceData ?? [])[0]?.price ?? null)),
        makeSignal('product-language', hasPattern(lower, productPattern), 15, (text.match(productPattern)?.[0] ?? null)),
        makeSignal('availability-signal', hasPattern(lower, availabilityPattern) || (page.commerceData ?? []).some((item) => Boolean(item.availability)), 10, (text.match(availabilityPattern)?.[0] ?? (page.commerceData ?? [])[0]?.availability ?? null)),
        makeSignal('image-signal', (page.images ?? []).length > 0, 10, (page.images ?? []).length),
        makeSignal('structured-data-signal', (page.structuredData ?? []).length > 0 || (page.microdata ?? []).length > 0 || (page.commerceData ?? []).length > 0, 10, (page.structuredData ?? []).length + (page.microdata ?? []).length + (page.commerceData ?? []).length),
        makeSignal('rating-signal', hasPattern(text, ratingPattern) || (page.commerceData ?? []).some((item) => Boolean(item.rating || item.reviewCount)), 5, (text.match(ratingPattern)?.[0] ?? (page.commerceData ?? [])[0]?.rating ?? null)),
    ];
}

function genericSignals(page: PageData): ContractDiagnosticSignal[] {
    const text = compactText(page);
    return [
        makeSignal('content-volume', text.length >= 500, 40, text.length),
        makeSignal('title-signal', Boolean(page.title && page.title.trim().length > 8), 15, page.title),
        makeSignal('structured-data-signal', (page.structuredData ?? []).length > 0 || (page.microdata ?? []).length > 0, 15, (page.structuredData ?? []).length + (page.microdata ?? []).length),
        makeSignal('markdown-signal', Boolean(page.markdown && page.markdown.length >= 500), 15, page.markdown?.length ?? 0),
        makeSignal('link-signal', (page.links ?? []).length > 0, 15, (page.links ?? []).length),
    ];
}

function recommendForDiagnostic(
    verdict: ContractDiagnosticVerdict,
    blockers: string[],
    warnings: string[],
    page: PageData,
): ContractRecommendedNextStep {
    if (verdict === 'ready') {
        return {
            action: 'run-contract-extraction',
            reason: 'Source has enough domain signals for contract extraction.',
        };
    }
    if (verdict === 'blocked') {
        if (page.errorRetryable || blockers.includes('rate-limit')) {
            return {
                action: 'retry-with-proxy-or-browser',
                reason: `Access blocker detected: ${blockers.join(', ')}.`,
            };
        }
        return {
            action: 'do-not-automate',
            reason: `Non-retryable access blocker detected: ${blockers.join(', ')}.`,
        };
    }
    if (verdict === 'failed') {
        if (page.errorRetryable) {
            return {
                action: 'retry-with-proxy-or-browser',
                reason: `Retryable crawl failure detected: ${blockers.join(', ') || 'unknown-error'}.`,
            };
        }
        return {
            action: 'do-not-automate',
            reason: `Crawl failed before extraction: ${blockers.join(', ') || 'unknown-error'}.`,
        };
    }
    return {
        action: 'manual-review',
        reason: warnings.includes('thin-content')
            ? 'Page content is too thin to trust automatic extraction.'
            : 'Source has partial signals and needs review before extraction.',
    };
}

function recommendForSummary(summary: Omit<ContractDiagnosticSummary, 'recommendedNextStep'>): ContractRecommendedNextStep {
    if (summary.workflowVerdict === 'ready') {
        return {
            action: 'run-contract-extraction',
            reason: 'All tested URLs are ready for contract extraction.',
        };
    }
    if (summary.workflowVerdict === 'mixed') {
        return {
            action: 'extract-ready-subset',
            reason: `${summary.readyUrls} of ${summary.totalUrls} URLs are ready; handle blockers before expanding automation.`,
        };
    }
    if (summary.workflowVerdict === 'blocked') {
        return {
            action: 'fix-access-first',
            reason: 'All tested URLs are blocked before extraction.',
        };
    }
    if (summary.workflowVerdict === 'failed') {
        return {
            action: 'do-not-automate',
            reason: 'No tested URLs produced usable crawl input.',
        };
    }
    return {
        action: 'manual-review',
        reason: 'The workflow has partial or thin evidence and needs review before extraction.',
    };
}

export function diagnoseContractReadiness(
    contract: ExtractionContract,
    page: PageData,
): ContractDiagnosticResult {
    const blockers: string[] = [];
    const warnings: string[] = [];

    if (page.status === 'error') {
        blockers.push(page.errorType ?? 'unknown-error');
    }

    const textChars = page.text?.length ?? 0;
    const markdownChars = page.markdown?.length ?? 0;
    if (page.status === 'success' && compactText(page).length < 500) {
        warnings.push('thin-content');
    }

    const signals = contract.name === 'real-estate-listing'
        ? realEstateSignals(page)
        : contract.name === 'product-page'
            ? productPageSignals(page)
            : genericSignals(page);
    const maxScore = signals.reduce((sum, signal) => sum + signal.weight, 0);
    const rawScore = signals.reduce((sum, signal) => sum + (signal.present ? signal.weight : 0), 0);
    const score = maxScore > 0 ? Math.round((rawScore / maxScore) * 100) : 0;

    let verdict: ContractDiagnosticVerdict = 'needs-review';
    if (blockers.includes('blocked-bot') || blockers.includes('rate-limit')) {
        verdict = 'blocked';
    } else if (blockers.length > 0) {
        verdict = 'failed';
    } else if (score >= 70 && warnings.length === 0) {
        verdict = 'ready';
    }

    return {
        contract: {
            name: contract.name,
            domain: contract.domain,
            version: contract.version,
        },
        url: page.url,
        verdict,
        readyForExtraction: verdict === 'ready',
        score,
        blockers,
        warnings,
        missingReadinessSignals: missingSignalNamesFromSignals(signals),
        recommendedNextStep: recommendForDiagnostic(verdict, blockers, warnings, page),
        signals,
        crawl: {
            status: page.status,
            errorType: page.errorType,
            errorRetryable: page.errorRetryable,
            title: page.title,
            markdownChars,
            textChars,
            imageCount: (page.images ?? []).length,
            structuredDataCount: (page.structuredData ?? []).length + (page.microdata ?? []).length,
            commerceDataCount: (page.commerceData ?? []).length,
            formCount: (page.forms ?? []).length,
            linkCount: (page.links ?? []).length,
            emailCount: (page.emails ?? []).length,
            phoneCount: (page.phones ?? []).length,
        },
    };
}

export function summarizeContractDiagnostics(results: ContractDiagnosticResult[]): ContractDiagnosticSummary {
    const totalUrls = results.length;
    const readyUrls = results.filter((result) => result.verdict === 'ready').length;
    const blockedUrls = results.filter((result) => result.verdict === 'blocked').length;
    const failedUrls = results.filter((result) => result.verdict === 'failed').length;
    const needsReviewUrls = results.filter((result) => result.verdict === 'needs-review').length;
    const averageScore = totalUrls > 0
        ? Math.round(results.reduce((sum, result) => sum + result.score, 0) / totalUrls)
        : 0;
    const blockersByType: Record<string, number> = {};
    for (const result of results) {
        for (const blocker of result.blockers) {
            blockersByType[blocker] = (blockersByType[blocker] ?? 0) + 1;
        }
    }

    let workflowVerdict: ContractWorkflowVerdict = 'needs-review';
    if (totalUrls === 0) {
        workflowVerdict = 'failed';
    } else if (readyUrls === totalUrls) {
        workflowVerdict = 'ready';
    } else if (blockedUrls === totalUrls) {
        workflowVerdict = 'blocked';
    } else if (failedUrls === totalUrls) {
        workflowVerdict = 'failed';
    } else if (readyUrls > 0) {
        workflowVerdict = 'mixed';
    }

    const summary = {
        totalUrls,
        readyUrls,
        blockedUrls,
        failedUrls,
        needsReviewUrls,
        averageScore,
        workflowVerdict,
        blockersByType,
        missingReadinessSignals: countMissingSignals(results),
    };
    return {
        ...summary,
        recommendedNextStep: recommendForSummary(summary),
    };
}

function mdCell(value: string | number | boolean | null | undefined): string {
    return String(value ?? 'none').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function missingSignalNames(diagnostic: ContractDiagnosticResult): string[] {
    return diagnostic.missingReadinessSignals ?? missingSignalNamesFromSignals(diagnostic.signals);
}

function countMissingSignals(diagnostics: ContractDiagnosticResult[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const diagnostic of diagnostics) {
        for (const name of missingSignalNames(diagnostic)) {
            counts[name] = (counts[name] ?? 0) + 1;
        }
    }
    return counts;
}

export function renderContractDiagnosticReport(input: {
    generatedAt: string;
    contract: Pick<ExtractionContract, 'name' | 'domain' | 'version'>;
    summary: ContractDiagnosticSummary;
    diagnostics: ContractDiagnosticResult[];
}): string {
    const { generatedAt, contract, summary, diagnostics } = input;
    const lines: string[] = [];
    lines.push('# TheCrawler Extraction Readiness Report');
    lines.push('');
    lines.push(`Generated: ${generatedAt}`);
    lines.push(`Contract: ${contract.name} (${contract.domain}, ${contract.version})`);
    lines.push('');
    lines.push('## Workflow Verdict');
    lines.push('');
    lines.push(`Verdict: ${summary.workflowVerdict}`);
    lines.push(`Recommended next step: ${summary.recommendedNextStep.action}`);
    lines.push(`Reason: ${summary.recommendedNextStep.reason}`);
    lines.push('');
    lines.push('| Metric | Value |');
    lines.push('|---|---:|');
    lines.push(`| Total URLs | ${summary.totalUrls} |`);
    lines.push(`| Ready | ${summary.readyUrls} |`);
    lines.push(`| Blocked | ${summary.blockedUrls} |`);
    lines.push(`| Failed | ${summary.failedUrls} |`);
    lines.push(`| Needs review | ${summary.needsReviewUrls} |`);
    lines.push(`| Average score | ${summary.averageScore} |`);
    lines.push('');
    lines.push('## Readiness Gaps');
    lines.push('');
    const missingSignalCounts = summary.missingReadinessSignals ?? countMissingSignals(diagnostics);
    const missingSignalEntries = Object.entries(missingSignalCounts)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    if (missingSignalEntries.length === 0) {
        lines.push('No missing readiness signals across tested URLs.');
    } else {
        lines.push('| Missing signal | URLs affected |');
        lines.push('|---|---:|');
        for (const [signalName, count] of missingSignalEntries) {
            lines.push(`| ${mdCell(signalName)} | ${count} |`);
        }
    }
    lines.push('');
    lines.push('## URL Results');
    lines.push('');
    lines.push('| URL | Verdict | Score | Next step | Blockers | Warnings | Missing readiness signals |');
    lines.push('|---|---|---:|---|---|---|---|');
    for (const diagnostic of diagnostics) {
        lines.push([
            mdCell(diagnostic.url),
            mdCell(diagnostic.verdict),
            mdCell(diagnostic.score),
            mdCell(diagnostic.recommendedNextStep.action),
            mdCell(diagnostic.blockers.join(', ') || 'none'),
            mdCell(diagnostic.warnings.join(', ') || 'none'),
            mdCell(missingSignalNames(diagnostic).join(', ') || 'none'),
        ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
    }
    lines.push('');
    lines.push('## Notes');
    lines.push('');
    lines.push('- This report does not include raw extracted contact details or raw page evidence.');
    lines.push('- A ready verdict means the source is a good candidate for contract extraction, not a guarantee that every page on the domain will work.');
    lines.push('- A blocked verdict should be handled before spending LLM tokens on extraction.');
    lines.push('');
    return lines.join('\n');
}
