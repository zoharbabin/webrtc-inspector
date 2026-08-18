// #6 — per-site adapter architecture: bundles a labeler + decoders for a
// given target site, auto-selected by hostname/URL, so customizing behavior
// for a site no longer requires forking core/webrtc-inspector.js — add an
// entry to ADAPTERS below, or set window.__webrtcInspectorAdapters to your
// own array from an earlier-running script (e.g. a userscript) to override
// the built-in list entirely without editing this file.
//
// Each adapter: { match(hostname, href) -> boolean, labeler?(meta) -> string|null,
// decoders?: [{ matcher(meta) -> boolean, decode(data, meta) -> any }] }.
// First matching adapter wins.

const ADAPTERS = [
  // Documented example — a real, well-known WebRTC product, but its hostname
  // never occurs in this repo's test fixtures (127.0.0.1), so it's inert
  // there and safe to ship as a working reference for writing your own.
  {
    name: 'jitsi-meet',
    match: (hostname) => hostname === 'meet.jit.si',
    labeler: (meta) => (meta.kind === 'connection' ? 'Jitsi Meet' : null),
    decoders: [
      {
        matcher: (meta) => meta.kind === 'datachannel',
        decode: (data) => {
          try {
            return JSON.parse(data);
          } catch (_) {
            return undefined;
          }
        },
      },
    ],
  },
];

function findAdapter(adapters, hostname, href) {
  if (!Array.isArray(adapters)) return null;
  return adapters.find((a) => {
    try {
      return !!a.match(hostname, href);
    } catch (_) {
      return false;
    }
  }) || null;
}

// Applies one adapter's labeler/decoders to a window.__webrtcInspector-shaped
// api. Returns the unsubscribe closures registerDecoder() handed back, so a
// caller can tear an adapter down (tests, or switching adapters at runtime).
function applyAdapter(adapter, api) {
  const unsubscribes = [];
  if (!adapter || !api) return unsubscribes;
  if (typeof adapter.labeler === 'function' && typeof api.setLabeler === 'function') {
    api.setLabeler(adapter.labeler);
  }
  if (Array.isArray(adapter.decoders) && typeof api.registerDecoder === 'function') {
    adapter.decoders.forEach(({ matcher, decode }) => {
      unsubscribes.push(api.registerDecoder(matcher, decode));
    });
  }
  return unsubscribes;
}

if (typeof window !== 'undefined' && window.__webrtcInspector && typeof location !== 'undefined') {
  const adapter = findAdapter(window.__webrtcInspectorAdapters || ADAPTERS, location.hostname, location.href);
  if (adapter) applyAdapter(adapter, window.__webrtcInspector);
}

if (typeof module !== 'undefined') module.exports = { ADAPTERS, findAdapter, applyAdapter };
