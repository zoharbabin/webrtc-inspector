// Before this fix, once getPage() fell back to a self-launched Chromium (no
// reachable CDP endpoint at the time), it stuck there forever — even after
// the user started the real Chrome with --remote-debugging-port a moment
// later, every tool call kept silently talking to the throwaway browser.
// WRTC_ATTACH_RETRY_MS=50 makes the throttled re-probe fast enough to test.
const path = require('path');
const { test, expect } = require('@playwright/test');
const { chromium } = require('playwright-core');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const CDP_PORT = 9338;
const CDP_ENDPOINT = `http://127.0.0.1:${CDP_PORT}`;
const FIXTURE_URL = 'http://127.0.0.1:8931/test/fixtures/base.html';
const SERVER_PATH = path.join(__dirname, '..', '..', 'mcp', 'server.js');

test.describe('MCP server: recovers from self-launch once the real endpoint becomes reachable', () => {
  test.describe.configure({ mode: 'serial' });

  let client;
  let realBrowser;

  test.beforeAll(async () => {
    // Nothing listens on CDP_PORT yet — forces self-launch on first tool call.
    client = new Client({ name: 'mcp-reattach-spec', version: '0.0.0' });
    const transport = new StdioClientTransport({
      command: 'node',
      args: [SERVER_PATH],
      env: { ...process.env, WRTC_CDP_ENDPOINT: CDP_ENDPOINT, WRTC_HEADLESS: 'true', WRTC_ATTACH_RETRY_MS: '50' },
    });
    await client.connect(transport);
  });

  test.afterAll(async () => {
    await client?.close();
    await realBrowser?.close();
  });

  test('falls back to self-launch when nothing is listening', async () => {
    const status = JSON.parse((await client.callTool({ name: 'wrtc_status', arguments: {} })).content[0].text);
    expect(status.mode).toBe('disconnected');
    await client.callTool({ name: 'wrtc_navigate', arguments: { url: FIXTURE_URL } });
    const after = JSON.parse((await client.callTool({ name: 'wrtc_status', arguments: {} })).content[0].text);
    expect(after.mode).toBe('self-launched');
  });

  test('switches back to attached once the real endpoint comes up, without being told to', async () => {
    realBrowser = await chromium.launch({ args: [`--remote-debugging-port=${CDP_PORT}`] });
    const page = await realBrowser.newPage();
    await page.goto(FIXTURE_URL);
    await page.waitForFunction(() => !!window.__webrtcInspector);
    await page.evaluate(() => window.testHelpers.createLoopbackSession('reattach-session'));

    // Retry interval is 50ms; poll a couple of times rather than sleeping a fixed amount.
    await expect(async () => {
      const status = JSON.parse((await client.callTool({ name: 'wrtc_status', arguments: {} })).content[0].text);
      expect(status.mode).toBe('attached');
    }).toPass({ timeout: 5000, intervals: [60, 60, 100, 200] });

    const snapshot = JSON.parse((await client.callTool({ name: 'wrtc_get_snapshot', arguments: {} })).content[0].text);
    expect(snapshot.connections.length).toBeGreaterThanOrEqual(2);
  });
});
