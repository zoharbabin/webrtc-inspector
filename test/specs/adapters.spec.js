const { test, expect } = require('@playwright/test');
const { ADAPTERS, findAdapter, applyAdapter } = require('../../extension/adapters.js');

// Per-site adapter architecture (#6) — plain Node-executed, no browser
// needed (mirrors panel-timeline.spec.js). The auto-registration side effect
// at the bottom of adapters.js is guarded by `typeof window !== 'undefined'`,
// so requiring it here in Node is a no-op beyond exporting these functions.

test.describe('findAdapter()', () => {
  test('returns null for an empty/non-array registry', () => {
    expect(findAdapter([], 'example.com', 'https://example.com/')).toBeNull();
    expect(findAdapter(undefined, 'example.com', 'https://example.com/')).toBeNull();
  });

  test('returns the first adapter whose match() returns true', () => {
    const a = { name: 'a', match: () => false };
    const b = { name: 'b', match: (hostname) => hostname === 'example.com' };
    expect(findAdapter([a, b], 'example.com', 'https://example.com/')).toBe(b);
  });

  test('a throwing match() is treated as non-matching, not a crash', () => {
    const bad = { name: 'bad', match: () => { throw new Error('nope'); } };
    const good = { name: 'good', match: () => true };
    expect(findAdapter([bad, good], 'x', 'https://x/')).toBe(good);
  });

  test('the built-in jitsi-meet adapter matches only its own hostname', () => {
    const jitsi = ADAPTERS.find((a) => a.name === 'jitsi-meet');
    expect(jitsi.match('meet.jit.si')).toBe(true);
    expect(jitsi.match('127.0.0.1')).toBe(false);
  });
});

test.describe('applyAdapter()', () => {
  test('calls setLabeler with the adapter labeler', () => {
    const calls = [];
    const api = { setLabeler: (fn) => calls.push(fn), registerDecoder: () => () => {} };
    const labeler = () => 'x';
    applyAdapter({ labeler }, api);
    expect(calls).toEqual([labeler]);
  });

  test('calls registerDecoder for each decoder entry and collects unsubscribes', () => {
    const unsub = () => {};
    const registered = [];
    const api = { registerDecoder: (matcher, decode) => { registered.push({ matcher, decode }); return unsub; } };
    const decoders = [{ matcher: () => true, decode: () => 1 }, { matcher: () => false, decode: () => 2 }];
    const result = applyAdapter({ decoders }, api);
    expect(registered.length).toBe(2);
    expect(result).toEqual([unsub, unsub]);
  });

  test('a null adapter or api is a no-op, not a throw', () => {
    expect(applyAdapter(null, {})).toEqual([]);
    expect(applyAdapter({}, null)).toEqual([]);
  });

  test('an adapter with no labeler/decoders is a no-op', () => {
    const api = { setLabeler: () => { throw new Error('should not be called'); } };
    expect(() => applyAdapter({}, api)).not.toThrow();
  });
});
