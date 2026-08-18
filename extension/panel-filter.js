// #32 — filter/search bar over the event log and connection/WebSocket
// lists, mirroring Chrome's own Network panel filter box. The query is
// space-separated "key:value" tokens (type, conn, dir) plus free text;
// free text matches case-insensitively against a haystack built from the
// item's own fields. Pure and testable without a chrome.devtools mock
// (same pattern as the other panel-*.js modules).

function parseFilterQuery(query) {
  const tokens = (query || '').trim().split(/\s+/).filter(Boolean);
  const filter = { text: [] };
  tokens.forEach((token) => {
    const m = /^(type|conn|dir):(.+)$/i.exec(token);
    if (m) filter[m[1].toLowerCase()] = m[2].toLowerCase();
    else filter.text.push(token.toLowerCase());
  });
  return filter;
}

function isEmptyFilter(filter) {
  return !filter.type && !filter.conn && !filter.dir && filter.text.length === 0;
}

function matchesText(fields, filter) {
  if (!filter.text.length) return true;
  const haystack = fields.filter((v) => v !== undefined && v !== null).join(' ').toLowerCase();
  return filter.text.every((t) => haystack.includes(t));
}

function filterLogEntries(entries, filter) {
  if (isEmptyFilter(filter)) return entries;
  return entries.filter((e) => {
    if (filter.type && !String(e.type || '').toLowerCase().includes(filter.type)) return false;
    const idField = e.connectionId != null ? e.connectionId : e.socketId;
    if (filter.conn && String(idField != null ? idField : '') !== filter.conn) return false;
    if (filter.dir && String(e.dir || '').toLowerCase() !== filter.dir) return false;
    return matchesText([e.type, e.connectionId, e.socketId, e.dir, e.preview, e.state], filter);
  });
}

function filterConnections(connections, filter) {
  if (isEmptyFilter(filter)) return connections;
  if (filter.type || filter.dir) return [];
  return connections.filter((c) => {
    if (filter.conn && String(c.id) !== filter.conn) return false;
    return matchesText([c.id, c.state && c.state.connectionState, c.state && c.state.iceConnectionState], filter);
  });
}

function filterWebSockets(webSockets, filter) {
  if (isEmptyFilter(filter)) return webSockets;
  if (filter.type || filter.dir) return [];
  return webSockets.filter((s) => {
    if (filter.conn && String(s.id) !== filter.conn) return false;
    return matchesText([s.id, s.state, s.url], filter);
  });
}

if (typeof module !== 'undefined') {
  module.exports = { parseFilterQuery, filterLogEntries, filterConnections, filterWebSockets };
}
