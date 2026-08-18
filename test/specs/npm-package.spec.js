// Packaging correctness (#7): `npm pack` dereferences symlinks by dropping
// them entirely, which previously left package.json's "main" pointing at a
// file (core/webrtc-inspector.js, a symlink) that didn't exist in the
// published tarball at all. This packs the repo for real and inspects the
// actual tarball contents, catching that class of bug before publish.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { test, expect } = require('@playwright/test');

const REPO_ROOT = path.join(__dirname, '..', '..');

test.describe('npm package contents', () => {
  let tmpDir;
  let pkg;

  test.beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrtc-pack-'));
    const packOutput = execFileSync(
      'npm',
      ['pack', '--pack-destination', tmpDir, '--json'],
      { cwd: REPO_ROOT }
    ).toString();
    const [{ filename }] = JSON.parse(packOutput);
    execFileSync('tar', ['xzf', filename], { cwd: tmpDir });
    pkg = path.join(tmpDir, 'package');
  });

  test.afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('package.json "main" resolves to a real, non-empty file in the tarball', () => {
    const pkgJson = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8'));
    const mainPath = path.join(pkg, pkgJson.main);
    expect(fs.existsSync(mainPath)).toBe(true);
    expect(fs.statSync(mainPath).size).toBeGreaterThan(0);
  });

  test('the "webrtc-inspector-mcp" bin target exists', () => {
    const pkgJson = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8'));
    const binPath = path.join(pkg, pkgJson.bin['webrtc-inspector-mcp']);
    expect(fs.existsSync(binPath)).toBe(true);
  });

  test('no dangling symlink ships in the tarball (npm drops them silently)', () => {
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) return [full];
      if (entry.isDirectory()) return walk(full);
      return [];
    });
    expect(walk(pkg)).toEqual([]);
  });

  test('every file the extension manifest references is present', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(pkg, 'extension', 'manifest.json'), 'utf8'));
    const referenced = [
      ...manifest.content_scripts.flatMap((cs) => cs.js),
      manifest.background.service_worker,
      manifest.devtools_page,
    ];
    referenced.forEach((rel) => {
      expect(fs.existsSync(path.join(pkg, 'extension', rel))).toBe(true);
    });
  });
});

// #80 — the README's MCP client config blocks are copied verbatim by a human
// into their own config; a stale package/bin name there is invisible to every
// other test in this suite since nothing else parses README.md.
test.describe('README MCP client config blocks', () => {
  const README = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
  const pkgJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const binName = Object.keys(pkgJson.bin)[0];

  function jsonBlocksContaining(marker) {
    const blocks = [...README.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => m[1]);
    return blocks.filter((b) => b.includes(marker)).map((b) => JSON.parse(b));
  }

  test('every mcpServers JSON block is valid JSON and points at the real package + bin', () => {
    const blocks = jsonBlocksContaining('"mcpServers"');
    expect(blocks.length).toBeGreaterThan(0);
    blocks.forEach((config) => {
      const server = Object.values(config.mcpServers)[0];
      expect(server.command).toBe('npx');
      expect(server.args).toContain(`--package=${pkgJson.name}`);
      expect(server.args).toContain(binName);
    });
  });

  test('the claude mcp add one-liner uses the real package + bin name', () => {
    expect(README).toContain(`--package=${pkgJson.name} ${binName}`);
  });
});
