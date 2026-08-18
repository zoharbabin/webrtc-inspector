// #26 — natural-language-to-fault-injection compiler. Deliberately not an
// LLM call: a small, deterministic keyword/regex DSL mapping short scenario
// phrases to a sequence of this library's existing fault-injection
// primitives, so an external agent (or a thin LLM-backed helper upstream of
// this) has a documented, testable target to compile *to* instead of
// hand-picking API calls and durations itself.
//
// Recognized per-clause, in priority order (first match wins):
//   - a named preset ("home wifi" / "4g train" / "congested mobile")
//     -> simulateNetworkPreset(name)
//   - "kill"/"terminate"/"drop"+"connection" (abrupt teardown)
//     -> killConnection(connectionId)
//   - "restart ice" / "ice restart" (renegotiate-in-place)
//     -> restartIce(connectionId)
//   - anything else mentioning a duration ("for 5s"/"for 200ms")
//     -> simulateNetworkLoss(durationMs, { targets }), targets inferred from
//        keywords (datachannel/websocket/http/media), default
//        ['websocket', 'datachannel'] matching simulateNetworkLoss's own default.
// A scenario is split into ordered clauses on "then"/";" so compound
// scenarios ("drop packets for 3s then kill the connection") compile to a
// sequence, executed in order by runCompiledScenario.

const PRESET_PATTERNS = [
  { name: 'home-wifi', re: /home[\s-]?wifi/i },
  { name: '4g-train', re: /4g[\s-]?train/i },
  { name: 'congested-mobile', re: /congested[\s-]?mobile/i },
];

const KILL_RE = /\b(kill|terminate|abrupt(?:ly)?\s+(?:disconnect|drop|close)|hard\s+(?:disconnect|close))\b/i;
const RESTART_ICE_RE = /\brestart\b[^.;]*\bice\b|\bice\b[^.;]*\brestart\b/i;
const DURATION_RE = /(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?)\b/i;

const TARGET_KEYWORDS = [
  { target: 'datachannel', re: /data[\s-]?channel/i },
  { target: 'websocket', re: /web[\s-]?socket|signal(?:ing|ling)/i },
  { target: 'http', re: /\bhttp\b|whip|whep/i },
  { target: 'media', re: /\bmedia\b|\baudio\b|\bvideo\b|\brtp\b|\bpacket(?:s)?\b/i },
];

function parseDurationMs(text) {
  const m = text.match(DURATION_RE);
  if (!m) return null;
  const value = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  return unit.startsWith('ms') ? value : value * 1000;
}

function parseTargets(text) {
  const targets = TARGET_KEYWORDS.filter(({ re }) => re.test(text)).map(({ target }) => target);
  return targets.length ? targets : ['websocket', 'datachannel'];
}

function splitClauses(text) {
  return String(text || '')
    .split(/\s*(?:,\s*)?\bthen\b\s*|\s*;\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

function compileClause(clause, context) {
  const preset = PRESET_PATTERNS.find(({ re }) => re.test(clause));
  if (preset) return { step: { primitive: 'simulateNetworkPreset', args: [preset.name] } };

  if (KILL_RE.test(clause)) {
    const warning = context.connectionId == null ? 'killConnection: no connectionId in context; args[0] will be null' : null;
    return {
      step: { primitive: 'killConnection', args: [context.connectionId == null ? null : context.connectionId] },
      warning,
    };
  }

  if (RESTART_ICE_RE.test(clause)) {
    const warning = context.connectionId == null ? 'restartIce: no connectionId in context; args[0] will be null' : null;
    return {
      step: { primitive: 'restartIce', args: [context.connectionId == null ? null : context.connectionId] },
      warning,
    };
  }

  const durationMs = parseDurationMs(clause);
  if (durationMs !== null) {
    return { step: { primitive: 'simulateNetworkLoss', args: [durationMs, { targets: parseTargets(clause) }] } };
  }

  return { warning: `Could not compile clause into a primitive: "${clause}"` };
}

// context: { connectionId?, socketId? } — filled into steps that need one.
function compileScenario(text, context) {
  const ctx = context || {};
  const steps = [];
  const warnings = [];
  splitClauses(text).forEach((clause) => {
    const { step, warning } = compileClause(clause, ctx);
    if (step) steps.push(step);
    if (warning) warnings.push(warning);
  });
  return { steps, warnings };
}

// Executes a compiled scenario's steps in order against an
// window.__webrtcInspector-shaped api. Awaits each primitive's return value
// (and, for simulateNetworkLoss/simulateNetworkPreset's {stop, done} shape,
// their `done` promise) before starting the next step, so "then"-sequenced
// steps run one after the other rather than racing. opts.bundle: true calls
// api.exportBundle() (#4) after all steps and attaches it as `bundle`.
async function runCompiledScenario(compiled, api, opts) {
  const results = [];
  for (const step of compiled.steps) {
    const fn = api[step.primitive];
    if (typeof fn !== 'function') {
      results.push({ step, error: `api.${step.primitive} is not a function` });
      continue;
    }
    try {
      const value = await fn.apply(api, step.args);
      if (value && typeof value.done !== 'undefined') await value.done;
      results.push({ step, value });
    } catch (error) {
      results.push({ step, error: error && error.message ? error.message : String(error) });
    }
  }
  const out = { results };
  if (opts && opts.bundle && typeof api.exportBundle === 'function') out.bundle = api.exportBundle();
  return out;
}

if (typeof module !== 'undefined') {
  module.exports = { compileScenario, runCompiledScenario, splitClauses, parseDurationMs, parseTargets };
}
