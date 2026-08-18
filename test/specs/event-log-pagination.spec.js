const { test, expect } = require('@playwright/test');
const { gotoFixture } = require('../helpers');

// Token-budgeted, paginated event log (#28) — getEvents({ since, limit,
// maxChars }) pages through the instrumentation's event log with an
// explicit, never-silent truncation marker instead of a fixed "last N".
// Five `new WebSocket(...)` calls are used purely as a cheap, deterministic
// way to produce exactly five log entries (each fires one synchronous
// 'websocket-created' event) — the pagination logic under test doesn't care
// what event type it's paging through.

test.describe('getEvents()', () => {
  test.beforeEach(async ({ page }) => {
    await gotoFixture(page);
  });

  test('with no events yet, returns an empty, non-truncated page', async ({ page }) => {
    const result = await page.evaluate(() => window.__webrtcInspector.getEvents());
    expect(result).toEqual({ events: [], nextSince: 0, remainingCount: 0, truncated: false, truncationMarker: null });
  });

  test('with no opts, returns every event with a monotonically increasing seq', async ({ page }) => {
    const result = await page.evaluate(() => {
      for (let i = 0; i < 5; i++) new WebSocket(`wss://mock.test/s${i}`);
      return window.__webrtcInspector.getEvents();
    });
    expect(result.events).toHaveLength(5);
    expect(result.truncated).toBe(false);
    expect(result.truncationMarker).toBeNull();
    const seqs = result.events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(5);
    expect(result.nextSince).toBe(seqs[seqs.length - 1]);
  });

  test('since only returns entries after that cursor', async ({ page }) => {
    const { thirdSeq, after } = await page.evaluate(() => {
      for (let i = 0; i < 5; i++) new WebSocket(`wss://mock.test/s${i}`);
      const all = window.__webrtcInspector.getEvents();
      const thirdSeq = all.events[2].seq;
      const after = window.__webrtcInspector.getEvents({ since: thirdSeq });
      return { thirdSeq, after };
    });
    expect(after.events).toHaveLength(2);
    expect(after.events.every((e) => e.seq > thirdSeq)).toBe(true);
    expect(after.truncated).toBe(false);
  });

  test('a since past the last entry returns an empty page with an unchanged cursor', async ({ page }) => {
    const result = await page.evaluate(() => {
      new WebSocket('wss://mock.test/only');
      return window.__webrtcInspector.getEvents({ since: 999999 });
    });
    expect(result).toEqual({ events: [], nextSince: 999999, remainingCount: 0, truncated: false, truncationMarker: null });
  });

  test('limit truncates explicitly, with a marker naming the remaining count and a resumable cursor', async ({ page }) => {
    const result = await page.evaluate(() => {
      for (let i = 0; i < 5; i++) new WebSocket(`wss://mock.test/s${i}`);
      return window.__webrtcInspector.getEvents({ limit: 2 });
    });
    expect(result.events).toHaveLength(2);
    expect(result.remainingCount).toBe(3);
    expect(result.truncated).toBe(true);
    expect(result.truncationMarker).toBe(`3 more entries — call getEvents({ since: ${result.nextSince} }) for more`);
  });

  test('a maxChars budget too small for even one entry still returns one, forcing progress', async ({ page }) => {
    const result = await page.evaluate(() => {
      for (let i = 0; i < 3; i++) new WebSocket(`wss://mock.test/s${i}`);
      return window.__webrtcInspector.getEvents({ maxChars: 1 });
    });
    expect(result.events).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(result.remainingCount).toBe(2);
  });

  test('paging with since+limit until truncated:false covers every event exactly once, in order', async ({ page }) => {
    const { pages, full } = await page.evaluate(() => {
      for (let i = 0; i < 7; i++) new WebSocket(`wss://mock.test/s${i}`);
      const full = window.__webrtcInspector.getEvents();
      const pages = [];
      let since = 0;
      for (let guard = 0; guard < 20; guard++) {
        const page = window.__webrtcInspector.getEvents({ since, limit: 2 });
        pages.push(page);
        since = page.nextSince;
        if (!page.truncated) break;
      }
      return { pages, full };
    });
    const paged = pages.flatMap((p) => p.events);
    expect(paged.map((e) => e.seq)).toEqual(full.events.map((e) => e.seq));
    expect(pages[pages.length - 1].truncated).toBe(false);
  });
});
