# webrtc-inspector

Framework-agnostic tool for live WebRTC inspection and injection: peer connections, tracks, data channels, `getStats()`, plus swapping in a synthetic microphone track and tracking exactly which peer connection consumed it. Born from third-party SDK research, to resolve which of two simultaneous WebRTC sessions on a page consumed a fake-mic override while live-testing a conversational-AI vendor's builder product. It patches standard WebRTC globals, so it works on any page — no dependency on any specific vendor or SDK.

## How it works

`core/webrtc-inspector.js` patches `RTCPeerConnection` (`addTrack`, `addTransceiver`, `setLocalDescription`, `setRemoteDescription`, `addIceCandidate`, `createDataChannel`, and the `icecandidate`/`icecandidateerror`/`track`/`datachannel` events), `RTCDataChannel.prototype.send`, `RTCRtpSender.prototype.replaceTrack`, `MediaStreamTrack.prototype.stop`, `WebSocket` (construction, `send`, message delivery), and `navigator.mediaDevices.getUserMedia`/`getDisplayMedia` at load time. Every connection, track, SDP exchange, ICE candidate, and data channel created afterward is tracked under `window.__webrtcInspector`, regardless of which SDK or framework created it. It must run *before* the page's own scripts grab references to the unpatched globals — injection method depends on the workflow (see Usage below).

`MediaStreamTrack.prototype.stop` is patched directly because the spec doesn't fire the track's `'ended'` event when the page calls `track.stop()` itself — only for externally-caused endings. Without this patch, an explicitly-stopped local track would silently vanish from tracking instead of showing `status: 'ended'`.

## Usage

### 1. Chrome extension (recommended for interactive research)

`extension/` is a Manifest V3 extension that loads the core module as a `document_start`, `world: "MAIN"` content script on every page, and adds a "WebRTC Inspector" DevTools panel.

Install: `chrome://extensions` → enable Developer mode → Load unpacked → select the `extension/` folder.

Open DevTools on any tab → "WebRTC Inspector" panel. Polls the page every second and shows:
- Each peer connection's state, tracks (tagged `fake-mic`/`fake-cam`/`real-device`/`display-capture` by source, with live remote-audio level and `ended` status), SDP summaries, ICE candidate types, data channels
- Every tracked WebSocket (url, state, sent/received counts, last messages)

Panel controls: inject a base64 audio clip into the fake mic, arm a synthetic fake camera, send an arbitrary data-channel or WebSocket message, inject a synthetic incoming WebSocket message, install a rewrite/block interceptor for data channels or WebSockets, swap a connection's outgoing track for the fake-mic track live.

`extension/core/webrtc-inspector.js` is the canonical file. `core/webrtc-inspector.js` (used by the Playwright/console-paste workflows below) is a symlink to it, not the reverse.

**Gotcha:** a symlink pointing *outside* `extension/` (e.g. `extension/core -> ../core`) silently resolves to an empty read on macOS Chrome. "Load unpacked"'s folder picker sandboxes file access to the selected directory's own tree and denies symlinks that escape it, with no error anywhere: DevTools' Sources panel showed the content script present but zero bytes, so the extension loaded successfully with a no-op script (confirmed live). Node (Playwright) and a manual console-paste `cat` both resolve symlinks fine — only Chrome's unpacked-extension loader has this restriction. Keeping the real file inside `extension/` and symlinking outward avoids the failure mode entirely.

### 2. Playwright

```js
await page.addInitScript({ path: 'webrtc-inspector/core/webrtc-inspector.js' });
await page.goto(targetUrl);
// ... exercise the page ...
const snapshot = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
```

`addInitScript` runs before any page script on every navigation — the reliable way to get full coverage from a Playwright-driven script. MCP-style Playwright tools that only expose a post-navigation `browser_evaluate` can't match this timing: any connection or `getUserMedia` call made before `browser_evaluate` runs goes unpatched. For that workflow, load the Chrome extension into the same browser profile instead — its content script installs at `document_start` regardless of how you navigated there.

### 3. DevTools console paste

Paste the contents of `core/webrtc-inspector.js` into the console before triggering whatever sets up the connection you want to inspect (e.g. before clicking a "start call" button). Pasting after a connection already exists means that connection predates the patch and won't be tracked — new connections/tracks/channels created afterward still will be.

## API (`window.__webrtcInspector`)

| Method | Purpose |
|---|---|
| `getSnapshot()` | Serializable summary of all connections (including SDP m-line/codec summaries, local/remote ICE candidate types), tracks (remote audio tracks include a live RMS `level`), data channels, tracked WebSockets (`url`/`protocol`/`state`/`sentCount`/`receivedCount`/last 10 messages), latest stats, `fakeCamActive`/`dataChannelInterceptorActive`/`webSocketInterceptorActive` flags, and the last 100 log entries — safe to `JSON.stringify` or poll from a UI. |
| `setFakeMic(base64OrArrayBuffer)` | Decode an audio clip and arm it as the source for future `getUserMedia({audio: true})` calls. |
| `clearFakeMic()` | Restore real microphone capture. |
| `injectAudio(base64OrArrayBuffer)` | `setFakeMic` + immediately play it into the current fake-mic destination (one-shot utterance). |
| `playIntoFakeMic()` | Replay the already-armed fake-mic buffer without re-decoding. |
| `getFakeMicTrack()` | A fresh cloned `MediaStreamTrack` from the fake-mic source, for manual `sender.replaceTrack()` calls. |
| `setFakeCam({width, height, color, text, fps})` | Arm a canvas-generated synthetic video track as the source for future `getUserMedia({video: true})` calls. |
| `clearFakeCam()` | Restore real camera capture. |
| `getSdp(connectionId)` | Full `{local, remote}` `RTCSessionDescription`-shaped objects (type + raw SDP) for a connection. |
| `getRemoteTrackStream(connectionId, trackId)` | A live `MediaStream` wrapping one remote track, for feeding into an `<audio>`/`<video>` element or an `AnalyserNode` to actually listen to/watch what the peer is sending. |
| `replaceOutgoingTrack(connectionId, kind, track)` | Swap the `audio`/`video` sender's track on a specific connection (by the id shown in `getSnapshot()`). |
| `injectDataChannelMessage(connectionId, label, data)` | Send a message on a specific data channel's own connection, as if that peer sent it — arrives at its remote peer, not at itself. |
| `setDataChannelInterceptor(fn)` | Global hook `fn(direction, {connectionId, label, data})`, called for every outgoing (`'out'`) and incoming (`'in'`) data-channel message on every tracked channel, before the app's own listeners run. Return new data to rewrite the message in flight, `false` to block it entirely, or `undefined`/nothing to pass it through unchanged. Opt-in only — installing it changes what the app actually sends/receives, so it stays inert until called. |
| `clearDataChannelInterceptor()` | Remove the hook and restore unmodified pass-through. |
| `setWebSocketInterceptor(fn)` | Same pattern as `setDataChannelInterceptor`, for every tracked `WebSocket`: `fn(direction, {socketId, url, data})`, called before every `send()` and before every incoming `message` event reaches the app's own listeners. Return new data to rewrite, `false` to block, `undefined` to pass through. Opt-in only. |
| `clearWebSocketInterceptor()` | Remove the hook and restore unmodified pass-through. |
| `injectWebSocketMessage(socketId, data)` | Dispatch a synthetic incoming `message` event on a specific tracked socket (by the id shown in `getSnapshot()`), as if the server sent it — does not touch the real network. |
| `sendOnWebSocket(socketId, data)` | Send an outgoing message on a specific tracked socket through the real `send()`, as if the app itself called it — counted/logged/intercepted like any other send. |
| `killConnection(connectionId)` | Real `pc.close()` on a tracked `RTCPeerConnection` — genuine, immediate ICE/DTLS teardown, for testing whether a client detects transport death and reconnects from scratch. Not a packet-loss simulation (see below); tests abrupt-death recovery instead. |
| `simulateNetworkLoss(durationMs, options)` | Real outage of the signaling/control plane: for `durationMs`, every WebSocket send and every data-channel send/receive is actually dropped rather than faked, then auto-restored. `options: {targets: ['websocket', 'datachannel']}` (default both). Composes with any interceptor already installed via `set*Interceptor` (restores it afterward). Returns `{stop, done}` — call `stop()` to end early, or await `done`. |
| `onEvent(callback)` | Subscribe to the live event log (connection/track/data-channel/getUserMedia/SDP/ICE-candidate events) as they happen. |
| `clearLog()` | Drop accumulated log and stats history. |

### Network-loss / reconnect testing

Neither Playwright's `browserContext.setOffline()` nor Chrome DevTools' `Network.emulateNetworkConditions` tears down already-flowing WebRTC UDP media. Both act on the browser's HTTP/network-service layer, which WebRTC media bypasses — a Chromium architecture fact, confirmed live against a real conversational-AI SDK: toggling `setOffline(true)`/`setOffline(false)` on a connected session didn't interrupt already-established WebRTC/WebSocket traffic at all. There's no page-JS-level way to force transient packet loss on a live `RTCPeerConnection` without OS/root network control (e.g. `pfctl`/`tc`), which is out of scope for a page-injected tool.

`killConnection` and `simulateNetworkLoss` are the closest real (not synthetic), generic, OS-access-free proxies, and they test two different failure modes any vendor's WebRTC client might need to recover from:

- `killConnection(connectionId)` — real abrupt transport death. Use to answer "does the client notice the peer connection is gone and start a fresh session," not "does it survive a transient blip."
- `simulateNetworkLoss(durationMs, {targets})` — real dropped signaling/control-plane messages for a window of time, then real restoration. Use to answer "does the client's heartbeat/backoff logic detect a control-plane outage and recover once it clears," without killing media. Pick `durationMs` to comfortably exceed the vendor's own documented heartbeat/backoff thresholds if known (e.g. several multiples of a 5s heartbeat interval), so the outage is unambiguous rather than borderline.

Both are generic across vendors because they operate on the standard `RTCPeerConnection`/`WebSocket` instances this module already tracks, not on any vendor-specific API.

Every track handed out by the patched `getUserMedia`/`getDisplayMedia` is tagged internally (`fake-mic`, `real-device`, or `display-capture`) and that tag follows the track into `pc.addTrack()` logging — so `getSnapshot()` shows exactly which peer connection consumed which source, even when multiple connections request media on the same page at once.

## Known limitations

- **Mediasoup/SFU app-message channels don't create a literal `RTCDataChannel` — fixed in v1.2.0 by also patching `WebSocket`, live-confirmed in v1.3.0.** Original gap: against a real SFU-backed conversational-AI session, `getSnapshot()` reported zero `RTCDataChannel` instances across 3 tracked peer connections, while the vendor's own JS API (an `on('app-message', ...)`-style callback) delivered dozens of real control-plane messages over the same session — mediasoup-client's SFU data-producer/consumer abstraction doesn't surface as a standard `RTCPeerConnection.prototype.createDataChannel`/`ondatachannel` object. Live re-verification against the same class of session: `getSnapshot()` tracked a `wss://` signaling WebSocket (state `open`) carrying real control-plane traffic both ways — framed JSON events for state changes like "replica present," "started speaking," and similar session lifecycle markers, each tagged with a live session/conversation ID. Confirms the WebSocket patch closes the gap: this app-message-equivalent traffic rides the signaling socket, observed by `core/webrtc-inspector.js` like any other tracked WebSocket (send/receive counts, message previews, interceptor/injection APIs all apply).
- `RTCPeerConnection`/track/SDP/ICE/`getUserMedia` instrumentation is unaffected by the gap above or its fix. A vendor whose control-plane traffic rides an unpatched transport (WebTransport, Server-Sent Events, a native non-browser channel) would stay invisible — no evidence of this in the corpus so far, but an open category, not a closed one.
- All instrumentation depends on the patch running before the page's own script grabs a reference to the unpatched global — see the injection-method caveats above (extension vs. `addInitScript` vs. MCP-style post-navigation `browser_evaluate`).

## Roadmap

Gaps identified while scoping a debug-tooling build for a consumer SDK's Chrome extension/repro-harness/agentic-debugging stack. All generic — no vendor-specific content belongs in this tool; a consumer plugs its own vendor knowledge into these hooks once they exist.

- **HTTP/`fetch`-signaling instrumentation.** The tool currently patches `RTCPeerConnection`, data channels, and `WebSocket`, but not `fetch`/XHR. A growing pattern (WHEP and WHEP-like SDP-over-HTTP signaling) rides plain HTTP requests with no WebSocket involved at all — today that leg is invisible to `getSnapshot()` and immune to `simulateNetworkLoss`. Needs a `fetch`/XHR patch plus an `'http'` target on `simulateNetworkLoss`. Extends the "Known limitations" note above, which currently only calls out WebTransport/SSE/native channels.
- **Connection/socket labeler API** — `getSnapshot()` only ever returns raw connection/socket IDs and URLs. A `setLabeler(fn)` hook (URL/hostname pattern → friendly name) would let a consumer attach its own vendor-specific names (e.g. "ASR uplink"/"video downlink") without this tool needing built-in knowledge of any vendor.
- **Message-decoder plugin API** — data-channel and WebSocket payloads only ever surface as raw previews. A `registerDecoder(matcher, decodeFn)` hook would let a consumer plug in its own protocol-specific decoding (its own documented wire schema) for a readable event timeline, instead of writing a second parser against `getSnapshot()`'s raw output.
- **Diagnostic-bundle export** — no single call currently packages a snapshot + event log + stats history into one portable object. An `exportBundle()` primitive is the natural building block for any consumer's "export for a support ticket" or "capture a test fixture" feature.
- **Capture-replay/diff engine** — a generic "record this session's event stream to JSON, diff it against a previous capture" utility, so consumers can build regression fixtures on top of this tool instead of hand-maintaining their own.
- **Extension plugin/adapter architecture** — let `extension/` load a per-site adapter (a bundle of labelers + decoders) so a consumer's vendor-aware UI layer plugs in rather than forking the extension.
- **npm packaging** — currently consumed via symlink or an `addInitScript` file path only; a real versioned package would let another repo take a clean dependency instead of vendoring or path-referencing this one.

## Self-test

`test/loopback-test.html` connects two `RTCPeerConnection`s to each other in one page (no signaling server, no network calls), exercises every patched code path — track tagging, data-channel messages both directions, `injectDataChannelMessage` — and writes PASS/FAIL results to `window.__testResult`. Serve the directory locally and open it in a browser to verify the core module after any change:

```sh
python3 -m http.server 8931 --bind 127.0.0.1
# open http://127.0.0.1:8931/test/loopback-test.html
```
