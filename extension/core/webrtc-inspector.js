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

  const config = { statsIntervalMs: 2000, maxLogEntries: 5000, maxStatsHistory: 60, levelIntervalMs: 250, maxDecodedPreviewChars: 500, maxHttpHistory: 200 };
  const connectionsById = new Map(); // id -> record
  const recordByPc = new WeakMap(); // pc -> record
  const trackTagById = new WeakMap(); // MediaStreamTrack -> {tag, sourceCallId}
  const trackRecordByTrack = new WeakMap(); // MediaStreamTrack -> trackRecord (for explicit stop() detection)
  const freezeTrackingStartByTrackRecord = new WeakMap(); // remote video trackRecord -> Date.now() at track start, for freezeRatio's elapsed-time denominator
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
  let mediaFaultInjector = null; // {connId, kind, fn} | null — single active injector, mirrors ws/dc interceptors
  const transformedRtpEndpoints = new WeakSet(); // RTCRtpSender|RTCRtpReceiver already piped through our transform

  function emit(entry) {
    entry.ts = entry.ts || Date.now();
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
    if (decoders.length === 0) return null;
    let match;
    for (const d of decoders) {
      try {
        if (d.matcher(meta)) { match = d; break; }
      } catch (_) { /* a throwing matcher just doesn't match */ }
    }
    if (!match) return null;
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
    // encodedInsertableStreams is a Chrome-specific RTCConfiguration extension
    // that unlocks RTCRtpSender/Receiver.createEncodedStreams() below — always
    // set, harmless no-op on engines that don't recognize it.
    const encodedStreamsConfig = Object.assign({}, configuration, { encodedInsertableStreams: true });
    const pc = constraints !== undefined
      ? new OriginalRTCPeerConnection(encodedStreamsConfig, constraints)
      : new OriginalRTCPeerConnection(encodedStreamsConfig);

    const id = nextConnectionId++;
    const record = {
      id,
      createdAt: Date.now(),
      configuration: configuration || null,
      closed: false,
      state: {
        iceConnectionState: pc.iceConnectionState,
        connectionState: pc.connectionState,
        signalingState: pc.signalingState,
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
      emit({ type: 'ice-state', connectionId: id, state: pc.iceConnectionState });
    });
    pc.addEventListener('connectionstatechange', () => {
      record.state.connectionState = pc.connectionState;
      emit({ type: 'connection-state', connectionId: id, state: pc.connectionState });
      if (pc.connectionState === 'closed' || pc.connectionState === 'failed') {
        record.closed = true;
        stopStatsPolling(record);
      }
    });
    pc.addEventListener('signalingstatechange', () => {
      record.state.signalingState = pc.signalingState;
      emit({ type: 'signaling-state', connectionId: id, state: pc.signalingState });
    });
    pc.addEventListener('icecandidate', (ev) => {
      if (!ev.candidate) return; // null candidate marks end-of-candidates
      const type = parseCandidateType(ev.candidate.candidate);
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
        freezeCount: null, totalFreezesDuration: null, freezeRatio: null, qualityFlag: null,
      };
      record.remoteTracks.push(trackRecord);
      freezeTrackingStartByTrackRecord.set(trackRecord, Date.now());
      attachTrackLifecycle(record, trackRecord, ev.track, 'remote');
      if (ev.track.kind === 'audio') meterRemoteAudioTrack(trackRecord, ev.track);
      emit({ type: 'track-received', connectionId: id, kind: ev.track.kind, trackId: ev.track.id, sourceTag: tag ? tag.tag : null });
      installEncodedTransform(record, ev.receiver, 'incoming', ev.track.kind);
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

  function attachTrackLifecycle(record, trackRecord, track, origin) {
    trackRecordByTrack.set(track, trackRecord);
    track.addEventListener('ended', () => { trackRecord.status = 'ended'; emit({ type: 'track-ended', connectionId: record.id, trackId: track.id, origin }); });
    track.addEventListener('mute', () => { trackRecord.status = 'muted'; emit({ type: 'track-muted', connectionId: record.id, trackId: track.id, origin }); });
    track.addEventListener('unmute', () => { trackRecord.status = 'live'; emit({ type: 'track-unmuted', connectionId: record.id, trackId: track.id, origin }); });
  }

  // ---- Insertable Streams: encoded media-frame fault injection --------------
  //
  // Chromium-only: createEncodedStreams() is a Chrome RTCRtpSender/Receiver
  // extension, not yet the standardized RTCRtpScriptTransform. No-ops on other
  // engines. setMediaFaultInjector's fn receives the live encoded frame — its
  // writable .data lets a caller corrupt/rewrite in place with no special
  // return value; 'duplicate'/{delayMs}/false are for actions the platform
  // has no direct API for.

  function injectorMatches(injector, connId, kind) {
    if (injector.connId != null && injector.connId !== connId) return false;
    if (injector.kind != null && injector.kind !== kind) return false;
    return true;
  }

  function cloneEncodedFrame(frame) {
    try {
      return new frame.constructor(frame, { data: frame.data.slice(0) });
    } catch (_) {
      return frame; // constructor form unsupported on this engine — best effort
    }
  }

  function installEncodedTransform(record, endpoint, direction, kind) {
    if (!endpoint || typeof endpoint.createEncodedStreams !== 'function') return; // unsupported browser
    if (transformedRtpEndpoints.has(endpoint)) return;
    transformedRtpEndpoints.add(endpoint);

    let streams;
    try {
      streams = endpoint.createEncodedStreams();
    } catch (_) {
      return;
    }

    const transform = new TransformStream({
      transform(frame, controller) {
        const injector = mediaFaultInjector;
        if (!injector || !injectorMatches(injector, record.id, kind)) {
          controller.enqueue(frame);
          return;
        }
        let action;
        try {
          action = injector.fn(direction, frame, { connId: record.id, kind, trackId: endpoint.track ? endpoint.track.id : null });
        } catch (_) {
          action = undefined; // a throwing injector just passes the frame through
        }
        if (action === false) return; // drop
        if (action === 'duplicate') {
          controller.enqueue(frame);
          controller.enqueue(cloneEncodedFrame(frame));
          return;
        }
        if (action && typeof action.delayMs === 'number') {
          setTimeout(() => {
            try { controller.enqueue(frame); } catch (_) { /* stream closed before the delay elapsed */ }
          }, action.delayMs);
          return;
        }
        controller.enqueue(frame);
      },
    });

    streams.readable.pipeThrough(transform).pipeTo(streams.writable).catch(() => {
      /* rejects on pc close/track end — expected, not an error */
    });
  }

  function setMediaFaultInjector(connId, kind, fn) {
    mediaFaultInjector = { connId: connId != null ? connId : null, kind: kind != null ? kind : null, fn };
  }
  function clearMediaFaultInjector() {
    mediaFaultInjector = null;
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
    const trackRecord = { trackId: track.id, kind: track.kind, label: track.label, sourceTag: tag ? tag.tag : null, status: 'live', level: null, qualityLimitationReason: null };
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
      installEncodedTransform(record, result, 'outgoing', track.kind);
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
        installEncodedTransform(record, result.sender, 'outgoing', kind);
      }
      return result;
    };
  }

  const originalSetLocalDescription = OriginalRTCPeerConnection.prototype.setLocalDescription;
  OriginalRTCPeerConnection.prototype.setLocalDescription = function (description) {
    const record = recordByPc.get(this);
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
      record.remoteCandidates.push({ ts: Date.now(), type: parseCandidateType(candStr), candidate: candStr });
      emit({ type: 'ice-candidate-remote', connectionId: record.id, candidateType: parseCandidateType(candStr) });
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
      emit({ type: 'track-replaced', kind: newTrack ? newTrack.kind : null, trackId: newTrack ? newTrack.id : null, sourceTag: tag ? tag.tag : null });
      return OriginalRTCRtpSenderReplaceTrack.call(this, newTrack);
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
    const dcRecord = { label: channel.label, id: channel.id, origin, state: channel.readyState, messages: [] };
    record.dataChannels.push(dcRecord);
    emit({ type: 'datachannel-opened', connectionId: record.id, label: channel.label, origin });

    channel.addEventListener('open', () => { dcRecord.state = 'open'; });
    channel.addEventListener('close', () => { dcRecord.state = 'closed'; });
    channel.addEventListener('message', (ev) => {
      let data = ev.data;
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

  const OriginalWebSocket = window.WebSocket;

  if (OriginalWebSocket) {
    function PatchedWebSocket(url, protocols) {
      const ws = protocols !== undefined ? new OriginalWebSocket(url, protocols) : new OriginalWebSocket(url);
      const id = nextSocketId++;
      const record = { id, url: String(url), protocol: null, state: 'connecting', sentCount: 0, receivedCount: 0, messages: [], ws };
      socketsById.set(id, record);
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

    const originalWsSend = OriginalWebSocket.prototype.send;
    OriginalWebSocket.prototype.send = function (data) {
      const record = wsRecordByInstance.get(this);
      if (!record) return originalWsSend.call(this, data);
      let payload = data;
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
  let httpBlocked = false;

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

  const OriginalFetch = window.fetch ? window.fetch.bind(window) : null;
  if (OriginalFetch) {
    window.fetch = function (input, init) {
      const method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      const url = typeof input === 'string' || input instanceof URL ? String(input) : (input && input.url) || String(input);
      const record = recordHttpRequest(method, url);
      record.requestPreview = preview((init && init.body) || null);

      if (httpBlocked) {
        finishHttpRequest(record, { error: 'blocked by simulateNetworkLoss' });
        emit({ type: 'http-request-blocked', httpId: record.id, method, url: record.url });
        return Promise.reject(new TypeError('Failed to fetch: simulated network loss'));
      }

      return OriginalFetch(input, init).then(
        (response) => {
          response.clone().text().then(
            (text) => finishHttpRequest(record, { statusCode: response.status, responseBody: text }),
            () => finishHttpRequest(record, { statusCode: response.status })
          );
          return response;
        },
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

      if (httpBlocked) {
        finishHttpRequest(record, { error: 'blocked by simulateNetworkLoss' });
        emit({ type: 'http-request-blocked', httpId: record.id, method: record.method, url: record.url });
        setTimeout(() => this.dispatchEvent(new Event('error')), 0);
        return;
      }

      this.addEventListener('loadend', () => {
        if (!this.status) { finishHttpRequest(record, { error: 'network error' }); return; }
        let responseBody;
        try { responseBody = this.responseType === '' || this.responseType === 'text' ? this.responseText : `<${this.responseType} response>`; } catch (_) { /* responseText throws for some responseTypes mid-flight */ }
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
        updateQualityScore(record, summary.reports, summary.ts);
      } catch (_) { /* getStats can race a just-closed connection */ }
    }, config.statsIntervalMs);
  }
  function stopStatsPolling(record) {
    if (record.__statsTimer) clearInterval(record.__statsTimer);
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
    const audio = avgJitterBufferDelayMs(reports.find((r) => r.type === 'inbound-rtp' && r.kind === 'audio'));
    const video = avgJitterBufferDelayMs(reports.find((r) => r.type === 'inbound-rtp' && r.kind === 'video'));
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

  function updateQualityScore(record, reports, ts) {
    const selectedPair = findSelectedCandidatePair(reports);
    const rttMs = selectedPair && typeof selectedPair.currentRoundTripTime === 'number' ? selectedPair.currentRoundTripTime * 1000 : null;

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

  let meterCtx = null;
  function meterRemoteAudioTrack(trackRecord, track) {
    if (!meterCtx) meterCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = meterCtx.createMediaStreamSource(new MediaStream([track]));
    const analyser = meterCtx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const timer = setInterval(() => {
      if (trackRecord.status === 'ended') { clearInterval(timer); return; }
      analyser.getByteTimeDomainData(data);
      let sumSquares = 0;
      for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sumSquares += v * v; }
      trackRecord.level = Math.sqrt(sumSquares / data.length); // 0 (silence) .. ~1 (full scale)
    }, config.levelIntervalMs);
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
    };
  }

  if (OriginalGetDisplayMedia) {
    navigator.mediaDevices.getDisplayMedia = async function (constraints) {
      const callId = nextGumCallId++;
      const stream = await OriginalGetDisplayMedia(constraints);
      stream.getTracks().forEach((track) => trackTagById.set(track, { tag: 'display-capture', sourceCallId: callId }));
      emit({ type: 'getDisplayMedia-served', callId, trackIds: stream.getTracks().map((t) => t.id) });
      return stream;
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
    record.pc.close();
    record.closed = true;
    stopStatsPolling(record);
  }

  function simulateNetworkLoss(durationMs, options) {
    const opts = Object.assign({ targets: ['websocket', 'datachannel'] }, options);
    const wantWs = opts.targets.includes('websocket');
    const wantDc = opts.targets.includes('datachannel');
    const wantHttp = opts.targets.includes('http');
    const wantMedia = opts.targets.includes('media');
    const priorWsInterceptor = webSocketInterceptor;
    const priorDcInterceptor = dataChannelInterceptor;
    const priorHttpBlocked = httpBlocked;
    const priorMediaFaultInjector = mediaFaultInjector;
    let stopped = false;

    if (wantWs) webSocketInterceptor = () => false;
    if (wantDc) dataChannelInterceptor = () => false;
    if (wantHttp) httpBlocked = true;
    if (wantMedia) mediaFaultInjector = { connId: null, kind: null, fn: () => false };
    emit({ type: 'network-loss-start', durationMs, targets: opts.targets });

    let resolveDone;
    const done = new Promise((resolve) => { resolveDone = resolve; });

    function restore() {
      if (stopped) return;
      stopped = true;
      if (wantWs) webSocketInterceptor = priorWsInterceptor;
      if (wantDc) dataChannelInterceptor = priorDcInterceptor;
      if (wantHttp) httpBlocked = priorHttpBlocked;
      if (wantMedia) mediaFaultInjector = priorMediaFaultInjector;
      clearTimeout(timer);
      emit({ type: 'network-loss-end', targets: opts.targets });
      resolveDone();
    }

    const timer = setTimeout(restore, durationMs);
    return { stop: restore, done };
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
    return sender.setParameters(params);
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

  function getSnapshot(opts) {
    const concise = !!opts && opts.detail === 'concise';
    return {
      connections: Array.from(connectionsById.values()).map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        closed: r.closed,
        state: r.state,
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
      httpBlocked,
      fakeMicActive: !!fakeMic,
      fakeCamActive: !!fakeCam,
      dataChannelInterceptorActive: !!dataChannelInterceptor,
      webSocketInterceptorActive: !!webSocketInterceptor,
      mediaFaultInjectorActive: !!mediaFaultInjector,
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
      version: '1.4.0',
      snapshot: getSnapshot({ detail: 'detailed' }),
      fullLog: log.slice(),
      statsHistory: Array.from(connectionsById.values()).map((r) => ({
        connectionId: r.id,
        stats: r.statsHistory.slice(),
      })),
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

  function diffConnection(before, after) {
    const changes = {};
    ['iceConnectionState', 'connectionState', 'signalingState'].forEach((key) => {
      const c = fieldChange(before.state && before.state[key], after.state && after.state[key]);
      if (c) changes[key] = c;
    });
    [
      ['closed', before.closed, after.closed],
      ['localTrackCount', before.localTracks.length, after.localTracks.length],
      ['remoteTrackCount', before.remoteTracks.length, after.remoteTracks.length],
      ['dataChannelCount', before.dataChannels.length, after.dataChannels.length],
      ['selectedCandidateType', before.selectedCandidateType, after.selectedCandidateType],
      ['qualityScore', before.qualityScore, after.qualityScore],
      ['avSyncDeltaMs', before.avSyncDeltaMs, after.avSyncDeltaMs],
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
    version: '1.4.0',
    getSnapshot,
    getSnapshotDiff,
    exportBundle,
    captureEvents,
    diffCaptures,
    getSdp,
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
    setWebSocketInterceptor,
    clearWebSocketInterceptor,
    setMediaFaultInjector,
    clearMediaFaultInjector,
    injectWebSocketMessage,
    sendOnWebSocket,
    killConnection,
    simulateNetworkLoss,
    onEvent: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    clearLog: () => { log.length = 0; },
  };
})();
