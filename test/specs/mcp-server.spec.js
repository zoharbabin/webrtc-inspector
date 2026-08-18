// End-to-end: a real Chromium exposing CDP, a real loopback WebRTC session on
// one of its pages, and mcp/server.js spawned as a real subprocess talking to
// it over stdio via the MCP SDK's own Client — not just unit-testing handlers.
const path = require('path');
const { test, expect } = require('@playwright/test');
const { chromium } = require('playwright-core');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const CDP_PORT = 9333;
const FIXTURE_URL = 'http://127.0.0.1:8931/test/fixtures/base.html';

test.describe('MCP server tools', () => {
  // One shared browser + MCP subprocess for the whole file (a fixed CDP port
  // can't be bound by more than one worker at once) — run tests in this file
  // in a single worker, in order.
  test.describe.configure({ mode: 'serial' });

  let browser;
  let mcpPage;
  let client;

  test.beforeAll(async () => {
    browser = await chromium.launch({
      args: [
        `--remote-debugging-port=${CDP_PORT}`,
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
      ],
    });
    mcpPage = await browser.newPage();
    await mcpPage.goto(FIXTURE_URL);
    await mcpPage.waitForFunction(() => !!window.__webrtcInspector);

    client = new Client({ name: 'mcp-server-spec', version: '0.0.0' });
    const transport = new StdioClientTransport({
      command: 'node',
      args: [path.join(__dirname, '..', '..', 'mcp', 'server.js')],
      env: { ...process.env, WRTC_CDP_ENDPOINT: `http://127.0.0.1:${CDP_PORT}` },
    });
    await client.connect(transport);
  });

  test.afterAll(async () => {
    await client?.close();
    await browser?.close();
  });

  function callTool(name, args = {}) {
    return client.callTool({ name, arguments: args });
  }

  async function toolJson(name, args = {}) {
    const result = await callTool(name, args);
    return JSON.parse(result.content[0].text);
  }

  test('lists wrtc_ tools including get_snapshot, kill_connection, and restart_ice', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'wrtc_get_snapshot',
        'wrtc_kill_connection',
        'wrtc_restart_ice',
        'wrtc_simulate_network_loss',
        'wrtc_register_network_preset',
        'wrtc_simulate_network_preset',
        'wrtc_export_webrtc_internals_dump',
      ])
    );
  });

  test('wrtc_get_snapshot sees a real loopback session created directly on the page', async () => {
    await mcpPage.evaluate(() => window.testHelpers.createLoopbackSession('mcp-session-1'));
    const snapshot = await toolJson('wrtc_get_snapshot');
    expect(snapshot.connections.length).toBeGreaterThanOrEqual(2);
  });

  test("wrtc_get_snapshot detail: 'concise' drops recentLog but keeps connections", async () => {
    const snapshot = await toolJson('wrtc_get_snapshot', { detail: 'concise' });
    expect(snapshot.recentLog).toBeUndefined();
    expect(Array.isArray(snapshot.connections)).toBe(true);
  });

  test('wrtc_kill_connection closes the targeted connection, visible in the next wrtc_get_snapshot', async () => {
    const { connectionIdA } = await mcpPage.evaluate(() => window.testHelpers.createLoopbackSession('mcp-session-kill'));
    await callTool('wrtc_kill_connection', { connId: connectionIdA });
    await mcpPage.waitForFunction(
      (id) => window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === id).closed === true,
      connectionIdA
    );
    const snapshot = await toolJson('wrtc_get_snapshot');
    expect(snapshot.connections.find((c) => c.id === connectionIdA).closed).toBe(true);
  });

  test('wrtc_kill_connection on an unknown id comes back as an MCP tool error, not a thrown protocol error', async () => {
    const result = await callTool('wrtc_kill_connection', { connId: 999999 });
    expect(result.isError).toBe(true);
  });

  test('wrtc_restart_ice renegotiates a real connection without closing it', async () => {
    const { connectionIdA } = await mcpPage.evaluate(() => window.testHelpers.createLoopbackSession('mcp-session-restart'));
    const result = await callTool('wrtc_restart_ice', { connId: connectionIdA });
    expect(result.isError).toBeUndefined();
    const closed = await mcpPage.evaluate(() => window.__pcA.connectionState === 'closed');
    expect(closed).toBe(false);
  });

  test('wrtc_inject_data_channel_message delivers a real message to the other peer', async () => {
    const { connectionIdA } = await mcpPage.evaluate(() => window.testHelpers.createLoopbackSession('mcp-session-inject'));
    await mcpPage.evaluate(() => {
      window.__dcBMessages = [];
      window.__dcB.addEventListener('message', (e) => window.__dcBMessages.push(e.data));
    });
    await callTool('wrtc_inject_data_channel_message', { connId: connectionIdA, label: 'mcp-session-inject', data: 'from-mcp' });
    await mcpPage.waitForFunction(() => window.__dcBMessages.length >= 1);
    const delivered = await mcpPage.evaluate(() => window.__dcBMessages[0]);
    expect(delivered).toBe('from-mcp');
  });

  test('wrtc_simulate_network_loss awaits the full outage and returns a completion result', async () => {
    await mcpPage.evaluate(() => window.testHelpers.createLoopbackSession('mcp-session-loss'));
    const result = await toolJson('wrtc_simulate_network_loss', { durationMs: 150, targets: ['datachannel'] });
    expect(result.completed).toBe(true);
  });

  test('wrtc_register_network_preset then wrtc_simulate_network_preset runs the registered preset to completion', async () => {
    await mcpPage.evaluate(() => window.testHelpers.createLoopbackSession('mcp-session-preset'));
    await callTool('wrtc_register_network_preset', {
      name: 'mcp-test-preset',
      config: { durationMs: 150, targets: ['datachannel'], pattern: 'full' },
    });
    const result = await toolJson('wrtc_simulate_network_preset', { name: 'mcp-test-preset' });
    expect(result).toEqual({ completed: true, name: 'mcp-test-preset' });
  });

  test('wrtc_simulate_network_preset on an unknown name comes back as an MCP tool error', async () => {
    const result = await callTool('wrtc_simulate_network_preset', { name: 'no-such-preset' });
    expect(result.isError).toBe(true);
  });

  test('wrtc_export_webrtc_internals_dump matches the chrome://webrtc-internals dump shape', async () => {
    const { connectionIdA } = await mcpPage.evaluate(() => window.testHelpers.createLoopbackSession('mcp-session-dump'));
    await mcpPage.waitForFunction(
      (id) => !!window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === id).latestStats,
      connectionIdA
    );
    const dump = await toolJson('wrtc_export_webrtc_internals_dump');
    expect(typeof dump.UserAgent).toBe('string');
    expect(Array.isArray(dump.getUserMedia)).toBe(true);
    const pc = dump.PeerConnections[connectionIdA];
    expect(pc).toBeDefined();
    expect(typeof pc.url).toBe('string');
    expect(Array.isArray(pc.updateLog)).toBe(true);
    expect(pc.updateLog.some((e) => e.type === 'iceconnectionstatechange')).toBe(true);
    const statsKey = Object.keys(pc.stats).find((k) => k.endsWith('-timestamp'));
    expect(statsKey).toBeDefined();
    expect(() => JSON.parse(pc.stats[statsKey].values)).not.toThrow();
  });
});
