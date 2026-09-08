// Named wait/poll constants for the LiveKit E2E suite. A real SFU round-trip
// (join, negotiate, ICE, publish) is much slower than the synthetic loopback
// fixtures in test/specs, so these start generous and get tuned from measured
// local runs (see plan section 6, "Flake policy").
'use strict';

module.exports = {
  ROOM_JOIN_TIMEOUT_MS: 20000,
  TRACK_SUBSCRIBED_TIMEOUT_MS: 20000,
  SIMULCAST_NEGOTIATED_TIMEOUT_MS: 15000,
  RECONNECT_CONVERGENCE_TIMEOUT_MS: 30000,
  STATS_FLOWING_TIMEOUT_MS: 20000,
  POLL_INTERVAL_MS: 250,
  // How long a getParameters()/setParameters() round-trip + the extension's
  // own capEncodingQueueBySender serialization may take to settle on a real
  // sender under active ABR, before we conclude encoding-capped/-cap-failed
  // isn't coming. Measured live at ~3-9s once track-diagnostics-real.spec.js's
  // bandwidth-starved-encoder test published its cappable track with
  // simulcast disabled (a simulcast sender's per-layer bitrate floor was
  // silently starving every layer at once under a uniform low cap, which
  // looked like a settle-time problem but wasn't). Kept generous at 25s as a
  // ceiling since a slow CI runner under contention is still plausible and a
  // high ceiling costs nothing on the passing path.
  CAP_ENCODING_SETTLE_TIMEOUT_MS: 25000,
  // How long a subscriber may take to render new frame content after the
  // publisher calls replaceOutgoingTrack() on an already-negotiated sender
  // (no renegotiation expected, just new RTP payload).
  TRACK_REPLACE_CONVERGENCE_TIMEOUT_MS: 15000,
  // How long a full rejoin may take after server.js's control server kills
  // and respawns the real livekit-server process: waitForPortFree's OS probe
  // (up to 15s per port), a fresh health check, plus livekit-client's own
  // backoff before its next reconnect attempt succeeds against the
  // newly-live server.
  SERVER_OUTAGE_RECOVERY_TIMEOUT_MS: 60000,
};
