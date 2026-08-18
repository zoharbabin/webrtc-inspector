const { test, expect } = require('@playwright/test');
const { resolveTheme } = require('../../extension/panel-theme.js');

// DevTools theme sync (#30) — plain Node-executed, no browser needed
// (mirrors panel-timeline.spec.js). resolveTheme() is the pure mapping
// from chrome.devtools.panels.themeName to the panel's data-theme
// attribute value; panel.js wires it to the live API and CSS.

test.describe('resolveTheme()', () => {
  test('maps "default" (DevTools light theme) to "default"', () => {
    expect(resolveTheme('default')).toBe('default');
  });

  test('maps "dark" to "dark"', () => {
    expect(resolveTheme('dark')).toBe('dark');
  });

  test('falls back to "dark" for an unknown/future theme name', () => {
    expect(resolveTheme('some-future-theme')).toBe('dark');
  });

  test('falls back to "dark" when themeName is unset', () => {
    expect(resolveTheme(undefined)).toBe('dark');
    expect(resolveTheme(null)).toBe('dark');
  });
});
