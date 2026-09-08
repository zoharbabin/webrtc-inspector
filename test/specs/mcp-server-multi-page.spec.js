// Multiple tabs get auto-instrumented in real usage (the extension injects
// into every tab; two Playwright pages sharing one attached browser hit the
// same thing). Before this fix, getPage() picked whichever instrumented page
// it found first and every tool silently acted on it — wrtc_kill_connection
// could close page A's connection while the caller asked for page B's,
// still reporting {"ok":true}. Now more than one instrumented page without a
// disambiguating pageUrl is a hard error instead of a guess.
const path = require('path');
const { test, expect } = require('@playwright/test');
const { chromium } = require('playwright-core');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const CDP_PORT = 9337;
const FIXTURE_URL = 'http://127.0.0.1:8931/test/fixtures/base.html';
const SERVER_PATH = path.join(__dirname, '..', '..', 'mcp', 'server.js');

test.describe('MCP server: multiple instrumented pages', () => {
  test.describe.configure({ mode: 'serial' });

  let browser;
  let pageA;
  let pageB;
  let client;

  test.beforeAll(async () => {
    browser = await chromium.launch({ args: [`--remote-debugging-port=${CDP_PORT}`] });
    pageA = await browser.newPage();
    await pageA.goto(FIXTURE_URL);
    await pageA.waitForFunction(() => !!window.__webrtcInspector);
    await pageA.evaluate(() => window.testHelpers.createLoopbackSession('page-A-session'));

    pageB = await browser.newPage();
    await pageB.goto(FIXTURE_URL);
    await pageB.waitForFunction(() => !!window.__webrtcInspector);
    await pageB.evaluate(() => window.testHelpers.createLoopbackSession('page-B-session'));

    client = new Client({ name: 'mcp-multi-page-spec', version: '0.0.0' });
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

  test('a tool call with no pageUrl is a clear error naming both pages, not a silent guess', async () => {
    const result = await client.callTool({ name: 'wrtc_get_snapshot', arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('2 instrumented pages found');
    expect(result.content[0].text).toContain(FIXTURE_URL);
    expect(result.content[0].text).toContain('pageUrl');
  });

  test('a pageUrl matching neither page is a distinct, actionable error', async () => {
    const idA = await pageA.evaluate(() => window.__webrtcInspector.getSnapshot().connections[0].id);
    const result = await client.callTool({
      name: 'wrtc_kill_connection',
      arguments: { connId: idA, pageUrl: 'http://127.0.0.1:8931/no-such-page.html' },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('matched no instrumented page');
  });

  test('an exact pageUrl match kills only that page\'s connection, leaving the other untouched', async () => {
    const idA = await pageA.evaluate(() => window.__webrtcInspector.getSnapshot().connections.find((c) => !c.closed).id);
    const idBBefore = await pageB.evaluate(() => window.__webrtcInspector.getSnapshot().connections.find((c) => !c.closed).id);

    const result = await client.callTool({
      name: 'wrtc_kill_connection',
      arguments: { connId: idA, pageUrl: FIXTURE_URL },
    });
    expect(result.isError).toBe(true); // FIXTURE_URL alone still matches both pages (same URL) — stays ambiguous
    expect(result.content[0].text).toContain('2 instrumented pages');

    // Give page A a distinguishing marker so pageUrl can select it uniquely.
    await pageA.evaluate(() => { window.history.replaceState(null, '', window.location.pathname + '?tab=A'); });
    const urlA = pageA.url();

    const killResult = await client.callTool({
      name: 'wrtc_kill_connection',
      arguments: { connId: idA, pageUrl: urlA },
    });
    expect(killResult.isError).toBeUndefined();

    await pageA.waitForFunction(
      (id) => window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === id).closed === true,
      idA
    );
    const stillOpenOnB = await pageB.evaluate(
      (id) => window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === id).closed === false,
      idBBefore
    );
    expect(stillOpenOnB).toBe(true);
  });
});
