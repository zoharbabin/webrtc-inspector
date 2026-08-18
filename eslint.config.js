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
      },
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
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
