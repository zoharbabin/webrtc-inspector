const js = require('@eslint/js');

module.exports = [
  js.configs.recommended,
  {
    files: ['extension/**/*.js'],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'script',
      globals: {
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        console: 'readonly',
        chrome: 'readonly',
        RTCPeerConnection: 'readonly',
        RTCDataChannel: 'readonly',
        RTCRtpSender: 'readonly',
        MediaStream: 'readonly',
        MediaStreamTrack: 'readonly',
        MessageEvent: 'readonly',
        CloseEvent: 'readonly',
        CustomEvent: 'readonly',
        Event: 'readonly',
        URL: 'readonly',
        WebSocket: 'readonly',
        AudioContext: 'readonly',
        webkitAudioContext: 'readonly',
        Blob: 'readonly',
        TransformStream: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        atob: 'readonly',
        Uint8Array: 'readonly',
        alert: 'readonly',
        module: 'readonly',
        location: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
    },
  },
  {
    // panel-sparkline.js/panel-clipboard.js/panel-timeline.js/panel-theme.js/
    // panel-preserve-log.js/panel-filter.js/panel-severity.js are loaded
    // before panel.js as plain <script>s, exposing these as globals in the
    // DevTools panel page.
    files: ['extension/panel.js'],
    languageOptions: {
      globals: {
        updateSparklineHistory: 'readonly',
        sparklinePoints: 'readonly',
        buildSdpClipboardPayload: 'readonly',
        buildClipboardJson: 'readonly',
        buildTimelineLanes: 'readonly',
        timelineOffsetPct: 'readonly',
        resolveTheme: 'readonly',
        bufferGeneration: 'readonly',
        mergeSnapshotForRender: 'readonly',
        parseFilterQuery: 'readonly',
        filterLogEntries: 'readonly',
        filterConnections: 'readonly',
        filterWebSockets: 'readonly',
        sortConnectionsBySeverity: 'readonly',
      },
    },
  },
  {
    // metrics-exporter.js require()s panel-sparkline.js's pure logic when
    // run in Node (tests); in a plain <script> browser context (no require),
    // it falls back to that file's already-global export instead.
    files: ['extension/metrics-exporter.js'],
    languageOptions: {
      globals: { require: 'readonly', fetch: 'readonly' },
    },
  },
  {
    // Spec files mix Node (test/expect, require) and browser (page.evaluate
    // callback bodies) globals in the same file — ESLint can't tell which
    // scope a given `window` reference is in, so both are allowed here.
    files: ['test/specs/**/*.js', 'test/helpers.js', 'playwright.config.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'readonly',
        process: 'readonly',
        __dirname: 'readonly',
        console: 'readonly',
        window: 'readonly',
        navigator: 'readonly',
        document: 'readonly',
        WebSocket: 'readonly',
        RTCPeerConnection: 'readonly',
        MediaStream: 'readonly',
        setTimeout: 'readonly',
        fetch: 'readonly',
        XMLHttpRequest: 'readonly',
        Event: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { caughtErrors: 'none' }],
    },
  },
  {
    files: ['test/static-server.js', 'test/report-summary.js'],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'commonjs',
      globals: { require: 'readonly', module: 'readonly', __dirname: 'readonly', console: 'readonly', process: 'readonly' },
    },
  },
  {
    // mcp/*.js mixes Node (require/module/process) and browser globals
    // (page.evaluate callback bodies run in the inspected page, not Node).
    files: ['mcp/**/*.js'],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'readonly',
        __dirname: 'readonly',
        console: 'readonly',
        process: 'readonly',
        window: 'readonly',
      },
    },
  },
  {
    files: ['test/fixtures/**/*.js'],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'script',
      globals: {
        window: 'readonly',
        RTCPeerConnection: 'readonly',
        setTimeout: 'readonly',
        EventTarget: 'readonly',
        Event: 'readonly',
        CloseEvent: 'readonly',
      },
    },
  },
  {
    // core/webrtc-inspector.js is a symlink to extension/core/webrtc-inspector.js
    // (see README) — lint the canonical file once, not twice under two paths.
    ignores: ['playwright-report/**', 'test-results/**', 'node_modules/**', 'core/**'],
  },
];
