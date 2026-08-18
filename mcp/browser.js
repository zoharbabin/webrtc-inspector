// Connects to an already-running Chromium instance over CDP and locates the
// page that has webrtc-inspector's init script loaded. Mirrors how
// chrome-devtools-mcp attaches to a real browser rather than launching its own.
const { chromium } = require('playwright-core');

let cachedBrowser = null;
let cachedEndpoint = null;

async function findInspectedPage(browser) {
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      const hasInspector = await page.evaluate(() => !!window.__webrtcInspector).catch(() => false);
      if (hasInspector) return page;
    }
  }
  return null;
}

async function getPage(cdpEndpoint) {
  if (cachedBrowser && cachedEndpoint === cdpEndpoint && cachedBrowser.isConnected()) {
    const page = await findInspectedPage(cachedBrowser);
    if (page) return page;
  }
  const browser = await chromium.connectOverCDP(cdpEndpoint);
  cachedBrowser = browser;
  cachedEndpoint = cdpEndpoint;
  const page = await findInspectedPage(browser);
  if (!page) {
    throw new Error(
      `No page with window.__webrtcInspector found at ${cdpEndpoint}. ` +
        'Load core/webrtc-inspector.js on the target page before calling wrtc_ tools.'
    );
  }
  return page;
}

module.exports = { getPage };
