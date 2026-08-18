#!/usr/bin/env node
// MCP server exposing window.__webrtcInspector as typed tools over stdio.
// Attaches to an already-running Chromium via CDP (WRTC_CDP_ENDPOINT, default
// http://localhost:9222) when reachable. Otherwise (#78) mcp/browser.js
// launches its own Chromium with core/webrtc-inspector.js pre-injected — see
// wrtc_navigate and README.md.
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { registerTools } = require('./tools');
const pkg = require('../package.json');

async function main() {
  const cdpEndpoint = process.env.WRTC_CDP_ENDPOINT || 'http://localhost:9222';
  const server = new McpServer({ name: 'webrtc-inspector', version: pkg.version });
  registerTools(server, cdpEndpoint);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { main };
