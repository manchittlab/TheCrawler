/**
 * TheCrawler — Web scraper, PDF/DOCX parser, LLM-ready markdown.
 *
 * Usage:
 *   import { crawl } from 'thecrawler';
 *   const result = await crawl({ urls: ['https://example.com'] });
 *   console.log(result.pages[0].title);
 *
 * Streaming:
 *   import { crawlStream } from 'thecrawler';
 *   await crawlStream({ urls: ['https://example.com'] }, (page) => {
 *       console.log(page.url, page.title);
 *   });
 *
 * LLM-powered structured extraction (v0.3.0):
 *   import { extract } from 'thecrawler';
 *   const r = await extract({
 *       urls: ['https://example.com/product/123'],
 *       jsonSchema: { type: 'object', properties: { name: {type:'string'}, price: {type:'number'} } },
 *       llm: { baseUrl: 'http://localhost:8080/v1/chat/completions', model: 'your-model' },
 *   });
 *   console.log(r[0].data); // { name: '...', price: ... }
 */

export { crawl, crawlStream, parseSitemap, CrawlCache, searchGoogle } from './engine.js';
export { extract } from './extract.js';
export { buildEmbeddingRequests, parseEmbeddingResponse, embedTexts, embedMarkdown } from './embeddings.js';
export type { EmbeddingConfig, EmbeddingRequest, EmbedResult } from './embeddings.js';
export { attachContractValidation, getExtractionContract, listExtractionContracts, validateContractData } from './contracts.js';
export { diagnoseContractReadiness, renderContractDiagnosticReport, summarizeContractDiagnostics } from './diagnostics.js';
export { proposeFieldsFromPage, discoverFields } from './discover.js';
export type { DiscoveredField, DiscoverResult, FieldSource } from './discover.js';
export type { CrawlOptions, PageData, CrawlResult, BrowserAction, CrawlErrorType, CacheOptions } from './types.js';
export type { ExtractOptions, ExtractResult, ExtractErrorType, LlmConfig } from './extract.js';
export type { ContractExtractResult, ContractValidationResult, ExtractionContract } from './contracts.js';
export type { ContractDiagnosticResult, ContractDiagnosticSignal, ContractDiagnosticSummary, ContractDiagnosticVerdict, ContractRecommendedAction, ContractRecommendedNextStep, ContractWorkflowVerdict } from './diagnostics.js';
