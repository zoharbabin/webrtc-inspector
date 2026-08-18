const { test, expect } = require('@playwright/test');
const { buildSdpClipboardPayload, buildClipboardJson } = require('../../extension/panel-clipboard.js');

// Pure JSON-shaping for the DevTools panel's "Copy as..." buttons (#33) —
// plain Node-executed, no browser needed (mirrors panel-sparkline.spec.js).

test.describe('buildSdpClipboardPayload()', () => {
  test('shapes {connId, sdpType, type, sdp} from a getSdp()-style result', () => {
    const sdpResult = { local: { type: 'offer', sdp: 'v=0\r\n...' }, remote: { type: 'answer', sdp: 'v=0\r\n...' } };
    const payload = JSON.parse(buildSdpClipboardPayload(3, 'local', sdpResult));
    expect(payload).toEqual({ connId: 3, sdpType: 'local', type: 'offer', sdp: 'v=0\r\n...' });
  });

  test('reads the requested side independently of the other', () => {
    const sdpResult = { local: { type: 'offer', sdp: 'local-sdp' }, remote: { type: 'answer', sdp: 'remote-sdp' } };
    const payload = JSON.parse(buildSdpClipboardPayload(1, 'remote', sdpResult));
    expect(payload.sdp).toBe('remote-sdp');
    expect(payload.type).toBe('answer');
  });

  test('returns null when the requested side has not been set yet', () => {
    expect(buildSdpClipboardPayload(1, 'remote', { local: { type: 'offer', sdp: 'x' }, remote: null })).toBeNull();
  });

  test('returns null when getSdp() itself is missing', () => {
    expect(buildSdpClipboardPayload(1, 'local', null)).toBeNull();
  });
});

test.describe('buildClipboardJson()', () => {
  test('pretty-prints a message payload as JSON', () => {
    const message = { dir: 'out', preview: 'hello' };
    expect(JSON.parse(buildClipboardJson(message))).toEqual(message);
    expect(buildClipboardJson(message)).toContain('\n');
  });

  test('pretty-prints an event-log entry as JSON', () => {
    const entry = { type: 'iceconnectionstatechange', connectionId: 2, ts: 123, value: 'connected' };
    expect(JSON.parse(buildClipboardJson(entry))).toEqual(entry);
  });
});
