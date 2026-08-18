const { test, expect } = require('@playwright/test');

// Dockable/pop-out panel support (#35) — verifies panel.html's CSS doesn't
// force a horizontal scrollbar at Chrome DevTools' narrowest docked-right
// width (~300px) or leave dense tabular data (SDP/stats, long URLs)
// unreadable there, and still renders sanely undocked into a wide window.
//
// panel.js requires the real chrome.devtools.* extension APIs, unavailable
// to a plain page — this stubs just enough for it to load without
// throwing, then injects representative dense content (long codec/URL
// text, many timeline lanes) the same way live rendering would, since the
// real content only exists inside an actual WebRTC session.

const CHROME_STUB = `
  window.chrome = {
    devtools: {
      panels: { themeName: 'dark', onThemeChanged: { addListener: () => {} } },
      network: { onNavigated: { addListener: () => {} } },
      inspectedWindow: { eval: (expr, cb) => cb(null, false) },
    },
  };
`;

async function loadPanel(page) {
  await page.addInitScript(CHROME_STUB);
  await page.goto('/extension/panel.html');
}

async function injectDenseContent(page) {
  await page.evaluate(() => {
    // Deliberately no spaces/hyphens — a real long codec/candidate string
    // shouldn't overflow, but this also has no natural break opportunity,
    // so it only stays on-screen if the CSS actually wraps mid-word.
    const longCodecs = 'codecnamevariant'.repeat(20);
    const longUrl = `wss://${'unbreakablehostnamesegment'.repeat(15)}.example.com/socket`;
    document.getElementById('connections').innerHTML = `
      <div class="conn">
        <div class="row"><div><b>#1</b> <span class="badge connected">connected</span></div></div>
        <table>
          <tr><th>Local SDP</th><td>40 m-lines, codecs: ${longCodecs} <button class="copy-btn">Copy</button></td></tr>
          <tr><th>ICE candidates</th><td>local: host, srflx, relay / remote: host, srflx, relay</td></tr>
        </table>
      </div>`;
    document.getElementById('websockets').innerHTML = `
      <div class="conn"><div class="row"><div><b>ws#1</b> <span class="badge connected">open</span> ${longUrl}</div></div></div>`;
    document.getElementById('eventlog').innerHTML = Array.from({ length: 5 }, (_, i) => `
      <div class="log-row">message payload ${'x'.repeat(200)}-${i}</div>`).join('');
    document.getElementById('timeline').innerHTML = Array.from({ length: 4 }, (_, i) => `
      <div class="timeline-lane">
        <span class="timeline-label">conn-${i}</span>
        <div class="timeline-track"><span class="timeline-marker timeline-open" style="left: 10%"></span></div>
      </div>`).join('');
  });
}

function overflowsHorizontally(page) {
  return page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
}

test.describe('panel.html layout across dock widths', () => {
  test('docked-right minimum width (300px): no horizontal overflow with dense content', async ({ page }) => {
    await page.setViewportSize({ width: 300, height: 800 });
    await loadPanel(page);
    await injectDenseContent(page);
    expect(await overflowsHorizontally(page)).toBe(false);
  });

  test('undocked wide window (1400px): no horizontal overflow with dense content', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 800 });
    await loadPanel(page);
    await injectDenseContent(page);
    expect(await overflowsHorizontally(page)).toBe(false);
  });

  test('a two-column field (label + input) wraps instead of overflowing at 300px', async ({ page }) => {
    await page.setViewportSize({ width: 300, height: 800 });
    await loadPanel(page);
    const field = page.locator('#dcMessage').locator('xpath=..');
    const box = await field.boundingBox();
    expect(box.width).toBeLessThanOrEqual(300);
    expect(await overflowsHorizontally(page)).toBe(false);
  });

  test('loads without throwing given only a minimal chrome.devtools stub', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err));
    await loadPanel(page);
    await page.waitForTimeout(100);
    expect(errors).toEqual([]);
  });
});
