const { test, expect } = require('@playwright/test');
const { gotoFixture } = require('../helpers');

test.describe('captureEvents() / diffCaptures()', () => {
  test.beforeEach(async ({ page }) => {
    await gotoFixture(page);
  });

  test('captureEvents() returns a JSON-serializable snapshot of the event stream', async ({ page }) => {
    const capture = await page.evaluate(async () => {
      await window.testHelpers.createLoopbackSession();
      return JSON.parse(JSON.stringify(window.__webrtcInspector.captureEvents()));
    });
    expect(typeof capture.capturedAt).toBe('number');
    expect(Array.isArray(capture.events)).toBe(true);
    expect(capture.events.length).toBeGreaterThan(0);
    expect(capture.events.every((e) => typeof e.type === 'string')).toBe(true);
  });

  test('diffCaptures() reports no differences for two identical captures', async ({ page }) => {
    const diff = await page.evaluate(async () => {
      await window.testHelpers.createLoopbackSession();
      const capture = window.__webrtcInspector.captureEvents();
      return window.__webrtcInspector.diffCaptures(capture, capture);
    });
    expect(diff.eventTypeCounts).toEqual({});
    expect(diff.sequenceLengths.from).toBe(diff.sequenceLengths.to);
    expect(diff.firstDivergenceIndex).toBeNull();
  });

  test('diffCaptures() reports per-type count deltas when an extra event occurs after the first capture', async ({ page }) => {
    const diff = await page.evaluate(async () => {
      await window.testHelpers.createLoopbackSession();
      const before = window.__webrtcInspector.captureEvents();
      window.__dcA.send('extra-message');
      await window.testHelpers.waitFor(() => {
        const after = window.__webrtcInspector.captureEvents();
        return after.events.length > before.events.length;
      });
      const after = window.__webrtcInspector.captureEvents();
      return window.__webrtcInspector.diffCaptures(before, after);
    });
    expect(diff.eventTypeCounts['datachannel-message']).toBeDefined();
    expect(diff.eventTypeCounts['datachannel-message'].to).toBeGreaterThan(diff.eventTypeCounts['datachannel-message'].from);
    expect(diff.sequenceLengths.to).toBeGreaterThan(diff.sequenceLengths.from);
    // before's events are a clean prefix of after's — no per-index divergence, only a length change.
    expect(diff.firstDivergenceIndex).toBeNull();
  });

  test('diffCaptures() is symmetric-safe: reversing before/after flips from/to', async ({ page }) => {
    const result = await page.evaluate(async () => {
      await window.testHelpers.createLoopbackSession();
      const before = window.__webrtcInspector.captureEvents();
      window.__dcA.send('extra-message');
      await window.testHelpers.waitFor(() => window.__webrtcInspector.captureEvents().events.length > before.events.length);
      const after = window.__webrtcInspector.captureEvents();
      return {
        forward: window.__webrtcInspector.diffCaptures(before, after),
        reversed: window.__webrtcInspector.diffCaptures(after, before),
      };
    });
    const type = Object.keys(result.forward.eventTypeCounts)[0];
    expect(result.reversed.eventTypeCounts[type]).toEqual({
      from: result.forward.eventTypeCounts[type].to,
      to: result.forward.eventTypeCounts[type].from,
    });
    expect(result.reversed.sequenceLengths).toEqual({ from: result.forward.sequenceLengths.to, to: result.forward.sequenceLengths.from });
  });

  test('diffCaptures() detects a divergence within the shared prefix, not just a length change', async ({ page }) => {
    const diff = await page.evaluate(() => {
      const before = { capturedAt: 1, events: [{ type: 'a' }, { type: 'b' }, { type: 'c' }] };
      const after = { capturedAt: 2, events: [{ type: 'a' }, { type: 'x' }, { type: 'c' }] };
      return window.__webrtcInspector.diffCaptures(before, after);
    });
    expect(diff.firstDivergenceIndex).toBe(1);
    expect(diff.sequenceLengths).toEqual({ from: 3, to: 3 });
  });
});
