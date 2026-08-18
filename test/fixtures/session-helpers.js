// In-page helpers shared by every spec: a two-RTCPeerConnection loopback
// session (no signaling server — both sides are reachable in the same JS
// context) plus small polling utilities. Loaded by base.html after
// webrtc-inspector.js so window.RTCPeerConnection is already patched.
window.testHelpers = {
  wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },

  async waitFor(fn, timeoutMs = 2000, intervalMs = 20) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await fn()) return true;
      await this.wait(intervalMs);
    }
    return false;
  },

  // Opens pcA/pcB with a data channel negotiated end to end and stashes both
  // on window so a spec's later evaluate() calls can reach them by name.
  // `beforeOffer(pcA, pcB)` runs after pc creation but before the single O/A
  // round — e.g. to addTrack() so it lands in the initial SDP, since adding a
  // track after negotiation needs a renegotiation this helper doesn't drive.
  async createLoopbackSession(channelLabel = 'test-channel', beforeOffer) {
    const ids = [];
    const unsubscribe = window.__webrtcInspector.onEvent((entry) => {
      if (entry.type === 'pc-created') ids.push(entry.connectionId);
    });

    const pcA = new RTCPeerConnection({ iceServers: [] });
    const pcB = new RTCPeerConnection({ iceServers: [] });
    pcA.onicecandidate = (e) => { if (e.candidate) pcB.addIceCandidate(e.candidate); };
    pcB.onicecandidate = (e) => { if (e.candidate) pcA.addIceCandidate(e.candidate); };
    unsubscribe();

    const dcA = pcA.createDataChannel(channelLabel);
    const dcBReady = new Promise((resolve) => { pcB.ondatachannel = (e) => resolve(e.channel); });

    if (beforeOffer) await beforeOffer(pcA, pcB);

    const offer = await pcA.createOffer();
    await pcA.setLocalDescription(offer);
    await pcB.setRemoteDescription(offer);
    const answer = await pcB.createAnswer();
    await pcB.setLocalDescription(answer);
    await pcA.setRemoteDescription(answer);

    const dcB = await dcBReady;
    await new Promise((resolve) => {
      if (dcA.readyState === 'open') return resolve();
      dcA.onopen = resolve;
    });

    window.__pcA = pcA;
    window.__pcB = pcB;
    window.__dcA = dcA;
    window.__dcB = dcB;

    return { connectionIdA: ids[0], connectionIdB: ids[1] };
  },
};
