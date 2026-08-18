// Pure unit tests for extension/panel-sparkline.js (see #19) — no browser
// needed, this is plain Node-side logic shared between the DevTools panel
// (loaded as a global via <script>) and these tests (via require()).
const { test, expect } = require('@playwright/test');
const {
  SPARKLINE_MAX_SAMPLES,
  extractMetricsFromStats,
  pushSample,
  updateSparklineHistory,
  sparklinePoints,
} = require('../../extension/panel-sparkline.js');

test.describe('panel-sparkline: extractMetricsFromStats()', () => {
  test('computes bitrate from a bytesSent delta over elapsed time', () => {
    const reports = [{ type: 'outbound-rtp', bytesSent: 2000 }];
    const { metrics, counters } = extractMetricsFromStats(reports, 2000, { bytesSent: 1000, ts: 1000 });
    expect(metrics.bitrateKbps).toBeCloseTo((1000 * 8) / 1000, 5);
    expect(counters).toEqual({ bytesSent: 2000, ts: 2000 });
  });

  test('has no bitrate on the first sample (no previous counters yet)', () => {
    const reports = [{ type: 'outbound-rtp', bytesSent: 1000 }];
    const { metrics } = extractMetricsFromStats(reports, 1000, { bytesSent: null, ts: null });
    expect(metrics.bitrateKbps).toBeNull();
  });

  test('guards against a counter reset (encoder reinit) instead of charting a negative delta', () => {
    const reports = [{ type: 'outbound-rtp', bytesSent: 50 }];
    const { metrics } = extractMetricsFromStats(reports, 2000, { bytesSent: 5000, ts: 1000 });
    expect(metrics.bitrateKbps).toBeNull();
  });

  test('reads RTT in ms from the selected candidate pair (seconds -> ms)', () => {
    const reports = [{ type: 'candidate-pair', nominated: true, state: 'succeeded', currentRoundTripTime: 0.045 }];
    const { metrics } = extractMetricsFromStats(reports, 1000, { bytesSent: null, ts: null });
    expect(metrics.rttMs).toBeCloseTo(45, 5);
  });

  test('reads jitter in ms from inbound-rtp (seconds -> ms)', () => {
    const reports = [{ type: 'inbound-rtp', jitter: 0.012 }];
    const { metrics } = extractMetricsFromStats(reports, 1000, { bytesSent: null, ts: null });
    expect(metrics.jitterMs).toBeCloseTo(12, 5);
  });

  test('prefers remote-inbound-rtp.fractionLost for loss percentage when present', () => {
    const reports = [
      { type: 'inbound-rtp', packetsLost: 999, packetsReceived: 1 },
      { type: 'remote-inbound-rtp', fractionLost: 0.02 },
    ];
    const { metrics } = extractMetricsFromStats(reports, 1000, { bytesSent: null, ts: null });
    expect(metrics.lossPct).toBeCloseTo(2, 5);
  });

  test('falls back to inbound-rtp packetsLost/packetsReceived ratio when no remote-inbound-rtp', () => {
    const reports = [{ type: 'inbound-rtp', packetsLost: 5, packetsReceived: 95 }];
    const { metrics } = extractMetricsFromStats(reports, 1000, { bytesSent: null, ts: null });
    expect(metrics.lossPct).toBeCloseTo(5, 5);
  });

  test('all metrics are null when no correlating report is present', () => {
    const { metrics } = extractMetricsFromStats([], 1000, { bytesSent: null, ts: null });
    expect(metrics).toEqual({ bitrateKbps: null, rttMs: null, jitterMs: null, lossPct: null });
  });
});

test.describe('panel-sparkline: pushSample() / updateSparklineHistory()', () => {
  test('pushSample caps the series at SPARKLINE_MAX_SAMPLES, dropping the oldest', () => {
    const series = {};
    for (let i = 0; i < SPARKLINE_MAX_SAMPLES + 5; i++) pushSample(series, 'rttMs', i, i);
    expect(series.rttMs).toHaveLength(SPARKLINE_MAX_SAMPLES);
    expect(series.rttMs[0].ts).toBe(5);
    expect(series.rttMs[series.rttMs.length - 1].ts).toBe(SPARKLINE_MAX_SAMPLES + 4);
  });

  test('updateSparklineHistory accumulates a rolling bitrate series across polls for one connection', () => {
    const history = new Map();
    updateSparklineHistory(history, 1, [{ type: 'outbound-rtp', bytesSent: 1000 }], 1000);
    const series = updateSparklineHistory(history, 1, [{ type: 'outbound-rtp', bytesSent: 3000 }], 2000);
    expect(series.bitrateKbps).toHaveLength(2);
    expect(series.bitrateKbps[0].value).toBeNull();
    expect(series.bitrateKbps[1].value).toBeCloseTo((2000 * 8) / 1000, 5);
  });

  test('tracks separate connections independently', () => {
    const history = new Map();
    updateSparklineHistory(history, 1, [{ type: 'inbound-rtp', jitter: 0.01 }], 1000);
    updateSparklineHistory(history, 2, [{ type: 'inbound-rtp', jitter: 0.02 }], 1000);
    expect(history.get(1).series.jitterMs[0].value).toBeCloseTo(10, 5);
    expect(history.get(2).series.jitterMs[0].value).toBeCloseTo(20, 5);
  });
});

test.describe('panel-sparkline: sparklinePoints()', () => {
  test('returns empty string when there are no numeric samples', () => {
    expect(sparklinePoints([{ ts: 1, value: null }], 80, 24)).toBe('');
    expect(sparklinePoints([], 80, 24)).toBe('');
  });

  test('places a single sample at x=0 (normalized against a zero baseline)', () => {
    const points = sparklinePoints([{ ts: 1, value: 5 }], 80, 24);
    expect(points).toBe('0.0,0.0');
  });

  test('spans multiple samples from x=0 to x=width', () => {
    const points = sparklinePoints([{ ts: 1, value: 1 }, { ts: 2, value: 2 }, { ts: 3, value: 3 }], 80, 24);
    const coords = points.split(' ').map((p) => p.split(',').map(Number));
    expect(coords[0][0]).toBe(0);
    expect(coords[coords.length - 1][0]).toBe(80);
  });

  test('skips null samples but keeps numeric ones in order', () => {
    const points = sparklinePoints([{ ts: 1, value: 1 }, { ts: 2, value: null }, { ts: 3, value: 3 }], 80, 24);
    expect(points.split(' ')).toHaveLength(2);
  });
});
