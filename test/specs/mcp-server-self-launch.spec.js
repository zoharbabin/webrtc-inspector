// #78 — MCP server self-launch fallback when no CDP endpoint is reachable.
// Exercises mcp/server.js as a real subprocess (like mcp-server.spec.js) but
// points WRTC_CDP_ENDPOINT at a port nothing is listening on, so getPage()'s
// connectOverCDP fails and mcp/browser.js falls back to launching its own
// Chromium with core/webrtc-inspector.js pre-injected via addInitScript.
const path = require('path');
const { test, expect } = require('@playwright/test');
const { chromium } = require('playwright-core');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const UNREACHABLE_CDP_ENDPOINT = 'http://127.0.0.1:19222'; // nothing listens here
const NO_PRELOAD_URL = 'http://127.0.0.1:8931/test/fixtures/no-preload.html';
const SERVER_PATH = path.join(__dirname, '..', '..', 'mcp', 'server.js');

test.describe('MCP server self-launch fallback (no reachable CDP endpoint)', () => {
  test.describe.configure({ mode: 'serial' });

  let client;

  test.beforeAll(async () => {
    client = new Client({ name: 'mcp-server-self-launch-spec', version: '0.0.0' });
    const transport = new StdioClientTransport({
      command: 'node',
      args: [SERVER_PATH],
      env: { ...process.env, WRTC_CDP_ENDPOINT: UNREACHABLE_CDP_ENDPOINT, WRTC_HEADLESS: 'true' },
    });
    await client.connect(transport);
  });

  test.afterAll(async () => {
    await client?.close();
  });

  function callTool(name, args = {}) {
    return client.callTool({ name, arguments: args });
  }

  async function toolJson(name, args = {}) {
    const result = await callTool(name, args);
    return JSON.parse(result.content[0].text);
  }

  test('lists wrtc_navigate alongside the existing tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['wrtc_navigate', 'wrtc_get_snapshot']));
  });

  test('wrtc_navigate self-launches a Chromium and lands on the target page', async () => {
    const result = await toolJson('wrtc_navigate', { url: NO_PRELOAD_URL });
    expect(result).toEqual({ navigated: true, url: NO_PRELOAD_URL });
  });

  test('wrtc_get_snapshot sees the connection created before any page script could run — proves pre-injection', async () => {
    const snapshot = await toolJson('wrtc_get_snapshot');
    expect(snapshot.connections.length).toBe(1);
  });

  test('wrtc_kill_connection works against the self-launched page too', async () => {
    const snapshot = await toolJson('wrtc_get_snapshot');
    const connId = snapshot.connections[0].id;
    const result = await callTool('wrtc_kill_connection', { connId });
    expect(result.isError).toBeUndefined();
  });
});

test.describe('MCP server attach-mode regression: reachable endpoint, no instrumented page', () => {
  const CDP_PORT = 9334;
  let browser;
  let client;

  test.beforeAll(async () => {
    browser = await chromium.launch({ args: [`--remote-debugging-port=${CDP_PORT}`] });
    await browser.newPage(); // deliberately never loads core/webrtc-inspector.js

    client = new Client({ name: 'mcp-server-no-instrumented-page-spec', version: '0.0.0' });
    const transport = new StdioClientTransport({
      command: 'node',
      args: [SERVER_PATH],
      env: { ...process.env, WRTC_CDP_ENDPOINT: `http://127.0.0.1:${CDP_PORT}` },
    });
    await client.connect(transport);
  });

  test.afterAll(async () => {
    await client?.close();
    await browser?.close();
  });

  test('wrtc_get_snapshot stays a real error instead of silently self-launching', async () => {
    const result = await client.callTool({ name: 'wrtc_get_snapshot', arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No page with window.__webrtcInspector found');
  });
});
