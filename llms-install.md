# TheCrawler MCP install guide for Cline

This repository contains an Apify actor wrapper at the root and the open-source MCP/CLI engine in `engine/`.

Use the `engine/` folder for local MCP installation. The published npm package is still older, so use this GitHub-source path for current validated-contract and MCP tools.

## Requirements

- Node.js 18 or newer
- npm

## Setup from a fresh clone

```bash
git clone https://github.com/manchittlab/TheCrawler.git
cd TheCrawler/engine
npm install
npm run build
```

## MCP command

Use this command in Cline's MCP server configuration after replacing the absolute path with the local clone path:

```json
{
  "mcpServers": {
    "thecrawler": {
      "command": "node",
      "args": ["/absolute/path/to/TheCrawler/engine/dist/mcp.js"],
      "env": {
        "NODE_OPTIONS": "--use-system-ca"
      }
    }
  }
}
```

On Windows, the equivalent `args` path looks like:

```json
["C:/Users/you/path/to/TheCrawler/engine/dist/mcp.js"]
```

`NODE_OPTIONS=--use-system-ca` is optional on most machines. It helps on Windows systems where Node's bundled certificate store fails against npm or HTTPS targets.

## Optional LLM defaults

The crawl tools do not require an LLM. The `extract_structured` tool can use any OpenAI-compatible chat-completions endpoint.

```json
{
  "THECRAWLER_LLM_BASEURL": "http://localhost:1234/v1/chat/completions",
  "THECRAWLER_LLM_MODEL": "your-model-name"
}
```

Add `THECRAWLER_LLM_API_KEY` only if your endpoint requires it. Do not put API keys in public issues, screenshots, or committed files.

## Tools exposed

- `list_extraction_contracts`
- `diagnose_extraction_contract`
- `extract_extraction_contract`
- `crawl`
- `crawl_markdown`
- `search_and_crawl`
- `crawl_sitemap`
- `extract_structured`

## Verification used before Marketplace submission

From `engine/`, this sequence was tested locally:

```bash
npm run build
node dist/mcp.js
```

The MCP server initialized successfully, listed all eight tools, and `crawl_markdown` returned Markdown for `https://example.com`.

## Notes

The current public GitHub source includes validated extraction contracts and contract diagnostics. The npm package remains `thecrawler@0.1.1` until the next publish, so Cline should install from the GitHub clone path above for the current MCP build.
