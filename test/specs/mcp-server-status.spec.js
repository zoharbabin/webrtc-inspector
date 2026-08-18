// #79 — wrtc_status health-check tool. Covers all three documented modes:
// disconnected (nothing reachable yet), self-launched (#78's fallback), and
// attached (both with and without an instrumented page on the current tab).
const path = require('path');
const { test, expect } = require('@playwright/test');
const { chromium } = require('playwright-core');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const pkg = require('../../package.json');

const UNREACHABLE_CDP_ENDPOINT = 'http://127.0.0.1:19223'; // nothing listens here
const NO_PRELOAD_URL = 'http://127.0.0.1:8931/test/fixtures/no-preload.html';
const BASE_URL = 'http://127.0.0.1:8931/test/fixtures/base.html';
const SERVER_PATH = path.join(__dirname, '..', '..', 'mcp', 'server.js');

function spawnClient(name, env) {
  const client = new Client({ name, version: '0.0.0' });
  const transport = new StdioClientTransport({
    command: 'node',
    args: [SERVER_PATH],
    env: { ...process.env, ...env },
  });
  return client.connect(transport).then(() => client);
}

async function statusOf(client) {
  const result = await client.callTool({ name: 'wrtc_status', arguments: {} });
  expect(result.isError).toBeUndefined();
  return JSON.parse(result.content[0].text);
}

test.describe('wrtc_status: disconnected then self-launched', () => {
  test.describe.configure({ mode: 'serial' });
  let client;

  test.beforeAll(async () => {
    client = await spawnClient('status-self-launch-spec', { WRTC_CDP_ENDPOINT: UNREACHABLE_CDP_ENDPOINT, WRTC_HEADLESS: 'true' });
  });

  test.afterAll(async () => {
    await client?.close();
  });

  test('reports disconnected before any tool has tried to connect', async () => {
    const status = await statusOf(client);
    expect(status).toEqual({
      cdpEndpoint: UNREACHABLE_CDP_ENDPOINT,
      mode: 'disconnected',
      pageFound: false,
      pageUrl: null,
      inspectorLoaded: false,
      inspectorVersion: null,
    });
  });

  test('reports self-launched with the real page/version once wrtc_navigate has run', async () => {
    await client.callTool({ name: 'wrtc_navigate', arguments: { url: NO_PRELOAD_URL } });
    const status = await statusOf(client);
    expect(status.mode).toBe('self-launched');
    expect(status.pageFound).toBe(true);
    expect(status.pageUrl).toBe(NO_PRELOAD_URL);
    expect(status.inspectorLoaded).toBe(true);
    expect(status.inspectorVersion).toBe(pkg.version);
  });
});

test.describe('wrtc_status: attached, with an instrumented page', () => {
  const CDP_PORT = 9335;
  let browser;
  let client;

  test.beforeAll(async () => {
    browser = await chromium.launch({ args: [`--remote-debugging-port=${CDP_PORT}`] });
    const page = await browser.newPage();
    await page.goto(BASE_URL);
    await page.waitForFunction(() => !!window.__webrtcInspector);

    client = await spawnClient('status-attached-instrumented-spec', { WRTC_CDP_ENDPOINT: `http://127.0.0.1:${CDP_PORT}` });
  });

  test.afterAll(async () => {
    await client?.close();
    await browser?.close();
  });

  test('reports attached, pageFound, inspectorLoaded, and the real version', async () => {
    const status = await statusOf(client);
    expect(status.mode).toBe('attached');
    expect(status.pageFound).toBe(true);
    expect(status.pageUrl).toBe(BASE_URL);
    expect(status.inspectorLoaded).toBe(true);
    expect(status.inspectorVersion).toBe(pkg.version);
  });
});

test.describe('wrtc_status: attached, no instrumented page', () => {
  const CDP_PORT = 9336;
  let browser;
  let client;

  test.beforeAll(async () => {
    browser = await chromium.launch({ args: [`--remote-debugging-port=${CDP_PORT}`] });
    await browser.newPage(); // deliberately never loads core/webrtc-inspector.js

    client = await spawnClient('status-attached-uninstrumented-spec', { WRTC_CDP_ENDPOINT: `http://127.0.0.1:${CDP_PORT}` });
  });

  test.afterAll(async () => {
    await client?.close();
    await browser?.close();
  });

  test('reports attached and pageFound, but inspectorLoaded: false', async () => {
    const status = await statusOf(client);
    expect(status.mode).toBe('attached');
    expect(status.pageFound).toBe(true);
    expect(status.inspectorLoaded).toBe(false);
    expect(status.inspectorVersion).toBeNull();
  });
});
