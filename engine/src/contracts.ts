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

const CONTRACTS = new Map<string, ExtractionContract>([
    [REAL_ESTATE_LISTING_CONTRACT.name, REAL_ESTATE_LISTING_CONTRACT],
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
