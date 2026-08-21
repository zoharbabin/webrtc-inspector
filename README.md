# webrtc-inspector

[![CI](https://github.com/zoharbabin/webrtc-inspector/actions/workflows/ci.yml/badge.svg)](https://github.com/zoharbabin/webrtc-inspector/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40zoharbabin%2Fwebrtc-inspector.svg)](https://www.npmjs.com/package/@zoharbabin/webrtc-inspector)
[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/mkfhlnakkjdmoofccmabhmnplmlglngb.svg)](https://chromewebstore.google.com/detail/webrtc-inspector/mkfhlnakkjdmoofccmabhmnplmlglngb)
[![Get the extension](https://img.shields.io/badge/Chrome%20Web%20Store-Get%20the%20extension-4285F4?logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/webrtc-inspector/mkfhlnakkjdmoofccmabhmnplmlglngb)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A WebRTC debugging and fault-injection tool for any page, any SDK, no app changes needed.

It patches standard browser globals — `RTCPeerConnection`, `WebSocket`, `fetch`, `getUserMedia`, and more — before the page's own code can grab a reference. That gives you a live view of every connection, track, data channel, and signaling message, plus real fault injection to test reconnect logic.

Use it as a Chrome extension, an MCP server for AI coding agents, an npm library, or a Playwright plugin.

## Quick start

**Agent** (Claude Code, etc.) — MCP, zero manual setup:

```sh
claude mcp add webrtc-inspector -- npx -y --package=@zoharbabin/webrtc-inspector webrtc-inspector-mcp
```

Call `wrtc_status` first. If nothing's reachable yet, it self-launches its own Chromium — no human needs to start Chrome.

The bundled [Claude Code Skill](.claude/skills/webrtc-inspector/SKILL.md) adds runnable recipes on top of the tools below: reconnect testing, quality regression triage, signaling-outage testing. Full details: [MCP server](#mcp-server).

**Human** doing interactive debugging — the Chrome extension:

1. [Install from the Chrome Web Store](https://chromewebstore.google.com/detail/webrtc-inspector/mkfhlnakkjdmoofccmabhmnplmlglngb) — one click, no unzip needed.
2. Open DevTools on any page with a WebRTC session.
3. Click the "WebRTC Inspector" panel.

Building the extension from source instead? Download the zip from the [latest release](https://github.com/zoharbabin/webrtc-inspector/releases/latest), unzip, then `chrome://extensions` → Developer mode → Load unpacked → that folder.

Need Playwright or a one-off console paste instead? See the full method comparison in [Usage](#usage).

## What it patches

- `RTCPeerConnection` — tracks, transceivers, SDP, ICE, data channels
- `RTCDataChannel.send`
- `RTCRtpSender.replaceTrack`
- `RTCRtpSender`/`Receiver.createEncodedStreams()`
- `MediaStreamTrack.stop` — patched directly. The spec doesn't fire `'ended'` for a self-initiated `stop()`.
- `WebSocket`
- `fetch` / `XMLHttpRequest` — covers HTTP-based signaling (WHIP/WHEP, SDP-over-HTTP). Previews land in `getSnapshot().httpRequests`. Faultable via `simulateNetworkLoss({targets: ['http']})`.
- `getUserMedia` / `getDisplayMedia`

It must run before the page's own scripts grab references to these globals — that's why it's a `document_start` patch, not a regular script.

## Install

```sh
npm install @zoharbabin/webrtc-inspector
```

`main` resolves to `extension/core/webrtc-inspector.js`. Inside this repo, `core/webrtc-inspector.js` is a symlink to the same file, for repo-relative paths only.

## Usage

Full comparison — [Quick start](#quick-start) above covers the two most common paths (agent → MCP, human → extension); this is reference material for the rest.

| Method | When | How |
|---|---|---|
| Chrome extension | Interactive inspection | See [Quick start](#quick-start). From a clone instead of the release zip: `extension/` or `node_modules/@zoharbabin/webrtc-inspector/extension/`. |
| MCP server | MCP clients (Claude Code, etc.) | See [Quick start](#quick-start) and [MCP server](#mcp-server). |
| Playwright | Scripted tests | `await page.addInitScript({ path: require.resolve('@zoharbabin/webrtc-inspector') })` before `page.goto(url)`. Runs on every navigation. |
| DevTools console paste | One-off manual inspection | Paste `require.resolve('@zoharbabin/webrtc-inspector')`'s contents into the console before the connection is created. |

MCP-style Playwright tools that only expose post-navigation `browser_evaluate` miss anything created before that call — use the extension instead.

## DevTools panel

- **Sparklines** — live bitrate/RTT/jitter/loss per connection, from each 1s `getSnapshot()` poll.
- **Copy buttons** — next to SDP, each data-channel/WebSocket message, and each log entry. Copies JSON to clipboard.
- **Timeline** — per-connection/-WebSocket open/close/error lifecycle, from the same log timestamps.
- **Theme sync** — matches DevTools' dark/light theme automatically.
- **Preserve log** — checkbox. Keeps connection/WebSocket/event history across page navigations. Buffers up to 5 page loads, tagged `page load #N` and dimmed.
- **Filter box** — narrows the log/connection/WebSocket lists live. Free text matches case-insensitively. `type:`, `conn:`, `dir:` tokens (e.g. `type:websocket-message conn:3 dir:out`) AND together.
- **Bad-state-first sort** — connections ranked failed → disconnected → closed → connecting/new → healthy. Ties keep insertion order. A connection ranks by whichever of `connectionState`/`iceConnectionState` is worse.
- **Screenshot capture** — "⏺ Record screenshots" button, off by default. While armed, it captures the tab on connection-created, track-added, or reconnect. Reconnect means ICE/connection state recovering to connected/completed after disconnected/failed. Each thumbnail is keyed to the triggering log entry's `seq` and shown inline — click to open full size. Requires the `tabs` permission and `host_permissions: ["<all_urls>"]`.
- **"Test this stream" overlay** — right-click any `<video>`/`<audio>` element → overlays live kind/status/quality on the element.
- **Per-site adapters** — `extension/adapters.js`: `{match(hostname, href), labeler?, decoders?}`, auto-selected by hostname. Add an entry to `ADAPTERS`, or set `window.__webrtcInspectorAdapters` to override the built-in list.

## API — `window.__webrtcInspector`

| Method | Does |
|---|---|
| `getSnapshot(opts?)` | Full state: connections, tracks, SDP/ICE summaries, data channels, WebSockets, HTTP requests, stats, flags, last 100 log entries. JSON-serializable. `opts.detail: 'concise'` drops raw stats/log/message dumps, keeps derived metrics. Default: `'detailed'`. |
| `getSnapshotDiff(before, after)` | Delta between two `getSnapshot()` outputs: connections/WebSockets added/removed, and changed fields for the rest. |
| `exportBundle()` | `{exportedAt, version, snapshot, fullLog, statsHistory}` — full event log and full per-connection stats history, for bug reports. |
| `exportWebrtcInternalsDump()` | Same data as `exportBundle()`, reshaped to `chrome://webrtc-internals`' "Create Dump" format: `{UserAgent, getUserMedia, PeerConnections: {<id>: {url, rtcConfiguration, updateLog, stats}}}`. |
| `captureEvents()` / `diffCaptures(before, after)` | `captureEvents()` → `{capturedAt, events}`. `diffCaptures` compares two captures: `eventTypeCounts`, `sequenceLengths`, `firstDivergenceIndex` (`null` if identical or one is a prefix of the other). |
| `onEvent(fn)` | Subscribe to the live event log. |
| `getEvents({since?, limit?, maxChars?})` | Paginated log. `since` is a `seq` cursor (0 or omit = start). `maxChars` (default 25000) caps JSON size. Returns `{events, nextSince, remainingCount, truncated, truncationMarker}`. At least one entry is always returned when available. |
| `clearLog()` | Drop accumulated log/stats history. |
| `getSdp(connId)` | `{local, remote}` full SDP. |
| `getTrackDiagnostics(trackIds)` | Matches track ids (e.g. an element's `srcObject.getTracks()`) to a tracked local/remote track. Returns `{connectionId, kind, status, qualityScore, ...}`, `null` if no match. |
| `getRemoteTrackStream(connId, trackId)` | Live `MediaStream` for one remote track. |
| `replaceOutgoingTrack(connId, kind, track)` | Swap a sender's outgoing track. |
| `capEncoding(connId, kind, {maxBitrate, maxFramerate, scaleResolutionDownBy, degradationPreference})` | Force encoding params via `getParameters()`/`setParameters()`. Omit a field to leave it. |
| `setFakeMic(base64\|ArrayBuffer)` / `clearFakeMic()` | Route future `getUserMedia({audio:true})` to a synthetic source / restore real mic. |
| `injectAudio(base64\|ArrayBuffer)` | `setFakeMic` + play immediately. |
| `playIntoFakeMic()` | Replay the armed fake-mic buffer. |
| `getFakeMicTrack()` | Fresh cloned track from the fake-mic source. |
| `setFakeCam({width,height,color,text,fps})` / `clearFakeCam()` | Synthetic canvas video source / restore real camera. |
| `injectDataChannelMessage(connId, label, data)` | Deliver a message as if the remote peer sent it. |
| `setDataChannelInterceptor(fn)` / `clearDataChannelInterceptor()` | `fn(dir, {connId, label, data})` on every send/deliver. Return new data to rewrite, `false` to block, nothing to pass through. |
| `registerDecoder(matcher, decodeFn)` | `matcher(meta) -> boolean`, `meta = {kind, connectionId?, socketId?, label?, url?, dir}`. First match wins. `decodeFn(normalizedData, meta) -> any\|Promise`. Runs after any interceptor. |
| `setSuggestDecoder(fn)` / `clearSuggestDecoder()` | Runs only when no `registerDecoder` matched. Result lands under `suggested` (never `decoded`) with `advisory: true`. This library makes no LLM calls itself. |
| `setLabeler(fn)` / `clearLabeler()` | `fn(meta) -> string\|null`, `meta = {kind:'connection', connectionId, urls}` or `{kind:'websocket', socketId, url}`. Result lands in `label` (`null` if unmatched, or if `fn` throws). |
| `setIceCandidateFilter(connId, fn)` / `clearIceCandidateFilter(connId)` | `fn(candidateType, candidateStr) -> boolean`, `false` drops. Scoped per connection. A throwing `fn` lets the candidate through. |
| `setWebSocketInterceptor(fn)` / `clearWebSocketInterceptor()` | `fn(dir, {socketId, url, data})`, same return contract as the data-channel interceptor. |
| `injectWebSocketMessage(socketId, data)` | Synthetic incoming message, no real network. |
| `sendOnWebSocket(socketId, data)` | Real `send()` on a tracked socket. |
| `killConnection(connId)` | Real `pc.close()` — abrupt transport death. |
| `restartIce(connId)` | Real `pc.restartIce()` — renegotiate in place, no teardown. |
| `simulateNetworkLoss(durationMs, {targets})` | Drops sends on `websocket`/`datachannel` (default both) for `durationMs`, then restores. `'http'` also fails every `fetch`/XHR. `'media'` drops real encoded frames (Chromium only). Returns `{stop, done}`. |
| `simulateNetworkPreset(name)` / `registerNetworkPreset(name, config)` | Named scenarios on `simulateNetworkLoss`. Ships `'home-wifi'`, `'4g-train'`, `'congested-mobile'`. `config = {durationMs, targets, pattern:'full'\|'flapping', flapIntervalMs?}`. Returns `{stop, done}`. |
| `setMediaFaultInjector(connId, kind, fn)` / `clearMediaFaultInjector()` | Per-frame fault injection via Insertable Streams. `kind: 'audio'\|'video'`, `null` matches all. `fn(direction, frame, meta)`, `direction: 'outgoing'\|'incoming'`. Mutate `frame.data` to corrupt; return `false` to drop, `'duplicate'` to duplicate, `{delayMs}` to delay/reorder. One injector at a time. Chromium only. |

Every track from patched `getUserMedia`/`getDisplayMedia` is tagged (`fake-mic`/`real-device`/`display-capture`/`fake-cam`), visible in `getSnapshot()`.

### MCP server

`mcp/server.js` exposes the JSON-serializable API above as typed MCP tools (`wrtc_get_snapshot`, `wrtc_kill_connection`, `wrtc_restart_ice`, `wrtc_simulate_network_loss`, `wrtc_navigate`, `wrtc_status`, etc.).

Call `wrtc_status` first. It never throws. It returns `{cdpEndpoint, mode: 'attached'|'self-launched'|'disconnected', pageFound, pageUrl, inspectorLoaded, inspectorVersion}` even when nothing is connected yet — so an agent can check setup with no try/catch before calling anything else.

- **Attaches** to an already-running Chromium over CDP when `WRTC_CDP_ENDPOINT` (default `http://localhost:9222`) is reachable.
- **Self-launches** its own Chromium otherwise. No human needs to start Chrome first. `core/webrtc-inspector.js` is pre-injected via `addInitScript()` before any page script runs, same as the Playwright path. Headed by default — set `WRTC_HEADLESS=true` for CI or headless use.

```sh
# Attach mode
google-chrome --remote-debugging-port=9222   # or Chromium/Playwright-launched
WRTC_CDP_ENDPOINT=http://localhost:9222 node mcp/server.js   # defaults to that URL

# Self-launch mode: just run it, then call wrtc_navigate({url}) to open a page
node mcp/server.js
```

**Add it to an MCP client** — pick one:

```sh
# npm-installed
claude mcp add webrtc-inspector -- npx -y --package=@zoharbabin/webrtc-inspector webrtc-inspector-mcp

# repo clone
claude mcp add webrtc-inspector -- node /absolute/path/to/webrtc-inspector/mcp/server.js
```

Or the equivalent `.mcp.json`:

```json
{
  "mcpServers": {
    "webrtc-inspector": {
      "command": "npx",
      "args": ["-y", "--package=@zoharbabin/webrtc-inspector", "webrtc-inspector-mcp"]
    }
  }
}
```

`WRTC_CDP_ENDPOINT` is optional — only set it to attach to one specific already-running Chrome instead of letting the server self-launch its own:

```json
{
  "mcpServers": {
    "webrtc-inspector": {
      "command": "npx",
      "args": ["-y", "--package=@zoharbabin/webrtc-inspector", "webrtc-inspector-mcp"],
      "env": { "WRTC_CDP_ENDPOINT": "http://localhost:9222" }
    }
  }
}
```

First call after connecting: `wrtc_status` — confirms `mode` (`attached`/`self-launched`/`disconnected`) and whether a page is instrumented, before you rely on any other tool.

Covers the pure-JSON surface: snapshots/diffs/bundles/captures, `getSdp`, `killConnection`, `restartIce`, `simulateNetworkLoss`, `capEncoding`, fake mic/cam, and data-channel/WebSocket message injection. Also `wrtc_navigate({url})`, which points the current page at a target URL — creating and pre-instrumenting one if none exists yet.

`simulateNetworkLoss` blocks until the outage finishes. There's no early `stop()` across the MCP boundary.

Not exposed, since these are live JS references that can't cross the MCP boundary: `setMediaFaultInjector`, `setDataChannelInterceptor`, `setWebSocketInterceptor`, `registerDecoder`, `setSuggestDecoder`, `setLabeler`, `setIceCandidateFilter`, `onEvent`, `replaceOutgoingTrack`, `getFakeMicTrack`. Use `core/webrtc-inspector.js` in-page for those instead.

### Claude Code Skill

`.claude/skills/webrtc-inspector/SKILL.md` — reconnect-testing, quality-regression-triage, and signaling-outage recipes on top of the MCP tools above, auto-discovered by Claude Code from a project's `.claude/skills/` directory.

Works with no setup in a clone of this repo. In an npm-installed project, Claude Code doesn't scan `node_modules`, so copy the file in once:

```sh
mkdir -p .claude/skills/webrtc-inspector
cp node_modules/@zoharbabin/webrtc-inspector/.claude/skills/webrtc-inspector/SKILL.md .claude/skills/webrtc-inspector/
```

### `qualityScore` (1-5)

`getSnapshot().connections[].qualityScore` — single number, `null` when no data. Averages up to two sub-scores:

- **Audio** — simplified ITU-T G.107 E-model on RTT/jitter/loss. Ignores codec impairment and echo.
- **Video** — bits-delivered-per-pixel-per-frame, linearly mapped to 1-5. Ignores content complexity and codec efficiency.

Approximate diagnostic signal, not a certified MOS/VMAF measurement.

### `flags`

`getSnapshot().connections[].flags` — short machine-readable strings, computed live. Empty when nothing looks wrong.

| Flag | Meaning |
|---|---|
| `ice_stuck_checking_<ms>ms` | ICE in `checking` for over 5s. |
| `datachannel_opened_never_used:<label>` | Channel `open` for over 3s, zero messages. |
| `track_added_no_stats:<trackId>` | Track added over 3s ago, no correlated stats report. |
| `freeze_ratio_bad:<trackId>` | Remote track `freezeRatio` above 10%. |
| `quality_limited_<reason>:<trackId>` | Local track `qualityLimitationReason` is non-`'none'`. |
| `candidate_type_flipped_<n>x` | Selected candidate type flipped (srflx↔relay) 2+ times. |

### Reconnect / fault-injection primitives

`browserContext.setOffline()` and DevTools' `Network.emulateNetworkConditions` don't touch already-flowing WebRTC UDP media. `pfctl`/`tc` is the OS-level fallback. `setMediaFaultInjector` (Chromium only) is the page-JS alternative.

| Primitive | Tests |
|---|---|
| `killConnection` | Fresh-session recovery after abrupt death. |
| `restartIce` | Renegotiate-in-place recovery, no teardown. |
| `simulateNetworkLoss` | Heartbeat/backoff detection of a control-plane outage. Pick `durationMs` past any known heartbeat interval. |
| `setMediaFaultInjector` | Concealment/jitter-buffer/PLI/NACK tolerance to real packet loss/reorder/duplication. |

### Scenario compiler

`extension/scenario-compiler.js` — optional, not loaded by default. Deterministic keyword/regex DSL (no LLM) compiling a scenario phrase into a sequence of the primitives above.

```js
const { compileScenario, runCompiledScenario } = require('@zoharbabin/webrtc-inspector/extension/scenario-compiler.js');

const compiled = compileScenario('drop packets for 3s then kill the connection', { connectionId: 1 });
// compiled.steps -> [
//   { primitive: 'simulateNetworkLoss', args: [3000, { targets: ['media'] }] },
//   { primitive: 'killConnection', args: [1] },
// ]
// compiled.warnings -> [] (unmapped clauses, or kill/restartIce with no connectionId)

await runCompiledScenario(compiled, window.__webrtcInspector, { bundle: true });
// attaches exportBundle() as `bundle`
```

Clauses split on `"then"`/`";"`. Matched in this priority order:

1. Named preset (`"home wifi"`/`"4g train"`/`"congested mobile"`) → `simulateNetworkPreset`
2. `"kill"`/`"terminate"` → `killConnection`
3. `"restart ice"` → `restartIce`
4. A duration (e.g. `"for 5s"`) → `simulateNetworkLoss`

For `simulateNetworkLoss`, `targets` is inferred from keywords: `data channel`, `websocket`/`signaling`, `http`/`whip`/`whep`, `media`/`audio`/`video`/`rtp`/`packet`. Default is `['websocket', 'datachannel']`.

### Signature matching

`extension/signature-matcher.js` — optional, not loaded by default. Pattern-matches a captured event log against named signatures.

```js
const { matchSignatures } = require('@zoharbabin/webrtc-inspector/extension/signature-matcher.js');

const capture = window.__webrtcInspector.captureEvents(); // or exportBundle()
const findings = matchSignatures(capture);
// [{ signature: 'missed-heartbeat-reconnect-gap', scopeKey: 'socketId', scopeId: 1,
//    missedCount: 3, firstMissedSeq: 12, closeSeq: 15, description: '...' }, ...]
```

`matchSignatures(capture, signatures?, opts?)` accepts a raw events array, `captureEvents()`-shaped `{events}`, or `exportBundle()`-shaped `{fullLog}`. Pass `signatures` to run custom ones alongside or instead of the defaults.

| Signature | Flags |
|---|---|
| `missed-heartbeat-reconnect-gap` | `opts.minConsecutive` (default 3) consecutive unanswered outgoing WebSocket/data-channel messages, then close within `opts.windowMs` (default 10000). |
| `abrupt-close-without-recovery` | `websocket-close`/`connection-killed`/failed-or-disconnected `connection-state` with no reconnect or same-connection recovery within `opts.windowMs`. |

### Metrics export

`extension/metrics-exporter.js` — optional, not loaded by default.

```js
const { startMetricsExporter } = require('@zoharbabin/webrtc-inspector/extension/metrics-exporter.js');
const handle = startMetricsExporter(window.__webrtcInspector, {
  endpointUrl: 'http://localhost:9090/api/v1/otlp/v1/metrics',
  format: 'otlp', // or 'prometheus' (default)
  intervalMs: 15000,
  resourceAttributes: { 'service.name': 'my-app' },
  onError: (err) => console.error('metrics push failed', err),
});
// later: handle.stop();
```

Pushes per-connection `qualityScore`, `bitrateKbps`, `rttMs`, `jitterMs`, `lossPct` as gauges. `connection_id` is the only label. Failed pushes route to `onError`, not thrown.

## Known limitations

- **`setMediaFaultInjector` is Chromium-only** — uses `createEncodedStreams()`. No-ops silently elsewhere.
- **Decoded payloads aren't redacted** — `registerDecoder` output is size-capped but not scrubbed. Redaction is the caller's responsibility.
- **SFU app-message channels** — some SFU transports route control-plane messages over `WebSocket` instead of `RTCDataChannel`. Covered here since `WebSocket` is patched.
- **Unpatched transports** — WebTransport, SSE, or a native channel carrying control-plane traffic is invisible.
- **Timing-dependent** — only sees connections/tracks/channels created after the patch runs.

## Roadmap

Tracked as issues: https://github.com/zoharbabin/webrtc-inspector/issues

## Testing

```sh
npm install
npx playwright install --with-deps chromium   # once
npm test                                      # headless run
npm run test:ui                               # interactive UI mode
npm run lint
npm run pack-extension                        # -> dist/webrtc-inspector-extension-v<version>.zip
```

Playwright suite under `test/specs/`, one file per feature area. Specs connect two `RTCPeerConnection`s directly in one page (no signaling server) via `test/fixtures/session-helpers.js`.

`test/specs/mcp-server.spec.js` launches a real Chromium with `--remote-debugging-port`. It spawns `mcp/server.js` as a subprocess over stdio, via the MCP SDK's `Client`, and drives a real loopback session through the MCP tools.

CI (`.github/workflows/ci.yml`) runs lint and the full suite on every push/PR. It posts a pass/fail table to the job summary, and uploads the HTML report — traces and failure screenshots — as an artifact.

Pushing a `v<version>` tag matching `package.json` triggers `.github/workflows/release.yml`. It packs `extension/` and attaches the zip to a GitHub Release.

## License

MIT — see [LICENSE](LICENSE).
