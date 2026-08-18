const { test, expect } = require('@playwright/test');
const {
  deriveConnectionMetrics,
  buildPrometheusExposition,
  buildOtlpPayload,
  startMetricsExporter,
} = require('../../extension/metrics-exporter.js');

// Optional Prometheus/OTel metrics export (#21) — plain Node-executed, no
// browser needed (mirrors panel-timeline.spec.js). Reuses panel-sparkline's
// already-tested extractMetricsFromStats, so these tests cover this file's
// own logic: metric assembly + both wire formats + the push loop.

function outboundReport(bytesSent) {
  return [{ type: 'outbound-rtp', bytesSent }];
}

test.describe('deriveConnectionMetrics()', () => {
  test('carries qualityScore through even with no latestStats', () => {
    const snapshot = { connections: [{ id: 1, qualityScore: 4.2, latestStats: null }] };
    const result = deriveConnectionMetrics(snapshot, new Map());
    expect(result).toEqual([{ connectionId: 1, qualityScore: 4.2, bitrateKbps: null, rttMs: null, jitterMs: null, lossPct: null }]);
  });

  test('derives bitrateKbps from a bytesSent delta across two ticks, tracked per connection', () => {
    const counters = new Map();
    deriveConnectionMetrics({ connections: [{ id: 1, qualityScore: 3, latestStats: { reports: outboundReport(0), ts: 1000 } }] }, counters);
    const second = deriveConnectionMetrics(
      { connections: [{ id: 1, qualityScore: 3, latestStats: { reports: outboundReport(12500), ts: 2000 } }] },
      counters
    );
    expect(second[0].bitrateKbps).toBeCloseTo(100, 5);
  });
});

test.describe('buildPrometheusExposition()', () => {
  test('emits a TYPE line and one sample line per metric with a real value', () => {
    const text = buildPrometheusExposition([{ connectionId: 1, qualityScore: 4.5, bitrateKbps: null, rttMs: 20, jitterMs: null, lossPct: 0 }]);
    expect(text).toContain('# TYPE webrtc_quality_score gauge');
    expect(text).toContain('webrtc_quality_score{connection_id="1"} 4.5');
    expect(text).toContain('webrtc_rtt_ms{connection_id="1"} 20');
    expect(text).toContain('webrtc_packet_loss_pct{connection_id="1"} 0');
    expect(text).not.toContain('webrtc_bitrate_kbps');
  });

  test('returns an empty string when nothing is measurable', () => {
    expect(buildPrometheusExposition([{ connectionId: 1, qualityScore: null, bitrateKbps: null, rttMs: null, jitterMs: null, lossPct: null }])).toBe('');
  });
});

test.describe('buildOtlpPayload()', () => {
  test('emits one gauge metric per measurable key, with connection_id as an attribute', () => {
    const payload = buildOtlpPayload([{ connectionId: 7, qualityScore: 5, bitrateKbps: null, rttMs: null, jitterMs: null, lossPct: null }], 1700000000000, { 'service.name': 'my-app' });
    const scopeMetrics = payload.resourceMetrics[0].scopeMetrics[0];
    expect(scopeMetrics.metrics.map((m) => m.name)).toEqual(['webrtc_quality_score']);
    const dp = scopeMetrics.metrics[0].gauge.dataPoints[0];
    expect(dp.asDouble).toBe(5);
    expect(dp.attributes).toEqual([{ key: 'connection_id', value: { stringValue: '7' } }]);
    expect(payload.resourceMetrics[0].resource.attributes).toEqual([{ key: 'service.name', value: { stringValue: 'my-app' } }]);
  });
});

test.describe('startMetricsExporter()', () => {
  test('throws synchronously without endpointUrl or a fetch implementation', () => {
    const api = { getSnapshot: () => ({ connections: [] }) };
    expect(() => startMetricsExporter(api, {})).toThrow(/endpointUrl/);
    expect(() => startMetricsExporter(api, { endpointUrl: 'http://x', fetchImpl: null })).toThrow(/fetch/);
  });

  test('pushes immediately (before the first interval tick) and again on each interval', async () => {
    const calls = [];
    const api = { getSnapshot: () => ({ connections: [{ id: 1, qualityScore: 4, latestStats: null }] }) };
    const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: true }; };
    const handle = startMetricsExporter(api, { endpointUrl: 'http://collector/metrics', intervalMs: 20, fetchImpl });
    await new Promise((r) => setTimeout(r, 5));
    expect(calls.length).toBe(1);
    await new Promise((r) => setTimeout(r, 40));
    handle.stop();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0].url).toBe('http://collector/metrics');
    expect(calls[0].init.body).toContain('webrtc_quality_score{connection_id="1"} 4');
  });

  test('a failed push is routed to onError instead of throwing / stopping the loop', async () => {
    const errors = [];
    const api = { getSnapshot: () => ({ connections: [] }) };
    const fetchImpl = async () => { throw new Error('collector unreachable'); };
    const handle = startMetricsExporter(api, {
      endpointUrl: 'http://collector/metrics', intervalMs: 10, fetchImpl, onError: (err) => errors.push(err),
    });
    await new Promise((r) => setTimeout(r, 15));
    handle.stop();
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].message).toBe('collector unreachable');
  });

  test('format: "otlp" sends a JSON body with the OTLP shape', async () => {
    const calls = [];
    const api = { getSnapshot: () => ({ connections: [{ id: 2, qualityScore: 3, latestStats: null }] }) };
    const fetchImpl = async (url, init) => { calls.push(init); return { ok: true }; };
    const handle = startMetricsExporter(api, { endpointUrl: 'http://collector/v1/metrics', intervalMs: 1000, format: 'otlp', fetchImpl });
    await new Promise((r) => setTimeout(r, 5));
    handle.stop();
    expect(calls[0].headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(calls[0].body).resourceMetrics[0].scopeMetrics[0].metrics[0].name).toBe('webrtc_quality_score');
  });
});
