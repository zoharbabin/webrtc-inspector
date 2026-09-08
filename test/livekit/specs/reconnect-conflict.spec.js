const { test, expect } = require('@playwright/test');
const { mintToken, LIVEKIT_URL } = require('../server.js');
const { ROOM_JOIN_TIMEOUT_MS, RECONNECT_CONVERGENCE_TIMEOUT_MS, POLL_INTERVAL_MS } = require('../helpers.js');

// Plan section 4 Tier A "killConnection, restartIce" / section 5 item 3.
// LiveKit's own client-side reconnection engine (DefaultReconnectPolicy,
// RTCEngine.attemptReconnect/handleDisconnect) runs in the same MAIN-world JS
// context as our instrumentation. Firing restartIce mid-session races that
// engine's own recovery attempt. This is flaky by construction (see the
// plan's flake policy), so its test runs N repetitions and reports a pass
// rate instead of a single pass/fail. Safety invariants, unlike convergence,
// must hold on every single repetition — they are asserted strictly.
//
// killConnection is deliberately NOT tested the same way, after measuring its
// real behavior against a real LiveKit session: it is not flaky, it is
// structurally silent. killConnection() closes the raw RTCPeerConnection
// directly (record.pc.close()). Chrome does not fire connectionstatechange
// or iceconnectionstatechange after a JS-initiated close() (see this
// extension's own close()-patch comment in
// extension/core/webrtc-inspector.js), and livekit-client's PCTransport
// wires pc.onconnectionstatechange/pc.oniceconnectionstatechange directly to
// the callbacks that drive its reconnect engine (see
// node_modules/livekit-client's PCTransport.createPC). With no event ever
// firing, LiveKit's engine never learns the pc died: measured over a 5s
// repeated poll against real infra, room.state never once left 'connected',
// 5/5 runs, and no new RTCPeerConnection was ever created — a permanent
// blind spot, not a race with an eventual winner. See the dedicated test
// below for the measured proof and the filed finding.

const REPEAT_COUNT = 5;
const KNOWN_ROOM_STATES = ['disconnected', 'connecting', 'connected', 'reconnecting', 'signalReconnecting'];

async function joinAndPublish(page, roomName, identity) {
  await page.goto('/test/livekit/fixture.html');
  await page.waitForFunction(() => !!window.__livekitTestHelpers);
  const token = await mintToken(identity, roomName);
  await page.evaluate(
    ([url, tok]) => window.__livekitTestHelpers.join(url, tok, {}),
    [LIVEKIT_URL, token]
  );
  await page.evaluate(() => window.__livekitTestHelpers.publishCamMic());
}

function outboundPacketsSent(snap, connId) {
  const conn = snap.connections.find((c) => c.id === connId);
  const reports = (conn && conn.latestStats && conn.latestStats.reports) || [];
  let sent = 0;
  reports.forEach((r) => { if (r.type === 'outbound-rtp' && r.kind === 'video') sent += r.packetsSent || 0; });
  return sent;
}

// restartIce-only. Fires restartIce against whichever connection is
// currently live, then checks two independent things: (1) does the room
// eventually converge back to 'connected' (reported, not hard-asserted —
// this is the flaky part), and (2) do our own safety invariants hold
// throughout (hard-asserted — these must never be violated regardless of
// whether LiveKit's own reconnect races us and wins, loses, or ties).
// Unlike killConnection (see the file header), restartIce triggers a real,
// immediate renegotiation on the same live pc rather than passively waiting
// on a native event LiveKit itself depends on, so it genuinely races
// LiveKit's engine instead of going unnoticed by it.
async function raceOnce(pageA) {
  const violations = [];
  const snapBefore = await pageA.evaluate(() => window.__webrtcInspector.getSnapshot());
  const liveConn = snapBefore.connections.find((c) => !c.closed);
  if (!liveConn) {
    violations.push('no live connection found before firing the action');
    return { converged: false, invariantViolations: violations };
  }

  const eventsCountBefore = await pageA.evaluate(() => window.__livekitTestHelpers.getEvents().length);

  await pageA.evaluate(
    (connId) => window.__webrtcInspector.restartIce(connId),
    liveConn.id
  );

  let converged = false;
  const deadline = Date.now() + RECONNECT_CONVERGENCE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = await pageA.evaluate(() => window.__livekitTestHelpers.getConnectionState());
    if (!KNOWN_ROOM_STATES.includes(state)) {
      violations.push(`room reported an unknown state: ${state}`);
      break;
    }
    if (state === 'connected') {
      converged = true;
      break;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  // The snapshot's own closed flag must never contradict connectionState —
  // e.g. never "closed: false" while the real pc reports 'closed'/'failed'.
  const snapAfter = await pageA.evaluate(() => window.__webrtcInspector.getSnapshot());
  snapAfter.connections.forEach((c) => {
    const cs = c.state.connectionState;
    if (c.closed && (cs === 'connected' || cs === 'connecting')) {
      violations.push(`connection ${c.id}: closed=true but connectionState=${cs}`);
    }
    if (!c.closed && (cs === 'closed' || cs === 'failed')) {
      violations.push(`connection ${c.id}: closed=false but connectionState=${cs}`);
    }
  });

  // No contradictory event storm: 'disconnected' must never fire twice in a
  // row on the room's own event log with no intervening 'connected'/'reconnected'.
  const eventsAfter = await pageA.evaluate(() => window.__livekitTestHelpers.getEvents());
  let lastWasDisconnected = false;
  eventsAfter.slice(eventsCountBefore).forEach((e) => {
    if (e.type === 'disconnected') {
      if (lastWasDisconnected) violations.push('duplicate disconnected event with no intervening connected/reconnected');
      lastWasDisconnected = true;
    } else if (e.type === 'connected' || e.type === 'reconnected') {
      lastWasDisconnected = false;
    }
  });

  return { converged, invariantViolations: violations };
}

test.describe('reconnect-conflict: killConnection/restartIce racing LiveKit\'s own reconnect engine', () => {
  test('killConnection real-closes the pc, but LiveKit never notices: room.state stays \'connected\' and media silently stops', async ({ browser }) => {
    test.setTimeout(30000);
    const roomName = `reconnect-kill-${Date.now()}`;
    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();

    try {
      await joinAndPublish(pageA, roomName, 'alice');
      await expect.poll(
        () => pageA.evaluate(() => window.__livekitTestHelpers.getConnectionState()),
        { timeout: ROOM_JOIN_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toBe('connected');

      const snapBefore = await pageA.evaluate(() => window.__webrtcInspector.getSnapshot());
      const connBefore = snapBefore.connections.find((c) => !c.closed);
      expect(connBefore).toBeTruthy();
      const sentBefore = outboundPacketsSent(snapBefore, connBefore.id);

      await pageA.evaluate((connId) => window.__webrtcInspector.killConnection(connId), connBefore.id);

      // record.closed flips immediately and reliably — this half of
      // killConnection's bookkeeping does not depend on any native event.
      await expect.poll(
        () => pageA.evaluate(
          (connId) => window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === connId).closed,
          connBefore.id
        ),
        { timeout: 5000, intervals: [POLL_INTERVAL_MS] }
      ).toBe(true);

      // The real, spec-level pc.connectionState (read directly off the raw
      // RTCPeerConnection, bypassing the extension's event-driven cache)
      // reflects the close() immediately, per spec: the transport really is
      // dead, not just marked dead by us.
      const rawStateAfterClose = await pageA.evaluate(() => {
        const pc = window.__livekitTestHelpers.rawPublisherPc();
        return pc && pc.connectionState;
      });
      expect(rawStateAfterClose).toBe('closed');

      // Chrome does not fire connectionstatechange/iceconnectionstatechange
      // after this raw close() (see this file's header and the extension's
      // own close()-patch comment), and livekit-client's PCTransport is
      // wired directly to those two native events to drive its reconnect
      // engine — so it never learns the pc died. Polled over a real window
      // against real infra rather than asserted once: room.state must never
      // leave 'connected', because nothing ever tells LiveKit otherwise.
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const state = await pageA.evaluate(() => window.__livekitTestHelpers.getConnectionState());
        expect(state).toBe('connected');
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }

      // The extension's own cached state.connectionState would otherwise stay
      // stale for the same reason (getSnapshot() only updates it from the
      // connectionstatechange listener, which never fires here) — but
      // markConnectionClosed() resyncs both cached state fields from the pc's
      // live getters the instant it marks a record closed, specifically so
      // closed=true can never coexist with a stale non-'closed' connectionState.
      const snapAfter = await pageA.evaluate(() => window.__webrtcInspector.getSnapshot());
      const connAfter = snapAfter.connections.find((c) => c.id === connBefore.id);
      expect(connAfter.closed).toBe(true);
      expect(connAfter.state.connectionState).toBe('closed');

      // Concrete proof media really stopped, despite the room claiming
      // health the whole time: outbound packet count never advances again.
      const sentAfter = outboundPacketsSent(snapAfter, connBefore.id);
      expect(sentAfter).toBe(sentBefore);
    } finally {
      await ctxA.close();
    }
  });

  test('restartIce repeatedly races LiveKit\'s reconnect engine: invariants always hold, convergence reported as a pass rate', async ({ browser }) => {
    test.setTimeout(REPEAT_COUNT * (RECONNECT_CONVERGENCE_TIMEOUT_MS + 10000) + 30000);
    const roomName = `reconnect-restartice-${Date.now()}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    try {
      await joinAndPublish(pageA, roomName, 'alice');
      await joinAndPublish(pageB, roomName, 'bob');
      await expect.poll(
        () => pageA.evaluate(() => window.__livekitTestHelpers.getConnectionState()),
        { timeout: ROOM_JOIN_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toBe('connected');

      const results = [];
      for (let rep = 0; rep < REPEAT_COUNT; rep++) {
        results.push(await raceOnce(pageA));
      }
      const passCount = results.filter((r) => r.converged).length;
      console.log(`[reconnect-conflict] restartIce convergence pass rate: ${passCount}/${results.length}`, JSON.stringify(results));

      results.forEach((r, i) => expect(r.invariantViolations, `repetition ${i}`).toEqual([]));
      expect(passCount).toBeGreaterThan(0);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});
