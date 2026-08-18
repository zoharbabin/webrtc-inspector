// #37 "Test this stream" — right-click overlay showing live per-track
// metrics directly on the <video>/<audio> element. Runs in the default
// ISOLATED world (needs chrome.runtime for the context-menu message from
// background.js) and reads resolution straight off the element (a platform
// property, visible from either world); everything from our own
// instrumentation (freeze/quality flags, qualityScore) crosses the MAIN/
// ISOLATED world boundary via a CustomEvent on `document` — see the
// 'wrtc-overlay-request' listener in core/webrtc-inspector.js.

let lastMediaTarget = null;
let overlayEl = null;
let overlayFollowTarget = null;

document.addEventListener('contextmenu', (e) => {
  const t = e.target;
  if (t && (t.tagName === 'VIDEO' || t.tagName === 'AUDIO')) lastMediaTarget = t;
}, true);

function ensureOverlayId(el) {
  if (!el.dataset.wrtcOverlayId) el.dataset.wrtcOverlayId = `wrtc-${Math.random().toString(36).slice(2)}`;
  return el.dataset.wrtcOverlayId;
}

function getElementTrackIds(el) {
  const stream = el.srcObject;
  if (!(stream instanceof MediaStream)) return [];
  return stream.getTracks().map((t) => t.id);
}

function positionOverlay() {
  if (!overlayEl || !overlayFollowTarget || !overlayFollowTarget.isConnected) {
    removeOverlay();
    return;
  }
  const r = overlayFollowTarget.getBoundingClientRect();
  overlayEl.style.top = `${Math.max(0, r.top + 4)}px`;
  overlayEl.style.left = `${Math.max(0, r.left + 4)}px`;
}

function removeOverlay() {
  if (overlayEl) { overlayEl.remove(); overlayEl = null; }
  overlayFollowTarget = null;
  window.removeEventListener('scroll', positionOverlay, true);
  window.removeEventListener('resize', positionOverlay);
}

function formatMetrics(el, diagnostics) {
  const lines = [];
  if (el.tagName === 'VIDEO' && el.videoWidth) lines.push(`Resolution: ${el.videoWidth}x${el.videoHeight}`);
  if (!diagnostics) {
    lines.push('No tracked WebRTC track on this element');
    return lines.join('\n');
  }
  lines.push(`${diagnostics.kind} · pc#${diagnostics.connectionId} · ${diagnostics.status}`);
  if (typeof diagnostics.qualityScore === 'number') lines.push(`Quality: ${diagnostics.qualityScore.toFixed(1)}/5`);
  if (typeof diagnostics.freezeRatio === 'number') lines.push(`Freeze ratio: ${(diagnostics.freezeRatio * 100).toFixed(1)}%`);
  if (diagnostics.qualityFlag) lines.push(`Flag: ${diagnostics.qualityFlag}`);
  if (diagnostics.qualityLimitationReason && diagnostics.qualityLimitationReason !== 'none') {
    lines.push(`Limited by: ${diagnostics.qualityLimitationReason}`);
  }
  return lines.join('\n');
}

function renderOverlay(el, diagnostics) {
  removeOverlay();
  overlayEl = document.createElement('div');
  overlayEl.setAttribute('data-wrtc-inspector-overlay', '1');
  overlayEl.style.cssText = 'position: fixed; z-index: 2147483647; background: rgba(20,20,20,0.92); color: #ddd;'
    + 'font: 11px -apple-system, sans-serif; padding: 6px 8px; border: 1px solid #4ec9b0;'
    + 'border-radius: 4px; max-width: 220px; white-space: pre-line;';

  const closeBtn = document.createElement('span');
  closeBtn.textContent = '✕';
  closeBtn.style.cssText = 'float: right; cursor: pointer; color: #f44747; margin-left: 6px;';
  closeBtn.addEventListener('click', removeOverlay);

  const body = document.createElement('div');
  body.textContent = formatMetrics(el, diagnostics);

  overlayEl.appendChild(closeBtn);
  overlayEl.appendChild(body);
  document.body.appendChild(overlayEl);
  overlayFollowTarget = el;
  positionOverlay();
  window.addEventListener('scroll', positionOverlay, true);
  window.addEventListener('resize', positionOverlay);
}

function requestDiagnosticsAndRender(el) {
  const elId = ensureOverlayId(el);
  let done = false;
  const handler = (e) => {
    if (!e.detail || e.detail.elId !== elId) return;
    done = true;
    document.removeEventListener('wrtc-overlay-response', handler);
    renderOverlay(el, e.detail.diagnostics);
  };
  document.addEventListener('wrtc-overlay-response', handler);
  document.dispatchEvent(new CustomEvent('wrtc-overlay-request', { detail: { elId, trackIds: getElementTrackIds(el) } }));
  setTimeout(() => {
    if (done) return;
    document.removeEventListener('wrtc-overlay-response', handler);
    renderOverlay(el, null);
  }, 300);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'wrtc-test-stream' && lastMediaTarget) requestDiagnosticsAndRender(lastMediaTarget);
});
