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
});
