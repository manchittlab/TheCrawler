import type { ExtractResult } from './extract.js';

export interface ExtractionContract {
    name: string;
    domain: string;
    version: string;
    description: string;
    schema: {
        type: 'object';
        properties: Record<string, unknown>;
        required: string[];
        additionalProperties: boolean;
    };
    prompt: string;
    requiredFields: string[];
}

export interface ContractValidationResult {
    valid: boolean;
    missingRequiredFields: string[];
    requiredFields: string[];
    data: Record<string, unknown>;
}

export interface ContractExtractResult extends ExtractResult {
    contract: {
        name: string;
        domain: string;
        version: string;
    };
    validation: ContractValidationResult | null;
}

const REAL_ESTATE_LISTING_CONTRACT: ExtractionContract = {
    name: 'real-estate-listing',
    domain: 'real-estate',
    version: '2026-05-19',
    description: 'Extracts a normalized listing record for agent workflows that need repeatable property data, not loose markdown.',
    requiredFields: ['title', 'price', 'location', 'sourceUrl'],
    schema: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'price', 'location', 'sourceUrl'],
        properties: {
            title: { type: ['string', 'null'], description: 'Listing headline or property title.' },
            price: {
                type: 'object',
                additionalProperties: false,
                required: ['amount', 'currency', 'raw'],
                properties: {
                    amount: { type: ['number', 'null'], description: 'Numeric price when present.' },
                    currency: { type: ['string', 'null'], description: 'ISO currency code or visible currency symbol/name.' },
                    raw: { type: ['string', 'null'], description: 'Exact visible price text when numeric normalization is uncertain.' },
                },
            },
            location: {
                type: 'object',
                additionalProperties: false,
                required: ['raw', 'city', 'region', 'country'],
                properties: {
                    raw: { type: ['string', 'null'], description: 'Exact visible location/address text.' },
                    city: { type: ['string', 'null'] },
                    region: { type: ['string', 'null'], description: 'State, province, county, or locality when present.' },
                    country: { type: ['string', 'null'] },
                },
            },
            beds: { type: ['number', 'null'], description: 'Bedroom count when present.' },
            baths: { type: ['number', 'null'], description: 'Bathroom count when present.' },
            area: {
                type: 'object',
                additionalProperties: false,
                required: ['value', 'unit', 'raw'],
                properties: {
                    value: { type: ['number', 'null'] },
                    unit: { type: ['string', 'null'], description: 'sqft, sqm, acres, etc.' },
                    raw: { type: ['string', 'null'] },
                },
            },
            listingType: { type: ['string', 'null'], description: 'sale, rent, lease, auction, or other visible listing type.' },
            propertyType: { type: ['string', 'null'], description: 'apartment, villa, house, condo, land, office, etc.' },
            description: { type: ['string', 'null'], description: 'Concise listing description from the page.' },
            images: {
                type: 'array',
                items: { type: 'string' },
                description: 'Image URLs visible in extracted page content.',
            },
            agentOrBroker: {
                type: 'object',
                additionalProperties: false,
                required: ['name', 'phone', 'email', 'company'],
                properties: {
                    name: { type: ['string', 'null'] },
                    phone: { type: ['string', 'null'] },
                    email: { type: ['string', 'null'] },
                    company: { type: ['string', 'null'] },
                },
            },
            sourceUrl: { type: ['string', 'null'], description: 'Canonical URL for the listing or page that was extracted.' },
            confidence: { type: ['number', 'null'], description: '0 to 1 confidence score based only on visible evidence.' },
            evidenceNotes: {
                type: 'array',
                items: { type: 'string' },
                description: 'Short notes citing what was visible, missing, blocked, or ambiguous.',
            },
        },
    },
    prompt: [
        'Extract one real-estate listing record from the page content.',
        'Use only facts visible in the provided content.',
        'If the page is a search results page, extract the first complete listing-like record.',
        'Do not invent missing values. Use null when a field is not visible.',
        'Set sourceUrl to the input URL or canonical listing URL visible in the content.',
        'Use evidenceNotes to explain missing required fields, blocked content, or ambiguity.',
    ].join(' '),
};

const PRODUCT_PAGE_CONTRACT: ExtractionContract = {
    name: 'product-page',
    domain: 'ecommerce',
    version: '2026-05-22',
    description: 'Extracts a normalized product record for catalog, price-monitoring, and agent shopping workflows.',
    requiredFields: ['name', 'price', 'sourceUrl'],
    schema: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'price', 'sourceUrl'],
        properties: {
            name: { type: ['string', 'null'], description: 'Product name or title visible on the page.' },
            price: {
                type: 'object',
                additionalProperties: false,
                required: ['amount', 'currency', 'raw'],
                properties: {
                    amount: { type: ['number', 'null'], description: 'Numeric price when visible.' },
                    currency: { type: ['string', 'null'], description: 'ISO currency code or visible currency symbol/name.' },
                    raw: { type: ['string', 'null'], description: 'Exact visible price text when normalization is uncertain.' },
                },
            },
            availability: { type: ['string', 'null'], description: 'Visible availability or stock status.' },
            brand: { type: ['string', 'null'], description: 'Visible brand or manufacturer.' },
            sku: { type: ['string', 'null'], description: 'Visible SKU, model, or product identifier.' },
            rating: {
                type: 'object',
                additionalProperties: false,
                required: ['value', 'reviewCount', 'raw'],
                properties: {
                    value: { type: ['number', 'null'], description: 'Numeric rating when visible.' },
                    reviewCount: { type: ['number', 'null'], description: 'Visible review count when present.' },
                    raw: { type: ['string', 'null'], description: 'Exact visible rating/review text.' },
                },
            },
            images: {
                type: 'array',
                items: { type: 'string' },
                description: 'Product image URLs visible in extracted page content.',
            },
            description: { type: ['string', 'null'], description: 'Concise product description from the page.' },
            sourceUrl: { type: ['string', 'null'], description: 'Canonical URL for the product page that was extracted.' },
            confidence: { type: ['number', 'null'], description: '0 to 1 confidence score based only on visible evidence.' },
            evidenceNotes: {
                type: 'array',
                items: { type: 'string' },
                description: 'Short notes citing what was visible, missing, blocked, or ambiguous.',
            },
        },
    },
    prompt: [
        'Extract one product record from the page content.',
        'Use only facts visible in the provided content.',
        'If the page is a category or search page, extract the first complete product-like record.',
        'Do not invent missing values. Use null when a field is not visible.',
        'Set sourceUrl to the input URL or canonical product URL visible in the content.',
        'Use evidenceNotes to explain missing required fields, blocked content, or ambiguity.',
    ].join(' '),
};

const DOCS_PAGE_CONTRACT: ExtractionContract = {
    name: 'docs-page',
    domain: 'documentation',
    version: '2026-05-24',
    description: 'Extracts public documentation page facts for RAG and agent knowledge-base workflows.',
    requiredFields: ['title', 'summary', 'sourceUrl'],
    schema: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'summary', 'sourceUrl'],
        properties: {
            title: { type: ['string', 'null'], description: 'Documentation page title or primary heading.' },
            summary: { type: ['string', 'null'], description: 'Concise summary of what the public documentation page explains.' },
            sourceUrl: { type: ['string', 'null'], description: 'Canonical URL for the documentation page that was extracted.' },
            headings: {
                type: 'array',
                items: { type: 'string' },
                description: 'Important public section headings visible on the page.',
            },
            apiEndpoints: {
                type: 'array',
                items: { type: 'string' },
                description: 'Public API endpoints, methods, or route patterns documented on the page.',
            },
            codeExamples: {
                type: 'array',
                items: { type: 'string' },
                description: 'Short public code snippets or command examples visible in the documentation.',
            },
            productArea: { type: ['string', 'null'], description: 'Documented product, API, SDK, or feature area.' },
            confidence: { type: ['number', 'null'], description: '0 to 1 confidence score based only on visible documentation evidence.' },
            evidenceNotes: {
                type: 'array',
                items: { type: 'string' },
                description: 'Short notes citing what was visible, missing, blocked, or ambiguous.',
            },
        },
    },
    prompt: [
        'Extract one public documentation page record for a RAG or agent knowledge-base workflow.',
        'Use only documentation facts visible in the provided content.',
        'Do not extract contributor identities, comments, personal data, contact fields, or account-specific data.',
        'Keep codeExamples short and omit secrets, tokens, or credentials if any example resembles one.',
        'Do not invent missing values. Use null or empty arrays when a field is not visible.',
        'Set sourceUrl to the input URL or canonical documentation URL visible in the content.',
        'Use evidenceNotes to explain missing required fields, blocked content, or ambiguity.',
    ].join(' '),
};

const BRAND_CONTEXT_CONTRACT: ExtractionContract = {
    name: 'brand-context',
    domain: 'brand',
    version: '2026-06-28',
    description: 'Extracts a structured brand profile from a company website (homepage/about) for AI content generation — name, tagline, what they do, tone/voice, products, differentiators, socials. NOTE: tone/voice/summary fields are INFERRED from the visible copy + its writing style, so this contract is best used WITHOUT strict groundToSource (which would null inferred values).',
    requiredFields: ['brandName', 'sourceUrl'],
    schema: {
        type: 'object',
        additionalProperties: false,
        required: ['brandName', 'sourceUrl'],
        properties: {
            brandName: { type: ['string', 'null'], description: 'Company/brand name as it presents itself on the page.' },
            tagline: { type: ['string', 'null'], description: 'Short hero tagline/slogan, verbatim if present.' },
            oneLineDescription: { type: ['string', 'null'], description: 'One sentence ("We help X do Y") summarized from visible copy.' },
            whatWeDo: { type: ['string', 'null'], description: '1-2 sentences on what the company does, from the page copy.' },
            companyDescription: { type: ['string', 'null'], description: 'Longer about/description (up to ~400 chars) from visible copy.' },
            targetAudience: { type: ['string', 'null'], description: 'Who it is for, if stated or clearly implied by visible copy.' },
            industryCategory: { type: ['string', 'null'], description: 'Industry/category (e.g. SaaS, fintech, e-commerce, agency).' },
            brandTone: { type: ['string', 'null'], description: 'Overall tone in a few words (e.g. "professional, playful, direct"), inferred from the copy style.' },
            voiceAdjectives: { type: 'array', items: { type: 'string' }, description: '3-6 adjectives describing the brand voice, inferred from the writing style.' },
            keyProductsOrServices: { type: 'array', items: { type: 'string' }, description: 'Named products/services visible on the page.' },
            keyDifferentiators: { type: 'array', items: { type: 'string' }, description: 'Stated value propositions / differentiators from visible copy.' },
            socialLinks: {
                type: 'object',
                additionalProperties: false,
                required: ['twitter', 'linkedin', 'instagram', 'facebook', 'youtube'],
                properties: {
                    twitter: { type: ['string', 'null'] },
                    linkedin: { type: ['string', 'null'] },
                    instagram: { type: ['string', 'null'] },
                    facebook: { type: ['string', 'null'] },
                    youtube: { type: ['string', 'null'] },
                },
            },
            sourceUrl: { type: ['string', 'null'], description: 'The input or canonical URL that was extracted.' },
            evidenceNotes: { type: 'array', items: { type: 'string' }, description: 'Short notes on what was visible, missing, or heavily inferred.' },
        },
    },
    prompt: [
        'Extract a structured brand profile for AI content generation from the page content.',
        'brandName, tagline, named products/services, and social links must come ONLY from visible content.',
        'oneLineDescription, whatWeDo, companyDescription, brandTone, voiceAdjectives, targetAudience, and industryCategory may be summarized or inferred FROM the visible copy and its writing style — never from outside/world knowledge.',
        'brandTone and voiceAdjectives describe HOW the site is written; keep them grounded in the actual copy.',
        'Use null (or empty arrays) when a field cannot be determined from the content. Do not invent company facts.',
        'Set sourceUrl to the input or canonical URL. Use evidenceNotes to flag anything missing or heavily inferred.',
    ].join(' '),
};

const CONTRACTS = new Map<string, ExtractionContract>([
    [DOCS_PAGE_CONTRACT.name, DOCS_PAGE_CONTRACT],
    [REAL_ESTATE_LISTING_CONTRACT.name, REAL_ESTATE_LISTING_CONTRACT],
    [PRODUCT_PAGE_CONTRACT.name, PRODUCT_PAGE_CONTRACT],
    [BRAND_CONTEXT_CONTRACT.name, BRAND_CONTEXT_CONTRACT],
]);

export function listExtractionContracts(): string[] {
    return [...CONTRACTS.keys()].sort();
}

export function getExtractionContract(name: string): ExtractionContract {
    const contract = CONTRACTS.get(name);
    if (!contract) {
        throw new Error(`Unknown extraction contract "${name}". Available contracts: ${listExtractionContracts().join(', ')}`);
    }
    return contract;
}

function hasMeaningfulValue(value: unknown): boolean {
    if (value === null || value === undefined) return false;
    if (typeof value === 'string') return value.trim().length > 0;
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value === 'boolean') return true;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'object') {
        return Object.values(value as Record<string, unknown>).some(hasMeaningfulValue);
    }
    return false;
}

export function validateContractData(
    contract: ExtractionContract,
    data: unknown,
): ContractValidationResult {
    const normalized = data && typeof data === 'object' && !Array.isArray(data)
        ? data as Record<string, unknown>
        : {};
    const missingRequiredFields = contract.requiredFields.filter((field) => !hasMeaningfulValue(normalized[field]));
    return {
        valid: missingRequiredFields.length === 0,
        missingRequiredFields,
        requiredFields: contract.requiredFields,
        data: normalized,
    };
}

export function attachContractValidation(
    contract: ExtractionContract,
    results: ExtractResult[],
): ContractExtractResult[] {
    return results.map((result) => ({
        ...result,
        contract: {
            name: contract.name,
            domain: contract.domain,
            version: contract.version,
        },
        validation: result.status === 'success'
            ? validateContractData(contract, result.data)
            : null,
    }));
}
