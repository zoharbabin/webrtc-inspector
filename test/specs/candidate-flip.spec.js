const { test, expect } = require('@playwright/test');
const { gotoFixture } = require('../helpers');

// The loopback fixture has no real STUN/TURN infra, so a real srflx<->relay
// transition can't be produced end to end. Instead, getStats() is overridden
// on the live pc instance (shadowing the prototype method the core module
// calls internally) to feed synthetic candidate-pair/local-candidate reports
// into the existing 2s poll, exercising the real correlation + flip logic.

test.describe('TURN-relay candidate-flip detection', () => {
  test.beforeEach(async ({ page }) => {
    await gotoFixture(page);
    await page.evaluate(() => window.testHelpers.createLoopbackSession());
  });

  test('reflects the selected local candidate type with no flip yet', async ({ page }) => {
    const connectionIdA = await page.evaluate(() => {
      window.__pcA.getStats = async () => new Map([
        ['pair1', { id: 'pair1', type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'local1' }],
        ['local1', { id: 'local1', type: 'local-candidate', candidateType: 'srflx' }],
      ]);
      return window.__webrtcInspector.getSnapshot().connections[0].id;
    });
    await page.waitForFunction(
      (id) => window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === id).selectedCandidateType === 'srflx',
      connectionIdA,
      { timeout: 3000 }
    );
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    const recA = snap.connections.find((c) => c.id === connectionIdA);
    expect(recA.candidateTypeFlips).toHaveLength(0);
  });

  test('flags a flip from srflx to relay with a log event and snapshot entry', async ({ page }) => {
    const connectionIdA = await page.evaluate(async () => {
      window.__flipEvents = [];
      window.__webrtcInspector.onEvent((entry) => { if (entry.type === 'candidate-type-flip') window.__flipEvents.push(entry); });
      window.__pcA.getStats = async () => new Map([
        ['pair1', { id: 'pair1', type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'local1' }],
        ['local1', { id: 'local1', type: 'local-candidate', candidateType: 'srflx' }],
      ]);
      const id = window.__webrtcInspector.getSnapshot().connections[0].id;
      await window.testHelpers.waitFor(() => window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === id).selectedCandidateType === 'srflx');
      window.__pcA.getStats = async () => new Map([
        ['pair1', { id: 'pair1', type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'local2' }],
        ['local2', { id: 'local2', type: 'local-candidate', candidateType: 'relay' }],
      ]);
      return id;
    });
    await page.waitForFunction(
      (id) => window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === id).candidateTypeFlips.length >= 1,
      connectionIdA,
      { timeout: 3000 }
    );
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    const recA = snap.connections.find((c) => c.id === connectionIdA);
    expect(recA.selectedCandidateType).toBe('relay');
    expect(recA.candidateTypeFlips[0]).toMatchObject({ from: 'srflx', to: 'relay' });
    const flipEvents = await page.evaluate(() => window.__flipEvents);
    expect(flipEvents[0]).toMatchObject({ from: 'srflx', to: 'relay' });
  });

  test('does not flag the initial host -> srflx settling as a flip', async ({ page }) => {
    const connectionIdA = await page.evaluate(async () => {
      const id = window.__webrtcInspector.getSnapshot().connections[0].id;
      window.__pcA.getStats = async () => new Map([
        ['pair1', { id: 'pair1', type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'local1' }],
        ['local1', { id: 'local1', type: 'local-candidate', candidateType: 'host' }],
      ]);
      await window.testHelpers.waitFor(() => window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === id).selectedCandidateType === 'host');
      window.__pcA.getStats = async () => new Map([
        ['pair1', { id: 'pair1', type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'local2' }],
        ['local2', { id: 'local2', type: 'local-candidate', candidateType: 'srflx' }],
      ]);
      return id;
    });
    await page.waitForFunction(
      (id) => window.__webrtcInspector.getSnapshot().connections.find((c) => c.id === id).selectedCandidateType === 'srflx',
      connectionIdA,
      { timeout: 3000 }
    );
    const snap = await page.evaluate(() => window.__webrtcInspector.getSnapshot());
    const recA = snap.connections.find((c) => c.id === connectionIdA);
    expect(recA.candidateTypeFlips).toHaveLength(0);
  });
});
