const { test, expect } = require('@playwright/test');
const { gotoFixture } = require('../helpers');

// test/static-server.js serves the repo root as static files (GET only, no
// signaling) — used here purely as a same-origin fetch/XHR target so these
// tests exercise the real network stack instead of mocking fetch/XHR.

test.describe('HTTP (fetch/XHR) signaling instrumentation', () => {
  test.beforeEach(async ({ page }) => {
    await gotoFixture(page);
  });

  test('captures a successful fetch() with method, status, and response preview', async ({ page }) => {
    await page.evaluate(async () => {
      await fetch('/test/fixtures/base.html');
    });
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    const req = snap.httpRequests.find((r) => r.url.endsWith('/test/fixtures/base.html'));
    expect(req).toBeDefined();
    expect(req.method).toBe('GET');
    expect(req.state).toBe('complete');
    expect(req.statusCode).toBe(200);
    expect(req.responsePreview).toContain('<html');
  });

  test('captures a 404 fetch() with its status code', async ({ page }) => {
    await page.evaluate(async () => {
      await fetch('/no-such-path');
    });
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    const req = snap.httpRequests.find((r) => r.url.endsWith('/no-such-path'));
    expect(req.state).toBe('complete');
    expect(req.statusCode).toBe(404);
  });

  test('captures request body preview for a POST-style fetch()', async ({ page }) => {
    await page.evaluate(async () => {
      await fetch('/no-such-path', { method: 'POST', body: 'sdp-offer-body' }).catch(() => {});
    });
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    const req = snap.httpRequests.find((r) => r.url.endsWith('/no-such-path') && r.method === 'POST');
    expect(req).toBeDefined();
    expect(req.requestPreview).toBe('sdp-offer-body');
  });

  test('captures a successful XMLHttpRequest', async ({ page }) => {
    await page.evaluate(() => new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', '/test/fixtures/base.html');
      xhr.addEventListener('loadend', resolve);
      xhr.send();
    }));
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    const req = snap.httpRequests.find((r) => r.url.endsWith('/test/fixtures/base.html'));
    expect(req.state).toBe('complete');
    expect(req.statusCode).toBe(200);
    expect(req.responsePreview).toContain('<html');
  });

  // The XHR path samples a slice of responseText rather than the whole string,
  // so a large download is not copied again just to build a 200-char preview.
  // Peak memory isn't observable from a page, so this pins what is: the app
  // still sees the full body, and the stored preview stays short.
  test('samples a bounded slice of a large XMLHttpRequest body, leaving the full body to the app', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', '/test/dyn/bulk?mb=2&tag=xhr-bounded');
      // The inspector registers its own loadend listener inside send(), so it
      // runs after this one: read the record only once it reports complete.
      const done = new Promise((resolve) => xhr.addEventListener('loadend', resolve));
      xhr.send();
      await done;
      const find = () => window.__webrtcInspector.getSnapshot().httpRequests.find((r) => r.url.includes('tag=xhr-bounded'));
      await window.testHelpers.waitFor(() => find() && find().state === 'complete', 3000);
      const record = find();
      return {
        appLength: xhr.responseText.length,
        allA: /^a+$/.test(xhr.responseText),
        state: record.state,
        statusCode: record.statusCode,
        previewLength: record.responsePreview.length,
      };
    });
    expect(result.appLength).toBe(2 * 1024 * 1024);
    expect(result.allA).toBe(true);
    expect(result.state).toBe('complete');
    expect(result.statusCode).toBe(200);
    expect(result.previewLength).toBeLessThanOrEqual(256);
  });

  test('drops requestPreview/responsePreview in concise mode', async ({ page }) => {
    await page.evaluate(async () => {
      await fetch('/test/fixtures/base.html');
    });
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot({ detail: 'concise' }));
    const req = snap.httpRequests.find((r) => r.url.endsWith('/test/fixtures/base.html'));
    expect(req.statusCode).toBe(200);
    expect(req.requestPreview).toBeUndefined();
    expect(req.responsePreview).toBeUndefined();
  });

  test("simulateNetworkLoss with targets: ['http'] fails fetch() without hitting the network", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { stop } = window.__webrtcInspector.simulateNetworkLoss(5000, { targets: ['http'] });
      let rejected = false;
      try {
        await fetch('/test/fixtures/base.html');
      } catch (_) {
        rejected = true;
      }
      stop();
      const snap = window.__webrtcInspector.getSnapshot();
      const req = snap.httpRequests.find((r) => r.url.endsWith('/test/fixtures/base.html'));
      return { rejected, req };
    });
    expect(result.rejected).toBe(true);
    expect(result.req.state).toBe('error');
  });

  test("simulateNetworkLoss with targets: ['http'] fails XMLHttpRequest without hitting the network", async ({ page }) => {
    const result = await page.evaluate(() => new Promise((resolve) => {
      const { stop } = window.__webrtcInspector.simulateNetworkLoss(5000, { targets: ['http'] });
      const xhr = new XMLHttpRequest();
      xhr.open('GET', '/test/fixtures/base.html');
      xhr.addEventListener('error', () => {
        stop();
        const snap = window.__webrtcInspector.getSnapshot();
        const req = snap.httpRequests.find((r) => r.url.endsWith('/test/fixtures/base.html'));
        resolve({ req });
      });
      xhr.addEventListener('load', () => resolve({ req: null, unexpectedLoad: true }));
      xhr.send();
    }));
    expect(result.unexpectedLoad).toBeUndefined();
    expect(result.req.state).toBe('error');
  });

  test('does not block websocket/datachannel targets when only http is requested', async ({ page }) => {
    await page.evaluate(() => window.testHelpers.createLoopbackSession());
    const active = await page.evaluate(async () => {
      const { stop } = window.__webrtcInspector.simulateNetworkLoss(5000, { targets: ['http'] });
      window.__dcA.send('still-flows');
      stop();
      return window.__dcA.readyState;
    });
    expect(active).toBe('open');
  });

  test('fetch() succeeds again once the network-loss window is stopped', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { stop } = window.__webrtcInspector.simulateNetworkLoss(5000, { targets: ['http'] });
      stop();
      const res = await fetch('/test/fixtures/base.html');
      return res.status;
    });
    expect(result).toBe(200);
  });

  // Sampling a response must be bounded in bytes and in time, and must leave the
  // app's own copy of the body untouched. Before this, the sampler read the whole
  // body into a string: a 256 MiB download cost 256 MiB of extension memory to
  // produce a 201-char preview, and a never-ending stream left the record
  // 'pending' for the life of the page. These four lock the bounds in.
  test('completes the record for an open-ended text/event-stream instead of leaving it pending', async ({ page }) => {
    const req = await page.evaluate(async () => {
      const res = await fetch('/test/dyn/sse');
      await window.testHelpers.waitFor(() => {
        const r = window.__webrtcInspector.getSnapshot().httpRequests.find((x) => x.url.endsWith('/test/dyn/sse'));
        return r && r.state === 'complete';
      }, 3000);
      res.body.cancel();
      return window.__webrtcInspector.getSnapshot().httpRequests.find((x) => x.url.endsWith('/test/dyn/sse'));
    });
    expect(req.state).toBe('complete');
    expect(req.statusCode).toBe(200);
    expect(req.responsePreview).toBeFalsy(); // headers only: reading the stream would never finish
  });

  // The sampler stops at its byte cap, so a body that is still open 3s later
  // must not hold the record open with it.
  test('completes the record once the sample cap is reached, without waiting for the body to end', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const startedAt = Date.now();
      const res = await fetch('/test/dyn/slow?head=65536&delayMs=3000'); // 64 KiB now, rest in 3s
      await window.testHelpers.waitFor(() => {
        const r = window.__webrtcInspector.getSnapshot().httpRequests.find((x) => x.url.includes('/test/dyn/slow'));
        return r && r.state === 'complete';
      }, 2500, 20);
      const completedAfterMs = Date.now() - startedAt;
      const record = window.__webrtcInspector.getSnapshot().httpRequests.find((x) => x.url.includes('/test/dyn/slow'));
      res.body.cancel();
      return { completedAfterMs, state: record.state, preview: record.responsePreview };
    });
    expect(result.state).toBe('complete');
    expect(result.completedAfterMs).toBeLessThan(2500); // body ends at 3000ms
    expect(result.preview.length).toBeLessThanOrEqual(256); // 64 KiB in, 200 chars kept
  });

  // A body that stalls below the cap can't settle on bytes, so the watchdog has
  // to close the record instead. It keeps whatever arrived first.
  test('completes the record via the sampling watchdog when a body stalls under the cap', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const startedAt = Date.now();
      const res = await fetch('/test/dyn/slow?head=64&delayMs=8000'); // 64 bytes, then a long stall
      await window.testHelpers.waitFor(() => {
        const r = window.__webrtcInspector.getSnapshot().httpRequests.find((x) => x.url.includes('delayMs=8000'));
        return r && r.state === 'complete';
      }, 4000, 20);
      const completedAfterMs = Date.now() - startedAt;
      const record = window.__webrtcInspector.getSnapshot().httpRequests.find((x) => x.url.includes('delayMs=8000'));
      res.body.cancel();
      return { completedAfterMs, state: record.state, preview: record.responsePreview };
    });
    expect(result.state).toBe('complete');
    expect(result.completedAfterMs).toBeLessThan(4000); // body would end at 8000ms
    expect(result.preview).toBe('a'.repeat(64));
  });

  test('leaves the full response body readable by the app after sampling it', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const res = await fetch('/test/dyn/bulk?mb=2&tag=readable');
      const text = await res.text();
      await window.testHelpers.waitFor(() => {
        const r = window.__webrtcInspector.getSnapshot().httpRequests.find((x) => x.url.includes('tag=readable'));
        return r && r.state === 'complete';
      }, 3000);
      const record = window.__webrtcInspector.getSnapshot().httpRequests.find((x) => x.url.includes('tag=readable'));
      return { length: text.length, allA: /^a+$/.test(text), preview: record.responsePreview };
    });
    expect(result.length).toBe(2 * 1024 * 1024);
    expect(result.allA).toBe(true);
    expect(result.preview.length).toBeLessThanOrEqual(256); // truncated preview, not the whole body
  });
});
