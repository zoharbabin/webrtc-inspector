// Guards the "never blocks a PR or push to main" constraint on the LiveKit
// nightly job (see ~/Downloads/webrtc-inspector-livekit-e2e-plan.md section
// 2/6): fails CI if livekit-nightly.yml's trigger block grows a `push` or
// `pull_request` key, since nothing else in the repo would catch that.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const WORKFLOW_PATH = path.join(__dirname, '..', '.github', 'workflows', 'livekit-nightly.yml');
const ALLOWED_TRIGGERS = new Set(['schedule', 'workflow_dispatch']);

const doc = yaml.load(fs.readFileSync(WORKFLOW_PATH, 'utf8'));
// YAML 1.1 parses the bare `on:` key as boolean `true`, not the string "on".
const triggers = doc.on || doc[true];
if (!triggers || typeof triggers !== 'object') {
  console.error(`${WORKFLOW_PATH}: could not find an "on:" trigger block`);
  process.exit(1);
}

const found = Object.keys(triggers);
const disallowed = found.filter((key) => !ALLOWED_TRIGGERS.has(key));
if (disallowed.length > 0) {
  console.error(
    `${WORKFLOW_PATH}: disallowed trigger(s) ${disallowed.join(', ')} — ` +
    `this job must never run on push/pull_request, only ${[...ALLOWED_TRIGGERS].join('/')}`
  );
  process.exit(1);
}

console.log(`${WORKFLOW_PATH}: triggers OK (${found.join(', ')})`);
