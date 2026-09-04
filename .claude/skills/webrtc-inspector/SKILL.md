---
name: webrtc-inspector
description: Debug and fault-test live WebRTC sessions (RTCPeerConnection, data channels, WebSockets) via the webrtc-inspector MCP tools — reconnect testing, quality regression triage, signaling-outage testing. Use when a task involves inspecting, reproducing, or fault-injecting a WebRTC/RTCPeerConnection session through wrtc_ MCP tools.
---

Full API reference, tool list, and fault-injection table: this package's README.md (`### MCP server`, `### Reconnect / fault-injection primitives`). This file is recipes on top of that reference — don't duplicate signatures here, link back to the README when in doubt.

## Setup

Call `wrtc_status` first, every session. It never throws. Read `mode`:

- `self-launched` or `attached` + `inspectorLoaded: true` — ready, proceed.
- `attached` + `inspectorLoaded: false` — connected to a real Chrome but the current tab isn't the target page. Call `wrtc_navigate({url})` to open/instrument the right one.
- `disconnected` — nothing reachable yet. No action needed: the next tool call (e.g. `wrtc_navigate`) self-launches a Chromium automatically. No human needs to start Chrome first.

Don't call `wrtc_get_snapshot` or any other tool before `wrtc_status` — it's the only tool guaranteed not to error, so it's the correct first probe every time.

### Pairing with a browser-automation MCP (Playwright, chrome-devtools-mcp, etc.)

webrtc-inspector has no click/type/navigate-a-UI tool — it's inspection and fault-injection only. Driving real page interaction (clicking through a consent flow, a "Start call" button, etc.) needs a separate browser-automation MCP alongside it. They're complementary: one drives the page, the other watches the WebRTC layer. **They must share one browser, not each launch their own** — left alone, each MCP self-launches its own separate Chromium, and `wrtc_get_snapshot`/`wrtc_status` end up watching an unrelated, empty browser that never saw the real session. If a snapshot looks empty or stale while a call is clearly running, check `wrtc_status`'s `mode` first — it's almost always this.

The automation MCP is wired one of two ways. Check which before picking a fix:

- **CDP attach/self-launch** (e.g. Playwright MCP with `--browser chromium`, or an explicit `--cdp-endpoint`): it exposes a real CDP debugging port.
- **Browser-extension relay** (e.g. Playwright MCP with `--extension --browser chrome`): it drives the user's real, already-open Chrome through an installed extension's WebSocket relay. **No CDP port is exposed in this mode** — there is nothing for webrtc-inspector to attach to.

**Mode 1 — CDP attach shared, use the `wrtc_*` tools normally.** Launch one Chrome with a fixed CDP port (e.g. `--remote-debugging-port=9222`), point both MCPs at it: `WRTC_CDP_ENDPOINT=http://localhost:9222` for webrtc-inspector, the matching `--cdp-endpoint`/attach flag for the other tool. Any webrtc-inspector tool call — `wrtc_status` included, no need to call `wrtc_navigate` first — re-arms instrumentation for new pages on the shared browser. This holds only while webrtc-inspector's MCP server process stays connected: instrumentation isn't stored durably on the browser, it's re-applied by the connected client each time a new page opens. Since MCP servers run for the whole session, this just works in practice. Confirms itself: `wrtc_status` returns `mode: 'attached'` with `pageUrl` matching the page the automation tool is actually on.

**Mode 2 — extension relay, skip the `wrtc_*` tools and call the in-page API directly.** webrtc-inspector's MCP server has no CDP port to reach here — pointed at the default `localhost:9222` with nothing listening there, it silently self-launches its own disconnected Chromium, and `wrtc_*` tool calls inspect the wrong browser. This is a dead end no matter how the endpoint env var is tweaked. Instead, rely on the fact that the webrtc-inspector Chrome extension, if installed in that same real Chrome, auto-injects on every page and exposes `window.__webrtcInspector` (same methods the `wrtc_*` tools wrap: `getSnapshot`, `killConnection`, `restartIce`, `simulateNetworkLoss`, etc. — see `extension/core/webrtc-inspector.js`'s public API for the full list). Call it through the automation tool's own JS-eval (e.g. Playwright MCP's `browser_evaluate`) on the exact tab it's already driving. Requires the webrtc-inspector *extension* to be installed in the user's real Chrome — if it isn't, ask the user to install it (Chrome Web Store or an unpacked load of `extension/`) rather than trying to work around the gap.

Each eval call is an isolated invocation — nothing local survives between calls. For a before/after workflow (e.g. `captureEvents()` then `diffCaptures(before, after)`), stash the intermediate result on a page global (`window.__before = window.__webrtcInspector.captureEvents();`) in one call and read it back in the next, rather than assuming a return value carries over.

**Telling them apart without prior knowledge:** call `wrtc_status`. `mode: 'attached'` with a `pageUrl` that matches what the automation tool is doing confirms Mode 1 is wired correctly — proceed with `wrtc_*` tools. `mode: 'self-launched'` means the default CDP endpoint had nothing listening — that's the tell you're in Mode 2 (or nothing is configured at all): switch to calling `window.__webrtcInspector` via the automation tool's eval instead of retrying `wrtc_*` tools against a browser that will never see the real session.

## Recipes

### "Why did the call drop / how do I test reconnect"

1. `wrtc_get_snapshot()` — find the connection id, note `flags` and `qualityScore`.
2. Capture a baseline: `wrtc_capture_events()` or note the current snapshot.
3. Pick the fault that matches the real-world failure you're reproducing:
   - **Abrupt transport death** (tab crash, network cable pull, cold reconnect): `wrtc_kill_connection({connId})`.
   - **Renegotiate without teardown** (ICE restart while media keeps flowing): `wrtc_restart_ice({connId})`.
   - These exercise different code paths — don't substitute one for the other.
4. `wrtc_get_snapshot_diff(before, after)` (or `wrtc_diff_captures` if you captured events) to see exactly what recovered and what didn't.

### Quality regression triage

1. `wrtc_get_snapshot({detail: 'concise'})` — check every connection's `qualityScore` (1-5, `null` = no data yet) and `flags` (empty array = nothing flagged).
2. A non-empty `flags` entry names the specific symptom (e.g. `ice_stuck_checking_<ms>ms`, `freeze_ratio_bad:<trackId>`) — see the README's `### flags` table for what each one means before guessing.
3. Also check each `remoteTracks[].qualityFlag` (`ok`/`degraded`/`bad`) directly — it fires at 1% freeze ratio, well before the connection-level `freeze_ratio_bad` flag (10%). A track can be `degraded` with `flags` still empty; don't rely on `flags` alone.
4. Once you've reproduced the issue, `wrtc_export_bundle()` — attach its output verbatim to a bug report; it carries the full event log and stats history, not just the current snapshot.

### Signaling-outage / heartbeat testing

1. Know your app's heartbeat/reconnect interval before picking a duration — the outage needs to outlast it to actually trigger reconnect logic.
2. Named, realistic scenario: `wrtc_simulate_network_preset({name})` — `'home-wifi'`, `'4g-train'`, `'congested-mobile'`, or one already registered via `wrtc_register_network_preset`.
3. Custom outage: `wrtc_simulate_network_loss({durationMs, targets})`. `targets` defaults to `['websocket', 'datachannel']`; add `'http'` for WHIP/WHEP/SDP-over-HTTP signaling, `'media'` for real dropped encoded frames (Chromium only).
4. Both tools block until the outage finishes and auto-restore — there's no early-stop handle over MCP, so pick a duration you actually want to wait out.

## Optional modules — when to reach past the primitives above

These live in `extension/*.js`, are not MCP tools, and only matter for in-page/Node usage (agent scripts, not MCP tool calls):

- **Scenario compiler** (`extension/scenario-compiler.js`) — turn a plain-English fault description into a sequence of the primitives above. Reach for it only when the fault is described in natural language and you want it compiled once rather than hand-picking tool calls.
- **Signature matcher** (`extension/signature-matcher.js`) — pattern-match a captured event log against named failure signatures (e.g. `missed-heartbeat-reconnect-gap`). Reach for it when triaging a long capture for a known failure shape, instead of eyeballing the log.
- **Metrics exporter** (`extension/metrics-exporter.js`) — continuous Prometheus/OTLP push of `qualityScore`/`bitrateKbps`/`rttMs`/`jitterMs`/`lossPct`. Reach for it for long-running/soak sessions, not one-off debugging.
