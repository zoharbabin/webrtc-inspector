// WebRTC Inspector — framework-agnostic WebRTC instrumentation core.
// Usage and full API reference: see README.md. No dependencies.
//
// Patches RTCPeerConnection (+ transceivers/senders), RTCDataChannel,
// setLocalDescription/setRemoteDescription, ICE candidate exchange,
// getUserMedia/getDisplayMedia, and WebSocket at the prototype level. Must
// run before the page's own scripts grab references to the unpatched globals.
//
// MediaStreamTrack.prototype.stop is patched directly because the spec
// doesn't fire 'ended' for a self-initiated stop().
//
// WebSocket is patched too (not just RTCPeerConnection/RTCDataChannel)
// because some SFU transports (e.g. mediasoup-client) route control-plane
// messages over a signaling WebSocket instead of a literal RTCDataChannel.

(function () {
  if (window.__webrtcInspector) return;

  const OriginalRTCPeerConnection = window.RTCPeerConnection;
  const OriginalRTCDataChannelSend = window.RTCDataChannel && window.RTCDataChannel.prototype.send;
  const OriginalRTCRtpSenderReplaceTrack = window.RTCRtpSender && window.RTCRtpSender.prototype.replaceTrack;
  const OriginalMediaStreamTrackStop = window.MediaStreamTrack && window.MediaStreamTrack.prototype.stop;
  const OriginalGetUserMedia = navigator.mediaDevices && navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  const OriginalGetDisplayMedia = navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia
    ? navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices)
    : null;

  if (!OriginalRTCPeerConnection) {
    window.__webrtcInspector = { unsupported: true, reason: 'RTCPeerConnection not present on this page' };
    return;
  }

  const config = { statsIntervalMs: 2000, maxLogEntries: 5000, maxStatsHistory: 60, levelIntervalMs: 250, maxDecodedPreviewChars: 500, maxHttpHistory: 200, maxSocketHistory: 100 };
  // Thresholds for getSnapshot()'s heuristic anomaly flags (see #25) — each is
  // "how long a suspicious-looking state has to persist before it's worth
  // flagging", tuned low enough to keep loopback tests fast.
  const ANOMALY_THRESHOLDS = { iceCheckingStuckMs: 5000, dataChannelUnusedMs: 3000, trackNoStatsMs: 3000, freezeRatioBad: 0.10, candidateFlipCount: 2 };
  const connectionsById = new Map(); // id -> record
  const recordByPc = new WeakMap(); // pc -> record
  const trackTagById = new WeakMap(); // MediaStreamTrack -> {tag, sourceCallId}
  const trackRecordByTrack = new WeakMap(); // MediaStreamTrack -> trackRecord (for explicit stop() detection)
  const freezeTrackingStartByTrackRecord = new WeakMap(); // remote video trackRecord -> Date.now() at track start, for freezeRatio's elapsed-time denominator
  const audioMeterProbeByTrackRecord = new WeakMap(); // remote audio trackRecord -> last {samples, packets}, for detecting an undecoded track
  const log = [];
  const listeners = new Set();
  let nextConnectionId = 1;
  let nextGumCallId = 1;
  let dataChannelInterceptor = null;
  const socketsById = new Map(); // id -> record
  const wsRecordByInstance = new WeakMap(); // WebSocket -> record
  let nextSocketId = 1;
  let webSocketInterceptor = null;
  const decoders = []; // {id, matcher, decodeFn}, registration order = match priority
  let nextDecoderId = 1;
  let suggestDecoder = null; // (payload, meta) => any | Promise<any> — single active advisory hook, mirrors ws/dc interceptors
  let mediaFaultInjector = null; // {connId, kind, fnSource} | null — single active injector, mirrors ws/dc interceptors
  let mediaFaultWorker = null; // lazily created Worker that runs every RTCRtpScriptTransform we attach
  let mediaFaultWorkerError = null; // set once the worker dies (CSP blocked the blob: URL); no endpoint is covered after that
  const mediaTransformEndpoints = new WeakSet(); // RTCRtpSender|RTCRtpReceiver that already carry our transform
  let labeler = null; // (meta) => string|null — single active hook, mirrors ws/dc interceptors
  const iceCandidateFilters = new Map(); // connectionId -> predicateFn(candidateType, candidateStr) => boolean, false drops

  let nextSeq = 1;

  // ---- outage state (simulateNetworkLoss) --------------------------------
  //
  // Ref-counted per target so overlapping outages nest: the last one to end
  // lifts the block. The interceptor slots are deliberately NOT used to
  // implement an outage — the send/receive paths consult outageDepth directly.
  // Swapping a blocker into the interceptor slot and restoring the previous
  // value per call breaks whenever two outages overlap: the earlier-ending one
  // restores app state while the other is still running (media leaks through),
  // and the later-ending one restores the other's blocker as if it were the
  // app's own, leaving the page permanently blocked.
  const outageDepth = { websocket: 0, datachannel: 0, http: 0, media: 0 };

  function acquireOutage(target) {
    outageDepth[target] += 1;
    if (target === 'media' && outageDepth.media === 1) startMediaBlackout();
  }

  // Returns a promise for the targets whose teardown is asynchronous (media), so
  // a caller can wait for the outage to be genuinely over. Resolves immediately
  // for every other target.
  function releaseOutage(target) {
    if (outageDepth[target] === 0) return Promise.resolve();
    outageDepth[target] -= 1;
    if (target === 'media' && outageDepth.media === 0) return endMediaBlackout();
    return Promise.resolve();
  }

  function emit(entry) {
    entry.ts = entry.ts || Date.now();
    entry.seq = nextSeq++;
    log.push(entry);
    if (log.length > config.maxLogEntries) log.shift();
    listeners.forEach((cb) => {
      try { cb(entry); } catch (_) { /* listener errors must not break instrumentation */ }
    });
  }

  function preview(data) {
    if (typeof data === 'string') return data.length > 200 ? data.slice(0, 200) + '…' : data;
    if (data instanceof Blob) return `<blob ${data.size} bytes>`;
    if (data && data.byteLength !== undefined) return `<binary ${data.byteLength} bytes>`;
    return String(data);
  }

  function parseSdpSummary(sdp) {
    if (!sdp) return null;
    const mLines = (sdp.match(/^m=/gm) || []).length;
    const codecs = Array.from(new Set((sdp.match(/^a=rtpmap:\d+ (\S+)/gm) || []).map((l) => l.replace(/^a=rtpmap:\d+ /, ''))));
    return { mLines, codecs, byteLength: sdp.length };
  }

  function parseCandidateType(candidateStr) {
    if (!candidateStr) return null;
    const m = candidateStr.match(/typ (\w+)/);
    return m ? m[1] : null; // host | srflx | prflx | relay
  }

  // ---- ICE candidate filtering -----------------------------------------------
  //
  // setIceCandidateFilter(connId, fn) lets a consumer drop candidates by type
  // before they reach addIceCandidate (incoming) or the page's own
  // onicecandidate handler (outgoing) — e.g. drop all 'relay' to force a
  // direct-only path, or drop all non-'relay' to force TURN-only. Per
  // connectionId, unlike the single-active-hook interceptors above, since
  // forcing different paths on different connections in the same test is a
  // real use case.

  function setIceCandidateFilter(connId, fn) { iceCandidateFilters.set(connId, fn); }
  function clearIceCandidateFilter(connId) { iceCandidateFilters.delete(connId); }

  function shouldDropCandidate(connId, candidateType, candidateStr) {
    const fn = iceCandidateFilters.get(connId);
    if (!fn) return false;
    try {
      return fn(candidateType, candidateStr) === false;
    } catch (_) {
      return false;
    }
  }

  // ---- connection/socket labeler ---------------------------------------------
  //
  // setLabeler(fn) lets a consumer map URL/hostname patterns (signaling
  // server, TURN/STUN server) to a friendly name in getSnapshot() output,
  // without this tool knowing any vendor specifics itself.

  function flattenIceServerUrls(configuration) {
    if (!configuration || !Array.isArray(configuration.iceServers)) return [];
    const urls = [];
    configuration.iceServers.forEach((server) => {
      if (!server || !server.urls) return;
      if (Array.isArray(server.urls)) urls.push(...server.urls);
      else urls.push(server.urls);
    });
    return urls;
  }

  function setLabeler(fn) { labeler = fn; }
  function clearLabeler() { labeler = null; }

  function computeLabel(meta) {
    if (!labeler) return null;
    try {
      return labeler(meta) || null;
    } catch (_) {
      return null;
    }
  }

  // ---- message decoders -----------------------------------------------------
  //
  // Opt-in protocol decoding on top of the raw preview() capture below.
  // registerDecoder(matcher, decodeFn) mirrors onEvent's "return an
  // unsubscribe closure" convention. First registered match wins; decode runs
  // after any interceptor has had a chance to rewrite/block the message, so a
  // decoder sees the data as actually delivered/sent.

  function registerDecoder(matcher, decodeFn) {
    const entry = { id: nextDecoderId++, matcher, decodeFn };
    decoders.push(entry);
    return () => {
      const idx = decoders.indexOf(entry);
      if (idx !== -1) decoders.splice(idx, 1);
    };
  }

  // Opt-in advisory layer on top of registerDecoder's no-match path (see #27):
  // when nothing matches, hand the raw payload to a consumer-supplied hook
  // (e.g. wired to an LLM call) that proposes a best-guess label. This library
  // makes no LLM calls itself and never treats a suggestion as a decode —
  // results are tagged advisory:true and land under `suggested`, never
  // `decoded`, so a consumer can't mistake one for the other.
  function setSuggestDecoder(fn) { suggestDecoder = fn; }
  function clearSuggestDecoder() { suggestDecoder = null; }

  function cappedSuggestionResult(value) {
    let json;
    try {
      json = JSON.stringify(value);
    } catch (err) {
      return { decoderId: null, suggestionError: `suggestion not JSON-serializable: ${err.message}`, advisory: true };
    }
    if (json === undefined) return { decoderId: null, suggestionError: 'suggestion not JSON-serializable', advisory: true };
    const suggested = json.length <= config.maxDecodedPreviewChars ? value : json.slice(0, config.maxDecodedPreviewChars) + '…';
    return { decoderId: null, suggested, advisory: true };
  }

  function runSuggestDecoder(meta, data) {
    if (!suggestDecoder) return null;
    return normalizeDecodable(data).then((normalized) => {
      let result;
      try {
        result = suggestDecoder(normalized, meta);
      } catch (err) {
        return { decoderId: null, suggestionError: String(err), advisory: true };
      }
      if (result && typeof result.then === 'function') {
        return result.then(
          (suggested) => cappedSuggestionResult(suggested),
          (err) => ({ decoderId: null, suggestionError: String(err), advisory: true })
        );
      }
      return cappedSuggestionResult(result);
    });
  }

  function cappedDecodedResult(decoderId, value) {
    let json;
    try {
      json = JSON.stringify(value);
    } catch (err) {
      return { decoderId, decodeError: `decoder output not JSON-serializable: ${err.message}` };
    }
    if (json === undefined) return { decoderId, decodeError: 'decoder output not JSON-serializable' };
    if (json.length <= config.maxDecodedPreviewChars) return { decoderId, decoded: value };
    return { decoderId, decoded: json.slice(0, config.maxDecodedPreviewChars) + '…' };
  }

  function normalizeDecodable(data) {
    return data instanceof Blob ? data.arrayBuffer() : Promise.resolve(data);
  }

  // Returns null when no decoder is registered (zero cost for callers who
  // never opt in), otherwise a Promise resolving to {decoderId, decoded} or
  // {decoderId, decodeError} — never rejects, a throwing decodeFn is caught.
  function runDecoders(meta, data) {
    if (decoders.length === 0) return runSuggestDecoder(meta, data);
    let match;
    for (const d of decoders) {
      try {
        if (d.matcher(meta)) { match = d; break; }
      } catch (_) { /* a throwing matcher just doesn't match */ }
    }
    if (!match) return runSuggestDecoder(meta, data);
    return normalizeDecodable(data).then((normalized) => {
      let result;
      try {
        result = match.decodeFn(normalized, meta);
      } catch (err) {
        return { decoderId: match.id, decodeError: String(err) };
      }
      if (result && typeof result.then === 'function') {
        return result.then(
          (decoded) => cappedDecodedResult(match.id, decoded),
          (err) => ({ decoderId: match.id, decodeError: String(err) })
        );
      }
      return cappedDecodedResult(match.id, result);
    });
  }

  // Attaches a decode result (once resolved) onto the already-pushed message
  // record in place, and emits a follow-up event — never blocks delivery.
  function attachDecodeResult(decodePromise, messageRecord, eventType, eventBase) {
    if (!decodePromise) return;
    decodePromise.then((result) => {
      Object.assign(messageRecord, result);
      emit(Object.assign({ type: eventType }, eventBase, result));
    });
  }

  // ---- RTCPeerConnection ----------------------------------------------------

  function PatchedRTCPeerConnection(configuration, constraints) {
    // The configuration is passed through untouched: the inspector never forces
    // encodedInsertableStreams or any other media-path option, so by default
    // it measures exactly what the app would do on its own.
    const pc = constraints !== undefined
      ? new OriginalRTCPeerConnection(configuration, constraints)
      : new OriginalRTCPeerConnection(configuration);

    const id = nextConnectionId++;
    const record = {
      id,
      createdAt: Date.now(),
      configuration: configuration || null,
      // Decided once, here: encoded-frame transforms can only be attached to
      // senders before setLocalDescription and to receivers inside the 'track'
      // event on Chromium, so coverage is fixed at creation time. Never covered
      // when the app asked for legacy insertable streams itself.
      mediaFaultInjectable: !!mediaFaultInjector && supportsMediaTransform() && !(configuration && configuration.encodedInsertableStreams),
      closed: false,
      state: {
        iceConnectionState: pc.iceConnectionState,
        connectionState: pc.connectionState,
        signalingState: pc.signalingState,
        iceConnectionStateSince: Date.now(),
      },
      localTracks: [],
      remoteTracks: [],
      dataChannels: [],
      statsHistory: [],
      localCandidates: [],
      remoteCandidates: [],
      lastLocalSdp: null,
      lastRemoteSdp: null,
      selectedCandidateType: null,
      candidateTypeFlips: [],
      avSyncDeltaMs: null,
      qualityScore: null,
      pc,
    };
    connectionsById.set(id, record);
    recordByPc.set(pc, record);
    emit({ type: 'pc-created', connectionId: id, configuration });

    pc.addEventListener('iceconnectionstatechange', () => {
      record.state.iceConnectionState = pc.iceConnectionState;
      record.state.iceConnectionStateSince = Date.now();
      emit({ type: 'ice-state', connectionId: id, state: pc.iceConnectionState });
    });
    pc.addEventListener('connectionstatechange', () => {
      record.state.connectionState = pc.connectionState;
      emit({ type: 'connection-state', connectionId: id, state: pc.connectionState });
      if (pc.connectionState === 'closed' || pc.connectionState === 'failed') {
        markConnectionClosed(record, pc.connectionState);
      }
    });
    pc.addEventListener('signalingstatechange', () => {
      record.state.signalingState = pc.signalingState;
      emit({ type: 'signaling-state', connectionId: id, state: pc.signalingState });
    });
    pc.addEventListener('icecandidate', (ev) => {
      if (!ev.candidate) return; // null candidate marks end-of-candidates
      const type = parseCandidateType(ev.candidate.candidate);
      if (shouldDropCandidate(id, type, ev.candidate.candidate)) {
        emit({ type: 'ice-candidate-local-dropped', connectionId: id, candidateType: type });
        ev.stopImmediatePropagation(); // registered before any page listener — prevents the app's own onicecandidate from ever seeing it
        return;
      }
      record.localCandidates.push({ ts: Date.now(), type, candidate: ev.candidate.candidate });
      emit({ type: 'ice-candidate-local', connectionId: id, candidateType: type });
    });
    pc.addEventListener('icecandidateerror', (ev) => {
      emit({ type: 'ice-candidate-error', connectionId: id, errorCode: ev.errorCode, errorText: ev.errorText, url: ev.url });
    });
    pc.addEventListener('track', (ev) => {
      const tag = trackTagById.get(ev.track);
      const trackRecord = {
        trackId: ev.track.id, kind: ev.track.kind, label: ev.track.label, sourceTag: tag ? tag.tag : null, status: 'live', level: null,
        // Derived, never assigned directly: two independent writers feed it (the
        // 2s stats poll decides 'track-not-rendered', the 250ms meter tick decides
        // 'meter-failed'/'audio-context-not-rendering'). Assigning it from both made
        // the poll clobber the meter's reason, leaving level null with no reason.
        levelUnavailableReason: null,
        freezeCount: null, totalFreezesDuration: null, freezeRatio: null, qualityFlag: null, addedAt: Date.now(),
        qualityScore: null,
      };
      record.remoteTracks.push(trackRecord);
      // First, before anything that can throw: Chromium only accepts a receiver
      // transform synchronously inside this handler, so a throw from the audio
      // meter (AudioContext limit, non-fully-active document) would otherwise
      // cost incoming fault coverage for the rest of the call with no signal.
      // installMediaTransform never throws — it reports via media-transform-failed.
      installMediaTransform(record, ev.receiver, 'incoming', ev.track.kind);
      freezeTrackingStartByTrackRecord.set(trackRecord, Date.now());
      attachTrackLifecycle(record, trackRecord, ev.track, 'remote');
      if (ev.track.kind === 'audio') {
        try {
          meterRemoteAudioTrack(record, trackRecord, ev.track);
        } catch (err) {
          setMeterUnavailable(trackRecord, 'meter-failed');
          emit({ type: 'audio-meter-failed', connectionId: id, trackId: ev.track.id, error: String((err && err.message) || err) });
        }
      }
      emit({ type: 'track-received', connectionId: id, kind: ev.track.kind, trackId: ev.track.id, sourceTag: tag ? tag.tag : null });
    });
    pc.addEventListener('datachannel', (ev) => {
      instrumentDataChannel(record, ev.channel, 'remote');
    });

    startStatsPolling(record);
    return pc;
  }
  PatchedRTCPeerConnection.prototype = OriginalRTCPeerConnection.prototype;
  Object.setPrototypeOf(PatchedRTCPeerConnection, OriginalRTCPeerConnection);
  window.RTCPeerConnection = PatchedRTCPeerConnection;
  // The prototype is shared with the native constructor, so `pc.constructor`
  // would otherwise be the native RTCPeerConnection while `window.RTCPeerConnection`
  // is the patched one. Apps that compare the two (`pc.constructor === RTCPeerConnection`)
  // must not be able to tell the inspector is loaded.
  defineHiddenConstructor(OriginalRTCPeerConnection.prototype, PatchedRTCPeerConnection);

  // close() does not reliably fire connectionstatechange: per spec it sets the
  // state directly, and on a connection that never negotiated no event fires at
  // all. Without this patch an app's own close() leaves the record open, so the
  // 2s stats poll and the audio meters run for the life of the page and
  // getSnapshot() reports a dead connection as live.
  const originalPcClose = OriginalRTCPeerConnection.prototype.close;
  OriginalRTCPeerConnection.prototype.close = function () {
    const result = originalPcClose.apply(this, arguments);
    const record = recordByPc.get(this);
    if (record) markConnectionClosed(record, 'closed');
    return result;
  };

  function defineHiddenConstructor(proto, ctor) {
    try {
      Object.defineProperty(proto, 'constructor', { value: ctor, writable: true, enumerable: false, configurable: true });
    } catch (_) { /* a frozen prototype is not worth failing instrumentation over */ }
  }

  function attachTrackLifecycle(record, trackRecord, track, origin) {
    trackRecordByTrack.set(track, trackRecord);
    track.addEventListener('ended', () => { trackRecord.status = 'ended'; emit({ type: 'track-ended', connectionId: record.id, trackId: track.id, origin }); });
    track.addEventListener('mute', () => { trackRecord.status = 'muted'; emit({ type: 'track-muted', connectionId: record.id, trackId: track.id, origin }); });
    track.addEventListener('unmute', () => { trackRecord.status = 'live'; emit({ type: 'track-unmuted', connectionId: record.id, trackId: track.id, origin }); });
  }

  // ---- WebRTC Encoded Transform: encoded media-frame fault injection --------
  //
  // Uses the standard RTCRtpScriptTransform (Chromium, Firefox, WebKit), not
  // Chromium's legacy createEncodedStreams(). Transforms run in a Worker, so
  // the injector fn is shipped as source text and must be self-contained: no
  // closures over page state. fn(direction, frame, meta, report) receives the
  // live encoded frame — its writable .data lets it corrupt in place with no
  // special return value; {delayMs}/false cover actions the platform has no
  // direct API for. report(payload) posts a cloneable payload back to the page
  // as a 'media-fault-report' event.
  //
  // There is deliberately no 'duplicate' action. Enqueueing a second copy of an
  // encoded frame succeeds in the worker on every engine and still produces
  // zero extra RTP: measured packetsSent over a fixed window was identical to
  // baseline on Chromium, Firefox and WebKit, with the copy's rtpTimestamp
  // shifted by 0, +1 and +3000 and its frameId bumped. The sender drops the
  // extra frame before packetization. Don't re-add it.
  //
  // Nothing is attached unless an injector is armed when the connection is
  // created (record.mediaFaultInjectable). Chromium only accepts a sender
  // transform before setLocalDescription and a receiver transform inside the
  // 'track' event; a later attach silently does nothing, and setting
  // .transform = null on a live endpoint stalls media (Chromium schedules its
  // native pass-through only once, at sender construction, so a detached
  // endpoint has no consumer left). So coverage is decided at creation and
  // never detached: clearMediaFaultInjector() switches the worker to
  // pass-through instead. An endpoint that already carries an app transform
  // is left alone; legacy createEncodedStreams() and .transform feed the same
  // frame slot in Chromium and the later one silently starves the earlier,
  // so encodedInsertableStreams connections are never covered either.

  const MEDIA_FAULT_WORKER_SOURCE = `'use strict';
let injector = null; // {connId, kind, fn}
let outage = false;  // simulateNetworkLoss({targets:['media']}) drops every frame on covered endpoints

function compile(src) {
  try {
    return new Function('return (' + src + ')')();
  } catch (err) {
    if (err instanceof SyntaxError) throw err;
    // CSP blocked eval in this worker: load the source as a script instead.
    const url = URL.createObjectURL(new Blob(['self.__mediaFaultFn = (' + src + ');'], { type: 'text/javascript' }));
    try { importScripts(url); } finally { URL.revokeObjectURL(url); }
    const fn = self.__mediaFaultFn;
    delete self.__mediaFaultFn;
    return fn;
  }
}

self.onmessage = (e) => {
  const msg = e.data || {};
  if (msg.type === 'set') {
    try {
      injector = { connId: msg.connId, kind: msg.kind, fn: compile(msg.fnSource) };
    } catch (err) {
      injector = null;
      self.postMessage({ type: 'injector-error', stage: 'compile', message: String((err && err.message) || err) });
    }
  } else if (msg.type === 'clear') {
    injector = null;
  } else if (msg.type === 'outage') {
    outage = !!msg.active;
  }
};

function matches(inj, meta) {
  return (inj.connId == null || inj.connId === meta.connId) && (inj.kind == null || inj.kind === meta.kind);
}

self.onrtctransform = (ev) => {
  const meta = ev.transformer.options || {};
  let reportedError = false;
  const reportOnce = (stage, message) => {
    if (reportedError) return;
    reportedError = true;
    self.postMessage({ type: 'injector-error', stage: stage, meta: meta, message: message });
  };
  // A non-cloneable payload makes postMessage throw. Unguarded, that throw
  // escapes the injector, is caught below as an injector failure, and turns an
  // intended drop (return false) into a sent frame — silently changing what the
  // fault does. Report the bad payload and let the injector's return value stand.
  const report = (payload) => {
    try {
      self.postMessage({ type: 'report', meta: meta, payload: payload });
    } catch (err) {
      reportOnce('report', 'report() payload is not structured-cloneable: ' + String((err && err.message) || err));
    }
  };
  const ts = new TransformStream({
    transform(frame, controller) {
      if (outage) return;
      const inj = injector;
      if (!inj || !matches(inj, meta)) { controller.enqueue(frame); return; }
      let action;
      try {
        action = inj.fn(meta.direction, frame, meta, report);
      } catch (err) {
        action = undefined; // a throwing injector passes the frame through
        reportOnce('run', String((err && err.message) || err));
      }
      if (action === false) return; // drop
      if (action && typeof action.delayMs === 'number') {
        setTimeout(() => { try { controller.enqueue(frame); } catch (_) { /* stream closed before the delay elapsed */ } }, action.delayMs);
        return;
      }
      controller.enqueue(frame);
    },
  });
  ev.transformer.readable.pipeThrough(ts).pipeTo(ev.transformer.writable).catch(() => {
    /* rejects on pc close/track end — expected, not an error */
  });
};
`;

  function supportsMediaTransform() {
    return typeof window.RTCRtpScriptTransform === 'function' && typeof window.Worker === 'function';
  }

  const WORKER_CSP_HINT = "The page's Content-Security-Policy must allow blob: workers (worker-src/script-src).";

  function getMediaFaultWorker() {
    // A CSP-blocked blob: worker does NOT throw from `new Worker` — it fails
    // asynchronously through the error event. Once that has happened, refusing
    // here is what keeps a transform from being attached in front of a worker
    // that will never consume a frame, which stalls the media path outright.
    if (mediaFaultWorkerError) throw new Error(`setMediaFaultInjector: the transform worker died (${mediaFaultWorkerError}). ${WORKER_CSP_HINT}`);
    if (mediaFaultWorker) return mediaFaultWorker;
    let worker;
    try {
      worker = new Worker(URL.createObjectURL(new Blob([MEDIA_FAULT_WORKER_SOURCE], { type: 'text/javascript' })));
    } catch (err) {
      throw new Error(`setMediaFaultInjector: could not start the transform worker (${err && err.message}). ${WORKER_CSP_HINT}`);
    }
    worker.onmessage = (e) => {
      const msg = e.data || {};
      const meta = msg.meta || {};
      if (msg.type === 'report') {
        emit({ type: 'media-fault-report', connectionId: meta.connId, kind: meta.kind, direction: meta.direction, trackId: meta.trackId, payload: msg.payload });
      } else if (msg.type === 'injector-error') {
        emit({ type: 'media-fault-injector-error', stage: msg.stage, connectionId: meta.connId, kind: meta.kind, direction: meta.direction, message: msg.message });
      }
    };
    worker.onerror = (e) => {
      const message = (e && e.message) || 'worker error (blocked by Content-Security-Policy?)';
      mediaFaultWorkerError = message;
      mediaFaultInjector = null; // nothing can run, so stop claiming a connection is injectable
      emit({ type: 'media-fault-injector-error', stage: 'worker', message: `${message}. ${WORKER_CSP_HINT}` });
    };
    mediaFaultWorker = worker;
    return worker;
  }

  function installMediaTransform(record, endpoint, direction, kind) {
    if (!record.mediaFaultInjectable || !endpoint || mediaTransformEndpoints.has(endpoint)) return;
    if (endpoint.transform) {
      emit({ type: 'media-transform-failed', connectionId: record.id, kind, direction, error: 'app transform already set' });
      return;
    }
    let worker;
    try { worker = getMediaFaultWorker(); } catch (err) {
      emit({ type: 'media-transform-failed', connectionId: record.id, kind, direction, error: err.message });
      return;
    }
    const meta = { connId: record.id, kind, direction, trackId: endpoint.track ? endpoint.track.id : null };
    try {
      endpoint.transform = new window.RTCRtpScriptTransform(worker, meta);
      mediaTransformEndpoints.add(endpoint);
      record.mediaFaultCoveredEndpoints = (record.mediaFaultCoveredEndpoints || 0) + 1;
      emit({ type: 'media-transform-installed', connectionId: record.id, kind, direction });
    } catch (err) {
      emit({ type: 'media-transform-failed', connectionId: record.id, kind, direction, error: String((err && err.message) || err) });
    }
  }

  function setMediaFaultInjector(connId, kind, fn) {
    if (typeof fn !== 'function') throw new TypeError('setMediaFaultInjector: fn must be a function');
    if (!supportsMediaTransform()) throw new Error('setMediaFaultInjector: RTCRtpScriptTransform is not available in this browser');
    const fnSource = String(fn);
    try {
      new Function(`return (${fnSource})`); // surface a non-expression source (bound/native/method shorthand) right here
    } catch (err) {
      if (err instanceof SyntaxError) throw new Error(`setMediaFaultInjector: fn must be a self-contained function expression (${err.message})`);
      // any other error means the page CSP blocks eval; the worker compiles it instead
    }
    const worker = getMediaFaultWorker();
    mediaFaultInjector = { connId: connId != null ? connId : null, kind: kind != null ? kind : null, fnSource };
    worker.postMessage({ type: 'set', connId: mediaFaultInjector.connId, kind: mediaFaultInjector.kind, fnSource });
    const uncovered = Array.from(connectionsById.values()).filter((r) => !r.closed && !r.mediaFaultInjectable).map((r) => r.id);
    if (uncovered.length) emit({ type: 'media-fault-injector-uncovered', connectionIds: uncovered });
  }
  function clearMediaFaultInjector() {
    mediaFaultInjector = null;
    if (mediaFaultWorker) mediaFaultWorker.postMessage({ type: 'clear' });
  }

  // Transform-free outgoing media blackout for simulateNetworkLoss: every live
  // sender gets replaceTrack(null), which stops RTP on all engines mid-call
  // with no renegotiation, then gets its track back on restore. Endpoints that
  // do carry our transform additionally drop both directions via the worker.
  //
  // The blacked-out set is module state, not a per-call snapshot, so a sender
  // the app adds while the outage is running is blacked out too — otherwise a
  // track added mid-outage would keep sending and the outage would silently
  // cover less than it claims. Lifecycle is owned by acquireOutage/
  // releaseOutage, which ref-count overlapping outages.
  let mediaBlackout = null; // { blackedOut: [] } while the media target is down

  // Whatever the app last set on a sender is what the outage owes it back, so a
  // sender never holds two pending restores. Without this, an app track swapped
  // in mid-outage would race the original for the restore slot.
  function forgetBlackedOutSender(sender) {
    if (!mediaBlackout) return;
    mediaBlackout.blackedOut = mediaBlackout.blackedOut.filter((e) => e.sender !== sender);
  }

  function blackOutSender(record, sender) {
    if (!mediaBlackout || !OriginalRTCRtpSenderReplaceTrack || !sender) return;
    const track = sender.track;
    if (!track) return;
    forgetBlackedOutSender(sender);
    try {
      const settled = OriginalRTCRtpSenderReplaceTrack.call(sender, null).catch(() => {});
      mediaBlackout.blackedOut.push({ record: record || null, sender, track, settled });
    } catch (_) { /* sender already closed */ }
  }

  function recordForSender(sender) {
    let found = null;
    connectionsById.forEach((record) => {
      if (found || record.closed) return;
      try { if (record.pc.getSenders().indexOf(sender) !== -1) found = record; } catch (_) { /* pc closed */ }
    });
    return found;
  }

  function startMediaBlackout() {
    mediaBlackout = { blackedOut: [] };
    connectionsById.forEach((record) => {
      if (record.closed) return;
      let senders = [];
      try { senders = record.pc.getSenders(); } catch (_) { return; }
      senders.forEach((sender) => blackOutSender(record, sender));
    });
    if (mediaFaultWorker) mediaFaultWorker.postMessage({ type: 'outage', active: true });
  }

  // Returns a promise that settles once every sender has actually had its track
  // put back, so callers can report the outage as over only when it really is.
  function endMediaBlackout() {
    const outage = mediaBlackout;
    mediaBlackout = null;
    if (mediaFaultWorker) mediaFaultWorker.postMessage({ type: 'outage', active: false });
    if (!outage) return Promise.resolve();
    return Promise.all(outage.blackedOut.map(({ record, sender, track, settled }) => settled.then(() => {
      // Only put back what we removed: skip if the app replaced/removed the track meanwhile.
      if ((record && record.closed) || sender.track !== null || track.readyState !== 'live') return undefined;
      return OriginalRTCRtpSenderReplaceTrack.call(sender, track);
    }).catch((err) => {
      // A rejected/thrown restore must not vanish silently — same trust
      // principle as the app-facing replaceTrack wrapper's track-replace-
      // failed event below. Without this, the sender is left dark and
      // simulateNetworkLoss still reports network-loss-end as if every
      // track had actually come back.
      emit({ type: 'media-blackout-restore-failed', connectionId: record ? record.id : null, kind: track.kind, trackId: track.id, error: String((err && err.message) || err) });
    }))).then(() => undefined);
  }

  // MediaStreamTrack's spec-defined 'ended' EVENT does not fire for an explicit
  // .stop() call by the page's own script (only for externally caused endings),
  // so relying on the event alone silently misses the single most common way
  // apps release a mic/camera. Patch stop() itself to catch that case too.
  if (OriginalMediaStreamTrackStop) {
    window.MediaStreamTrack.prototype.stop = function () {
      const trackRecord = trackRecordByTrack.get(this);
      if (trackRecord && trackRecord.status !== 'ended') {
        trackRecord.status = 'ended';
        emit({ type: 'track-ended', trackId: this.id, reason: 'stop() called' });
      }
      return OriginalMediaStreamTrackStop.call(this);
    };
  }

  function logLocalTrack(record, track) {
    const tag = trackTagById.get(track);
    const trackRecord = { trackId: track.id, kind: track.kind, label: track.label, sourceTag: tag ? tag.tag : null, status: 'live', level: null, qualityLimitationReason: null, addedAt: Date.now() };
    record.localTracks.push(trackRecord);
    attachTrackLifecycle(record, trackRecord, track, 'local');
    emit({ type: 'track-added', connectionId: record.id, kind: track.kind, trackId: track.id, sourceTag: tag ? tag.tag : null });
  }

  const originalAddTrack = OriginalRTCPeerConnection.prototype.addTrack;
  OriginalRTCPeerConnection.prototype.addTrack = function (track, ...streams) {
    const result = originalAddTrack.apply(this, [track, ...streams]);
    const record = recordByPc.get(this);
    if (record) {
      logLocalTrack(record, track);
      installMediaTransform(record, result, 'outgoing', track.kind);
      blackOutSender(record, result);
    }
    return result;
  };

  const originalAddTransceiver = OriginalRTCPeerConnection.prototype.addTransceiver;
  if (originalAddTransceiver) {
    OriginalRTCPeerConnection.prototype.addTransceiver = function (trackOrKind, init) {
      const result = originalAddTransceiver.apply(this, [trackOrKind, init]);
      const record = recordByPc.get(this);
      if (record) {
        const kind = typeof trackOrKind === 'string' ? trackOrKind : trackOrKind.kind;
        emit({ type: 'transceiver-added', connectionId: record.id, kind, direction: init && init.direction });
        if (trackOrKind && typeof trackOrKind !== 'string') logLocalTrack(record, trackOrKind);
        installMediaTransform(record, result.sender, 'outgoing', kind);
        blackOutSender(record, result.sender);
      }
      return result;
    };
  }

  // An answering peer's senders are created by setRemoteDescription, not by
  // addTrack/addTransceiver, so nothing else in this file ever sees them. Sweep
  // every transceiver here, synchronously before the native call, because
  // Chromium only accepts a sender transform before setLocalDescription.
  // installMediaTransform skips endpoints it already covers, so this is a no-op
  // on the offerer path and safe to run on every renegotiation.
  function coverExistingSenders(record, pc) {
    if (!record.mediaFaultInjectable) return;
    let transceivers = [];
    try { transceivers = pc.getTransceivers(); } catch (_) { return; }
    transceivers.forEach((tr) => {
      if (!tr.sender) return;
      const kind = (tr.sender.track && tr.sender.track.kind) || (tr.receiver && tr.receiver.track && tr.receiver.track.kind) || null;
      installMediaTransform(record, tr.sender, 'outgoing', kind);
    });
  }

  const originalSetLocalDescription = OriginalRTCPeerConnection.prototype.setLocalDescription;
  OriginalRTCPeerConnection.prototype.setLocalDescription = function (description) {
    const record = recordByPc.get(this);
    if (record) coverExistingSenders(record, this);
    return originalSetLocalDescription.apply(this, [description]).then((res) => {
      if (record) {
        const sdp = description ? description.sdp : this.localDescription && this.localDescription.sdp;
        const type = description ? description.type : this.localDescription && this.localDescription.type;
        record.lastLocalSdp = { type, sdp, summary: parseSdpSummary(sdp) };
        emit({ type: 'local-description-set', connectionId: record.id, sdpType: type, summary: record.lastLocalSdp.summary });
      }
      return res;
    });
  };

  const originalSetRemoteDescription = OriginalRTCPeerConnection.prototype.setRemoteDescription;
  OriginalRTCPeerConnection.prototype.setRemoteDescription = function (description) {
    const record = recordByPc.get(this);
    return originalSetRemoteDescription.apply(this, [description]).then((res) => {
      if (record) {
        record.lastRemoteSdp = { type: description.type, sdp: description.sdp, summary: parseSdpSummary(description.sdp) };
        emit({ type: 'remote-description-set', connectionId: record.id, sdpType: description.type, summary: record.lastRemoteSdp.summary });
      }
      return res;
    });
  };

  const originalAddIceCandidate = OriginalRTCPeerConnection.prototype.addIceCandidate;
  OriginalRTCPeerConnection.prototype.addIceCandidate = function (candidate) {
    const record = recordByPc.get(this);
    if (record && candidate) {
      const candStr = candidate.candidate || '';
      const type = parseCandidateType(candStr);
      if (shouldDropCandidate(record.id, type, candStr)) {
        emit({ type: 'ice-candidate-remote-dropped', connectionId: record.id, candidateType: type });
        return Promise.resolve();
      }
      // addIceCandidate() can reject (bad SDP fragment, wrong signaling state) —
      // emit only after it settles, so a rejected candidate isn't logged as added.
      return originalAddIceCandidate.apply(this, [candidate]).then((res) => {
        record.remoteCandidates.push({ ts: Date.now(), type, candidate: candStr });
        emit({ type: 'ice-candidate-remote', connectionId: record.id, candidateType: type });
        return res;
      }, (err) => {
        emit({ type: 'ice-candidate-remote-failed', connectionId: record.id, candidateType: type, error: String((err && err.message) || err) });
        throw err;
      });
    }
    return originalAddIceCandidate.apply(this, [candidate]);
  };

  const originalCreateDataChannel = OriginalRTCPeerConnection.prototype.createDataChannel;
  OriginalRTCPeerConnection.prototype.createDataChannel = function (label, options) {
    const channel = originalCreateDataChannel.apply(this, [label, options]);
    const record = recordByPc.get(this);
    if (record) instrumentDataChannel(record, channel, 'local');
    return channel;
  };

  if (OriginalRTCRtpSenderReplaceTrack) {
    window.RTCRtpSender.prototype.replaceTrack = function (newTrack) {
      const tag = newTrack ? trackTagById.get(newTrack) : null;
      const sender = this;
      // Emit only once the native call has actually settled — a rejected
      // replaceTrack() (closed sender, invalid track) must not be logged as
      // done, and a caller reading the event log as its only record of what
      // happened (the MCP path) needs the failure to be visible too.
      return OriginalRTCRtpSenderReplaceTrack.call(sender, newTrack).then((res) => {
        emit({ type: 'track-replaced', kind: newTrack ? newTrack.kind : null, trackId: newTrack ? newTrack.id : null, sourceTag: tag ? tag.tag : null });
        // The app's choice wins: drop any restore we still owe this sender, then
        // keep the new track dark for the rest of the outage. An app that clears
        // the track mid-outage gets no track back when the outage lifts.
        if (mediaBlackout) {
          forgetBlackedOutSender(sender);
          if (newTrack) blackOutSender(recordForSender(sender), sender);
        }
        return res;
      }, (err) => {
        emit({ type: 'track-replace-failed', kind: newTrack ? newTrack.kind : null, trackId: newTrack ? newTrack.id : null, error: String((err && err.message) || err) });
        throw err;
      });
    };
  }

  // ---- data channels: capture + optional in-flight interceptor --------------
  //
  // Our 'message' listener and the 'datachannel'/createDataChannel wrapping
  // above are attached synchronously before the calling app code can attach
  // its own — so on Chrome's synchronous, registration-order event dispatch,
  // this listener always runs first. That ordering is what makes the
  // interceptor safe: mutating ev.data here (via defineProperty) or calling
  // stopImmediatePropagation() is visible to / blocks every listener the app
  // adds afterward, on the same event object.

  function instrumentDataChannel(record, channel, origin) {
    const dcRecord = { label: channel.label, id: channel.id, origin, state: channel.readyState, messages: [], createdAt: Date.now() };
    record.dataChannels.push(dcRecord);
    emit({ type: 'datachannel-opened', connectionId: record.id, label: channel.label, origin });

    channel.addEventListener('open', () => { dcRecord.state = 'open'; });
    channel.addEventListener('close', () => { dcRecord.state = 'closed'; });
    channel.addEventListener('message', (ev) => {
      let data = ev.data;
      if (outageDepth.datachannel > 0) {
        emit({ type: 'datachannel-message-blocked', connectionId: record.id, label: channel.label, dir: 'in' });
        ev.stopImmediatePropagation();
        return;
      }
      if (dataChannelInterceptor) {
        const result = dataChannelInterceptor('in', { connectionId: record.id, label: channel.label, data });
        if (result === false) {
          emit({ type: 'datachannel-message-blocked', connectionId: record.id, label: channel.label, dir: 'in' });
          ev.stopImmediatePropagation();
          return;
        }
        if (result !== undefined && result !== data) {
          data = result;
          Object.defineProperty(ev, 'data', { value: data, configurable: true });
        }
      }
      const messageRecord = { dir: 'in', ts: Date.now(), preview: preview(data) };
      dcRecord.messages.push(messageRecord);
      emit({ type: 'datachannel-message', connectionId: record.id, label: channel.label, dir: 'in', preview: preview(data) });
      attachDecodeResult(
        runDecoders({ kind: 'datachannel', connectionId: record.id, label: channel.label, dir: 'in' }, data),
        messageRecord,
        'datachannel-message-decoded',
        { connectionId: record.id, label: channel.label, dir: 'in' }
      );
    });

    if (OriginalRTCDataChannelSend && !channel.__inspectorSendPatched) {
      channel.__inspectorSendPatched = true;
      const originalSend = channel.send.bind(channel);
      channel.send = function (data) {
        let payload = data;
        if (outageDepth.datachannel > 0) {
          emit({ type: 'datachannel-message-blocked', connectionId: record.id, label: channel.label, dir: 'out' });
          return;
        }
        if (dataChannelInterceptor) {
          const result = dataChannelInterceptor('out', { connectionId: record.id, label: channel.label, data: payload });
          if (result === false) {
            emit({ type: 'datachannel-message-blocked', connectionId: record.id, label: channel.label, dir: 'out' });
            return;
          }
          if (result !== undefined) payload = result;
        }
        const messageRecord = { dir: 'out', ts: Date.now(), preview: preview(payload) };
        dcRecord.messages.push(messageRecord);
        emit({ type: 'datachannel-message', connectionId: record.id, label: channel.label, dir: 'out', preview: preview(payload) });
        attachDecodeResult(
          runDecoders({ kind: 'datachannel', connectionId: record.id, label: channel.label, dir: 'out' }, payload),
          messageRecord,
          'datachannel-message-decoded',
          { connectionId: record.id, label: channel.label, dir: 'out' }
        );
        return originalSend(payload);
      };
    }
    dcRecord.__channelRef = channel;
  }

  function setDataChannelInterceptor(fn) { dataChannelInterceptor = fn; }
  function clearDataChannelInterceptor() { dataChannelInterceptor = null; }

  // ---- WebSocket: capture + optional in-flight interceptor ------------------
  //
  // Same registration-order argument as the data-channel interceptor above:
  // our 'message' listener is attached inside the constructor, before the
  // page's own code can get a reference to the socket and attach its own —
  // so it always runs first, making in-flight rewrite/block reliable.

  // Each socket record pins the WebSocket object and up to 200 message previews,
  // so on a page that churns sockets (reconnect loops, per-request sockets) an
  // unbounded map is a leak that grows for as long as the tab lives. Only
  // already-closed records are dropped, oldest first: a live socket stays
  // addressable by id for injectWebSocketMessage/sendOnWebSocket no matter how
  // many sockets the page has opened.
  function evictClosedSockets() {
    if (socketsById.size <= config.maxSocketHistory) return;
    for (const [id, record] of socketsById) {
      if (socketsById.size <= config.maxSocketHistory) break;
      if (record.state === 'closed') socketsById.delete(id);
    }
  }

  const OriginalWebSocket = window.WebSocket;

  if (OriginalWebSocket) {
    function PatchedWebSocket(url, protocols) {
      const ws = protocols !== undefined ? new OriginalWebSocket(url, protocols) : new OriginalWebSocket(url);
      const id = nextSocketId++;
      const record = { id, url: String(url), protocol: null, state: 'connecting', sentCount: 0, receivedCount: 0, messages: [], ws };
      socketsById.set(id, record);
      evictClosedSockets();
      wsRecordByInstance.set(ws, record);
      emit({ type: 'websocket-created', socketId: id, url: record.url });

      ws.addEventListener('open', () => {
        record.state = 'open';
        record.protocol = ws.protocol || null;
        emit({ type: 'websocket-open', socketId: id, url: record.url, protocol: record.protocol });
      });
      ws.addEventListener('close', (ev) => {
        record.state = 'closed';
        emit({ type: 'websocket-close', socketId: id, code: ev.code, reason: ev.reason, wasClean: ev.wasClean });
      });
      ws.addEventListener('error', () => {
        emit({ type: 'websocket-error', socketId: id, url: record.url });
      });
      ws.addEventListener('message', (ev) => {
        let data = ev.data;
        if (outageDepth.websocket > 0) {
          emit({ type: 'websocket-message-blocked', socketId: id, dir: 'in' });
          ev.stopImmediatePropagation();
          return;
        }
        if (webSocketInterceptor) {
          const result = webSocketInterceptor('in', { socketId: id, url: record.url, data });
          if (result === false) {
            emit({ type: 'websocket-message-blocked', socketId: id, dir: 'in' });
            ev.stopImmediatePropagation();
            return;
          }
          if (result !== undefined && result !== data) {
            data = result;
            Object.defineProperty(ev, 'data', { value: data, configurable: true });
          }
        }
        record.receivedCount++;
        const messageRecord = { dir: 'in', ts: Date.now(), preview: preview(data) };
        record.messages.push(messageRecord);
        if (record.messages.length > 200) record.messages.shift();
        emit({ type: 'websocket-message', socketId: id, dir: 'in', preview: preview(data) });
        attachDecodeResult(
          runDecoders({ kind: 'websocket', socketId: id, url: record.url, dir: 'in' }, data),
          messageRecord,
          'websocket-message-decoded',
          { socketId: id, dir: 'in' }
        );
      });

      return ws;
    }
    PatchedWebSocket.prototype = OriginalWebSocket.prototype;
    Object.setPrototypeOf(PatchedWebSocket, OriginalWebSocket);
    PatchedWebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
    PatchedWebSocket.OPEN = OriginalWebSocket.OPEN;
    PatchedWebSocket.CLOSING = OriginalWebSocket.CLOSING;
    PatchedWebSocket.CLOSED = OriginalWebSocket.CLOSED;
    window.WebSocket = PatchedWebSocket;
    defineHiddenConstructor(OriginalWebSocket.prototype, PatchedWebSocket);

    const originalWsSend = OriginalWebSocket.prototype.send;
    OriginalWebSocket.prototype.send = function (data) {
      const record = wsRecordByInstance.get(this);
      if (!record) return originalWsSend.call(this, data);
      let payload = data;
      if (outageDepth.websocket > 0) {
        emit({ type: 'websocket-message-blocked', socketId: record.id, dir: 'out' });
        return;
      }
      if (webSocketInterceptor) {
        const result = webSocketInterceptor('out', { socketId: record.id, url: record.url, data: payload });
        if (result === false) {
          emit({ type: 'websocket-message-blocked', socketId: record.id, dir: 'out' });
          return;
        }
        if (result !== undefined) payload = result;
      }
      record.sentCount++;
      const messageRecord = { dir: 'out', ts: Date.now(), preview: preview(payload) };
      record.messages.push(messageRecord);
      if (record.messages.length > 200) record.messages.shift();
      emit({ type: 'websocket-message', socketId: record.id, dir: 'out', preview: preview(payload) });
      attachDecodeResult(
        runDecoders({ kind: 'websocket', socketId: record.id, url: record.url, dir: 'out' }, payload),
        messageRecord,
        'websocket-message-decoded',
        { socketId: record.id, dir: 'out' }
      );
      return originalWsSend.call(this, payload);
    };
  }

  function setWebSocketInterceptor(fn) { webSocketInterceptor = fn; }
  function clearWebSocketInterceptor() { webSocketInterceptor = null; }

  function injectWebSocketMessage(socketId, data) {
    const record = socketsById.get(socketId);
    if (!record) throw new Error(`No WebSocket with id ${socketId}`);
    record.ws.dispatchEvent(new MessageEvent('message', { data }));
  }

  function sendOnWebSocket(socketId, data) {
    const record = socketsById.get(socketId);
    if (!record) throw new Error(`No WebSocket with id ${socketId}`);
    record.ws.send(data);
  }

  // ---- HTTP (fetch/XHR): capture + 'http' target for simulateNetworkLoss ----
  //
  // WHIP/WHEP and similar SDP-over-HTTP signaling isn't visible to
  // RTCPeerConnection/WebSocket instrumentation — this covers that gap so
  // getSnapshot() and simulateNetworkLoss({targets: ['http']}) reach it too.

  const httpRequestsById = new Map(); // id -> record, insertion-ordered for eviction
  let nextHttpId = 1;

  // Response-body sampling limits. preview() truncates to 200 chars, so there is
  // never a reason to buffer more than a few KB. Reading the whole body would
  // (a) hold the entire response in extension memory for the life of the record
  // (a 256 MiB download cost 256 MiB to produce a 201-char preview) and
  // (b) never finish on an endless streaming response, leaving the record
  // 'pending' forever and buffering that stream for as long as the page lives.
  const maxBodySampleBytes = 8 * 1024;
  const bodySampleTimeoutMs = 1500;
  // Content types whose bodies are open-ended by design: sampling them would
  // stall the record forever, so only headers are captured.
  const streamingContentType = /^\s*(text\/event-stream|multipart\/|application\/(x-)?ndjson|application\/grpc)/i;

  function recordHttpRequest(method, url) {
    const id = nextHttpId++;
    const record = {
      id, method, url: String(url), state: 'pending', statusCode: null,
      requestPreview: null, responsePreview: null, startedAt: Date.now(), completedAt: null,
    };
    httpRequestsById.set(id, record);
    if (httpRequestsById.size > config.maxHttpHistory) {
      httpRequestsById.delete(httpRequestsById.keys().next().value);
    }
    emit({ type: 'http-request-start', httpId: id, method, url: record.url });
    return record;
  }

  function finishHttpRequest(record, { statusCode, error, responseBody }) {
    record.state = error ? 'error' : 'complete';
    record.statusCode = statusCode != null ? statusCode : null;
    record.completedAt = Date.now();
    if (error) record.error = String(error);
    if (responseBody !== undefined) record.responsePreview = preview(responseBody);
    emit(Object.assign(
      { type: error ? 'http-error' : 'http-response', httpId: record.id, method: record.method, url: record.url },
      error ? { error: String(error) } : { statusCode: record.statusCode }
    ));
  }

  // Samples at most maxBodySampleBytes from a clone of the response, then
  // cancels that branch. Cancelling one branch of a teed body does not cancel
  // the other, so the app still reads its own response in full. Always finishes
  // the record, even if the body stalls mid-stream.
  function captureResponseBody(record, response) {
    const finish = (responseBody) => finishHttpRequest(record, { statusCode: response.status, responseBody });

    let contentType = '';
    try { contentType = response.headers.get('content-type') || ''; } catch (_) { /* opaque response */ }
    if (streamingContentType.test(contentType)) { finish(undefined); return; }

    let body = null;
    try { body = response.clone().body; } catch (_) { /* already-consumed or opaque response */ }
    if (!body || typeof body.getReader !== 'function') { finish(undefined); return; }

    const reader = body.getReader();
    let settled = false;
    const chunks = [];
    let total = 0;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { reader.cancel(); } catch (_) { /* already closed */ }
      if (!total) { finish(undefined); return; }
      const merged = new Uint8Array(Math.min(total, maxBodySampleBytes));
      let offset = 0;
      for (const chunk of chunks) {
        if (offset >= merged.length) break;
        const slice = chunk.subarray(0, merged.length - offset);
        merged.set(slice, offset);
        offset += slice.length;
      }
      let text;
      try { text = new TextDecoder('utf-8', { fatal: false }).decode(merged); } catch (_) { text = undefined; }
      finish(text);
    };
    const timer = setTimeout(settle, bodySampleTimeoutMs);

    (function pump() {
      reader.read().then(
        ({ value, done }) => {
          if (settled) return;
          if (value && value.byteLength) { chunks.push(value); total += value.byteLength; }
          if (done || total >= maxBodySampleBytes) { settle(); return; }
          pump();
        },
        settle
      );
    }());
  }

  const OriginalFetch = window.fetch ? window.fetch.bind(window) : null;
  if (OriginalFetch) {
    window.fetch = function (input, init) {
      const method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      const url = typeof input === 'string' || input instanceof URL ? String(input) : (input && input.url) || String(input);
      const record = recordHttpRequest(method, url);
      record.requestPreview = preview((init && init.body) || null);

      if (outageDepth.http > 0) {
        finishHttpRequest(record, { error: 'blocked by simulateNetworkLoss' });
        emit({ type: 'http-request-blocked', httpId: record.id, method, url: record.url });
        return Promise.reject(new TypeError('Failed to fetch: simulated network loss'));
      }

      return OriginalFetch(input, init).then(
        (response) => { captureResponseBody(record, response); return response; },
        (err) => { finishHttpRequest(record, { error: err }); throw err; }
      );
    };
  }

  const OriginalXHR = window.XMLHttpRequest;
  if (OriginalXHR) {
    const OriginalXHROpen = OriginalXHR.prototype.open;
    const OriginalXHRSend = OriginalXHR.prototype.send;

    OriginalXHR.prototype.open = function (method, url, ...rest) {
      this.__inspectorMethod = String(method || 'GET').toUpperCase();
      this.__inspectorUrl = url;
      return OriginalXHROpen.call(this, method, url, ...rest);
    };

    OriginalXHR.prototype.send = function (body) {
      const record = recordHttpRequest(this.__inspectorMethod || 'GET', this.__inspectorUrl || '');
      record.requestPreview = preview(body || null);

      if (outageDepth.http > 0) {
        finishHttpRequest(record, { error: 'blocked by simulateNetworkLoss' });
        emit({ type: 'http-request-blocked', httpId: record.id, method: record.method, url: record.url });
        setTimeout(() => this.dispatchEvent(new Event('error')), 0);
        return;
      }

      this.addEventListener('loadend', () => {
        if (!this.status) { finishHttpRequest(record, { error: 'network error' }); return; }
        let responseBody;
        try {
          // Sliced to the same budget as the fetch sampler. Touching the whole
          // responseText would copy the entire body into a new JS string just to
          // make a 200-char preview, so a large download cost its own size again.
          responseBody = this.responseType === '' || this.responseType === 'text'
            ? this.responseText.slice(0, maxBodySampleBytes)
            : `<${this.responseType} response>`;
        } catch (_) { /* responseText throws for some responseTypes mid-flight */ }
        finishHttpRequest(record, { statusCode: this.status, responseBody });
      });
      return OriginalXHRSend.call(this, body);
    };
  }

  // ---- stats polling ----------------------------------------------------

  function startStatsPolling(record) {
    record.__statsTimer = setInterval(async () => {
      if (record.closed) return;
      try {
        const stats = await record.pc.getStats();
        const summary = { ts: Date.now(), reports: [] };
        stats.forEach((report) => {
          if (['inbound-rtp', 'outbound-rtp', 'remote-inbound-rtp', 'remote-outbound-rtp', 'candidate-pair', 'local-candidate', 'codec'].includes(report.type)) {
            summary.reports.push(report);
          }
        });
        record.statsHistory.push(summary);
        if (record.statsHistory.length > config.maxStatsHistory) record.statsHistory.shift();
        updateLocalTrackQuality(record, summary.reports);
        updateCandidateTypeFlip(record, summary.reports);
        updateAvSyncDelta(record, summary.reports);
        updateRemoteTrackFreeze(record, summary.reports);
        updateRemoteAudioMeterValidity(record, summary.reports);
        updateQualityScore(record, summary.reports, summary.ts);
      } catch (_) { /* getStats can race a just-closed connection */ }
    }, config.statsIntervalMs);
  }
  function stopStatsPolling(record) {
    if (record.__statsTimer) clearInterval(record.__statsTimer);
  }

  // Every path that ends a connection funnels through here, because a record
  // left with closed: false keeps a 2s getStats interval and a 250ms audio
  // meter running for the life of the page, and makes getSnapshot() report a
  // dead connection as live. Idempotent: called again, it does nothing.
  function markConnectionClosed(record, reason) {
    if (record.closed) return;
    record.closed = true;
    stopStatsPolling(record);
    (record.__levelMeterStops || []).forEach((stop) => stop());
    record.__levelMeterStops = [];
    emit({ type: 'pc-closed', connectionId: record.id, reason });
  }

  // outbound-rtp reports carry no stable track-id field in modern Chromium, but
  // each RTCRtpTransceiver's `mid` links its sender's track to the outbound-rtp
  // report sharing that `mid` — that's the correlation this uses.
  function updateLocalTrackQuality(record, reports) {
    const outboundByMid = new Map();
    reports.forEach((r) => { if (r.type === 'outbound-rtp' && r.mid != null) outboundByMid.set(r.mid, r); });
    if (outboundByMid.size === 0) return;
    const midByTrackId = new Map();
    record.pc.getTransceivers().forEach((t) => {
      if (t.sender && t.sender.track && t.mid != null) midByTrackId.set(t.sender.track.id, t.mid);
    });
    record.localTracks.forEach((trackRecord) => {
      const mid = midByTrackId.get(trackRecord.trackId);
      const report = mid != null ? outboundByMid.get(mid) : null;
      trackRecord.qualityLimitationReason = (report && report.qualityLimitationReason) || null;
    });
  }

  // A silent mid-call flip between a direct/reflexive (srflx) path and a TURN
  // relay path is a common, hard-to-spot cause of a sudden RTT/quality change —
  // flag it specifically, rather than every candidate-type transition (e.g. the
  // expected host -> srflx settling during initial ICE negotiation).
  function findSelectedCandidatePair(reports) {
    return reports.find((r) => r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded')
      || reports.find((r) => r.type === 'candidate-pair' && r.state === 'succeeded')
      || null;
  }

  function updateCandidateTypeFlip(record, reports) {
    const selectedPair = findSelectedCandidatePair(reports);
    if (!selectedPair) return;
    const localCandidate = reports.find((r) => r.type === 'local-candidate' && r.id === selectedPair.localCandidateId);
    const type = localCandidate && localCandidate.candidateType;
    if (!type) return;
    const previous = record.selectedCandidateType;
    if (previous && previous !== type && ['srflx', 'relay'].includes(previous) && ['srflx', 'relay'].includes(type)) {
      const flip = { ts: Date.now(), from: previous, to: type };
      record.candidateTypeFlips.push(flip);
      emit({ type: 'candidate-type-flip', connectionId: record.id, from: previous, to: type });
    }
    record.selectedCandidateType = type;
  }

  // jitterBufferDelay/jitterBufferEmittedCount on inbound-rtp are cumulative —
  // dividing gives the running average delay a frame of that kind spent in the
  // jitter buffer. A growing gap between the audio and video averages is
  // exactly what produces visible lip-sync drift.
  function avgJitterBufferDelayMs(report) {
    if (!report || !report.jitterBufferEmittedCount) return null;
    return (report.jitterBufferDelay / report.jitterBufferEmittedCount) * 1000;
  }

  function updateAvSyncDelta(record, reports) {
    const audioReports = reports.filter((r) => r.type === 'inbound-rtp' && r.kind === 'audio');
    const videoReports = reports.filter((r) => r.type === 'inbound-rtp' && r.kind === 'video');
    // More than one remote track of a kind (e.g. camera + screen-share video)
    // means there's no single "the" audio/video pair to diff — picking one of
    // each with find() would silently report a delta for tracks that were
    // never actually meant to be in sync with each other.
    if (audioReports.length !== 1 || videoReports.length !== 1) {
      record.avSyncDeltaMs = null;
      return;
    }
    const audio = avgJitterBufferDelayMs(audioReports[0]);
    const video = avgJitterBufferDelayMs(videoReports[0]);
    record.avSyncDeltaMs = audio != null && video != null ? audio - video : null;
  }

  // freezeCount/totalFreezesDuration (W3C stats spec, video-kind inbound-rtp
  // only) are cumulative counters with no ratio of their own — freezeRatio
  // divides totalFreezesDuration by wall-clock time elapsed since the track
  // started, giving the fraction of playback time spent frozen. Thresholds
  // follow this project's own published guidance: >10% is unshippable, >1%
  // is a noticeable degradation worth flagging.
  function updateRemoteTrackFreeze(record, reports) {
    reports.forEach((report) => {
      if (report.type !== 'inbound-rtp' || report.kind !== 'video' || !report.trackIdentifier) return;
      const trackRecord = record.remoteTracks.find((t) => t.trackId === report.trackIdentifier);
      if (!trackRecord) return;
      const startTs = freezeTrackingStartByTrackRecord.get(trackRecord) || Date.now();
      const elapsedSec = (Date.now() - startTs) / 1000;
      trackRecord.freezeCount = report.freezeCount || 0;
      trackRecord.totalFreezesDuration = report.totalFreezesDuration || 0;
      trackRecord.freezeRatio = elapsedSec > 0 ? trackRecord.totalFreezesDuration / elapsedSec : 0;
      trackRecord.qualityFlag = trackRecord.freezeRatio > 0.10 ? 'bad' : trackRecord.freezeRatio > 0.01 ? 'degraded' : 'ok';
    });
  }

  // Chromium only runs the audio decoder for a remote track that something is
  // actually rendering. With no sink of the app's own (a media element, or Web
  // Audio it drives itself), totalSamplesReceived never advances even while RTP
  // keeps arriving, so our analyser tap reads pure digital silence. Reporting
  // level: 0 there would claim "the far end is silent" when the truth is
  // "nothing is pulling this track". Firefox and WebKit decode regardless, so
  // this only ever trips on Chromium. Detection is a stats delta: packets in,
  // samples flat. When it trips, level goes null and the reason says why.
  //
  // Two consecutive flat polls are required, because during warm-up the first
  // packets arrive a poll before the decoder produces its first samples. Judging
  // on one delta reports a rendered track as unrendered for ~2s and pins its
  // level to null, so a caller sampling early sees no audio on a healthy call.
  // Recovery is immediate in the other direction: one decoding poll clears it.
  const NOT_RENDERED_CONFIRM_POLLS = 2;

  // levelUnavailableReason has two independent writers on different clocks, so
  // each owns its own field and the public one is recomputed from both. A meter
  // that cannot measure at all outranks "nothing is pulling the track": with no
  // running AudioContext we don't know whether the track is rendered.
  const notRenderedByTrackRecord = new WeakMap();
  const meterUnavailableByTrackRecord = new WeakMap();
  function recomputeLevelValidity(trackRecord) {
    const reason = meterUnavailableByTrackRecord.get(trackRecord) || (notRenderedByTrackRecord.get(trackRecord) ? 'track-not-rendered' : null);
    trackRecord.levelUnavailableReason = reason;
    if (reason) trackRecord.level = null;
  }
  function setMeterUnavailable(trackRecord, reason) {
    if (reason) meterUnavailableByTrackRecord.set(trackRecord, reason);
    else meterUnavailableByTrackRecord.delete(trackRecord);
    recomputeLevelValidity(trackRecord);
  }

  function updateRemoteAudioMeterValidity(record, reports) {
    reports.forEach((report) => {
      if (report.type !== 'inbound-rtp' || report.kind !== 'audio' || !report.trackIdentifier) return;
      const trackRecord = record.remoteTracks.find((t) => t.trackId === report.trackIdentifier);
      if (!trackRecord) return;
      const samples = report.totalSamplesReceived || 0;
      const packets = report.packetsReceived || 0;
      const prev = audioMeterProbeByTrackRecord.get(trackRecord);
      if (!prev) { // first poll has no delta to compare
        audioMeterProbeByTrackRecord.set(trackRecord, { samples, packets, flatPolls: 0 });
        return;
      }
      const receiving = packets > prev.packets;
      const decoding = samples > prev.samples;
      const flatPolls = receiving && !decoding ? prev.flatPolls + 1 : 0;
      audioMeterProbeByTrackRecord.set(trackRecord, { samples, packets, flatPolls });
      notRenderedByTrackRecord.set(trackRecord, flatPolls >= NOT_RENDERED_CONFIRM_POLLS);
      recomputeLevelValidity(trackRecord);
    });
  }

  // Audio: simplified ITU-T G.107 E-model approximation (R-factor -> MOS),
  // the same constants independently reproduced by rtpengine and multiple
  // VoIP-monitoring write-ups (e.g. https://stackoverflow.com/q/54124329,
  // https://telecom.altanai.com/2018/04/17/voip-call-metric-monitoring/).
  // This is an approximation for a live diagnostic signal, not a certified
  // MOS measurement — it ignores codec-specific impairment and echo.
  function audioMosFromRtcp(rttMs, jitterMs, packetLossPercent) {
    const effectiveLatency = rttMs + jitterMs * 2 + 10;
    let r = effectiveLatency < 160 ? 93.2 - effectiveLatency / 40 : 93.2 - (effectiveLatency - 120) / 10;
    r -= packetLossPercent * 2.5;
    r = Math.max(0, Math.min(100, r));
    const mos = 1 + 0.035 * r + 0.000007 * r * (r - 60) * (100 - r);
    return Math.max(1, Math.min(4.5, mos));
  }

  // Video: no equivalent standardized model exists, so this uses a simple,
  // transparent proxy — bits delivered per pixel per frame (bits-per-pixel),
  // a common encoder-tuning heuristic where ~0.1 bpp is solidly good H.264/VP8
  // quality and below ~0.01 bpp is visibly blocky. Linearly mapped onto 1-5.
  // This is a heuristic, not a perceptual-quality regression against ground
  // truth — it ignores content complexity and codec efficiency differences.
  function videoScoreFromBitrate(bitrateBps, width, height, fps) {
    if (!bitrateBps || !width || !height || !fps) return null;
    const bitsPerPixelPerFrame = bitrateBps / (width * height * fps);
    const low = 0.01;
    const high = 0.12;
    const t = Math.max(0, Math.min(1, (bitsPerPixelPerFrame - low) / (high - low)));
    return 1 + 4 * t;
  }

  // record.qualityScore below picks the first report of each kind — a fine
  // single-track heuristic, but on a connection with more than one remote
  // track of the same kind (camera + screen-share) it silently scores
  // whichever track getStats() happens to list first, and every track would
  // report back that same arbitrary number via getTrackDiagnostics. This
  // computes a genuine per-track score from that track's own report,
  // correlated by trackIdentifier the same way freeze ratio already is.
  const prevVideoReportByTrackRecord = new WeakMap();

  function trackQualityScore(trackRecord, report, rttMs, ts) {
    if (report.kind === 'audio') {
      if (rttMs == null) return null;
      const jitterMs = (report.jitter || 0) * 1000;
      const totalPackets = (report.packetsLost || 0) + (report.packetsReceived || 0);
      const lossPercent = totalPackets > 0 ? (report.packetsLost / totalPackets) * 100 : 0;
      return audioMosFromRtcp(rttMs, jitterMs, lossPercent);
    }
    const prev = prevVideoReportByTrackRecord.get(trackRecord);
    prevVideoReportByTrackRecord.set(trackRecord, { report, ts });
    if (!prev) return null;
    const dtSec = (ts - prev.ts) / 1000;
    if (dtSec <= 0) return null;
    const bitrateBps = ((report.bytesReceived - prev.report.bytesReceived) * 8) / dtSec;
    return videoScoreFromBitrate(bitrateBps, report.frameWidth, report.frameHeight, report.framesPerSecond);
  }

  function updateRemoteTrackQualityScores(record, reports, rttMs, ts) {
    reports.forEach((report) => {
      if (report.type !== 'inbound-rtp' || (report.kind !== 'audio' && report.kind !== 'video') || !report.trackIdentifier) return;
      const trackRecord = record.remoteTracks.find((t) => t.trackId === report.trackIdentifier);
      if (!trackRecord) return;
      trackRecord.qualityScore = trackQualityScore(trackRecord, report, rttMs, ts);
    });
  }

  function updateQualityScore(record, reports, ts) {
    const selectedPair = findSelectedCandidatePair(reports);
    const rttMs = selectedPair && typeof selectedPair.currentRoundTripTime === 'number' ? selectedPair.currentRoundTripTime * 1000 : null;

    updateRemoteTrackQualityScores(record, reports, rttMs, ts);

    let audioScore = null;
    const audioReport = reports.find((r) => r.type === 'inbound-rtp' && r.kind === 'audio');
    if (rttMs != null && audioReport) {
      const jitterMs = (audioReport.jitter || 0) * 1000;
      const totalPackets = (audioReport.packetsLost || 0) + (audioReport.packetsReceived || 0);
      const lossPercent = totalPackets > 0 ? (audioReport.packetsLost / totalPackets) * 100 : 0;
      audioScore = audioMosFromRtcp(rttMs, jitterMs, lossPercent);
    }

    let videoScore = null;
    const videoReport = reports.find((r) => r.type === 'inbound-rtp' && r.kind === 'video');
    const prevVideoReport = record.__prevVideoInboundReport;
    if (videoReport && prevVideoReport && record.__prevStatsTs) {
      const dtSec = (ts - record.__prevStatsTs) / 1000;
      if (dtSec > 0) {
        const bitrateBps = ((videoReport.bytesReceived - prevVideoReport.bytesReceived) * 8) / dtSec;
        videoScore = videoScoreFromBitrate(bitrateBps, videoReport.frameWidth, videoReport.frameHeight, videoReport.framesPerSecond);
      }
    }
    record.__prevVideoInboundReport = videoReport || null;
    record.__prevStatsTs = ts;

    const subScores = [audioScore, videoScore].filter((v) => v != null);
    record.qualityScore = subScores.length ? subScores.reduce((a, b) => a + b, 0) / subScores.length : null;
  }

  // ---- remote audio metering ("listen" tap) ------------------------------

  // An AnalyserNode only keeps its last `fftSize` samples, so the window length
  // decides what the meter can see. A 512-sample window is 11ms at 48kHz, read
  // once per 250ms poll: a 4% duty cycle that misses most of speech and any
  // other bursty audio. Measured on a loopback tone, that under-reported by
  // ~60x (0.008 reported against a true 0.49). Sizing the window to cover the
  // whole poll interval means every sample between polls is counted, so the
  // level is an honest short-window RMS instead of a point sample.
  const MAX_FFT_SIZE = 32768; // Web Audio spec ceiling
  function analyserWindowFor(sampleRate) {
    const wanted = (sampleRate * config.levelIntervalMs) / 1000;
    let size = 256; // spec floor
    while (size < wanted && size < MAX_FFT_SIZE) size *= 2;
    return size;
  }

  let meterCtx = null;
  let meterCtxResumePending = false;
  // Firefox with no audio output device returns a resume() promise that never
  // settles, so calling this every tick would pile up one pending promise per
  // levelIntervalMs for the whole call. Only one attempt is in flight at a
  // time. That is also the correct retry policy: where resume() stays pending
  // until a user gesture, the pending promise *is* the retry, and where it
  // settles without starting the context (autoplay policy) the next tick tries
  // again.
  function resumeMeterCtx() {
    if (meterCtx.state === 'running' || meterCtxResumePending) return;
    meterCtxResumePending = true;
    const done = () => { meterCtxResumePending = false; };
    try {
      const p = meterCtx.resume();
      if (p && typeof p.then === 'function') p.then(done, done);
      else done(); // pre-promise callback-style resume(): nothing to wait on
    } catch (_) { done(); /* some builds throw instead of rejecting */ }
  }

  function meterRemoteAudioTrack(record, trackRecord, track) {
    if (!meterCtx) meterCtx = new (window.AudioContext || window.webkitAudioContext)();
    // An AudioContext that is not rendering never pulls the graph, so the
    // analyser keeps returning a flat 128 and the RMS comes out exactly 0.
    // Reporting that as a level claims the far end is silent when the truth is
    // that we cannot measure at all, which is the single worst thing this meter
    // could get wrong. Headless Firefox and WebKit both start the context
    // suspended, so this resume() is what makes any measurement possible, and
    // on a machine with no audio device Firefox never leaves suspended at all.
    // The tick below compares currentTime instead of only reading state, so a
    // context whose clock is stopped, or one that stalls mid-call, is reported
    // as unmeasurable rather than read as silence.
    resumeMeterCtx();
    const source = meterCtx.createMediaStreamSource(new MediaStream([track]));
    const analyser = meterCtx.createAnalyser();
    analyser.fftSize = analyserWindowFor(meterCtx.sampleRate);
    source.connect(analyser);
    // Must be fftSize long, not frequencyBinCount: getByteTimeDomainData copies
    // min(fftSize, array.length) samples, so a half-length array reads half the
    // window and silently discards the rest.
    const data = new Uint8Array(analyser.fftSize);
    const stop = () => {
      clearInterval(timer);
      // The nodes share the one page-wide AudioContext, so leaving them
      // connected keeps a dead track's graph alive for the life of the page.
      try { source.disconnect(); } catch (_) { /* already disconnected */ }
      try { analyser.disconnect(); } catch (_) { /* already disconnected */ }
    };
    let lastCtxTime = meterCtx.currentTime;
    const timer = setInterval(() => {
      if (record.closed || trackRecord.status === 'ended') { stop(); return; }
      // The clock has to have moved since the previous tick for the analyser to
      // hold anything new. Compared, not sampled once, so a context that stalls
      // mid-call is caught too.
      const rendering = meterCtx.state === 'running' && meterCtx.currentTime > lastCtxTime;
      lastCtxTime = meterCtx.currentTime;
      if (!rendering) {
        setMeterUnavailable(trackRecord, 'audio-context-not-rendering');
        resumeMeterCtx();
        return;
      }
      // Clear only our own reason: 'meter-failed' means the graph was never built and no tick can fix it.
      if (meterUnavailableByTrackRecord.get(trackRecord) === 'audio-context-not-rendering') setMeterUnavailable(trackRecord, null);
      if (trackRecord.levelUnavailableReason) { trackRecord.level = null; return; }
      analyser.getByteTimeDomainData(data);
      let sumSquares = 0;
      for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sumSquares += v * v; }
      trackRecord.level = Math.sqrt(sumSquares / data.length); // 0 (silence) .. ~1 (full scale)
    }, config.levelIntervalMs);
    // Registered so a close() tears the meter down immediately rather than on
    // the next tick, and so nothing is left running if the track never ends.
    record.__levelMeterStops = record.__levelMeterStops || [];
    record.__levelMeterStops.push(stop);
  }

  function getRemoteTrackStream(connectionId, trackId) {
    const record = connectionsById.get(connectionId);
    if (!record) throw new Error(`No connection with id ${connectionId}`);
    const receiver = record.pc.getReceivers().find((r) => r.track && r.track.id === trackId);
    if (!receiver) throw new Error(`No remote track ${trackId} on connection ${connectionId}`);
    return new MediaStream([receiver.track]);
  }

  // ---- getUserMedia / getDisplayMedia tagging + fake mic/cam injection ------

  let fakeMic = null; // { ctx, buffer, dest, callId }
  let fakeCam = null; // { canvas, ctx2d, stream, callId, timer }

  function decodeToBuffer(ctx, base64OrArrayBuffer) {
    let arrayBuffer;
    if (typeof base64OrArrayBuffer === 'string') {
      const binary = atob(base64OrArrayBuffer);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      arrayBuffer = bytes.buffer;
    } else {
      arrayBuffer = base64OrArrayBuffer;
    }
    return ctx.decodeAudioData(arrayBuffer.slice(0));
  }

  async function setFakeMic(base64OrArrayBuffer) {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const buffer = await decodeToBuffer(ctx, base64OrArrayBuffer);
    const dest = ctx.createMediaStreamDestination();
    fakeMic = { ctx, buffer, dest, callId: nextGumCallId++ };
    emit({ type: 'fake-mic-set', sourceCallId: fakeMic.callId });
    return fakeMic.callId;
  }

  function clearFakeMic() {
    if (fakeMic) {
      emit({ type: 'fake-mic-cleared', sourceCallId: fakeMic.callId });
      fakeMic.ctx.close();
    }
    fakeMic = null;
  }

  function playIntoFakeMic() {
    if (!fakeMic) throw new Error('No fake mic set — call setFakeMic() or injectAudio() first');
    const source = fakeMic.ctx.createBufferSource();
    source.buffer = fakeMic.buffer;
    source.connect(fakeMic.dest);
    source.start();
    emit({ type: 'fake-mic-play', sourceCallId: fakeMic.callId, duration: fakeMic.buffer.duration });
    return fakeMic.buffer.duration;
  }

  async function injectAudio(base64OrArrayBuffer) {
    await setFakeMic(base64OrArrayBuffer);
    return playIntoFakeMic();
  }

  function getFakeMicTrack() {
    if (!fakeMic) throw new Error('No fake mic set — call setFakeMic() or injectAudio() first');
    const track = fakeMic.dest.stream.getAudioTracks()[0].clone();
    trackTagById.set(track, { tag: 'fake-mic', sourceCallId: fakeMic.callId });
    return track;
  }

  function setFakeCam(options) {
    const opts = Object.assign({ width: 320, height: 240, color: '#00b894', text: 'webrtc-inspector', fps: 15 }, options);
    const canvas = document.createElement('canvas');
    canvas.width = opts.width;
    canvas.height = opts.height;
    const ctx2d = canvas.getContext('2d');
    const callId = nextGumCallId++;
    const draw = () => {
      ctx2d.fillStyle = opts.color;
      ctx2d.fillRect(0, 0, opts.width, opts.height);
      ctx2d.fillStyle = '#ffffff';
      ctx2d.font = '16px sans-serif';
      ctx2d.fillText(opts.text, 10, 24);
      ctx2d.fillText(new Date().toISOString(), 10, opts.height - 12);
    };
    draw();
    const timer = setInterval(draw, Math.round(1000 / opts.fps));
    const stream = canvas.captureStream(opts.fps);
    if (fakeCam) clearFakeCam();
    fakeCam = { canvas, ctx2d, stream, callId, timer };
    emit({ type: 'fake-cam-set', sourceCallId: callId, options: opts });
    return callId;
  }

  function clearFakeCam() {
    if (fakeCam) {
      clearInterval(fakeCam.timer);
      fakeCam.stream.getTracks().forEach((t) => t.stop());
      emit({ type: 'fake-cam-cleared', sourceCallId: fakeCam.callId });
    }
    fakeCam = null;
  }

  if (OriginalGetUserMedia) {
    navigator.mediaDevices.getUserMedia = async function (constraints) {
      const callId = nextGumCallId++;
      emit({ type: 'getUserMedia-called', callId, constraints });

      try {
        const wantsAudio = !!(constraints && constraints.audio);
        const wantsVideo = !!(constraints && constraints.video);
        const useFakeAudio = wantsAudio && !!fakeMic;
        const useFakeVideo = wantsVideo && !!fakeCam;

        if (!useFakeAudio && !useFakeVideo) {
          const stream = await OriginalGetUserMedia(constraints);
          stream.getTracks().forEach((track) => trackTagById.set(track, { tag: 'real-device', sourceCallId: callId }));
          emit({ type: 'getUserMedia-served-real', callId, trackIds: stream.getTracks().map((t) => t.id) });
          return stream;
        }

        const tracks = [];
        if (wantsAudio) {
          if (useFakeAudio) {
            const t = fakeMic.dest.stream.getAudioTracks()[0].clone();
            trackTagById.set(t, { tag: 'fake-mic', sourceCallId: fakeMic.callId });
            tracks.push(t);
          } else {
            const real = await OriginalGetUserMedia({ audio: constraints.audio });
            real.getAudioTracks().forEach((t) => { trackTagById.set(t, { tag: 'real-device', sourceCallId: callId }); tracks.push(t); });
          }
        }
        if (wantsVideo) {
          if (useFakeVideo) {
            const t = fakeCam.stream.getVideoTracks()[0].clone();
            trackTagById.set(t, { tag: 'fake-cam', sourceCallId: fakeCam.callId });
            tracks.push(t);
          } else {
            const real = await OriginalGetUserMedia({ video: constraints.video });
            real.getVideoTracks().forEach((t) => { trackTagById.set(t, { tag: 'real-device', sourceCallId: callId }); tracks.push(t); });
          }
        }
        const stream = new MediaStream(tracks);
        emit({ type: 'getUserMedia-served-mixed', callId, fakeAudio: useFakeAudio, fakeVideo: useFakeVideo, trackIds: tracks.map((t) => t.id) });
        return stream;
      } catch (err) {
        // Without this, a denied/failed getUserMedia() call is a dead end in the
        // log: 'getUserMedia-called' with nothing after it, and no clue why no
        // track ever showed up.
        emit({ type: 'getUserMedia-failed', callId, error: String((err && err.message) || err) });
        throw err;
      }
    };
  }

  if (OriginalGetDisplayMedia) {
    navigator.mediaDevices.getDisplayMedia = async function (constraints) {
      const callId = nextGumCallId++;
      try {
        const stream = await OriginalGetDisplayMedia(constraints);
        stream.getTracks().forEach((track) => trackTagById.set(track, { tag: 'display-capture', sourceCallId: callId }));
        emit({ type: 'getDisplayMedia-served', callId, trackIds: stream.getTracks().map((t) => t.id) });
        return stream;
      } catch (err) {
        emit({ type: 'getDisplayMedia-failed', callId, error: String((err && err.message) || err) });
        throw err;
      }
    };
  }

  // ---- network-loss / reconnect testing ----------------------------------
  //
  // Neither Playwright's browserContext.setOffline() nor Chrome DevTools'
  // Network.emulateNetworkConditions tears down already-flowing WebRTC UDP
  // media — both operate on the browser's HTTP/network-service layer, which
  // WebRTC media bypasses (a Chromium architecture fact, not a tooling gap).
  // There is no page-JS-level way to force transient packet loss on a live
  // RTCPeerConnection without OS/root network control. These two functions
  // are the closest real (non-synthetic), generic, OS-access-free proxies:
  // an actual abrupt transport death (killConnection) and an actual dropped-
  // message outage on the signaling/control plane (simulateNetworkLoss).

  function killConnection(connectionId) {
    const record = connectionsById.get(connectionId);
    if (!record) throw new Error(`No connection with id ${connectionId}`);
    emit({ type: 'connection-killed', connectionId, iceConnectionState: record.pc.iceConnectionState, connectionState: record.pc.connectionState });
    record.pc.close(); // the patched close() marks the record; this is belt-and-braces
    markConnectionClosed(record, 'killed');
  }

  // Renegotiate-in-place, distinct from killConnection()'s full teardown —
  // exercises a materially different recovery path in the client under test.
  function restartIce(connectionId) {
    const record = connectionsById.get(connectionId);
    if (!record) throw new Error(`No connection with id ${connectionId}`);
    // Per spec, restartIce() on a closed connection silently aborts its own
    // steps — no exception, nothing to catch after the fact. Check the
    // record's own closed flag ourselves, so a request against a dead
    // connection is reported as failed instead of logged as done.
    if (record.closed) {
      const err = new Error(`Connection ${connectionId} is closed`);
      emit({ type: 'ice-restart-failed', connectionId, iceConnectionState: record.pc.iceConnectionState, connectionState: record.pc.connectionState, error: err.message });
      throw err;
    }
    record.pc.restartIce();
    emit({ type: 'ice-restart', connectionId, iceConnectionState: record.pc.iceConnectionState, connectionState: record.pc.connectionState });
  }

  function simulateNetworkLoss(durationMs, options) {
    const opts = Object.assign({ targets: ['websocket', 'datachannel'] }, options);
    const targets = ['websocket', 'datachannel', 'http', 'media'].filter((t) => opts.targets.includes(t));
    let stopped = false;
    let restored = null;

    targets.forEach(acquireOutage);
    emit({ type: 'network-loss-start', durationMs, targets: opts.targets });

    let resolveDone;
    const done = new Promise((resolve) => { resolveDone = resolve; });

    // Restoring the 'media' target is asynchronous (each sender needs a
    // replaceTrack round-trip), so done/network-loss-end must wait for it.
    // Resolving earlier would tell the caller media is back while it is still
    // black, and any measurement taken right after would read the outage.
    function restore() {
      if (stopped) return restored;
      stopped = true;
      clearTimeout(timer);
      restored = Promise.all(targets.map(releaseOutage)).then(() => {
        emit({ type: 'network-loss-end', targets: opts.targets });
        resolveDone();
      });
      return restored;
    }

    const timer = setTimeout(restore, durationMs);
    return { stop: restore, done };
  }

  // ---- named network-impairment presets ----------------------------------
  //
  // Wraps simulateNetworkLoss in labeled scenario presets — tc/netem-style
  // named profiles instead of picking raw durations/targets by hand.
  // pattern: 'full' is one continuous outage; 'flapping' alternates outage/
  // recovery in flapIntervalMs steps for the total durationMs, modeling
  // intermittent connectivity rather than a single clean drop.

  const networkPresets = new Map([
    ['home-wifi', { durationMs: 600, targets: ['websocket', 'datachannel'], pattern: 'full' }],
    ['4g-train', { durationMs: 2500, targets: ['websocket', 'datachannel', 'media'], pattern: 'full' }],
    ['congested-mobile', { durationMs: 3000, targets: ['websocket', 'datachannel'], pattern: 'flapping', flapIntervalMs: 400 }],
  ]);

  function registerNetworkPreset(name, presetConfig) { networkPresets.set(name, presetConfig); }

  function simulateFlappingLoss(presetConfig) {
    const flapIntervalMs = presetConfig.flapIntervalMs || 500;
    const cycles = Math.max(1, Math.round(presetConfig.durationMs / (flapIntervalMs * 2)));
    let stopped = false;
    let currentStop = null;
    let gapTimer = null;
    let resolveDone;
    const done = new Promise((resolve) => { resolveDone = resolve; });

    function runCycle(i) {
      if (stopped || i >= cycles) { resolveDone(); return; }
      const outage = simulateNetworkLoss(flapIntervalMs, { targets: presetConfig.targets });
      currentStop = outage.stop;
      outage.done.then(() => {
        if (stopped) return;
        gapTimer = setTimeout(() => runCycle(i + 1), flapIntervalMs);
      });
    }
    runCycle(0);

    function stop() {
      if (stopped) return;
      stopped = true;
      clearTimeout(gapTimer);
      if (currentStop) currentStop();
      resolveDone();
    }
    return { stop, done };
  }

  function simulateNetworkPreset(name) {
    const presetConfig = networkPresets.get(name);
    if (!presetConfig) throw new Error(`Unknown network preset: ${name}`);
    emit({ type: 'network-preset-start', name, config: presetConfig });
    if (presetConfig.pattern === 'flapping') return simulateFlappingLoss(presetConfig);
    return simulateNetworkLoss(presetConfig.durationMs, { targets: presetConfig.targets });
  }

  // ---- injection controls -----------------------------------------------

  function replaceOutgoingTrack(connectionId, kind, track) {
    const record = connectionsById.get(connectionId);
    if (!record) throw new Error(`No connection with id ${connectionId}`);
    const sender = record.pc.getSenders().find((s) => s.track && s.track.kind === kind);
    if (!sender) throw new Error(`No active ${kind} sender on connection ${connectionId}`);
    return sender.replaceTrack(track);
  }

  // Standard WebRTC pattern: read current encoding params, mutate, write
  // back via setParameters() — no interception needed, real congestion
  // control still runs but is capped by whatever's passed here. Only the
  // fields present in caps are touched; omit a field to leave it as-is.
  function capEncoding(connectionId, kind, caps) {
    const record = connectionsById.get(connectionId);
    if (!record) throw new Error(`No connection with id ${connectionId}`);
    const sender = record.pc.getSenders().find((s) => s.track && s.track.kind === kind);
    if (!sender) throw new Error(`No active ${kind} sender on connection ${connectionId}`);
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
    params.encodings.forEach((encoding) => {
      if ('maxBitrate' in caps) encoding.maxBitrate = caps.maxBitrate;
      if ('maxFramerate' in caps) encoding.maxFramerate = caps.maxFramerate;
      if ('scaleResolutionDownBy' in caps) encoding.scaleResolutionDownBy = caps.scaleResolutionDownBy;
    });
    if ('degradationPreference' in caps) params.degradationPreference = caps.degradationPreference;
    // Without this, a wrtc_cap_encoding call is invisible in the event log —
    // an agent reading the log to explain a bitrate drop has nothing that
    // points at the cap that caused it.
    return sender.setParameters(params).then((res) => {
      emit({ type: 'encoding-capped', connectionId, kind, caps });
      return res;
    }, (err) => {
      emit({ type: 'encoding-cap-failed', connectionId, kind, caps, error: String((err && err.message) || err) });
      throw err;
    });
  }

  function injectDataChannelMessage(connectionId, label, data) {
    const record = connectionsById.get(connectionId);
    if (!record) throw new Error(`No connection with id ${connectionId}`);
    const dcRecord = record.dataChannels.find((d) => d.label === label);
    if (!dcRecord || !dcRecord.__channelRef) throw new Error(`No data channel "${label}" on connection ${connectionId}`);
    dcRecord.__channelRef.send(data);
  }

  // ---- snapshot / subscription -------------------------------------------

  function getSdp(connectionId) {
    const record = connectionsById.get(connectionId);
    if (!record) throw new Error(`No connection with id ${connectionId}`);
    return { local: record.lastLocalSdp, remote: record.lastRemoteSdp };
  }

  // #37 — matches any of the given MediaStreamTrack ids (e.g. from a
  // <video>/<audio> element's srcObject.getTracks()) against tracks we're
  // already tracking, for the "Test this stream" right-click overlay.
  function getTrackDiagnostics(trackIds) {
    const ids = Array.isArray(trackIds) ? trackIds : [];
    // Two passes (remote across all connections, then local) rather than one
    // pass per connection: a sender's track id and its receiver's track id
    // can coincide (same-page loopback, or a track re-added after replaceTrack),
    // and the overlay cares about the *receiving* side's freeze/quality data.
    for (const record of connectionsById.values()) {
      const remote = record.remoteTracks.find((t) => ids.includes(t.trackId));
      if (remote) {
        return {
          connectionId: record.id, kind: remote.kind, status: remote.status,
          freezeRatio: remote.freezeRatio, qualityFlag: remote.qualityFlag,
          // Prefer this track's own score; fall back to the connection-level
          // heuristic only when no trackIdentifier-correlated report has
          // scored it yet (e.g. this poll hasn't run, or the browser omits
          // trackIdentifier) — see updateRemoteTrackQualityScores above.
          qualityScore: remote.qualityScore != null ? remote.qualityScore : record.qualityScore,
        };
      }
    }
    for (const record of connectionsById.values()) {
      const local = record.localTracks.find((t) => ids.includes(t.trackId));
      if (local) {
        return {
          connectionId: record.id, kind: local.kind, status: local.status,
          qualityLimitationReason: local.qualityLimitationReason,
          qualityScore: record.qualityScore,
        };
      }
    }
    return null;
  }

  // Pure rules engine: derives short machine-readable anomaly strings from
  // signals that already exist on the record (state timestamps, #15's
  // freezeRatio, #17's qualityLimitationReason, #16's candidateTypeFlips) —
  // no new stats correlation, just naming states worth a human's attention.
  function computeAnomalyFlags(record, now) {
    const flags = [];
    const t = ANOMALY_THRESHOLDS;

    if (record.state.iceConnectionState === 'checking') {
      const elapsed = now - record.state.iceConnectionStateSince;
      if (elapsed > t.iceCheckingStuckMs) flags.push(`ice_stuck_checking_${elapsed}ms`);
    }

    record.dataChannels.forEach((d) => {
      if (d.state === 'open' && d.messages.length === 0 && now - d.createdAt > t.dataChannelUnusedMs) {
        flags.push(`datachannel_opened_never_used:${d.label}`);
      }
    });

    record.localTracks.forEach((tr) => {
      if (tr.status === 'live' && tr.qualityLimitationReason === null && now - tr.addedAt > t.trackNoStatsMs) {
        flags.push(`track_added_no_stats:${tr.trackId}`);
      } else if (tr.qualityLimitationReason && tr.qualityLimitationReason !== 'none') {
        flags.push(`quality_limited_${tr.qualityLimitationReason}:${tr.trackId}`);
      }
    });

    record.remoteTracks.forEach((tr) => {
      if (tr.status === 'live' && tr.freezeCount === null && now - tr.addedAt > t.trackNoStatsMs) {
        flags.push(`track_added_no_stats:${tr.trackId}`);
      } else if (tr.freezeRatio !== null && tr.freezeRatio > t.freezeRatioBad) {
        flags.push(`freeze_ratio_bad:${tr.trackId}`);
      }
    });

    if (record.candidateTypeFlips.length >= t.candidateFlipCount) {
      flags.push(`candidate_type_flipped_${record.candidateTypeFlips.length}x`);
    }

    return flags;
  }

  function getSnapshot(opts) {
    const concise = !!opts && opts.detail === 'concise';
    const now = Date.now();
    return {
      connections: Array.from(connectionsById.values()).map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        closed: r.closed,
        state: r.state,
        mediaFaultInjectable: r.mediaFaultInjectable,
        // Eligibility (above) is decided at creation; this is how many sender or
        // receiver endpoints actually carry the transform right now. 0 on an
        // injectable connection means no fault can reach the media path.
        mediaFaultCoveredEndpoints: r.mediaFaultCoveredEndpoints || 0,
        flags: computeAnomalyFlags(r, now),
        label: computeLabel({ kind: 'connection', connectionId: r.id, urls: flattenIceServerUrls(r.configuration) }),
        localTracks: r.localTracks,
        remoteTracks: r.remoteTracks,
        dataChannels: r.dataChannels.map((d) => ({
          label: d.label, origin: d.origin, state: d.state, messageCount: d.messages.length,
          ...(concise ? {} : { lastMessages: d.messages.slice(-10) }),
        })),
        ...(concise ? {} : { latestStats: r.statsHistory[r.statsHistory.length - 1] || null }),
        localCandidateTypes: r.localCandidates.map((c) => c.type),
        remoteCandidateTypes: r.remoteCandidates.map((c) => c.type),
        selectedCandidateType: r.selectedCandidateType,
        candidateTypeFlips: r.candidateTypeFlips,
        avSyncDeltaMs: r.avSyncDeltaMs,
        qualityScore: r.qualityScore,
        localSdpSummary: r.lastLocalSdp && r.lastLocalSdp.summary,
        remoteSdpSummary: r.lastRemoteSdp && r.lastRemoteSdp.summary,
      })),
      webSockets: Array.from(socketsById.values()).map((r) => ({
        id: r.id,
        url: r.url,
        protocol: r.protocol,
        state: r.state,
        label: computeLabel({ kind: 'websocket', socketId: r.id, url: r.url }),
        sentCount: r.sentCount,
        receivedCount: r.receivedCount,
        ...(concise ? {} : { lastMessages: r.messages.slice(-10) }),
      })),
      httpRequests: Array.from(httpRequestsById.values()).map((r) => ({
        id: r.id,
        method: r.method,
        url: r.url,
        state: r.state,
        statusCode: r.statusCode,
        startedAt: r.startedAt,
        completedAt: r.completedAt,
        ...(concise ? {} : { requestPreview: r.requestPreview, responsePreview: r.responsePreview }),
      })),
      httpBlocked: outageDepth.http > 0,
      // Which simulateNetworkLoss targets are down right now. Independent of the
      // *InterceptorActive flags below, which report only the app's own hooks.
      activeOutages: Object.keys(outageDepth).filter((t) => outageDepth[t] > 0),
      fakeMicActive: !!fakeMic,
      fakeCamActive: !!fakeCam,
      dataChannelInterceptorActive: !!dataChannelInterceptor,
      webSocketInterceptorActive: !!webSocketInterceptor,
      mediaFaultInjectorActive: !!mediaFaultInjector,
      // Non-null once the transform worker has died (CSP blocked the blob: URL).
      // Nothing is covered after that, and arming again throws with this message.
      mediaFaultWorkerError: mediaFaultWorkerError,
      suggestDecoderActive: !!suggestDecoder,
      labelerActive: !!labeler,
      iceCandidateFilterActive: iceCandidateFilters.size > 0,
      ...(concise ? {} : { recentLog: log.slice(-100) }),
    };
  }

  // getSnapshot() caps recentLog at the last 100 entries and latestStats at
  // the most recent sample, to keep routine calls small. exportBundle() is
  // for the one-shot "attach to a bug report" case, so it trades that size
  // cap for completeness: the full log and each connection's full stats
  // history, alongside a detailed snapshot.
  function exportBundle() {
    return {
      exportedAt: Date.now(),
      version: '1.5.0',
      snapshot: getSnapshot({ detail: 'detailed' }),
      fullLog: log.slice(),
      statsHistory: Array.from(connectionsById.values()).map((r) => ({
        connectionId: r.id,
        stats: r.statsHistory.slice(),
      })),
    };
  }

  // ---- webrtc-internals-compatible dump export (#20) -------------------------
  //
  // Matches the JSON shape chrome://webrtc-internals' "Create Dump" produces
  // (verified against the still-maintained rtcstats/rtcstats dump-importer's
  // parser, since Chrome's own dump writer isn't public source we can pin to):
  // {UserAgent, getUserMedia, PeerConnections: {<id>: {url, rtcConfiguration,
  // updateLog, stats}}}. `stats` is a flat map keyed `<statId>-<property>`,
  // each `{statsType, values}` with `values` a JSON-stringified array aligned
  // index-for-index with that stat's own `<statId>-timestamp` entry — the
  // importer reads timestamps and values as parallel arrays, not paired
  // objects. Padding every property to the timestamp array's length (instead
  // of relying on trailing-alignment for late-appearing properties, a
  // documented real-dump quirk) sidesteps that ambiguity entirely.
  //
  // updateLog translates our event log's well-known state-change/SDP-set
  // types to the exact names the importer special-cases (so state timelines
  // and SDP diffing render), and passes every other event through under its
  // own type name with its extra fields as the JSON value — no event is
  // dropped, just not specially rendered. SDP text reflects the connection's
  // *current* local/remote description, not a full renegotiation history,
  // since only the latest is retained per connection.
  function buildInternalsUpdateLog(record) {
    return log.filter((e) => e.connectionId === record.id).map((e) => {
      let type = e.type;
      let value;
      if (e.type === 'ice-state') { type = 'iceconnectionstatechange'; value = e.state; }
      else if (e.type === 'connection-state') { type = 'connectionstatechange'; value = e.state; }
      else if (e.type === 'signaling-state') { type = 'signalingstatechange'; value = e.state; }
      else if (e.type === 'local-description-set') {
        type = 'setLocalDescription';
        value = JSON.stringify({ type: e.sdpType, sdp: record.lastLocalSdp ? record.lastLocalSdp.sdp : '' });
      } else if (e.type === 'remote-description-set') {
        type = 'setRemoteDescription';
        value = JSON.stringify({ type: e.sdpType, sdp: record.lastRemoteSdp ? record.lastRemoteSdp.sdp : '' });
      } else {
        const rest = { ...e };
        delete rest.type;
        delete rest.connectionId;
        delete rest.ts;
        value = JSON.stringify(rest);
      }
      return { time: new Date(e.ts).toString(), timestamp: e.ts, type, value };
    });
  }

  function buildInternalsStats(record) {
    const byId = new Map(); // statId -> {statsType, timestamps: [], props: Map<prop, value[]>}
    record.statsHistory.forEach(({ ts, reports }) => {
      reports.forEach((report) => {
        let entry = byId.get(report.id);
        if (!entry) { entry = { statsType: report.type, timestamps: [], props: new Map() }; byId.set(report.id, entry); }
        entry.timestamps.push(ts);
        const tickIndex = entry.timestamps.length - 1;
        Object.keys(report).forEach((key) => {
          if (key === 'id' || key === 'type' || key === 'timestamp') return;
          if (!entry.props.has(key)) entry.props.set(key, []);
          const values = entry.props.get(key);
          while (values.length < tickIndex) values.push(null);
          values.push(report[key]);
        });
      });
    });
    const stats = {};
    byId.forEach((entry, id) => {
      stats[`${id}-timestamp`] = { statsType: entry.statsType, values: JSON.stringify(entry.timestamps) };
      entry.props.forEach((values, prop) => {
        while (values.length < entry.timestamps.length) values.push(null);
        stats[`${id}-${prop}`] = { statsType: entry.statsType, values: JSON.stringify(values) };
      });
    });
    return stats;
  }

  function exportWebrtcInternalsDump() {
    const peerConnections = {};
    connectionsById.forEach((record) => {
      peerConnections[String(record.id)] = {
        url: location.href,
        rtcConfiguration: record.configuration,
        updateLog: buildInternalsUpdateLog(record),
        stats: buildInternalsStats(record),
      };
    });
    return {
      UserAgent: navigator.userAgent,
      getUserMedia: [],
      PeerConnections: peerConnections,
    };
  }

  // #28 — token-budgeted, paginated event log. getSnapshot()'s recentLog and
  // exportWebrtcInternalsDump()'s fullLog are both fixed-size/unbounded; an
  // agent polling a long-running session needs a cursor it can page through
  // without either missing entries (fixed-count "last N" can skip a burst)
  // or blowing its own context budget in one call. `since` is an entry's
  // `seq` (monotonic per emit(), independent of Date.now()'s clock
  // resolution and of log trimming), not a timestamp. maxChars is a
  // characters-in-JSON proxy for a token budget — no tokenizer is bundled,
  // so this is an approximation, documented as such. Per this project's
  // no-silent-caps standard, truncation is always reported explicitly
  // (never a silent drop) and at least one entry is always returned when
  // one is available, so a too-small budget can't stall pagination forever.
  function getEvents(opts) {
    const { since = 0, limit = Infinity, maxChars = 25000 } = opts || {};
    const candidates = log.filter((e) => e.seq > since);
    const events = [];
    let chars = 0;
    for (let i = 0; i < candidates.length; i++) {
      if (events.length >= limit) break;
      const entry = candidates[i];
      const size = JSON.stringify(entry).length;
      if (events.length > 0 && chars + size > maxChars) break;
      events.push(entry);
      chars += size;
    }
    const nextSince = events.length ? events[events.length - 1].seq : since;
    const remainingCount = candidates.length - events.length;
    return {
      events,
      nextSince,
      remainingCount,
      truncated: remainingCount > 0,
      truncationMarker: remainingCount > 0
        ? `${remainingCount} more entr${remainingCount === 1 ? 'y' : 'ies'} — call getEvents({ since: ${nextSince} }) for more`
        : null,
    };
  }

  // ---- capture / diff for regression fixtures --------------------------------
  //
  // captureEvents() snapshots the event stream as-is (shallow copy, so later
  // mutation of the live log can't retroactively change a stored capture).
  // diffCaptures() is a pure function over two captures — no new
  // instrumentation — meant to answer "did this connection's event shape
  // change between SDK versions": event-type counts, and the first index at
  // which the two event-type sequences diverge (null if one is a clean
  // prefix of the other, or they're identical).
  function captureEvents() {
    return { capturedAt: Date.now(), events: log.map((e) => ({ ...e })) };
  }

  function countByType(events) {
    const counts = {};
    events.forEach((e) => { counts[e.type] = (counts[e.type] || 0) + 1; });
    return counts;
  }

  function diffCaptures(before, after) {
    const countsBefore = countByType(before.events);
    const countsAfter = countByType(after.events);
    const eventTypeCounts = {};
    new Set([...Object.keys(countsBefore), ...Object.keys(countsAfter)]).forEach((type) => {
      const from = countsBefore[type] || 0;
      const to = countsAfter[type] || 0;
      if (from !== to) eventTypeCounts[type] = { from, to };
    });

    const typesBefore = before.events.map((e) => e.type);
    const typesAfter = after.events.map((e) => e.type);
    const minLength = Math.min(typesBefore.length, typesAfter.length);
    let firstDivergenceIndex = null;
    for (let i = 0; i < minLength; i++) {
      if (typesBefore[i] !== typesAfter[i]) { firstDivergenceIndex = i; break; }
    }

    return {
      eventTypeCounts,
      sequenceLengths: { from: typesBefore.length, to: typesAfter.length },
      firstDivergenceIndex,
    };
  }

  function fieldChange(before, after) {
    return before === after ? null : { from: before, to: after };
  }

  function diffById(listA, listB) {
    const mapA = new Map(listA.map((x) => [x.id, x]));
    const mapB = new Map(listB.map((x) => [x.id, x]));
    return {
      added: Array.from(mapB.keys()).filter((id) => !mapA.has(id)),
      removed: Array.from(mapA.keys()).filter((id) => !mapB.has(id)),
      common: Array.from(mapB.keys()).filter((id) => mapA.has(id)),
      mapA,
      mapB,
    };
  }

  function diffFlags(before, after) {
    const beforeSet = new Set(before || []);
    const afterSet = new Set(after || []);
    const added = (after || []).filter((f) => !beforeSet.has(f));
    const removed = (before || []).filter((f) => !afterSet.has(f));
    return added.length || removed.length ? { added, removed } : null;
  }

  function diffConnection(before, after) {
    const changes = {};
    ['iceConnectionState', 'connectionState', 'signalingState'].forEach((key) => {
      const c = fieldChange(before.state && before.state[key], after.state && after.state[key]);
      if (c) changes[key] = c;
    });
    const flagsChange = diffFlags(before.flags, after.flags);
    if (flagsChange) changes.flags = flagsChange;
    [
      ['closed', before.closed, after.closed],
      ['localTrackCount', before.localTracks.length, after.localTracks.length],
      ['remoteTrackCount', before.remoteTracks.length, after.remoteTracks.length],
      ['dataChannelCount', before.dataChannels.length, after.dataChannels.length],
      ['selectedCandidateType', before.selectedCandidateType, after.selectedCandidateType],
      ['qualityScore', before.qualityScore, after.qualityScore],
      ['avSyncDeltaMs', before.avSyncDeltaMs, after.avSyncDeltaMs],
      ['label', before.label, after.label],
    ].forEach(([key, from, to]) => {
      const c = fieldChange(from, to);
      if (c) changes[key] = c;
    });
    return changes;
  }

  function diffWebSocket(before, after) {
    const changes = {};
    [
      ['state', before.state, after.state],
      ['sentCount', before.sentCount, after.sentCount],
      ['receivedCount', before.receivedCount, after.receivedCount],
      ['label', before.label, after.label],
    ].forEach(([key, from, to]) => {
      const c = fieldChange(from, to);
      if (c) changes[key] = c;
    });
    return changes;
  }

  // Pure function over two getSnapshot() outputs — no new instrumentation,
  // so it works regardless of the detail mode either snapshot was taken with.
  function getSnapshotDiff(before, after) {
    const conn = diffById(before.connections, after.connections);
    const connections = conn.common
      .map((id) => ({ id, ...diffConnection(conn.mapA.get(id), conn.mapB.get(id)) }))
      .filter((c) => Object.keys(c).length > 1);

    const ws = diffById(before.webSockets, after.webSockets);
    const webSockets = ws.common
      .map((id) => ({ id, ...diffWebSocket(ws.mapA.get(id), ws.mapB.get(id)) }))
      .filter((w) => Object.keys(w).length > 1);

    return {
      connectionsAdded: conn.added,
      connectionsRemoved: conn.removed,
      connections,
      webSocketsAdded: ws.added,
      webSocketsRemoved: ws.removed,
      webSockets,
    };
  }

  window.__webrtcInspector = {
    version: '1.5.0',
    getSnapshot,
    getSnapshotDiff,
    exportBundle,
    exportWebrtcInternalsDump,
    captureEvents,
    diffCaptures,
    getEvents,
    getSdp,
    getTrackDiagnostics,
    setFakeMic,
    clearFakeMic,
    injectAudio,
    playIntoFakeMic,
    getFakeMicTrack,
    setFakeCam,
    clearFakeCam,
    getRemoteTrackStream,
    replaceOutgoingTrack,
    capEncoding,
    injectDataChannelMessage,
    setDataChannelInterceptor,
    clearDataChannelInterceptor,
    registerDecoder,
    setSuggestDecoder,
    clearSuggestDecoder,
    setLabeler,
    clearLabeler,
    setIceCandidateFilter,
    clearIceCandidateFilter,
    setWebSocketInterceptor,
    clearWebSocketInterceptor,
    setMediaFaultInjector,
    clearMediaFaultInjector,
    injectWebSocketMessage,
    sendOnWebSocket,
    killConnection,
    restartIce,
    simulateNetworkLoss,
    simulateNetworkPreset,
    registerNetworkPreset,
    onEvent: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    clearLog: () => { log.length = 0; },
  };

  // #37 — bridge for extension/overlay.js, which runs in the default
  // ISOLATED world (needs chrome.runtime for the context-menu message) and
  // so can't reach window.__webrtcInspector directly; the two worlds share
  // the DOM, so a CustomEvent on `document` is the crossing point.
  document.addEventListener('wrtc-overlay-request', (e) => {
    const detail = e.detail || {};
    document.dispatchEvent(new CustomEvent('wrtc-overlay-response', {
      detail: { elId: detail.elId, diagnostics: getTrackDiagnostics(detail.trackIds) },
    }));
  });
})();
