const { test, expect } = require('@playwright/test');
const { gotoFixture } = require('../helpers');

// setMediaFaultInjector rides the standard RTCRtpScriptTransform: the injector
// fn is serialized and runs in a Worker, so specs can't count calls through
// page closures. They use fn's 4th argument, report(payload), which surfaces as
// a 'media-fault-report' event on the page. Coverage is decided when a
// connection is created, so every spec arms the injector BEFORE
// createLoopbackSession. beforeOffer adds a real fake-cam video track (and a
// fake-mic audio track in the mixed test) so encoded frames genuinely flow
// over the loopback's real DTLS-SRTP transport.

async function armReportCollector(page) {
  await page.evaluate(() => {
    window.__reports = [];
    window.__errors = [];
    window.__webrtcInspector.onEvent((e) => {
      if (e.type === 'media-fault-report') window.__reports.push(e);
      if (e.type === 'media-fault-injector-error') window.__errors.push(e);
    });
  });
}

const addVideo = `async (pcA) => {
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  stream.getTracks().forEach((t) => pcA.addTrack(t, stream));
}`;

test.describe('setMediaFaultInjector() / clearMediaFaultInjector()', () => {
  test.beforeEach(async ({ page }) => {
    await gotoFixture(page);
    await armReportCollector(page);
  });

  test('mediaFaultInjectorActive flag reflects set/clear', async ({ page }) => {
    const states = await page.evaluate(() => {
      const before = window.__webrtcInspector.getSnapshot().mediaFaultInjectorActive;
      window.__webrtcInspector.setMediaFaultInjector(null, null, () => {});
      const during = window.__webrtcInspector.getSnapshot().mediaFaultInjectorActive;
      window.__webrtcInspector.clearMediaFaultInjector();
      const after = window.__webrtcInspector.getSnapshot().mediaFaultInjectorActive;
      return { before, during, after };
    });
    expect(states).toEqual({ before: false, during: true, after: false });
  });

  test('fn runs for outgoing and incoming video frames with connId/kind/direction metadata', async ({ page }) => {
    const result = await page.evaluate(async (addVideoSrc) => {
      window.__webrtcInspector.setMediaFaultInjector(null, null, (direction, frame, meta, report) => {
        report({ direction, kind: meta.kind, connId: meta.connId, bytes: frame.data.byteLength });
      });
      await window.__webrtcInspector.setFakeCam({ width: 64, height: 48 });
      const { connectionIdA, connectionIdB } = await window.testHelpers.createLoopbackSession('mfi', eval(addVideoSrc));
      const find = (direction) => window.__reports.find((r) => r.direction === direction && r.kind === 'video');
      await window.testHelpers.waitFor(() => find('outgoing') && find('incoming'), 5000); // throws if either direction never fires
      const out = find('outgoing');
      const inc = find('incoming');
      return {
        outConn: out && out.connectionId, outPayloadConn: out && out.payload.connId, outBytes: out && out.payload.bytes,
        incConn: inc && inc.connectionId,
        connectionIdA, connectionIdB,
        installed: window.__webrtcInspector.getEvents().events.filter((e) => e.type === 'media-transform-installed').map((e) => `${e.connectionId}:${e.direction}`),
        // The receiver install has to be the first thing the 'track' handler
        // does, because Chromium only accepts it synchronously in that handler:
        // anything before it that throws (the audio meter can) would cost
        // incoming coverage for the whole call. Pinned as event order.
        installBeforeTrackReceived: (() => {
          const evs = window.__webrtcInspector.getEvents().events;
          const inc = evs.find((e) => e.type === 'media-transform-installed' && e.direction === 'incoming');
          const recv = evs.find((e) => e.type === 'track-received' && e.connectionId === connectionIdB);
          return !!inc && !!recv && inc.seq < recv.seq;
        })(),
      };
    }, addVideo);
    expect(result.outConn).toBe(result.connectionIdA);
    expect(result.outPayloadConn).toBe(result.connectionIdA);
    expect(result.outBytes).toBeGreaterThan(0);
    expect(result.incConn).toBe(result.connectionIdB);
    expect(result.installed).toEqual(expect.arrayContaining([`${result.connectionIdA}:outgoing`, `${result.connectionIdB}:incoming`]));
    expect(result.installBeforeTrackReceived).toBe(true);
  });

  test('connId scoping: an injector scoped to a different connId never fires, but the connection is still covered', async ({ page }) => {
    const result = await page.evaluate(async (addVideoSrc) => {
      window.__webrtcInspector.setMediaFaultInjector(999999, null, (d, f, m, report) => { report(1); });
      await window.__webrtcInspector.setFakeCam({ width: 64, height: 48 });
      const { connectionIdA } = await window.testHelpers.createLoopbackSession('mfi-scope', eval(addVideoSrc));
      await window.testHelpers.wait(600);
      const conn = window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === connectionIdA);
      return { reports: window.__reports.length, injectable: conn.mediaFaultInjectable };
    }, addVideo);
    expect(result.reports).toBe(0);
    expect(result.injectable).toBe(true);
  });

  test('kind scoping: an audio-only injector never receives video frames', async ({ page }) => {
    const result = await page.evaluate(async () => {
      window.__webrtcInspector.setMediaFaultInjector(null, 'audio', (direction, frame, meta, report) => { report(meta.kind); });
      await window.__webrtcInspector.setFakeCam({ width: 64, height: 48 });
      await window.testHelpers.createLoopbackSession('mfi-kind', async (pcA) => {
        const camStream = await navigator.mediaDevices.getUserMedia({ video: true });
        const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        camStream.getTracks().forEach((t) => pcA.addTrack(t, camStream));
        micStream.getTracks().forEach((t) => pcA.addTrack(t, micStream));
      });
      await window.testHelpers.waitFor(() => window.__reports.length > 10, 5000);
      return Array.from(new Set(window.__reports.map((r) => r.payload)));
    });
    expect(result).toEqual(['audio']);
  });

  test('returning false drops outgoing video frames — sender packetsSent stays at 0', async ({ page }) => {
    const result = await page.evaluate(async (addVideoSrc) => {
      window.__webrtcInspector.setMediaFaultInjector(null, 'video', () => false);
      await window.__webrtcInspector.setFakeCam({ width: 64, height: 48 });
      await window.testHelpers.createLoopbackSession('mfi-drop', eval(addVideoSrc));
      await window.testHelpers.wait(600);
      const stats = await window.__pcA.getStats();
      let packetsSent = 0;
      let framesEncoded = 0;
      stats.forEach((s) => { if (s.type === 'outbound-rtp' && s.kind === 'video') { packetsSent += s.packetsSent || 0; framesEncoded += s.framesEncoded || 0; } });
      return { packetsSent, framesEncoded };
    }, addVideo);
    expect(result.framesEncoded).toBeGreaterThan(0); // the encoder ran; the transform swallowed its output
    expect(result.packetsSent).toBe(0);
  });

  test('mutating frame.data (corrupt) still lets packets flow — sender packetsSent grows', async ({ page }) => {
    const result = await page.evaluate(async (addVideoSrc) => {
      window.__webrtcInspector.setMediaFaultInjector(null, 'video', (direction, frame) => {
        const bytes = new Uint8Array(frame.data);
        if (bytes.length > 0) bytes[0] = bytes[0] ^ 0xff;
      });
      await window.__webrtcInspector.setFakeCam({ width: 64, height: 48 });
      await window.testHelpers.createLoopbackSession('mfi-corrupt', eval(addVideoSrc));
      await window.testHelpers.wait(600);
      const stats = await window.__pcA.getStats();
      let packetsSent = 0;
      stats.forEach((s) => { if (s.type === 'outbound-rtp' && s.kind === 'video') packetsSent += s.packetsSent || 0; });
      return packetsSent;
    }, addVideo);
    expect(result).toBeGreaterThan(0);
  });

  // A uniform {delayMs} shifts the whole stream and stalls nothing, so packets
  // must keep flowing and the connection must stay up. Delaying only *some*
  // frames reorders them and can wedge the receiver for seconds on Chromium and
  // Firefox (README caveat), so that case is deliberately not asserted here.
  test('a uniform {delayMs} on every frame keeps packets flowing', async ({ page }) => {
    const result = await page.evaluate(async (addVideoSrc) => {
      // Worker-side state lives on `self`, never on window: fn is self-contained.
      window.__webrtcInspector.setMediaFaultInjector(null, 'video', (direction, frame, meta, report) => {
        if (direction !== 'outgoing') return undefined;
        self.__n = (self.__n || 0) + 1;
        report(self.__n);
        return { delayMs: 50 };
      });
      await window.__webrtcInspector.setFakeCam({ width: 64, height: 48 });
      const { connectionIdA } = await window.testHelpers.createLoopbackSession('mfi-delay', eval(addVideoSrc));
      await window.testHelpers.waitFor(() => window.__reports.length >= 5, 5000);
      const packets = async () => {
        const stats = await window.__pcA.getStats();
        let n = 0;
        stats.forEach((s) => { if (s.type === 'outbound-rtp' && s.kind === 'video') n += s.packetsSent || 0; });
        return n;
      };
      const p0 = await packets();
      await window.testHelpers.wait(800);
      const delta = (await packets()) - p0;
      const conn = window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === connectionIdA);
      return {
        calls: window.__reports.length,
        delta,
        state: conn.state.connectionState,
        errors: window.__errors.map((e) => `${e.stage}: ${e.message}`),
      };
    }, addVideo);
    expect(result.calls).toBeGreaterThanOrEqual(5);
    expect(result.errors).toEqual([]);
    expect(result.delta).toBeGreaterThan(0); // delayed frames still reach the wire
    expect(result.state).toBe('connected');
  });

  test('clearMediaFaultInjector stops further invocations', async ({ page }) => {
    const result = await page.evaluate(async (addVideoSrc) => {
      window.__webrtcInspector.setMediaFaultInjector(null, 'video', (d, f, m, report) => { report(1); });
      await window.__webrtcInspector.setFakeCam({ width: 64, height: 48 });
      await window.testHelpers.createLoopbackSession('mfi-clear', eval(addVideoSrc));
      await window.testHelpers.waitFor(() => window.__reports.length > 0, 5000);
      window.__webrtcInspector.clearMediaFaultInjector();
      await window.testHelpers.wait(150); // let in-flight worker messages land
      const afterClear = window.__reports.length;
      await window.testHelpers.wait(400);
      return { afterClear, final: window.__reports.length };
    }, addVideo);
    expect(result.afterClear).toBeGreaterThan(0);
    expect(result.final).toBe(result.afterClear);
  });

  test('a covered connection takes a new fn mid-call: drop, then clear, without renegotiation', async ({ page }) => {
    const result = await page.evaluate(async (addVideoSrc) => {
      const packets = async () => {
        const stats = await window.__pcA.getStats();
        let n = 0;
        stats.forEach((s) => { if (s.type === 'outbound-rtp' && s.kind === 'video') n += s.packetsSent || 0; });
        return n;
      };
      window.__webrtcInspector.setMediaFaultInjector(null, 'video', () => {}); // arm coverage, pass frames through
      await window.__webrtcInspector.setFakeCam({ width: 64, height: 48 });
      await window.testHelpers.createLoopbackSession('mfi-midcall', eval(addVideoSrc));
      await window.testHelpers.waitFor(async () => (await packets()) > 0, 5000);

      window.__webrtcInspector.setMediaFaultInjector(null, 'video', () => false);
      await window.testHelpers.wait(200);
      const p0 = await packets();
      await window.testHelpers.wait(800);
      const droppedDelta = (await packets()) - p0;

      window.__webrtcInspector.clearMediaFaultInjector();
      await window.testHelpers.wait(200);
      const p1 = await packets();
      await window.testHelpers.wait(800);
      const restoredDelta = (await packets()) - p1;
      return { droppedDelta, restoredDelta, state: window.__pcA.connectionState, signaling: window.__pcA.signalingState };
    }, addVideo);
    expect(result.droppedDelta).toBe(0);
    expect(result.restoredDelta).toBeGreaterThan(0);
    expect(result.state).toBe('connected');
    expect(result.signaling).toBe('stable');
  });

  test('a throwing fn is reported once as media-fault-injector-error and frames keep flowing', async ({ page }) => {
    const result = await page.evaluate(async (addVideoSrc) => {
      window.__webrtcInspector.setMediaFaultInjector(null, 'video', () => { throw new Error('boom from injector'); });
      await window.__webrtcInspector.setFakeCam({ width: 64, height: 48 });
      await window.testHelpers.createLoopbackSession('mfi-throw', eval(addVideoSrc));
      await window.testHelpers.waitFor(() => window.__errors.length > 0, 5000);
      await window.testHelpers.wait(600);
      const stats = await window.__pcA.getStats();
      let packetsSent = 0;
      stats.forEach((s) => { if (s.type === 'outbound-rtp' && s.kind === 'video') packetsSent += s.packetsSent || 0; });
      const outgoingErrors = window.__errors.filter((e) => e.direction === 'outgoing');
      return { message: window.__errors[0].message, stage: window.__errors[0].stage, outgoingErrors: outgoingErrors.length, packetsSent };
    }, addVideo);
    expect(result.stage).toBe('run');
    expect(result.message).toContain('boom from injector');
    expect(result.outgoingErrors).toBe(1);
    expect(result.packetsSent).toBeGreaterThan(0);
  });

  test('rejects a fn whose source is not a standalone function expression', async ({ page }) => {
    const result = await page.evaluate(() => {
      const holder = { shorthand() { return false; } };
      try {
        window.__webrtcInspector.setMediaFaultInjector(null, null, holder.shorthand);
        return { threw: false };
      } catch (err) {
        return { threw: true, message: err.message, active: window.__webrtcInspector.getSnapshot().mediaFaultInjectorActive };
      }
    });
    expect(result.threw).toBe(true);
    expect(result.message).toContain('self-contained function expression');
    expect(result.active).toBe(false);
  });
});

test.describe('media path is untouched unless an injector is armed', () => {
  test.beforeEach(async ({ page }) => {
    await gotoFixture(page);
  });

  test('no injector: no transform installed, RTCConfiguration passed through, legacy insertable streams left to the app', async ({ page }) => {
    const result = await page.evaluate(async (addVideoSrc) => {
      await window.__webrtcInspector.setFakeCam({ width: 64, height: 48 });
      const { connectionIdA } = await window.testHelpers.createLoopbackSession('untouched', eval(addVideoSrc));
      const sender = window.__pcA.getSenders().find((s) => s.track && s.track.kind === 'video');
      const receiver = window.__pcB.getReceivers().find((r) => r.track && r.track.kind === 'video');
      const conn = window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === connectionIdA);
      // Without a forced encodedInsertableStreams flag Chromium refuses the legacy call (other engines don't have it).
      let legacyOnPlainPc = 'unsupported';
      if (typeof sender.createEncodedStreams === 'function') {
        try { sender.createEncodedStreams(); legacyOnPlainPc = 'allowed'; } catch (err) { legacyOnPlainPc = err.name; }
      }
      return {
        senderTransform: sender.transform,
        receiverTransform: receiver.transform,
        installedEvents: window.__webrtcInspector.getEvents().events.filter((e) => e.type === 'media-transform-installed').length,
        injectable: conn.mediaFaultInjectable,
        legacyOnPlainPc,
      };
    }, addVideo);
    expect(result.senderTransform).toBeNull();
    expect(result.receiverTransform).toBeNull();
    expect(result.installedEvents).toBe(0);
    expect(result.injectable).toBe(false);
    expect(['InvalidStateError', 'unsupported']).toContain(result.legacyOnPlainPc);
  });

  test('the app can still use legacy createEncodedStreams() and standard sender.transform itself', async ({ page }) => {
    const result = await page.evaluate(async () => {
      await window.__webrtcInspector.setFakeCam({ width: 64, height: 48 });
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      const legacyPc = new RTCPeerConnection({ iceServers: [], encodedInsertableStreams: true });
      const legacySender = legacyPc.addTrack(stream.getVideoTracks()[0], stream);
      let legacy = 'unsupported';
      if (typeof legacySender.createEncodedStreams === 'function') {
        try {
          const streams = legacySender.createEncodedStreams();
          legacy = typeof streams.readable === 'object' && typeof streams.writable === 'object' ? 'ok' : 'bad-shape';
        } catch (err) { legacy = err.name; }
      }
      legacyPc.close();

      const standardPc = new RTCPeerConnection({ iceServers: [] });
      const standardSender = standardPc.addTrack(stream.getVideoTracks()[0].clone(), stream);
      const worker = new Worker(URL.createObjectURL(new Blob(['self.onrtctransform = (ev) => ev.transformer.readable.pipeTo(ev.transformer.writable);'], { type: 'text/javascript' })));
      let standard;
      try {
        standardSender.transform = new RTCRtpScriptTransform(worker, {});
        standard = standardSender.transform ? 'ok' : 'not-set';
      } catch (err) { standard = err.name; }
      standardPc.close();
      return { legacy, standard };
    });
    expect(['ok', 'unsupported']).toContain(result.legacy);
    expect(result.standard).toBe('ok');
  });

  test('arming while an uncovered connection is open emits media-fault-injector-uncovered; a legacy-flag connection is never covered', async ({ page }) => {
    const result = await page.evaluate(async (addVideoSrc) => {
      await window.__webrtcInspector.setFakeCam({ width: 64, height: 48 });
      const { connectionIdA, connectionIdB } = await window.testHelpers.createLoopbackSession('pre-arm', eval(addVideoSrc));
      const events = [];
      window.__webrtcInspector.onEvent((e) => { if (e.type === 'media-fault-injector-uncovered') events.push(e); });
      window.__webrtcInspector.setMediaFaultInjector(null, null, () => {});

      const legacyPc = new RTCPeerConnection({ iceServers: [], encodedInsertableStreams: true });
      const legacyId = window.__webrtcInspector.getSnapshot().connections.slice(-1)[0].id;
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      const sender = legacyPc.addTrack(stream.getVideoTracks()[0], stream);
      let legacy = 'unsupported';
      if (typeof sender.createEncodedStreams === 'function') {
        try { sender.createEncodedStreams(); legacy = 'ok'; } catch (err) { legacy = err.name; }
      }
      const snap = window.__webrtcInspector.getSnapshot();
      const injectable = Object.fromEntries(snap.connections.map((c) => [c.id, c.mediaFaultInjectable]));
      legacyPc.close();
      return { uncovered: events.map((e) => e.connectionIds), connectionIdA, connectionIdB, legacyId, injectable, legacy, senderTransform: sender.transform };
    }, addVideo);
    expect(result.uncovered).toEqual([[result.connectionIdA, result.connectionIdB]]);
    expect(result.injectable[result.connectionIdA]).toBe(false);
    expect(result.injectable[result.legacyId]).toBe(false);
    expect(['ok', 'unsupported']).toContain(result.legacy);
    expect(result.senderTransform).toBeNull();
  });
});
