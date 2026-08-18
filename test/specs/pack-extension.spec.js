// #81 — the packed zip is what a human loads unpacked with no other repo
// files around, so its contents must exactly match extension/ (no extra
// wrapper folder, no dropped files, no dot-junk) and its version must be
// real.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { test, expect } = require('@playwright/test');

const REPO_ROOT = path.join(__dirname, '..', '..');
const pkg = require('../../package.json');

test.describe('pack-extension', () => {
  // fullyParallel would otherwise run these tests across separate workers,
  // each independently packing/deleting the same fixed dist/ zip path.
  test.describe.configure({ mode: 'serial' });
  let tmpDir;
  let zipPath;
  let entries;

  test.beforeAll(() => {
    execFileSync('node', ['scripts/pack-extension.js'], { cwd: REPO_ROOT });
    zipPath = path.join(REPO_ROOT, 'dist', `webrtc-inspector-extension-v${pkg.version}.zip`);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrtc-extension-zip-'));
    execFileSync('unzip', ['-o', zipPath, '-d', tmpDir]);
    entries = execFileSync('unzip', ['-Z1', zipPath]).toString().trim().split('\n').filter(Boolean);
  });

  test.afterAll(() => {
    fs.rmSync(zipPath, { force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('zip filename embeds the real package.json version', () => {
    expect(fs.existsSync(zipPath)).toBe(true);
  });

  test('manifest.json sits at the zip root, not nested under an extension/ folder', () => {
    expect(fs.existsSync(path.join(tmpDir, 'manifest.json'))).toBe(true);
    expect(entries).toContain('manifest.json');
    entries.forEach((entry) => expect(entry.startsWith('extension/')).toBe(false));
  });

  test('every real file under extension/ is present in the zip, and nothing extra', () => {
    const walk = (dir, base = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) return walk(path.join(dir, entry.name), rel);
      return [rel];
    });
    const sourceFiles = walk(path.join(REPO_ROOT, 'extension')).sort();
    const zippedFiles = entries.filter((e) => !e.endsWith('/')).sort();
    expect(zippedFiles).toEqual(sourceFiles);
  });

  test('extension/manifest.json version matches package.json', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'extension', 'manifest.json'), 'utf8'));
    expect(manifest.version).toBe(pkg.version);
  });
});
