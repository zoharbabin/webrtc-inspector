// Typed MCP tools wrapping window.__webrtcInspector's public API — see #22.
//
// Every tool here is pure JSON in/out over CDP page.evaluate(). Methods that
// require a live JS reference as an argument or return one (setMediaFaultInjector,
// setDataChannelInterceptor, setWebSocketInterceptor, registerDecoder, onEvent,
// replaceOutgoingTrack, getFakeMicTrack) can't cross that boundary and are not
// exposed here — use core/webrtc-inspector.js directly in-page for those.
const { z } = require('zod');
const { getPage } = require('./browser');

function textResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value === undefined ? { ok: true } : value) }] };
}

function errorResult(err) {
  return { content: [{ type: 'text', text: err && err.message ? err.message : String(err) }], isError: true };
}

function registerSimpleTool(server, cdpEndpoint, name, description, inputSchema, method, toArgs) {
  const config = { description };
  if (inputSchema) config.inputSchema = inputSchema;
  server.registerTool(name, config, async (input) => {
    try {
      const page = await getPage(cdpEndpoint);
      const args = toArgs ? toArgs(input) : [];
      const result = await page.evaluate(([m, a]) => window.__webrtcInspector[m](...a), [method, args]);
      return textResult(result);
    } catch (err) {
      return errorResult(err);
    }
  });
}

function registerTools(server, cdpEndpoint) {
  registerSimpleTool(
    server,
    cdpEndpoint,
    'wrtc_get_snapshot',
    "Full webrtc-inspector snapshot: connections, tracks, SDP/ICE, data channels, WebSockets, stats, flags. detail:'concise' drops raw dumps and keeps derived metrics.",
    { detail: z.enum(['detailed', 'concise']).optional() },
    'getSnapshot',
    ({ detail }) => (detail ? [{ detail }] : [])
  );

  registerSimpleTool(
    server,
    cdpEndpoint,
    'wrtc_get_snapshot_diff',
    'Structured delta between two wrtc_get_snapshot outputs — only the fields that changed.',
    { before: z.any(), after: z.any() },
    'getSnapshotDiff',
    ({ before, after }) => [before, after]
  );

  registerSimpleTool(
    server,
    cdpEndpoint,
    'wrtc_export_bundle',
    'Portable bug-report bundle: detailed snapshot, full event log, and full per-connection stats history.',
    undefined,
    'exportBundle'
  );

  registerSimpleTool(
    server,
    cdpEndpoint,
    'wrtc_export_webrtc_internals_dump',
    'Export diagnostics in the same JSON shape chrome://webrtc-internals\' "Create Dump" produces ({UserAgent, getUserMedia, PeerConnections}), for use with existing webrtc-internals-compatible analysis tools.',
    undefined,
    'exportWebrtcInternalsDump'
  );

  registerSimpleTool(
    server,
    cdpEndpoint,
    'wrtc_capture_events',
    'Snapshot the event stream as {capturedAt, events} for a later wrtc_diff_captures call.',
    undefined,
    'captureEvents'
  );

  registerSimpleTool(
    server,
    cdpEndpoint,
    'wrtc_diff_captures',
    'Diff two wrtc_capture_events outputs: per-type event-count deltas, sequence lengths, first divergence index.',
    { before: z.any(), after: z.any() },
    'diffCaptures',
    ({ before, after }) => [before, after]
  );

  registerSimpleTool(
    server,
    cdpEndpoint,
    'wrtc_get_sdp',
    'Full local/remote SDP strings for a connection.',
    { connId: z.number() },
    'getSdp',
    ({ connId }) => [connId]
  );

  registerSimpleTool(
    server,
    cdpEndpoint,
    'wrtc_clear_log',
    'Drop accumulated event log/stats history.',
    undefined,
    'clearLog'
  );

  registerSimpleTool(
    server,
    cdpEndpoint,
    'wrtc_kill_connection',
    'Real pc.close() — abrupt transport death. Tests cold-reconnect, not blip recovery.',
    { connId: z.number() },
    'killConnection',
    ({ connId }) => [connId]
  );

  registerSimpleTool(
    server,
    cdpEndpoint,
    'wrtc_restart_ice',
    "Real pc.restartIce() — renegotiate-in-place without tearing down the connection. A different recovery path than wrtc_kill_connection.",
    { connId: z.number() },
    'restartIce',
    ({ connId }) => [connId]
  );

  registerSimpleTool(
    server,
    cdpEndpoint,
    'wrtc_cap_encoding',
    "Force an active sender's encoding params (getParameters()/mutate/setParameters()) — simulates a bandwidth-constrained encoder decision deterministically. Omit a field to leave it as-is.",
    {
      connId: z.number(),
      kind: z.enum(['audio', 'video']),
      maxBitrate: z.number().optional(),
      maxFramerate: z.number().optional(),
      scaleResolutionDownBy: z.number().optional(),
      degradationPreference: z.enum(['maintain-framerate', 'maintain-resolution', 'balanced']).optional(),
    },
    'capEncoding',
    ({ connId, kind, ...caps }) => [connId, kind, caps]
  );

  registerSimpleTool(
    server,
    cdpEndpoint,
    'wrtc_set_fake_cam',
    "Synthetic canvas video source for future getUserMedia({video:true}) calls.",
    {
      width: z.number().optional(),
      height: z.number().optional(),
      color: z.string().optional(),
      text: z.string().optional(),
      fps: z.number().optional(),
    },
    'setFakeCam',
    (opts) => [opts]
  );

  registerSimpleTool(server, cdpEndpoint, 'wrtc_clear_fake_cam', 'Restore the real camera for future getUserMedia calls.', undefined, 'clearFakeCam');

  registerSimpleTool(
    server,
    cdpEndpoint,
    'wrtc_set_fake_mic',
    'Route future getUserMedia({audio:true}) calls to a synthetic source decoded from base64 audio.',
    { audioBase64: z.string() },
    'setFakeMic',
    ({ audioBase64 }) => [audioBase64]
  );

  registerSimpleTool(server, cdpEndpoint, 'wrtc_clear_fake_mic', 'Restore the real mic for future getUserMedia calls.', undefined, 'clearFakeMic');

  registerSimpleTool(
    server,
    cdpEndpoint,
    'wrtc_inject_audio',
    'setFakeMic + play immediately (one-shot) from base64 audio.',
    { audioBase64: z.string() },
    'injectAudio',
    ({ audioBase64 }) => [audioBase64]
  );

  registerSimpleTool(server, cdpEndpoint, 'wrtc_play_into_fake_mic', 'Replay the currently armed fake-mic buffer.', undefined, 'playIntoFakeMic');

  registerSimpleTool(
    server,
    cdpEndpoint,
    'wrtc_inject_data_channel_message',
    'Send from a connection\'s data channel as if that peer sent it.',
    { connId: z.number(), label: z.string(), data: z.string() },
    'injectDataChannelMessage',
    ({ connId, label, data }) => [connId, label, data]
  );

  registerSimpleTool(
    server,
    cdpEndpoint,
    'wrtc_inject_web_socket_message',
    'Synthetic incoming WebSocket message — no real network involved.',
    { socketId: z.number(), data: z.string() },
    'injectWebSocketMessage',
    ({ socketId, data }) => [socketId, data]
  );

  registerSimpleTool(
    server,
    cdpEndpoint,
    'wrtc_send_on_web_socket',
    'Real send() on a tracked WebSocket, as if the app called it.',
    { socketId: z.number(), data: z.string() },
    'sendOnWebSocket',
    ({ socketId, data }) => [socketId, data]
  );

  // simulateNetworkLoss returns {stop, done} — a live function + Promise, neither
  // of which survives the MCP JSON boundary. Runs the outage to completion in-page
  // and reports back once it's done, trading the early-stop() handle for a tool
  // call shape that's actually representable.
  server.registerTool(
    'wrtc_simulate_network_loss',
    {
      description:
        "Real dropped sends on websocket/datachannel/media/http for durationMs, then auto-restore. Awaits the full outage and returns once it's done — no early-stop handle over MCP.",
      inputSchema: {
        durationMs: z.number(),
        targets: z.array(z.enum(['websocket', 'datachannel', 'media', 'http'])).optional(),
      },
    },
    async ({ durationMs, targets }) => {
      try {
        const page = await getPage(cdpEndpoint);
        await page.evaluate(
          async ([d, t]) => {
            const loss = window.__webrtcInspector.simulateNetworkLoss(d, t ? { targets: t } : undefined);
            await loss.done;
          },
          [durationMs, targets]
        );
        return textResult({ completed: true, durationMs });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  registerSimpleTool(
    server,
    cdpEndpoint,
    'wrtc_register_network_preset',
    "Register/override a named network-impairment preset: {durationMs, targets, pattern: 'full'|'flapping', flapIntervalMs?}.",
    { name: z.string(), config: z.object({
      durationMs: z.number(),
      targets: z.array(z.enum(['websocket', 'datachannel', 'media', 'http'])),
      pattern: z.enum(['full', 'flapping']),
      flapIntervalMs: z.number().optional(),
    }) },
    'registerNetworkPreset',
    ({ name, config }) => [name, config]
  );

  // Same live-Promise boundary issue as wrtc_simulate_network_loss above —
  // awaits the full preset to completion in-page instead of returning a stop() handle.
  server.registerTool(
    'wrtc_simulate_network_preset',
    {
      description:
        "Run a named network-impairment preset ('home-wifi', '4g-train', 'congested-mobile', or one registered via wrtc_register_network_preset). Awaits completion — no early-stop handle over MCP.",
      inputSchema: { name: z.string() },
    },
    async ({ name }) => {
      try {
        const page = await getPage(cdpEndpoint);
        await page.evaluate(async (n) => {
          const run = window.__webrtcInspector.simulateNetworkPreset(n);
          await run.done;
        }, name);
        return textResult({ completed: true, name });
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}

module.exports = { registerTools };
