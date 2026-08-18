// Minimal static file server for Playwright's webServer — no signaling, no
// external deps, just serves the repo root so fixtures can load
// ../../extension/core/webrtc-inspector.js the same way the extension/README do.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const port = Number(process.env.PORT) || 8931;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };

const server = http.createServer((req, res) => {
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
