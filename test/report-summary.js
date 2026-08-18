// Turns Playwright's JSON reporter output into a compact Markdown table for
// $GITHUB_STEP_SUMMARY, so a CI run is readable from the Actions tab without
// downloading the HTML report artifact.
const fs = require('node:fs');
const path = require('node:path');

const resultsPath = path.join(__dirname, '..', 'test-results', 'results.json');
if (!fs.existsSync(resultsPath)) {
  console.log('No test-results/results.json found — skipping summary.');
  process.exit(0);
}

const report = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));

const STATUS_ICON = { expected: '✅', unexpected: '❌', flaky: '⚠️', skipped: '⏭️' };

function collectTests(suites, fileName, rows) {
  for (const suite of suites) {
    if (suite.suites) collectTests(suite.suites, suite.file || fileName, rows);
    for (const spec of suite.specs || []) {
      for (const test of spec.tests || []) {
        const lastResult = test.results[test.results.length - 1];
        rows.push({
          file: suite.file || fileName,
          title: spec.title,
          status: test.status,
          durationMs: lastResult ? lastResult.duration : 0,
        });
      }
    }
  }
}

const rows = [];
collectTests(report.suites || [], '', rows);

const totals = rows.reduce(
  (acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    acc.total++;
    return acc;
  },
  { total: 0 }
);

const lines = [];
lines.push('## 🧪 webrtc-inspector test results');
lines.push('');
lines.push(
  `${totals.total} tests — ${STATUS_ICON.expected} ${totals.expected || 0} passed, ${STATUS_ICON.unexpected} ${totals.unexpected || 0} failed, ${STATUS_ICON.flaky} ${totals.flaky || 0} flaky, ${STATUS_ICON.skipped} ${totals.skipped || 0} skipped`
);
lines.push('');

const byFile = new Map();
for (const row of rows) {
  if (!byFile.has(row.file)) byFile.set(row.file, []);
  byFile.get(row.file).push(row);
}

for (const [file, fileRows] of byFile) {
  lines.push(`### ${path.basename(file)}`);
  lines.push('');
  lines.push('| Status | Test | Duration |');
  lines.push('|---|---|---|');
  for (const row of fileRows) {
    const icon = STATUS_ICON[row.status] || '❔';
    lines.push(`| ${icon} | ${row.title} | ${row.durationMs}ms |`);
  }
  lines.push('');
}

const summary = lines.join('\n');
console.log(summary);

if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
}

if ((totals.unexpected || 0) > 0) process.exitCode = 1;
