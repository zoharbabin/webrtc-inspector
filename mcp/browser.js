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
let lastAttachAttemptTs = 0;

// Once self-launched (no reachable CDP endpoint at the time), a stale cache
// used to stick forever — even after the user started Chrome with the right
// --remote-debugging-port a moment later, every tool call kept silently
// talking to the throwaway browser. Re-probe the real endpoint at most this
// often so a transient failure can heal without paying a connectOverCDP
// round trip on every single call. Overridable for tests.
const ATTACH_RETRY_INTERVAL_MS = Number(process.env.WRTC_ATTACH_RETRY_MS) || 10000;

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

// All instrumented pages across every context, not just the first — lets
// getPage()/navigate() detect and refuse to guess when more than one exists,
// instead of silently acting on whichever page happened to be first.
async function findAllInspectedPages(browser) {
  const found = [];
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      const hasInspector = await page.evaluate(() => !!window.__webrtcInspector).catch(() => false);
      if (hasInspector) found.push({ page, url: page.url() });
    }
  }
  return found;
}

function ambiguousPageError(pages, pageUrl) {
  const urls = pages.map((p) => p.url).join(', ');
  if (pageUrl) {
    return new Error(
      `pageUrl "${pageUrl}" matched ${pages.length} instrumented pages (${urls}) — pass a more specific pageUrl.`
    );
  }
  return new Error(
    `${pages.length} instrumented pages found (${urls}) — pass pageUrl (an exact URL, or a distinguishing ` +
      'substring of one) to any wrtc_ tool to say which one to act on.'
  );
}

// Resolves one page out of every instrumented page in browser. pageUrl is
// optional: omit it only when exactly one instrumented page exists — with
// more than one, omitting it is a hard error rather than a silent guess,
// since guessing wrong here means acting on the wrong live connection while
// still reporting success.
async function resolveInspectedPage(browser, pageUrl) {
  const pages = await findAllInspectedPages(browser);
  if (pages.length === 0) return null;
  if (!pageUrl) {
    if (pages.length === 1) return pages[0].page;
    throw ambiguousPageError(pages);
  }
  const exact = pages.filter((p) => p.url === pageUrl);
  const matches = exact.length ? exact : pages.filter((p) => p.url.includes(pageUrl));
  if (matches.length === 0) {
    throw new Error(
      `pageUrl "${pageUrl}" matched no instrumented page. Instrumented pages: ${pages.map((p) => p.url).join(', ')}`
    );
  }
  if (matches.length > 1) throw ambiguousPageError(matches, pageUrl);
  return matches[0].page;
}

async function firstAnyPage(browser) {
  for (const context of browser.contexts()) {
    const pages = context.pages();
    if (pages.length) return pages[0];
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

// Throttled re-probe of the real CDP endpoint while stuck on a self-launched
// fallback browser. Returns true once the real endpoint is reachable again
// (and closes the throwaway browser); false if it's still unreachable, or if
// the retry interval hasn't elapsed since the last attempt.
async function maybeReattach(cdpEndpoint) {
  const now = Date.now();
  if (now - lastAttachAttemptTs < ATTACH_RETRY_INTERVAL_MS) return false;
  lastAttachAttemptTs = now;
  const staleBrowser = cachedBrowser;
  try {
    await attachedBrowser(cdpEndpoint); // on success, sets cachedBrowser/selfLaunched=false
  } catch {
    return false;
  }
  if (staleBrowser) {
    try {
      await staleBrowser.close();
    } catch {
      // best-effort — we've already switched over
    }
  }
  selfLaunchedPage = null;
  console.error(`webrtc-inspector: ${cdpEndpoint} is reachable again — switched back from self-launched Chromium.`);
  return true;
}

async function getPage(cdpEndpoint, pageUrl) {
  if (selfLaunched && cachedBrowser && cachedBrowser.isConnected()) {
    const reattached = await maybeReattach(cdpEndpoint);
    if (!reattached) return selfLaunchedPage;
  }
  let browser;
  try {
    browser = await attachedBrowser(cdpEndpoint);
  } catch {
    return ensureSelfLaunched();
  }
  // addInitScript only re-applies while this process's CDP connection stays
  // live (it's not stored durably on the browser) — re-arm it on every call
  // so a dropped-and-reconnected connection doesn't silently stop
  // instrumenting pages another MCP (e.g. Playwright) creates afterward.
  const context = browser.contexts()[0];
  if (context) await ensureInspectorInitScript(context);
  const page = await resolveInspectedPage(browser, pageUrl);
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
async function navigate(cdpEndpoint, url, pageUrl) {
  if (selfLaunched && cachedBrowser && cachedBrowser.isConnected()) {
    const reattached = await maybeReattach(cdpEndpoint);
    if (!reattached) {
      await selfLaunchedPage.goto(url);
      return selfLaunchedPage;
    }
  }
  let browser;
  try {
    browser = await attachedBrowser(cdpEndpoint);
  } catch {
    const page = await ensureSelfLaunched();
    await page.goto(url);
    return page;
  }
  // Ambiguous only matters when there's more than one instrumented page
  // already to choose from — resolveInspectedPage() throws in that case
  // instead of silently navigating whichever one was found first away from
  // whatever session it was tracking.
  const existing = await resolveInspectedPage(browser, pageUrl);
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

const DISCONNECTED_STATUS_FIELDS = { pageFound: false, pageUrl: null, inspectorLoaded: false, inspectorVersion: null };

async function inspectPage(page) {
  if (!page) return { ...DISCONNECTED_STATUS_FIELDS };
  const pageUrl = page.url();
  const inspector = await page
    .evaluate(() => {
      const insp = window.__webrtcInspector;
      return insp ? { loaded: true, version: insp.version || null } : { loaded: false, version: null };
    })
    .catch(() => ({ loaded: false, version: null }));
  return { pageFound: true, pageUrl, inspectorLoaded: inspector.loaded, inspectorVersion: inspector.version };
}

// #79 — sanity-check tool meant to be an agent's first call. Reuses getPage's
// connect logic (attach, reporting the self-launch case if one already
// happened) but never falls back to launching a browser itself, and never
// throws: a totally unreachable endpoint is just mode: 'disconnected', not
// an error, so callers don't need a try/catch around this one.
async function getStatus(cdpEndpoint) {
  try {
    if (selfLaunched && cachedBrowser && cachedBrowser.isConnected()) {
      const reattached = await maybeReattach(cdpEndpoint);
      if (!reattached) {
        return { cdpEndpoint, mode: 'self-launched', ...(await inspectPage(selfLaunchedPage)) };
      }
    }
    let browser;
    try {
      browser = await attachedBrowser(cdpEndpoint);
    } catch {
      return { cdpEndpoint, mode: 'disconnected', ...DISCONNECTED_STATUS_FIELDS };
    }
    const context = browser.contexts()[0];
    if (context) await ensureInspectorInitScript(context);
    const page = (await findInspectedPage(browser)) || (await firstAnyPage(browser));
    return { cdpEndpoint, mode: 'attached', ...(await inspectPage(page)) };
  } catch {
    return { cdpEndpoint, mode: 'disconnected', ...DISCONNECTED_STATUS_FIELDS };
  }
}

module.exports = { getPage, navigate, getStatus };
