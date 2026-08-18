// Resolves the page an MCP tool call should act on. Two modes:
//
// - Attach: connect to an already-running Chromium over CDP and locate the
//   page that has webrtc-inspector's init script loaded. Mirrors how
//   chrome-devtools-mcp attaches to a real browser rather than launching its
//   own — unchanged from before #78, and still wins whenever the endpoint is
//   reachable.
// - Self-launch (#78): when connectOverCDP itself fails for any reason (no
//   process listening, wrong port, etc.), launch our own Chromium with
//   core/webrtc-inspector.js wired in via context.addInitScript() so every
//   page it opens is pre-instrumented before that page's own scripts run —
//   the same timing guarantee the README promises Playwright users. This
//   lets an agent go from "nothing running" to "inspecting a session" with
//   no human having started Chrome first.
//
// A *reachable* endpoint with no instrumented page is a different, narrower
// error (wrong page/profile) and intentionally does not fall back — only a
// failed connectOverCDP does.
const path = require('path');
const { chromium } = require('playwright-core');

const INSPECTOR_SCRIPT_PATH = path.join(__dirname, '..', 'extension', 'core', 'webrtc-inspector.js');

let cachedBrowser = null;
let cachedEndpoint = null;
let selfLaunched = false;
let selfLaunchedPage = null;
let exitCleanupRegistered = false;

const initScriptAppliedContexts = new WeakSet();

async function ensureInspectorInitScript(context) {
  if (initScriptAppliedContexts.has(context)) return;
  await context.addInitScript({ path: INSPECTOR_SCRIPT_PATH });
  initScriptAppliedContexts.add(context);
}

function registerExitCleanup() {
  if (exitCleanupRegistered) return;
  exitCleanupRegistered = true;
  // Only ever closes a browser *we* launched — an attached browser is the
  // user's own Chrome and this process has no business killing it.
  const closeSelfLaunched = () => {
    if (selfLaunched && cachedBrowser) {
      try {
        cachedBrowser.close();
      } catch {
        // best-effort — process is exiting either way
      }
    }
  };
  process.on('exit', closeSelfLaunched);
  process.on('SIGINT', () => {
    closeSelfLaunched();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    closeSelfLaunched();
    process.exit(0);
  });
}

async function findInspectedPage(browser) {
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      const hasInspector = await page.evaluate(() => !!window.__webrtcInspector).catch(() => false);
      if (hasInspector) return page;
    }
  }
  return null;
}

async function ensureSelfLaunched() {
  if (selfLaunched && cachedBrowser && cachedBrowser.isConnected()) return selfLaunchedPage;
  // Headed by default so a human on the same machine can watch (mirrors why
  // the extension path exists); WRTC_HEADLESS=true for CI/headless use.
  const headless = process.env.WRTC_HEADLESS === 'true';
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  await ensureInspectorInitScript(context);
  const page = await context.newPage();
  cachedBrowser = browser;
  cachedEndpoint = null;
  selfLaunched = true;
  selfLaunchedPage = page;
  registerExitCleanup();
  console.error(`webrtc-inspector: no reachable CDP endpoint — launched its own ${headless ? 'headless' : 'headed'} Chromium.`);
  return page;
}

async function attachedBrowser(cdpEndpoint) {
  if (cachedBrowser && !selfLaunched && cachedEndpoint === cdpEndpoint && cachedBrowser.isConnected()) {
    return cachedBrowser;
  }
  const browser = await chromium.connectOverCDP(cdpEndpoint);
  cachedBrowser = browser;
  cachedEndpoint = cdpEndpoint;
  selfLaunched = false;
  console.error(`webrtc-inspector: attached to Chromium at ${cdpEndpoint}.`);
  return browser;
}

async function getPage(cdpEndpoint) {
  if (selfLaunched && cachedBrowser && cachedBrowser.isConnected()) return selfLaunchedPage;
  let browser;
  try {
    browser = await attachedBrowser(cdpEndpoint);
  } catch {
    return ensureSelfLaunched();
  }
  const page = await findInspectedPage(browser);
  if (!page) {
    throw new Error(
      `No page with window.__webrtcInspector found at ${cdpEndpoint}. ` +
        'Load core/webrtc-inspector.js on the target page before calling wrtc_ tools, or call wrtc_navigate(url) to open one.'
    );
  }
  return page;
}

// Unlike getPage(), never throws "no instrumented page found" — creates and
// pre-instruments one instead. Powers wrtc_navigate so an agent can point
// the self-launched or attached browser at a target page with no other tool.
async function navigate(cdpEndpoint, url) {
  if (selfLaunched && cachedBrowser && cachedBrowser.isConnected()) {
    await selfLaunchedPage.goto(url);
    return selfLaunchedPage;
  }
  let browser;
  try {
    browser = await attachedBrowser(cdpEndpoint);
  } catch {
    const page = await ensureSelfLaunched();
    await page.goto(url);
    return page;
  }
  const existing = await findInspectedPage(browser);
  if (existing) {
    await existing.goto(url);
    return existing;
  }
  const context = browser.contexts()[0] || (await browser.newContext());
  await ensureInspectorInitScript(context);
  const page = context.pages()[0] || (await context.newPage());
  await page.goto(url);
  return page;
}

module.exports = { getPage, navigate };
