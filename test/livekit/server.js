// Spawns a real `livekit-server --dev` for the LiveKit E2E suite. See
// ~/Downloads/webrtc-inspector-livekit-e2e-plan.md section 6.
//
// Security posture (non-negotiable, see plan section 2):
//   - devkey/secret is LiveKit's own publicly documented --dev default
//     (docs.livekit.io/transport/self-hosting/local), NOT a leaked credential.
//   - HTTP/WS signaling is loopback-only via an explicit --bind 127.0.0.1
//     (not relying on --dev's default), so a future livekit-server version
//     can't silently widen it. Never pass --bind 0.0.0.0, never point at a
//     non-loopback instance, staging deployment, or LiveKit Cloud, never a
//     real API key.
//   - The media (RTC) UDP mux binds loopback explicitly via
//     rtc.enable_loopback_candidate: true (confirmed against LiveKit's real
//     source, github.com/livekit/mediatransportutil pkg/rtcconfig — this is
//     the one flag that both binds a UDP mux socket on 127.0.0.1/::1 AND
//     includes it in ICE host candidates; without it, verified live via
//     lsof that the UDP mux only binds real non-loopback interface
//     addresses, so no candidate pair can ever connect).
//   - rtc.stun_servers: [] disables LiveKit's --dev default STUN servers
//     (Twilio/Google). Without this, the server performs real outbound STUN
//     queries and reports the machine's actual public IP as a srflx ICE
//     candidate — a real leak for a suite that's supposed to be local-only,
//     confirmed live (the candidate literally carried our public IP).
//   - TURN is off unless explicitly enabled below, and allow_restricted_peer_cidrs
//     is required because LiveKit denies relay allocation to loopback peers by
//     default even once the TURN listener is up.
'use strict';

const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const dgram = require('node:dgram');
const { AccessToken } = require('livekit-server-sdk');

const LIVEKIT_URL = 'ws://127.0.0.1:7880';
const HTTP_URL = 'http://127.0.0.1:7880';
const API_KEY = 'devkey'; // LiveKit's public --dev default, not a secret
const API_SECRET = 'secret'; // LiveKit's public --dev default, not a secret
const TURN_UDP_PORT = 47882;
// livekit-server --dev's default RTC UDP mux port (not configured above, so
// it's whatever the binary defaults to). Confirmed live: back-to-back
// invocations intermittently fail here with "bind: address already in use"
// — the OS doesn't release this UDP socket the instant the previous
// livekit-server process exits, so the next spawn must wait it out rather
// than assume it's free.
const RTC_UDP_PORT = 7882;
// globalSetup owns the LiveKitDevServer instance in Playwright's root
// process; worker processes running spec files cannot reach it directly.
// server-outage-recovery.spec.js needs to kill/restart the real server from
// a worker, so global-setup.js exposes it over this loopback-only control
// endpoint instead.
const CONTROL_PORT = 7899;

const CONFIG_BODY = [
  'rtc:',
  '  enable_loopback_candidate: true',
  '  stun_servers: []',
  'turn:',
  '  enabled: true',
  `  udp_port: ${TURN_UDP_PORT}`,
  '  allow_restricted_peer_cidrs:',
  '    - "127.0.0.1/32"',
  '    - "::1/128"',
].join('\n');

function httpGet(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

// `proc` is passed in so an early exit (e.g. EADDRINUSE from the previous
// invocation's port not fully released yet — see start()'s retry loop below)
// fails fast with a clear cause instead of polling ECONNREFUSED for the
// entire timeout.
// Probes by actually trying to bind the port ourselves — a real signal the
// OS will release it in time, not a guessed sleep duration. Resolves once a
// bind attempt succeeds (immediately closing the probe socket); rejects if
// it's still in use after timeoutMs.
function waitForPortFree(proto, port, host, timeoutMs) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function attempt() {
      const sock = proto === 'udp' ? dgram.createSocket('udp4') : new net.Server();
      const onError = (err) => {
        sock.close();
        if (err.code === 'EADDRINUSE' && Date.now() - start < timeoutMs) {
          setTimeout(attempt, 200);
        } else {
          reject(err);
        }
      };
      sock.once('error', onError);
      if (proto === 'udp') {
        sock.bind(port, host, () => sock.close(resolve));
      } else {
        sock.listen(port, host, () => sock.close(resolve));
      }
    }
    attempt();
  });
}

async function waitForHealthy(proc, timeoutMs = 20000) {
  const start = Date.now();
  let lastErr = null;
  let exitedEarly = null;
  const onExit = (code, signal) => { exitedEarly = `code=${code} signal=${signal}`; };
  proc.once('exit', onExit);
  try {
    while (Date.now() - start < timeoutMs) {
      if (exitedEarly) throw new Error(`livekit-server process exited before becoming healthy (${exitedEarly})`);
      try {
        const status = await httpGet(HTTP_URL, 1000);
        if (status === 200) return;
      } catch (err) {
        lastErr = err;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`livekit-server did not become healthy within ${timeoutMs}ms: ${lastErr}`);
  } finally {
    proc.removeListener('exit', onExit);
  }
}

// Confirms the log line's own reported settings match what we asked for —
// catches a config typo/rename silently falling back to TURN-disabled, which
// a bare "server is listening" health check would miss entirely.
function turnStartedFromLogs(logLines) {
  return logLines.some((l) => l.includes('Starting TURN server') && l.includes(`"turn.portUDP": ${TURN_UDP_PORT}`));
}

class LiveKitDevServer {
  constructor() {
    this.proc = null;
    this.logLines = [];
    this.exited = false;
  }

  async spawnOnce() {
    // Wait for the OS to actually release last invocation's ports before
    // spawning, rather than assume any fixed delay is long enough.
    await Promise.all([
      waitForPortFree('tcp', 7880, '127.0.0.1', 15000),
      waitForPortFree('udp', RTC_UDP_PORT, '127.0.0.1', 15000),
    ]);

    this.exited = false;
    this.logLines = [];
    this.proc = spawn(
      'livekit-server',
      ['--dev', '--bind', '127.0.0.1', '--config-body', CONFIG_BODY],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    this.proc.on('exit', () => { this.exited = true; });
    const onData = (chunk) => {
      const text = chunk.toString('utf8');
      text.split('\n').filter(Boolean).forEach((line) => this.logLines.push(line));
    };
    this.proc.stdout.on('data', onData);
    this.proc.stderr.on('data', onData);

    try {
      await waitForHealthy(this.proc);
    } catch (err) {
      err.message += `\nlog tail:\n${this.logLines.slice(-20).join('\n')}`;
      throw err;
    }
    if (!turnStartedFromLogs(this.logLines)) {
      throw new Error(`TURN server did not report starting on port ${TURN_UDP_PORT}; log tail:\n${this.logLines.slice(-20).join('\n')}`);
    }
  }

  // Back-to-back invocations (this class is constructed fresh per Playwright
  // run in global-setup.js) can spawn before the OS has fully released the
  // previous process's port 7880 listener — reproduced live: the new
  // livekit-server exits immediately (EADDRINUSE), and waitForHealthy() would
  // otherwise poll ECONNREFUSED for the whole timeout with no useful error.
  // Retrying rides out that transient window instead of failing the run.
  async start(attempts = 3) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await this.spawnOnce();
        return;
      } catch (err) {
        if (this.proc && !this.exited) this.proc.kill('SIGKILL');
        if (attempt === attempts) throw err;
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
  }

  // SIGKILL, not a graceful stop — server-outage-recovery.spec.js needs an
  // actual crash, not a clean shutdown.
  kill() {
    if (this.proc && !this.exited) this.proc.kill('SIGKILL');
  }

  async stop() {
    if (!this.proc || this.exited) return;
    this.proc.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(() => { this.proc.kill('SIGKILL'); resolve(); }, 3000);
      this.proc.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }

  async restart() {
    this.kill();
    await new Promise((resolve) => {
      if (this.exited) return resolve();
      this.proc.once('exit', resolve);
    });
    await this.start();
  }

  mintToken(identity, roomName) {
    return mintToken(identity, roomName);
  }
}

// Pure local JWT signing (devkey/secret HMAC) — no network call to the
// server, so worker processes can mint their own tokens without sharing
// process state with whichever process called LiveKitDevServer.start().
async function mintToken(identity, roomName) {
  const at = new AccessToken(API_KEY, API_SECRET, { identity });
  at.addGrant({ room: roomName, roomJoin: true, canPublish: true, canSubscribe: true });
  return at.toJwt();
}

// Started once, in global-setup.js's root process, alongside the
// LiveKitDevServer it wraps. Loopback-only, same trust boundary as the
// LiveKit server itself (see the security posture note above).
function startControlServer(devServer) {
  const srv = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/kill') {
      devServer.kill();
      res.writeHead(200);
      res.end('ok');
      return;
    }
    if (req.method === 'POST' && req.url === '/restart') {
      devServer.restart().then(
        () => { res.writeHead(200); res.end('ok'); },
        (err) => { res.writeHead(500); res.end(String(err)); }
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => srv.listen(CONTROL_PORT, '127.0.0.1', () => resolve(srv)));
}

function controlRequest(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: CONTROL_PORT, path, method: 'POST' },
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }
    );
    req.on('error', reject);
    req.end();
  });
}

// Called from a Playwright worker process (a spec file), which cannot reach
// the LiveKitDevServer instance directly — see the CONTROL_PORT note above.
async function killServer() { return controlRequest('/kill'); }
async function restartServer() { return controlRequest('/restart'); }

module.exports = {
  LiveKitDevServer,
  mintToken,
  LIVEKIT_URL,
  HTTP_URL,
  TURN_UDP_PORT,
  startControlServer,
  killServer,
  restartServer,
};
