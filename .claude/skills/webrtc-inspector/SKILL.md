---
name: webrtc-inspector
description: Debug and fault-test live WebRTC sessions (RTCPeerConnection, data channels, WebSockets) via the webrtc-inspector MCP tools — reconnect testing, quality regression triage, signaling-outage testing. Use when a task involves inspecting, reproducing, or fault-injecting a WebRTC/RTCPeerConnection session through wrtc_ MCP tools.
---

Full API reference, tool list, and fault-injection table: this package's README.md (`### MCP server`, `### Reconnect / fault-injection primitives`). This file is recipes on top of that reference — don't duplicate signatures here, link back to the README when in doubt.

## Setup

Call `wrtc_status` first, every session. It never throws.

1. `mode: 'attached'` + `inspectorLoaded: true` → ready. Use the `wrtc_*` tools normally; skip the rest of this section.
2. `mode: 'attached'` + `inspectorLoaded: false` → connected to a real Chrome, but the current tab isn't the target page. Call `wrtc_navigate({url})`.
3. Anything else (`disconnected`, `self-launched`, or a page it can't navigate to) → **do not assume a fresh Chromium is the answer yet.** Check first whether a different browser-automation MCP (Playwright, chrome-devtools-mcp, browser-tools, etc.) is already connected in this session. If one is, skip straight to "Already-open Chrome via another MCP" below — that tool is almost certainly already driving the browser that actually matters, the user's real, already-open Chrome.
4. Only when no other browser-automation MCP is connected at all: `disconnected`/`self-launched` is the normal, expected state. The next `wrtc_*` call (e.g. `wrtc_navigate`) self-launches a throwaway Chromium automatically — no human needs to start Chrome first, and no CDP flag or relaunch is needed either.

Never tell the user to quit or relaunch their real Chrome with `--remote-debugging-port`. Chrome blocks remote debugging on a default, signed-in profile by design — relaunching with the flag will not open the port, it only costs them their open tabs for nothing. `disconnected` means "nothing for the `wrtc_*` tools to attach to right now," not "impossible."

### Already-open Chrome via another MCP

webrtc-inspector has no click/type/navigate-a-UI tool, it's inspection and fault-injection only. A task that needs both driving the page (a "Start call" button, a consent flow) and inspecting WebRTC pairs it with a browser-automation MCP that's already connected. Once one is, don't try to work out how it's wired to the browser (CDP attach vs. an extension relay) — that distinction doesn't matter for what comes next.

These MCPs track one "current tab" pointer — an eval tool always runs against whatever tab is currently selected, not a tab you name per call. Picking the right one first matters, because the extension injects into *every* tab (`<all_urls>`, all frames): checking `!!window.__webrtcInspector` is true almost everywhere and confirms nothing about which tab has the actual call.

1. List open tabs (e.g. Playwright MCP's `browser_tabs({action: 'list'})`).
2. One tab, or one obviously matches the target app's URL → select it (`browser_tabs({action: 'select', index})`), then eval `window.__webrtcInspector.getSnapshot().connections.length` on it to confirm it actually has a live session before doing anything else. Zero connections on the only plausible tab usually just means the call hasn't started yet, not the wrong tab.
3. More than one plausible tab (e.g. two Meet tabs) → select each in turn and check `getSnapshot().connections.length`. Exactly one non-zero → that's the target. More than one non-zero, or the tab is otherwise ambiguous → ask the user which call they mean rather than guessing; acting on the wrong one reports success while watching the wrong session, the same failure mode `wrtc_*`'s own `pageUrl` disambiguation (`browser.js`) exists to prevent.
4. Once confirmed, call `window.__webrtcInspector.<method>(...)` through that same eval tool for every operation — `getSnapshot()`, `killConnection(connId)`, `restartIce(connId)`, `simulateNetworkLoss(...)`, etc. (full API: `extension/core/webrtc-inspector.js`'s public surface, the same methods the `wrtc_*` tools wrap). Re-select the tab before each eval if the automation tool has since navigated elsewhere or opened new tabs.
5. No tab has `window.__webrtcInspector` at all → the extension isn't installed in that Chrome. Ask the user to install it (Chrome Web Store, or an unpacked load of `extension/`). Don't try to route around this with CDP flags or a separate browser instance.

Each eval call is an isolated invocation — nothing local survives between calls. For a before/after workflow (e.g. `captureEvents()` then `diffCaptures(before, after)`), stash the intermediate result on a page global in one call (`window.__before = window.__webrtcInspector.captureEvents();`) and read it back in the next.

If `wrtc_status` and the eval check disagree, e.g. `wrtc_status` reports `self-launched` but the eval confirms the extension is live on the user's real page, trust the eval check. That's the browser the task actually cares about; the self-launched Chromium is an empty, irrelevant fallback and can be ignored.

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

### "Is remote audio actually arriving"

`remoteTracks[].level` distinguishes two different things, and reading them as the same is the most common way to misdiagnose audio:

- `level: 0` — measured, and the audio really is silent.
- `level: null` with `levelUnavailableReason: 'track-not-rendered'` — nothing measured. In Chromium the audio decoder only runs for a remote track the page is actually rendering, so with no `<audio>`/`<video>` sink the meter has nothing to read. Firefox and WebKit decode either way. This is a page setup fact, not an audio fault.
- `level: null` with `levelUnavailableReason: 'audio-context-not-rendering'` — the meter's `AudioContext` clock isn't advancing, so it can't measure anything. Needs a user gesture in the page, or the machine has no audio output device driving it (a container, a CI runner). Says nothing about the audio itself.
- `level: null` with `levelUnavailableReason: 'meter-failed'` — the analyser could not be built for this track. Look for the `audio-meter-failed` event and its error.
- `level: null` with `levelUnavailableReason: null` — no sample taken yet; poll again.

So don't report "no audio" off a null level. Confirm it against the stats instead: two `wrtc_get_snapshot` calls a few seconds apart, and check whether `packetsReceived` is growing. Packets growing while samples stay flat means the track arrives but nothing renders it.

### Signaling-outage / heartbeat testing

1. Know your app's heartbeat/reconnect interval before picking a duration — the outage needs to outlast it to actually trigger reconnect logic.
2. Named, realistic scenario: `wrtc_simulate_network_preset({name})` — `'home-wifi'`, `'4g-train'`, `'congested-mobile'`, or one already registered via `wrtc_register_network_preset`.
3. Custom outage: `wrtc_simulate_network_loss({durationMs, targets})`. `targets` defaults to `['websocket', 'datachannel']`; add `'http'` for WHIP/WHEP/SDP-over-HTTP signaling, `'media'` to black out every outgoing track for the duration (`replaceTrack(null)`, then restored; works mid-call on all engines).
4. Both tools block until the outage finishes and auto-restore — there's no early-stop handle over MCP, so pick a duration you actually want to wait out.
5. Overlapping outages nest per target, so a second outage starting inside the first doesn't get lifted early when the first one ends. `getSnapshot().activeOutages` lists the targets blocked right now — check it if traffic isn't flowing and you expected an outage to be over.

Reading captured HTTP signaling (WHIP/WHEP, SDP over POST): `responsePreview` is a bounded sample, not the whole body. It's capped at 8 KB and 1.5s, and it's absent entirely for open-ended content types (`text/event-stream`, `multipart/*`, NDJSON, gRPC), which are recorded with headers only. A large SDP or ICE payload may therefore be truncated in the preview — read it from the page, not the record, if you need every byte. The app's own copy of the body is never affected.

## Optional modules — when to reach past the primitives above

These live in `extension/*.js`, are not MCP tools, and only matter for in-page/Node usage (agent scripts, not MCP tool calls):

- **Scenario compiler** (`extension/scenario-compiler.js`) — turn a plain-English fault description into a sequence of the primitives above. Reach for it only when the fault is described in natural language and you want it compiled once rather than hand-picking tool calls.
- **Signature matcher** (`extension/signature-matcher.js`) — pattern-match a captured event log against named failure signatures (e.g. `missed-heartbeat-reconnect-gap`). Reach for it when triaging a long capture for a known failure shape, instead of eyeballing the log.
- **Metrics exporter** (`extension/metrics-exporter.js`) — continuous Prometheus/OTLP push of `qualityScore`/`bitrateKbps`/`rttMs`/`jitterMs`/`lossPct`. Reach for it for long-running/soak sessions, not one-off debugging.
