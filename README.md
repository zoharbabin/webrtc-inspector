# webrtc-inspector

[![CI](https://github.com/zoharbabin/webrtc-inspector/actions/workflows/ci.yml/badge.svg)](https://github.com/zoharbabin/webrtc-inspector/actions/workflows/ci.yml)

Framework-agnostic WebRTC inspection and fault injection. Patches standard browser globals — works on any page, regardless of SDK or framework.

## What it patches

`RTCPeerConnection` (tracks, transceivers, SDP, ICE, data channels), `RTCDataChannel.send`, `RTCRtpSender.replaceTrack`, `RTCRtpSender`/`Receiver.createEncodedStreams()`, `MediaStreamTrack.stop`, `WebSocket`, `fetch`/`XMLHttpRequest`, `getUserMedia`/`getDisplayMedia`.

`fetch`/`XMLHttpRequest` capture covers HTTP-based signaling (WHIP/WHEP and similar SDP-over-HTTP) that isn't visible to the `RTCPeerConnection`/`WebSocket` patches — request/response previews land in `getSnapshot().httpRequests`, and `simulateNetworkLoss({targets: ['http']})` can fail them on demand.

Must run before the page's own scripts grab references to these globals — see Usage.

`MediaStreamTrack.stop` is patched directly because the spec doesn't fire `'ended'` for a self-initiated `stop()` — only for externally-caused endings.

## Usage

| Method | When to use | How |
|---|---|---|
| Chrome extension | Interactive, ad hoc inspection | `chrome://extensions` → Developer mode → Load unpacked → `extension/`. DevTools → "WebRTC Inspector" panel. |
| Playwright | Scripted/automated tests | `await page.addInitScript({ path: 'core/webrtc-inspector.js' }); await page.goto(url);` — runs before any page script, on every navigation. |
| DevTools console paste | One-off manual inspection | Paste `core/webrtc-inspector.js` into the console *before* the connection you want to inspect is created. |

`extension/core/webrtc-inspector.js` is canonical; `core/webrtc-inspector.js` is a symlink to it. Keep it that way — a symlink pointing *outside* `extension/` silently loads as empty under Chrome's unpacked-extension loader (sandboxed to the selected folder), with no error.

MCP-style Playwright tools that only expose post-navigation `browser_evaluate` can't match `addInitScript`'s timing — anything created before `browser_evaluate` runs goes unpatched. Use the extension instead for that workflow.

## API — `window.__webrtcInspector`

| Method | Does |
|---|---|
| `getSnapshot(opts?)` | Full state: connections, tracks, SDP/ICE summaries, data channels, WebSockets, HTTP requests, stats, flags, last 100 log entries. JSON-serializable. `opts.detail: 'concise'` drops the raw stats report, log, and message/request-body dumps — keeps derived metrics (`qualityScore`, `avSyncDeltaMs`, candidate types, etc.) for routine health checks at a fraction of the tokens. Defaults to `'detailed'` (today's full output). |
| `getSnapshotDiff(before, after)` | Pure function over two `getSnapshot()` outputs — structured delta: connections/WebSockets added/removed, and for ones present in both, only the fields that changed (ICE/connection/signaling state, track/data-channel counts, `qualityScore`, `avSyncDeltaMs`, candidate type, socket counts). No new instrumentation; works with either detail mode. |
| `exportBundle()` | One portable, JSON-serializable object for attaching to a bug report: a detailed `getSnapshot()`, the *full* event log (not just the last 100 entries `getSnapshot()` keeps), and each connection's full `statsHistory` (not just the latest sample). `{exportedAt, version, snapshot, fullLog, statsHistory}`. |
| `captureEvents()` / `diffCaptures(before, after)` | Regression fixtures: `captureEvents()` snapshots the event stream as `{capturedAt, events}`; save two captures (e.g. from different SDK versions) and pass them to the pure `diffCaptures(before, after)` to see whether a connection's event *shape* changed — per-type event-count deltas (`eventTypeCounts`), total lengths (`sequenceLengths`), and the first index where the two event-type sequences diverge (`firstDivergenceIndex`, `null` if one is a clean prefix of the other or they're identical). |
| `onEvent(fn)` | Subscribe to the live event log. |
| `clearLog()` | Drop accumulated log/stats history. |
| `getSdp(connId)` | `{local, remote}` full SDP for a connection. |
| `getRemoteTrackStream(connId, trackId)` | Live `MediaStream` for one remote track — pipe into `<audio>`/`<video>`/`AnalyserNode`. |
| `replaceOutgoingTrack(connId, kind, track)` | Swap a sender's outgoing track. |
| `setFakeMic(base64\|ArrayBuffer)` / `clearFakeMic()` | Route future `getUserMedia({audio:true})` to a synthetic source / restore real mic. |
| `injectAudio(base64\|ArrayBuffer)` | `setFakeMic` + play immediately (one-shot). |
| `playIntoFakeMic()` | Replay the armed fake-mic buffer. |
| `getFakeMicTrack()` | Fresh cloned track from the fake-mic source, for manual `replaceTrack()`. |
| `setFakeCam({width,height,color,text,fps})` / `clearFakeCam()` | Synthetic canvas video source for `getUserMedia({video:true})` / restore real camera. |
| `injectDataChannelMessage(connId, label, data)` | Send *from* that connection's channel, as if that peer sent it. |
| `setDataChannelInterceptor(fn)` / `clearDataChannelInterceptor()` | `fn(dir, {connId, label, data})` on every send/deliver. Return new data to rewrite, `false` to block, nothing to pass through. Opt-in — inert until called. |
| `registerDecoder(matcher, decodeFn)` | Consumer-supplied protocol decoding for data-channel/WebSocket messages, in place of raw string/byte-count previews. `matcher(meta) -> boolean` where `meta = {kind: 'datachannel'\|'websocket', connectionId?, socketId?, label?, url?, dir: 'in'\|'out'}`; first registered match wins. `decodeFn(normalizedData, meta) -> any` (`normalizedData` is `string \| ArrayBuffer`, `Blob` pre-normalized) — may return a value or a Promise. Runs after any interceptor, so a decoder sees the data as actually delivered/sent. Returns an unsubscribe closure, same convention as `onEvent`. |
| `setWebSocketInterceptor(fn)` / `clearWebSocketInterceptor()` | Same pattern as above, for every tracked `WebSocket`: `fn(dir, {socketId, url, data})`. |
| `injectWebSocketMessage(socketId, data)` | Synthetic incoming `message` event — no real network involved. |
| `sendOnWebSocket(socketId, data)` | Real `send()` on a tracked socket, as if the app called it. |
| `killConnection(connId)` | Real `pc.close()` — genuine abrupt transport death. Tests cold-reconnect, not blip recovery. |
| `simulateNetworkLoss(durationMs, {targets})` | Real dropped sends on `websocket`/`datachannel` (default both) for `durationMs`, then auto-restore. Add `'http'` to `targets` to also fail every `fetch`/`XMLHttpRequest` for the duration (real rejection/error, request never sent) — covers HTTP-polled signaling (WHIP/WHEP). Add `'media'` to drop every real encoded audio/video frame for the duration, via `setMediaFaultInjector` underneath (Chromium-only, same as that primitive) — restores whatever media fault injector, if any, was already active. Composes with any active interceptor. Returns `{stop, done}`. |
| `setMediaFaultInjector(connId, kind, fn)` / `clearMediaFaultInjector()` | Fault injection on real, already-encoded RTP media frames via Insertable Streams. `connId`/`kind` (`'audio'`\|`'video'`) scope which sender/receiver `fn` runs for — `null` for either matches all. `fn(direction, frame, meta)` runs per frame, `direction: 'outgoing'` (sender, pre-network) \| `'incoming'` (receiver, post-network), `frame` is the live `RTCEncodedVideoFrame`/`RTCEncodedAudioFrame`, `meta = {connId, kind, trackId}`. To corrupt: mutate `frame.data` in place (a writable `ArrayBuffer`) and return nothing — the mutated frame flows through. To drop: return `false`. To duplicate: return `'duplicate'`. To delay (and, by giving neighboring frames different delays, reorder): return `{delayMs}`. Only one injector active at a time, same convention as the data-channel/WebSocket interceptors. Chromium-only (`RTCRtpSender`/`Receiver.createEncodedStreams()` isn't a cross-browser standard yet) — no-ops elsewhere. |

Every track from patched `getUserMedia`/`getDisplayMedia` is tagged (`fake-mic`/`real-device`/`display-capture`/`fake-cam`) and the tag follows it into connection logging — `getSnapshot()` shows exactly which connection consumed which source.

### `qualityScore` (MOS-style, 1-5)

`getSnapshot().connections[].qualityScore` is a single 1-5 number meant to answer "is this connection fine or bad" without RTP domain knowledge. It averages up to two sub-scores, each computed from stats already being polled — `null` when neither is available:

- **Audio** — a simplified ITU-T G.107 E-model: effective latency (`RTT + jitter*2 + 10`) and packet loss feed an R-factor, converted to MOS via the standard cubic. Same constants as [rtpengine's implementation](https://telecom.altanai.com/2018/04/17/voip-call-metric-monitoring/) and [this write-up](https://stackoverflow.com/questions/54124329/is-there-a-formula-for-rating-webrtc-audio-quality-as-excellent-good-fair-or). Ignores codec-specific impairment and echo.
- **Video** — no standardized equivalent exists, so this uses bits-delivered-per-pixel-per-frame (a common encoder-tuning heuristic: ~0.1 bpp is solidly good H.264/VP8, below ~0.01 bpp is visibly blocky) linearly mapped onto 1-5. Ignores content complexity and codec efficiency.

Both are approximations for a live diagnostic signal, not certified MOS/VMAF measurements — use `qualityScore` to spot "this call is degrading," not to certify codec performance.

### Reconnect / fault-injection testing

`browserContext.setOffline()` and DevTools' `Network.emulateNetworkConditions` don't touch already-flowing WebRTC UDP media — both act on the network-service layer, which WebRTC bypasses. `pfctl`/`tc` (OS-level) is the traditional fallback; `setMediaFaultInjector` (Chromium only) is the page-JS-only alternative for already-flowing media.

`killConnection`, `simulateNetworkLoss`, and `setMediaFaultInjector` are the real alternatives — each tests a different failure mode:

| Primitive | Tests |
|---|---|
| `killConnection` | Does the client detect the peer connection is gone and start a fresh session? (abrupt death, not a blip) |
| `simulateNetworkLoss` | Does the client's heartbeat/backoff logic detect a control-plane outage and recover once it clears, without killing media? Pick `durationMs` well past any known heartbeat interval so the outage is unambiguous. |
| `setMediaFaultInjector` | Does the client tolerate real packet loss/reorder/duplication on live RTP media (concealment, jitter buffer, PLI/NACK requests) without treating it as a connection failure? |

## Known limitations

- **`setMediaFaultInjector` is Chromium-only**: it uses `createEncodedStreams()`, a Chrome-specific `RTCRtpSender`/`Receiver` extension. The standards-track replacement, `RTCRtpScriptTransform`, requires a dedicated `Worker` and isn't implemented here yet — no-ops silently on Firefox/Safari and any Chromium build without support.
- **Decoded message payloads are not redacted**: `registerDecoder`'s output is capped in size like `preview()` but not scrubbed of secrets. A fully decoded payload (parsed protobuf, vendor framing) can surface more PII/tokens/user data in `getSnapshot()`/`recentLog`/exported bundles than a truncated string preview would. Scrubbing decoder output of secrets before persisting or sharing a snapshot is the caller's responsibility.
- **SFU app-message channels**: some SFU transports (e.g. mediasoup-client) route control-plane messages over a signaling `WebSocket` instead of a literal `RTCDataChannel` — invisible to pure `RTCDataChannel` instrumentation. Covered here since `WebSocket` is patched too.
- **Unpatched transports**: WebTransport, SSE, or a native non-browser channel carrying control-plane traffic stays invisible. Open category, not exhaustively covered.
- **Timing-dependent**: instrumentation only sees connections/tracks/channels created *after* the patch runs — see Usage for injection-timing caveats per method.

## Roadmap

Tracked as issues: https://github.com/zoharbabin/webrtc-inspector/issues

## Testing

Playwright suite under `test/specs/`, one file per feature area (peer connections, data channels, WebSockets, fake mic/cam, network-fault primitives). Every spec connects two `RTCPeerConnection`s directly in one page (no signaling server) via the shared helper in `test/fixtures/session-helpers.js`.

```sh
npm install
npx playwright install --with-deps chromium   # once
npm test                                      # headless run
npm run test:ui                               # interactive UI mode
npm run lint
```

CI (`.github/workflows/ci.yml`) runs lint + the full suite on every push/PR, posts a pass/fail table to the job summary, and uploads the full HTML report (traces, screenshots on failure) as an artifact.

## License

MIT — see [LICENSE](LICENSE).
