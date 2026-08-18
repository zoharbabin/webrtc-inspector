# webrtc-inspector

[![CI](https://github.com/zoharbabin/webrtc-inspector/actions/workflows/ci.yml/badge.svg)](https://github.com/zoharbabin/webrtc-inspector/actions/workflows/ci.yml)

Framework-agnostic WebRTC inspection and fault injection. Patches standard browser globals — works on any page, regardless of SDK or framework.

## What it patches

`RTCPeerConnection` (tracks, transceivers, SDP, ICE, data channels), `RTCDataChannel.send`, `RTCRtpSender.replaceTrack`, `MediaStreamTrack.stop`, `WebSocket`, `getUserMedia`/`getDisplayMedia`.

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
| `getSnapshot()` | Full state: connections, tracks, SDP/ICE summaries, data channels, WebSockets, stats, flags, last 100 log entries. JSON-serializable. |
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
| `setWebSocketInterceptor(fn)` / `clearWebSocketInterceptor()` | Same pattern as above, for every tracked `WebSocket`: `fn(dir, {socketId, url, data})`. |
| `injectWebSocketMessage(socketId, data)` | Synthetic incoming `message` event — no real network involved. |
| `sendOnWebSocket(socketId, data)` | Real `send()` on a tracked socket, as if the app called it. |
| `killConnection(connId)` | Real `pc.close()` — genuine abrupt transport death. Tests cold-reconnect, not blip recovery. |
| `simulateNetworkLoss(durationMs, {targets})` | Real dropped sends on `websocket`/`datachannel` (default both) for `durationMs`, then auto-restore. Composes with any active interceptor. Returns `{stop, done}`. |

Every track from patched `getUserMedia`/`getDisplayMedia` is tagged (`fake-mic`/`real-device`/`display-capture`/`fake-cam`) and the tag follows it into connection logging — `getSnapshot()` shows exactly which connection consumed which source.

### `qualityScore` (MOS-style, 1-5)

`getSnapshot().connections[].qualityScore` is a single 1-5 number meant to answer "is this connection fine or bad" without RTP domain knowledge. It averages up to two sub-scores, each computed from stats already being polled — `null` when neither is available:

- **Audio** — a simplified ITU-T G.107 E-model: effective latency (`RTT + jitter*2 + 10`) and packet loss feed an R-factor, converted to MOS via the standard cubic. Same constants as [rtpengine's implementation](https://telecom.altanai.com/2018/04/17/voip-call-metric-monitoring/) and [this write-up](https://stackoverflow.com/questions/54124329/is-there-a-formula-for-rating-webrtc-audio-quality-as-excellent-good-fair-or). Ignores codec-specific impairment and echo.
- **Video** — no standardized equivalent exists, so this uses bits-delivered-per-pixel-per-frame (a common encoder-tuning heuristic: ~0.1 bpp is solidly good H.264/VP8, below ~0.01 bpp is visibly blocky) linearly mapped onto 1-5. Ignores content complexity and codec efficiency.

Both are approximations for a live diagnostic signal, not certified MOS/VMAF measurements — use `qualityScore` to spot "this call is degrading," not to certify codec performance.

### Reconnect / fault-injection testing

`browserContext.setOffline()` and DevTools' `Network.emulateNetworkConditions` don't touch already-flowing WebRTC UDP media — both act on the network-service layer, which WebRTC bypasses. There's no page-JS way to force transient packet loss on live media without OS-level control (`pfctl`/`tc`).

`killConnection` and `simulateNetworkLoss` are the real, OS-access-free alternatives — each tests a different failure mode:

| Primitive | Tests |
|---|---|
| `killConnection` | Does the client detect the peer connection is gone and start a fresh session? (abrupt death, not a blip) |
| `simulateNetworkLoss` | Does the client's heartbeat/backoff logic detect a control-plane outage and recover once it clears, without killing media? Pick `durationMs` well past any known heartbeat interval so the outage is unambiguous. |

## Known limitations

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
