#!/usr/bin/env node
// #81 — zips extension/ into a versioned, loadable-as-is archive so a human
// can "Load unpacked" without cloning the whole repo. Shells out to the `zip`
// CLI (present on GitHub-hosted runners and every common dev machine) rather
// than adding a zip dependency.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const pkg = require('../package.json');

const REPO_ROOT = path.join(__dirname, '..');
const EXTENSION_DIR = path.join(REPO_ROOT, 'extension');
const DIST_DIR = path.join(REPO_ROOT, 'dist');
const ZIP_NAME = `webrtc-inspector-extension-v${pkg.version}.zip`;
const ZIP_PATH = path.join(DIST_DIR, ZIP_NAME);

const manifest = JSON.parse(fs.readFileSync(path.join(EXTENSION_DIR, 'manifest.json'), 'utf8'));
if (manifest.version !== pkg.version) {
  throw new Error(
    `extension/manifest.json version (${manifest.version}) does not match package.json version (${pkg.version}) — keep them in sync before packing a release.`
  );
}

fs.mkdirSync(DIST_DIR, { recursive: true });
fs.rmSync(ZIP_PATH, { force: true });

execFileSync('zip', ['-r', '-X', ZIP_PATH, '.', '-x', '.DS_Store', '-x', '**/.DS_Store'], { cwd: EXTENSION_DIR });

console.log(`Packed ${path.relative(REPO_ROOT, ZIP_PATH)}`);
