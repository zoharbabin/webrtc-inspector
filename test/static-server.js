// Minimal static file server for Playwright's webServer — no signaling, no
// external deps, just serves the repo root so fixtures can load
// ../../extension/core/webrtc-inspector.js the same way the extension/README do.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const port = Number(process.env.PORT) || 8931;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };

// ---- test-only dynamic endpoints ----------------------------------------
// Three response shapes a static file can't produce, each pinning one property
// of the inspector's bounded response sampling:
//   /test/dyn/sse   open-ended text/event-stream — the record must still complete
//   /test/dyn/slow  a body that pauses mid-flight — the record must complete
//                   before the body does, not wait for the last byte
//   /test/dyn/bulk  a large body — the app must still read all of it, and the
//                   stored preview must stay short
function serveEventStream(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  let n = 0;
  const timer = setInterval(() => {
    res.write(`data: tick-${n++}\n\n`);
    if (n >= 50) { clearInterval(timer); res.end(); }
  }, 100);
  res.on('close', () => clearInterval(timer));
}

// Writes `head` bytes at once, stalls for `delayMs`, then ends. Chunked (no
// Content-Length), so nothing about the response says when it will finish.
function serveSlow(res, query) {
  const head = Number(query.get('head')) || 16 * 1024;
  const delayMs = Number(query.get('delayMs')) || 3000;
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.write(Buffer.alloc(head, 0x61));
  const timer = setTimeout(() => res.end('TAIL'), delayMs);
  res.on('close', () => clearTimeout(timer));
}

function serveBulk(res, query) {
  const totalBytes = (Number(query.get('mb')) || 24) * 1024 * 1024;
  const chunk = Buffer.alloc(1024 * 1024, 0x61); // 1 MiB of 'a'
  res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': String(totalBytes) });
  let written = 0;
  let closed = false;
  res.on('close', () => { closed = true; });
  (function pump() {
    while (!closed && written < totalBytes) {
      written += chunk.length;
      // write() returns false once the socket buffer is full: wait for 'drain'
      // instead of queueing the whole file in Node's memory.
      if (!res.write(chunk)) { res.once('drain', pump); return; }
    }
    if (!closed) res.end();
  }());
}

const server = http.createServer((req, res) => {
  const [rawPath, rawQuery] = req.url.split('?');
  const query = new URLSearchParams(rawQuery || '');
  if (rawPath === '/test/dyn/sse') { serveEventStream(res); return; }
  if (rawPath === '/test/dyn/slow') { serveSlow(res, query); return; }
  if (rawPath === '/test/dyn/bulk') { serveBulk(res, query); return; }

  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const filePath = path.join(root, urlPath);
  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`static server listening on http://127.0.0.1:${port}`);
});
