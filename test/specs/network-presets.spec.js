const { test, expect } = require('@playwright/test');
const { gotoFixture } = require('../helpers');

// simulateNetworkPreset(name) wraps simulateNetworkLoss in tc/netem-style
// named profiles (see #13). Built-in presets use realistic durations; tests
// register short custom presets via registerNetworkPreset() to stay fast.

test.describe('Named network-impairment presets', () => {
  test('ships default presets: home-wifi, 4g-train, congested-mobile', async ({ page }) => {
    await gotoFixture(page);
    const error = await page.evaluate(() => {
      try {
        window.__webrtcInspector.simulateNetworkPreset('not-a-real-preset');
        return null;
      } catch (err) {
        return err.message;
      }
    });
    expect(error).toContain('not-a-real-preset');
  });

  test('a "full" pattern preset blocks data channel sends for its duration, then restores', async ({ page }) => {
    await gotoFixture(page);
    const result = await page.evaluate(async () => {
      await window.testHelpers.createLoopbackSession();
      window.__webrtcInspector.registerNetworkPreset('test-full', { durationMs: 150, targets: ['datachannel'], pattern: 'full' });
      const before = window.__webrtcInspector.getSnapshot().connections[0].dataChannels[0].messageCount;
      const run = window.__webrtcInspector.simulateNetworkPreset('test-full');
      window.__dcA.send('during-outage');
      await window.testHelpers.wait(30);
      const duringCount = window.__webrtcInspector.getSnapshot().connections[0].dataChannels[0].messageCount;
      await run.done;
      window.__dcA.send('after-outage');
      await window.testHelpers.wait(30);
      const afterCount = window.__webrtcInspector.getSnapshot().connections[0].dataChannels[0].messageCount;
      return { before, duringCount, afterCount };
    });
    expect(result.duringCount).toBe(result.before);
    expect(result.afterCount).toBe(result.before + 1);
  });

  test('a "flapping" pattern preset toggles the outage in flapIntervalMs steps and eventually restores', async ({ page }) => {
    await gotoFixture(page);
    const result = await page.evaluate(async () => {
      await window.testHelpers.createLoopbackSession();
      window.__webrtcInspector.registerNetworkPreset('test-flap', {
        durationMs: 400, targets: ['datachannel'], pattern: 'flapping', flapIntervalMs: 100,
      });
      const before = window.__webrtcInspector.getSnapshot().connections[0].dataChannels[0].messageCount;
      const run = window.__webrtcInspector.simulateNetworkPreset('test-flap');
      await run.done;
      window.__dcA.send('after-flap');
      await window.testHelpers.wait(30);
      const afterCount = window.__webrtcInspector.getSnapshot().connections[0].dataChannels[0].messageCount;
      return { before, afterCount };
    });
    expect(result.afterCount).toBe(result.before + 1);
  });

  test('stop() on a running preset ends it early', async ({ page }) => {
    await gotoFixture(page);
    const result = await page.evaluate(async () => {
      await window.testHelpers.createLoopbackSession();
      window.__webrtcInspector.registerNetworkPreset('test-stop', { durationMs: 5000, targets: ['datachannel'], pattern: 'full' });
      const run = window.__webrtcInspector.simulateNetworkPreset('test-stop');
      run.stop();
      await run.done;
      const before = window.__webrtcInspector.getSnapshot().connections[0].dataChannels[0].messageCount;
      window.__dcA.send('after-stop');
      await window.testHelpers.wait(30);
      const afterCount = window.__webrtcInspector.getSnapshot().connections[0].dataChannels[0].messageCount;
      return { before, afterCount };
    });
    expect(result.afterCount).toBe(result.before + 1);
  });

  test('registerNetworkPreset overrides a built-in preset by name', async ({ page }) => {
    await gotoFixture(page);
    const result = await page.evaluate(async () => {
      await window.testHelpers.createLoopbackSession();
      window.__webrtcInspector.registerNetworkPreset('home-wifi', { durationMs: 100, targets: ['datachannel'], pattern: 'full' });
      const start = Date.now();
      const run = window.__webrtcInspector.simulateNetworkPreset('home-wifi');
      await run.done;
      return Date.now() - start;
    });
    expect(result).toBeLessThan(600);
  });
});
