const { test, expect } = require('@playwright/test');
const { compileScenario, runCompiledScenario, splitClauses, parseDurationMs, parseTargets } = require('../../extension/scenario-compiler.js');

// Natural-language-to-fault-injection compiler (#26) — plain Node-executed,
// no browser needed (mirrors metrics-exporter.spec.js). compileScenario is
// pure; runCompiledScenario is exercised against a fake api object standing
// in for window.__webrtcInspector.

test.describe('splitClauses()', () => {
  test('splits on "then" and ";" but not on decimal points inside durations', () => {
    expect(splitClauses('drop packets for 2.5s then kill the connection')).toEqual([
      'drop packets for 2.5s',
      'kill the connection',
    ]);
    expect(splitClauses('kill the connection; restart ice')).toEqual(['kill the connection', 'restart ice']);
  });
});

test.describe('parseDurationMs() / parseTargets()', () => {
  test('parses seconds and milliseconds into ms', () => {
    expect(parseDurationMs('for 5s')).toBe(5000);
    expect(parseDurationMs('for 200ms')).toBe(200);
    expect(parseDurationMs('for 2.5 seconds')).toBe(2500);
    expect(parseDurationMs('no duration here')).toBeNull();
  });

  test('infers targets from keywords, defaulting to websocket+datachannel', () => {
    expect(parseTargets('drop the data channel for 5s')).toEqual(['datachannel']);
    expect(parseTargets('drop http requests for 5s')).toEqual(['http']);
    expect(parseTargets('simulate the connection dropping for 5s')).toEqual(['websocket', 'datachannel']);
  });
});

test.describe('compileScenario()', () => {
  test('compiles a plain duration clause to simulateNetworkLoss with default targets', () => {
    const compiled = compileScenario('simulate the connection dropping for 5s');
    expect(compiled.warnings).toEqual([]);
    expect(compiled.steps).toEqual([
      { primitive: 'simulateNetworkLoss', args: [5000, { targets: ['websocket', 'datachannel'] }] },
    ]);
  });

  test('compiles a targeted duration clause', () => {
    const compiled = compileScenario('drop media packets for 200ms');
    expect(compiled.steps).toEqual([
      { primitive: 'simulateNetworkLoss', args: [200, { targets: ['media'] }] },
    ]);
  });

  test('compiles a named preset', () => {
    expect(compileScenario('simulate a 4g train scenario').steps).toEqual([
      { primitive: 'simulateNetworkPreset', args: ['4g-train'] },
    ]);
    expect(compileScenario('switch to home wifi').steps).toEqual([
      { primitive: 'simulateNetworkPreset', args: ['home-wifi'] },
    ]);
  });

  test('compiles kill/restart-ice with the given connectionId, warning when none is given', () => {
    expect(compileScenario('kill the connection', { connectionId: 7 })).toEqual({
      steps: [{ primitive: 'killConnection', args: [7] }],
      warnings: [],
    });
    const noCtx = compileScenario('restart ice on the connection');
    expect(noCtx.steps).toEqual([{ primitive: 'restartIce', args: [null] }]);
    expect(noCtx.warnings[0]).toMatch(/no connectionId/);
  });

  test('compiles a compound "then" scenario into an ordered step sequence', () => {
    const compiled = compileScenario('drop packets for 3s then kill the connection', { connectionId: 1 });
    expect(compiled.steps).toEqual([
      { primitive: 'simulateNetworkLoss', args: [3000, { targets: ['media'] }] },
      { primitive: 'killConnection', args: [1] },
    ]);
  });

  test('an unparseable clause produces a warning and no step', () => {
    const compiled = compileScenario('do something vague');
    expect(compiled.steps).toEqual([]);
    expect(compiled.warnings[0]).toMatch(/Could not compile clause/);
  });
});

test.describe('runCompiledScenario()', () => {
  test('invokes each step\'s primitive on the api, in order, with the compiled args', async () => {
    const calls = [];
    const api = {
      simulateNetworkLoss: (...args) => { calls.push(['simulateNetworkLoss', args]); return { stop: () => {}, done: Promise.resolve() }; },
      killConnection: (...args) => { calls.push(['killConnection', args]); return Promise.resolve(); },
    };
    const compiled = compileScenario('drop packets for 3s then kill the connection', { connectionId: 9 });
    const { results } = await runCompiledScenario(compiled, api);
    expect(calls).toEqual([
      ['simulateNetworkLoss', [3000, { targets: ['media'] }]],
      ['killConnection', [9]],
    ]);
    expect(results).toHaveLength(2);
    expect(results.every((r) => !r.error)).toBe(true);
  });

  test('awaits a {done} promise before starting the next step', async () => {
    const order = [];
    let resolveDone;
    const api = {
      simulateNetworkLoss: () => {
        order.push('loss-start');
        return { stop: () => {}, done: new Promise((r) => { resolveDone = r; }) };
      },
      killConnection: () => { order.push('kill'); return Promise.resolve(); },
    };
    const compiled = compileScenario('drop packets for 1s then kill the connection', { connectionId: 1 });
    const runPromise = runCompiledScenario(compiled, api);
    await new Promise((r) => setTimeout(r, 5));
    expect(order).toEqual(['loss-start']);
    resolveDone();
    await runPromise;
    expect(order).toEqual(['loss-start', 'kill']);
  });

  test('a missing primitive on the api is recorded as an error, not thrown', async () => {
    const api = {};
    const compiled = compileScenario('kill the connection', { connectionId: 1 });
    const { results } = await runCompiledScenario(compiled, api);
    expect(results[0].error).toMatch(/killConnection is not a function/);
  });

  test('a primitive that throws is recorded as an error, not thrown', async () => {
    const api = { killConnection: () => { throw new Error('boom'); } };
    const compiled = compileScenario('kill the connection', { connectionId: 1 });
    const { results } = await runCompiledScenario(compiled, api);
    expect(results[0].error).toBe('boom');
  });

  test('opts.bundle attaches api.exportBundle()\'s return value', async () => {
    const api = {
      killConnection: () => Promise.resolve(),
      exportBundle: () => ({ scenario: 'ok' }),
    };
    const compiled = compileScenario('kill the connection', { connectionId: 1 });
    const { bundle } = await runCompiledScenario(compiled, api, { bundle: true });
    expect(bundle).toEqual({ scenario: 'ok' });
  });
});
