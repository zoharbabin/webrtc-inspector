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
3. Once you've reproduced the issue, `wrtc_export_bundle()` — attach its output verbatim to a bug report; it carries the full event log and stats history, not just the current snapshot.

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
