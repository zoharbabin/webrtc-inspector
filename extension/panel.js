// DevTools panel UI: polls window.__webrtcInspector.getSnapshot() in the
// inspected page and renders it; wires the injection controls to the same
// public API via chrome.devtools.inspectedWindow.eval. All user-provided
// values are passed through JSON.stringify before being spliced into the
// eval string, so nothing here executes unescaped user input as code.

const POLL_MS = 1000;
let lastAudioB64 = null;
const sparklineHistoryByConnection = new Map(); // connectionId -> {series, counters}, see panel-sparkline.js

const SPARKLINE_METRICS = [
  { key: 'bitrateKbps', label: 'kbps', fmt: (v) => v.toFixed(0) },
  { key: 'rttMs', label: 'RTT ms', fmt: (v) => v.toFixed(0) },
  { key: 'jitterMs', label: 'jitter ms', fmt: (v) => v.toFixed(1) },
  { key: 'lossPct', label: 'loss %', fmt: (v) => v.toFixed(1) },
];
const SPARKLINE_W = 80;
const SPARKLINE_H = 24;

function renderSparklines(connectionId, latestStats) {
  if (!latestStats) return '';
  const series = updateSparklineHistory(sparklineHistoryByConnection, connectionId, latestStats.reports, latestStats.ts);
  return `<div class="sparklines">${SPARKLINE_METRICS.map(({ key, label, fmt }) => {
    const samples = series[key] || [];
    const last = [...samples].reverse().find((s) => typeof s.value === 'number');
    const points = sparklinePoints(samples, SPARKLINE_W, SPARKLINE_H);
    return `
      <div class="sparkline">
        <svg width="${SPARKLINE_W}" height="${SPARKLINE_H}">${points ? `<polyline points="${points}" fill="none" stroke="#4ec9b0" stroke-width="1"/>` : ''}</svg>
        <span class="label">${label}: ${last ? fmt(last.value) : '—'}</span>
      </div>`;
  }).join('')}</div>`;
}

function evalInPage(expr) {
  return new Promise((resolve, reject) => {
    chrome.devtools.inspectedWindow.eval(expr, (result, isException) => {
      if (isException) reject(isException);
      else resolve(result);
    });
  });
}

function badgeClass(state) {
  if (state === 'connected' || state === 'completed' || state === 'open') return 'connected';
  if (state === 'failed' || state === 'closed') return 'failed';
  return '';
}

function renderSnapshot(snap) {
  const el = document.getElementById('connections');
  const status = document.getElementById('status');
  if (!snap) {
    status.textContent = 'window.__webrtcInspector not found on this page (reload the tab after installing the extension)';
    el.innerHTML = '';
    return;
  }
  status.textContent = `${snap.connections.length} connection(s) · ${snap.webSockets.length} websocket(s) · fake mic ${snap.fakeMicActive ? 'armed' : 'not set'} · fake cam ${snap.fakeCamActive ? 'armed' : 'not set'} · dc interceptor ${snap.dataChannelInterceptorActive ? 'ON' : 'off'} · ws interceptor ${snap.webSocketInterceptorActive ? 'ON' : 'off'}`;

  el.innerHTML = snap.connections.map((c) => `
    <div class="conn ${c.closed ? 'closed' : ''}">
      <div class="row">
        <div><b>#${c.id}</b> <span class="badge ${badgeClass(c.state.connectionState)}">${c.state.connectionState}</span>
          <span class="badge ${badgeClass(c.state.iceConnectionState)}">ice: ${c.state.iceConnectionState}</span></div>
      </div>
      ${renderSparklines(c.id, c.latestStats)}
      <table>
        <tr><th>Local tracks</th><td>${c.localTracks.map((t) => `${t.kind}${t.sourceTag ? ` <span class="badge">${t.sourceTag}</span>` : ''}${t.status === 'ended' ? ` <span class="badge failed">ended</span>` : ''}`).join(', ') || '—'}</td></tr>
        <tr><th>Remote tracks</th><td>${c.remoteTracks.map((t) => `${t.kind}${typeof t.level === 'number' ? ` (level ${t.level.toFixed(2)})` : ''}`).join(', ') || '—'}</td></tr>
        <tr><th>Data channels</th><td>${c.dataChannels.map((d) => `${d.label} (${d.origin}, ${d.messageCount} msgs)`).join(', ') || '—'}</td></tr>
        <tr><th>Local SDP</th><td>${c.localSdpSummary ? `${c.localSdpSummary.mLines} m-lines, codecs: ${c.localSdpSummary.codecs.join(', ')}` : '—'}</td></tr>
        <tr><th>Remote SDP</th><td>${c.remoteSdpSummary ? `${c.remoteSdpSummary.mLines} m-lines, codecs: ${c.remoteSdpSummary.codecs.join(', ')}` : '—'}</td></tr>
        <tr><th>ICE candidates</th><td>local: ${c.localCandidateTypes.join(', ') || '—'} / remote: ${c.remoteCandidateTypes.join(', ') || '—'}</td></tr>
      </table>
    </div>
  `).join('') || '<i>no peer connections observed yet</i>';

  const wsEl = document.getElementById('websockets');
  wsEl.innerHTML = snap.webSockets.map((s) => `
    <div class="conn ${s.state === 'closed' ? 'closed' : ''}">
      <div class="row">
        <div><b>ws#${s.id}</b> <span class="badge ${badgeClass(s.state)}">${s.state}</span> ${s.url}</div>
      </div>
      <table>
        <tr><th>Sent / received</th><td>${s.sentCount} / ${s.receivedCount}</td></tr>
        <tr><th>Last messages</th><td>${(s.lastMessages || []).map((m) => `${m.dir === 'out' ? '→' : '←'} ${m.preview}`).join('<br>') || '—'}</td></tr>
      </table>
    </div>
  `).join('') || '<i>no websockets observed yet</i>';
}

async function poll() {
  try {
    const snap = await evalInPage('window.__webrtcInspector && window.__webrtcInspector.getSnapshot()');
    renderSnapshot(snap);
  } catch (err) {
    document.getElementById('status').textContent = 'eval failed: ' + (err && err.value ? err.value : JSON.stringify(err));
  }
  setTimeout(poll, POLL_MS);
}
poll();

document.getElementById('injectAudioBtn').addEventListener('click', async () => {
  const b64 = document.getElementById('audioB64').value.trim();
  if (!b64) return;
  lastAudioB64 = b64;
  await evalInPage(`window.__webrtcInspector.injectAudio(${JSON.stringify(b64)})`);
});

document.getElementById('replayBtn').addEventListener('click', async () => {
  if (!lastAudioB64) { alert('Nothing injected yet in this panel session'); return; }
  await evalInPage('window.__webrtcInspector.playIntoFakeMic()');
});

document.getElementById('sendDcBtn').addEventListener('click', async () => {
  const connId = Number(document.getElementById('dcConnId').value);
  const label = document.getElementById('dcLabel').value;
  const message = document.getElementById('dcMessage').value;
  await evalInPage(`window.__webrtcInspector.injectDataChannelMessage(${connId}, ${JSON.stringify(label)}, ${JSON.stringify(message)})`);
});

document.getElementById('replaceTrackBtn').addEventListener('click', async () => {
  const connId = Number(document.getElementById('rtConnId').value);
  const kind = document.getElementById('rtKind').value;
  await evalInPage(`window.__webrtcInspector.replaceOutgoingTrack(${connId}, ${JSON.stringify(kind)}, window.__webrtcInspector.getFakeMicTrack())`);
});

document.getElementById('setFakeCamBtn').addEventListener('click', async () => {
  const width = Number(document.getElementById('camW').value) || 320;
  const height = Number(document.getElementById('camH').value) || 240;
  const text = document.getElementById('camText').value;
  await evalInPage(`window.__webrtcInspector.setFakeCam(${JSON.stringify({ width, height, text })})`);
});

document.getElementById('clearFakeCamBtn').addEventListener('click', async () => {
  await evalInPage('window.__webrtcInspector.clearFakeCam()');
});

document.getElementById('setInterceptorBtn').addEventListener('click', async () => {
  const dirFilter = document.getElementById('icDir').value;
  const action = document.getElementById('icAction').value;
  const expr = `window.__webrtcInspector.setDataChannelInterceptor((dir, ctx) => {
    if (${JSON.stringify(dirFilter)} && dir !== ${JSON.stringify(dirFilter)}) return undefined;
    if (${JSON.stringify(action)} === 'block') return false;
    return typeof ctx.data === 'string' ? ctx.data.toUpperCase() : undefined;
  })`;
  await evalInPage(expr);
  document.getElementById('interceptorStatus').textContent =
    `Installed: ${dirFilter || 'both directions'}, ${action === 'block' ? 'blocking' : 'uppercasing text messages'}. This changes what the app actually sends/receives.`;
});

document.getElementById('clearInterceptorBtn').addEventListener('click', async () => {
  await evalInPage('window.__webrtcInspector.clearDataChannelInterceptor()');
  document.getElementById('interceptorStatus').textContent = 'Removed.';
});

document.getElementById('sendWsBtn').addEventListener('click', async () => {
  const socketId = Number(document.getElementById('wsSocketId').value);
  const message = document.getElementById('wsMessage').value;
  await evalInPage(`window.__webrtcInspector.sendOnWebSocket(${socketId}, ${JSON.stringify(message)})`);
});

document.getElementById('injectWsBtn').addEventListener('click', async () => {
  const socketId = Number(document.getElementById('wsSocketId').value);
  const message = document.getElementById('wsMessage').value;
  await evalInPage(`window.__webrtcInspector.injectWebSocketMessage(${socketId}, ${JSON.stringify(message)})`);
});

document.getElementById('setWsInterceptorBtn').addEventListener('click', async () => {
  const dirFilter = document.getElementById('wsIcDir').value;
  const action = document.getElementById('wsIcAction').value;
  const expr = `window.__webrtcInspector.setWebSocketInterceptor((dir, ctx) => {
    if (${JSON.stringify(dirFilter)} && dir !== ${JSON.stringify(dirFilter)}) return undefined;
    if (${JSON.stringify(action)} === 'block') return false;
    return typeof ctx.data === 'string' ? ctx.data.toUpperCase() : undefined;
  })`;
  await evalInPage(expr);
  document.getElementById('wsInterceptorStatus').textContent =
    `Installed: ${dirFilter || 'both directions'}, ${action === 'block' ? 'blocking' : 'uppercasing text messages'}. This changes what the app actually sends/receives.`;
});

document.getElementById('clearWsInterceptorBtn').addEventListener('click', async () => {
  await evalInPage('window.__webrtcInspector.clearWebSocketInterceptor()');
  document.getElementById('wsInterceptorStatus').textContent = 'Removed.';
});

document.getElementById('killConnBtn').addEventListener('click', async () => {
  const connId = Number(document.getElementById('killConnId').value);
  try {
    await evalInPage(`window.__webrtcInspector.killConnection(${connId})`);
    document.getElementById('lossStatus').textContent = `Connection #${connId} killed (real pc.close()).`;
  } catch (err) {
    document.getElementById('lossStatus').textContent = 'Failed: ' + (err && err.value ? err.value : JSON.stringify(err));
  }
});

document.getElementById('simulateLossBtn').addEventListener('click', async () => {
  const duration = Number(document.getElementById('lossDuration').value) || 15000;
  const targetsSel = document.getElementById('lossTargets').value;
  const targets = targetsSel === 'both' ? ['websocket', 'datachannel'] : [targetsSel];
  await evalInPage(`window.__webrtcInspectorLossHandle = window.__webrtcInspector.simulateNetworkLoss(${duration}, ${JSON.stringify({ targets })})`);
  document.getElementById('lossStatus').textContent = `Dropping ${targets.join(' + ')} traffic for ${duration}ms…`;
  setTimeout(() => {
    document.getElementById('lossStatus').textContent = 'Restored (or click "Restore now" to end early next time).';
  }, duration);
});

document.getElementById('stopLossBtn').addEventListener('click', async () => {
  await evalInPage('window.__webrtcInspectorLossHandle && window.__webrtcInspectorLossHandle.stop()');
  document.getElementById('lossStatus').textContent = 'Restored.';
});
