const { test, expect } = require('@playwright/test');
const { mintToken, LIVEKIT_URL } = require('../server.js');
const {
  ROOM_JOIN_TIMEOUT_MS,
  TRACK_SUBSCRIBED_TIMEOUT_MS,
  RECONNECT_CONVERGENCE_TIMEOUT_MS,
  POLL_INTERVAL_MS,
} = require('../helpers.js');

// Plan section 4 Tier B "captureEvents, diffCaptures, getEvents" / section 5
// item 15. Confirms event capture across a full real session lifecycle
// (join -> publish -> subscribe -> network degradation -> reconnect -> leave)
// produces a coherent, correctly-ordered event log, using exactly the three
// APIs the plan names rather than a side-channel onEvent listener:
//   - captureEvents() snapshots the full log (extension/core/webrtc-inspector.js
//     ~line 2339): a copy taken before the lifecycle starts and one taken
//     after it ends.
//   - diffCaptures(before, after) (~line 2349): since the log is strictly
//     append-only within a single page's lifetime (nothing is ever removed
//     except the 5000-entry overflow cap, never reached in one test),
//     `before`'s event-type sequence must be an exact prefix of `after`'s —
//     firstDivergenceIndex must be null — and every event type this
//     lifecycle produces must show a real count increase.
//   - getEvents({since, limit}) (~line 2304): paginating through the whole
//     lifecycle's log with a small limit must reconstruct byte-for-byte the
//     same ordered sequence as one unbounded call — no gaps, no duplicates,
//     no reordering — and the pagination bookkeeping (nextSince,
//     remainingCount, truncated, truncationMarker) must be internally
//     consistent at every step, not just at the end.
//
// The network-degradation/reconnect phase reuses network-fault-real.spec.js's
// already-proven /'4g-train' preset (websocket + datachannel + media outage,
// real enough that LiveKit's own engine legitimately reconnects) — this file
// is not re-proving that recovery works, only that the event log stays
// coherent and correctly ordered while it happens.

async function gotoFixture(page) {
  await page.goto('/test/livekit/fixture.html');
  await page.waitForFunction(() => !!window.__livekitTestHelpers);
}

async function joinOnCurrentPage(page, roomName, identity) {
  const token = await mintToken(identity, roomName);
  await page.evaluate(
    ([url, tok]) => window.__livekitTestHelpers.join(url, tok, {}),
    [LIVEKIT_URL, token]
  );
}

test.describe('event-log-lifecycle: captureEvents/diffCaptures/getEvents across a full real session lifecycle', () => {
  test('join -> publish -> subscribe -> degrade -> reconnect -> leave produces a coherent, correctly-ordered event log', async ({ browser }) => {
    test.setTimeout(120000);
    const roomName = `event-log-lifecycle-${Date.now()}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    try {
      await gotoFixture(pageA);
      const before = await pageA.evaluate(() => window.__webrtcInspector.captureEvents());

      // join
      await joinOnCurrentPage(pageA, roomName, 'alice');
      await gotoFixture(pageB);
      await joinOnCurrentPage(pageB, roomName, 'bob');
      await expect.poll(
        () => pageA.evaluate(() => window.__livekitTestHelpers.getConnectionState()),
        { timeout: ROOM_JOIN_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toBe('connected');
      await expect.poll(
        () => pageB.evaluate(() => window.__livekitTestHelpers.getConnectionState()),
        { timeout: ROOM_JOIN_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toBe('connected');

      // publish + subscribe
      await pageA.evaluate(() => window.__livekitTestHelpers.publishCamMic());
      await expect.poll(
        () => pageB.evaluate(() => window.__livekitTestHelpers.getRemoteTracksByParticipant().alice),
        { timeout: TRACK_SUBSCRIBED_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toEqual(expect.arrayContaining([expect.objectContaining({ source: 'camera' })]));

      // network degradation -> reconnect
      await pageA.evaluate(() => {
        window.__wrtcPreset = window.__webrtcInspector.simulateNetworkPreset('4g-train');
      });
      await pageA.evaluate(() => window.__wrtcPreset.done);
      await expect.poll(
        () => pageA.evaluate(() => window.__livekitTestHelpers.getConnectionState()),
        { timeout: RECONNECT_CONVERGENCE_TIMEOUT_MS, intervals: [POLL_INTERVAL_MS] }
      ).toBe('connected');

      // leave
      await pageA.evaluate(() => window.__livekitTestHelpers.disconnect());
      expect(await pageA.evaluate(() => window.__livekitTestHelpers.getConnectionState())).toBe('disconnected');

      const after = await pageA.evaluate(() => window.__webrtcInspector.captureEvents());
      const diff = await pageA.evaluate(
        ([b, a]) => window.__webrtcInspector.diffCaptures(b, a),
        [before, after]
      );

      // The log only ever grew during this lifecycle: before is an exact
      // prefix of after, never a rewrite or a reorder of what was already there.
      expect(diff.sequenceLengths.to).toBeGreaterThan(diff.sequenceLengths.from);
      expect(diff.firstDivergenceIndex).toBeNull();

      // Every phase of the lifecycle left a real, counted trace.
      ['pc-created', 'network-preset-start', 'network-loss-start', 'network-loss-end', 'pc-closed'].forEach((type) => {
        expect(diff.eventTypeCounts[type], `expected a real count increase for "${type}"`).toBeTruthy();
        expect(diff.eventTypeCounts[type].to).toBeGreaterThan(diff.eventTypeCounts[type].from);
      });

      // Correctly ordered: each phase's marker event genuinely precedes the
      // next phase's, by real seq order, not just by wall-clock coincidence.
      const seqOfFirst = (type, extra) => {
        const hit = after.events.find((e) => e.type === type && (!extra || extra(e)));
        return hit ? hit.seq : null;
      };
      const pcCreatedSeq = seqOfFirst('pc-created');
      const videoTrackAddedSeq = seqOfFirst('track-added', (e) => e.kind === 'video');
      const presetStartSeq = seqOfFirst('network-preset-start');
      const lossEndSeq = seqOfFirst('network-loss-end');
      const pcClosedSeq = seqOfFirst('pc-closed');

      expect(pcCreatedSeq).not.toBeNull();
      expect(videoTrackAddedSeq).not.toBeNull();
      expect(presetStartSeq).not.toBeNull();
      expect(lossEndSeq).not.toBeNull();
      expect(pcClosedSeq).not.toBeNull();

      expect(pcCreatedSeq).toBeLessThan(videoTrackAddedSeq);
      expect(videoTrackAddedSeq).toBeLessThan(presetStartSeq);
      expect(presetStartSeq).toBeLessThan(lossEndSeq);
      expect(lossEndSeq).toBeLessThan(pcClosedSeq);

      // seq is a strictly consecutive, gap-free counter across the whole log
      // for the entire lifecycle (the 5000-entry overflow cap is nowhere
      // near reached in one test, so nothing was ever evicted mid-sequence).
      for (let i = 1; i < after.events.length; i++) {
        expect(after.events[i].seq).toBe(after.events[i - 1].seq + 1);
      }

      // getEvents pagination reconstructs exactly the same ordered sequence
      // as one unbounded call, with internally consistent bookkeeping at
      // every step.
      const wholeLog = await pageA.evaluate(() => window.__webrtcInspector.getEvents({ since: 0 }));
      expect(wholeLog.truncated).toBe(false);
      expect(wholeLog.truncationMarker).toBeNull();
      expect(wholeLog.remainingCount).toBe(0);

      const paged = [];
      let since = 0;
      let guard = 0;
      let page;
      do {
        page = await pageA.evaluate((s) => window.__webrtcInspector.getEvents({ since: s, limit: 5 }), since);
        expect(page.remainingCount).toBe(wholeLog.events.length - paged.length - page.events.length);
        expect(page.truncated).toBe(page.remainingCount > 0);
        if (page.truncated) {
          expect(page.truncationMarker).toContain(String(page.remainingCount));
        } else {
          expect(page.truncationMarker).toBeNull();
        }
        paged.push(...page.events);
        since = page.nextSince;
        guard++;
      } while (page.truncated && guard < 1000);

      expect(paged.map((e) => e.seq)).toEqual(wholeLog.events.map((e) => e.seq));
      expect(paged.map((e) => e.type)).toEqual(wholeLog.events.map((e) => e.type));
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});
