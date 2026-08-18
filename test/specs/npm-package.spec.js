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

  test('the Claude Code skill ships in the tarball, not just the repo', () => {
    const skillPath = path.join(pkg, '.claude', 'skills', 'webrtc-inspector', 'SKILL.md');
    expect(fs.existsSync(skillPath)).toBe(true);
    expect(fs.statSync(skillPath).size).toBeGreaterThan(0);
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

// #82 — the skill file and its README copy-step instructions are two places
// that name the same package/path; nothing else catches drift if either one
// is renamed on its own.
test.describe('Claude Code skill', () => {
  const REPO_ROOT_ = path.join(__dirname, '..', '..');
  const pkgJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT_, 'package.json'), 'utf8'));
  const skillPath = path.join(REPO_ROOT_, '.claude', 'skills', 'webrtc-inspector', 'SKILL.md');
  const README = fs.readFileSync(path.join(REPO_ROOT_, 'README.md'), 'utf8');

  test('package.json "files" ships .claude so it reaches npm installs', () => {
    expect(pkgJson.files).toContain('.claude');
  });

  test('SKILL.md exists with name + description frontmatter', () => {
    const content = fs.readFileSync(skillPath, 'utf8');
    const frontmatter = content.match(/^---\n([\s\S]*?)\n---/)[1];
    expect(frontmatter).toMatch(/^name: webrtc-inspector$/m);
    expect(frontmatter).toMatch(/^description: .+$/m);
  });

  test("README's copy-step command points at the real package name and skill path", () => {
    expect(README).toContain(`node_modules/${pkgJson.name}/.claude/skills/webrtc-inspector/SKILL.md`);
  });
});
