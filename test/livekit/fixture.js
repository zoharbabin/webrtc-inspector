// Fixture page logic for the LiveKit E2E suite. Loaded after livekit-client's
// UMD bundle (see fixture.html), which attaches its exports to
// `window.LivekitClient`. Exposes window.__livekitTestHelpers so Playwright
// specs can join a real LiveKit room, publish real media, and assert on the
// real negotiation that results — see
// ~/Downloads/webrtc-inspector-livekit-e2e-plan.md section 6.
(function () {
  'use strict';

  const { Room, RoomEvent, VideoPresets } = window.LivekitClient;

  let room = null;
  const events = [];

  function logEvent(type, detail) {
    events.push({ type, detail, at: Date.now() });
  }

  function buildRoomOptions(opts) {
    const options = Object.assign({}, opts);
    return {
      // Real 720p capture (not the synthetic suite's 320x240/64x48 shortcuts)
      // is required so LiveKit's own computeVideoEncodings() gates actually
      // negotiate multiple simulcast layers.
      videoCaptureDefaults: { resolution: VideoPresets.h720.resolution },
      publishDefaults: {
        simulcast: true,
        videoSimulcastLayers: [VideoPresets.h720, VideoPresets.h360, VideoPresets.h180],
      },
      adaptiveStream: false,
      dynacast: false,
      // Legacy dual-PC negotiation path toggle (plan section 4, "topology"):
      // default true is livekit-client's own modern default.
      singlePeerConnection: options.singlePeerConnection !== false,
    };
  }

  async function join(url, token, opts, connectOptions) {
    if (room) await disconnect();
    events.length = 0;
    room = new Room(buildRoomOptions(opts || {}));
    [
      RoomEvent.Connected,
      RoomEvent.Disconnected,
      RoomEvent.Reconnecting,
      RoomEvent.Reconnected,
      RoomEvent.SignalReconnecting,
      RoomEvent.ParticipantConnected,
      RoomEvent.ParticipantDisconnected,
      RoomEvent.TrackSubscribed,
      RoomEvent.TrackUnsubscribed,
      RoomEvent.ConnectionStateChanged,
    ].filter(Boolean).forEach((evt) => {
      room.on(evt, (...args) => logEvent(evt, args.length ? String(args[0]) : undefined));
    });
    // rtcConfig (e.g. forcing iceTransportPolicy: 'relay') is a
    // RoomConnectOptions field, not a RoomOptions field — it must go here,
    // not into the Room constructor, or it's silently ignored.
    await room.connect(url, token, connectOptions);
    window.__lkRoom = room;
    return {
      sid: await room.getSid(),
      identity: room.localParticipant.identity,
    };
  }

  async function publishCamMic() {
    const [videoPub, audioPub] = await Promise.all([
      room.localParticipant.setCameraEnabled(true),
      room.localParticipant.setMicrophoneEnabled(true),
    ]);
    return { videoTrackSid: videoPub && videoPub.trackSid, audioTrackSid: audioPub && audioPub.trackSid };
  }

  async function publishScreenShare() {
    const pub = await room.localParticipant.setScreenShareEnabled(true);
    return { trackSid: pub && pub.trackSid };
  }

  async function unpublishScreenShare() {
    await room.localParticipant.setScreenShareEnabled(false);
  }

  async function disconnect() {
    if (!room) return;
    await room.disconnect();
    room = null;
    window.__lkRoom = null;
  }

  // Best-effort access to the raw RTCPeerConnection for the checkpoint-1
  // central simulcast assertion, which must run before the extension (and
  // therefore getSdp()) is loaded. room.engine.pcManager is documented
  // @internal in livekit-client — if a version bump renames/removes it, this
  // degrades to the sender.getParameters() check only, it does not throw.
  function rawPublisherPc() {
    try {
      return room.engine.pcManager.publisher.pc;
    } catch {
      return null;
    }
  }

  function assertSimulcastNegotiated() {
    const videoPub = Array.from(room.localParticipant.videoTrackPublications.values())[0];
    const sender = videoPub && videoPub.track && videoPub.track.sender;
    const encodings = (sender && sender.getParameters().encodings) || [];
    const pc = rawPublisherPc();
    const sdp = pc && pc.localDescription && pc.localDescription.sdp;
    return {
      encodingCount: encodings.length,
      sdpHasSimulcast: typeof sdp === 'string' ? sdp.includes('a=simulcast') : null,
    };
  }

  function getConnectionState() {
    return room ? room.state : 'disconnected';
  }

  function getEvents() {
    return events.slice();
  }

  // Maps each subscribed remote participant's publications to the raw
  // MediaStreamTrack id, so a spec can cross-reference against
  // getSnapshot().connections[].remoteTracks[].trackId and call
  // window.__webrtcInspector.getRemoteTrackStream() to attribute a specific
  // inbound track to the LiveKit identity that published it.
  function getRemoteTracksByParticipant() {
    const result = {};
    room.remoteParticipants.forEach((participant, identity) => {
      result[identity] = Array.from(participant.trackPublications.values())
        .filter((pub) => pub.track && pub.track.mediaStreamTrack)
        .map((pub) => ({
          trackSid: pub.trackSid,
          source: pub.source,
          mediaStreamTrackId: pub.track.mediaStreamTrack.id,
        }));
    });
    return result;
  }

  function getLocalVideoSources() {
    return Array.from(room.localParticipant.videoTrackPublications.values()).map((pub) => ({
      trackSid: pub.trackSid,
      source: pub.source,
      mediaStreamTrackId: pub.track && pub.track.mediaStreamTrack && pub.track.mediaStreamTrack.id,
    }));
  }

  // Reads the LOCAL video sender(s) directly off the raw publisher PC —
  // deliberately bypasses livekit-client's own bookkeeping, since this is
  // used to check what capEncoding()/replaceOutgoingTrack() (which resolve
  // their target via raw RTCPeerConnection.getSenders()) actually did.
  function getVideoSenderStates() {
    const pc = rawPublisherPc();
    if (!pc) return [];
    return pc.getSenders()
      .filter((s) => s.track && s.track.kind === 'video')
      .map((s) => {
        const encodings = s.getParameters().encodings || [];
        return { trackId: s.track.id, maxBitrate: encodings[0] ? encodings[0].maxBitrate : undefined };
      });
  }

  // Samples a pixel far from the fake-cam's text label (top-left) and its
  // always-on timestamp overlay (bottom-left), to verify a remote stream
  // actually carries the distinguishable per-participant color set via
  // window.__webrtcInspector.setFakeCam({ color, text }).
  async function sampleStreamColor(stream) {
    const videoEl = document.createElement('video');
    videoEl.muted = true;
    videoEl.playsInline = true;
    videoEl.srcObject = stream;
    await videoEl.play();
    await new Promise((resolve) => {
      if (videoEl.readyState >= 2 && videoEl.videoWidth > 0) return resolve();
      videoEl.onloadeddata = () => resolve();
    });
    await new Promise((r) => setTimeout(r, 300));
    const canvas = document.createElement('canvas');
    canvas.width = videoEl.videoWidth || 320;
    canvas.height = videoEl.videoHeight || 240;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
    const [r, g, b] = ctx.getImageData(canvas.width - 10, 10, 1, 1).data;
    return { r, g, b };
  }

  window.__livekitTestHelpers = {
    join,
    publishCamMic,
    publishScreenShare,
    unpublishScreenShare,
    disconnect,
    assertSimulcastNegotiated,
    rawPublisherPc,
    getConnectionState,
    getEvents,
    getRemoteTracksByParticipant,
    getLocalVideoSources,
    getVideoSenderStates,
    sampleStreamColor,
  };
})();
