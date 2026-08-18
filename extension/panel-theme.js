// #30 — pure mapping from chrome.devtools.panels.themeName to this panel's
// data-theme attribute value. Extracted from panel.js so it's testable
// without a chrome.devtools mock (mirrors panel-sparkline.js/
// panel-clipboard.js/panel-timeline.js). Today's Chrome values are 'dark'
// or 'default' (light); anything else — an unknown/future theme name, or
// themeName being unset before the API is ready — falls back to 'dark',
// this project's original look.
function resolveTheme(themeName) {
  return themeName === 'default' ? 'default' : 'dark';
}

if (typeof module !== 'undefined') module.exports = { resolveTheme };
