'use strict';

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const ESBUILD =
  process.env.ESBUILD_BIN || require.resolve('esbuild/bin/esbuild');
const OUT = path.join(os.tmpdir(), `progress-nudge-config-test-${process.pid}`);
fs.mkdirSync(OUT, { recursive: true });
execFileSync(
  ESBUILD,
  [
    path.join(ROOT, 'src', 'index.ts'),
    '--bundle',
    '--format=cjs',
    '--platform=node',
    `--alias:@jakedowns/opencode-nudge-core=${path.join(ROOT, '..', 'nudge-core', 'src', 'index.ts')}`,
    `--outfile=${path.join(OUT, 'adapter.cjs')}`,
  ],
  { stdio: 'pipe' }
);
const { readNudgeConfig, resolveNudgeConfigPaths } = require(path.join(OUT, 'adapter.cjs'));

function env() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-nudge-config-'));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  fs.mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true });
  fs.mkdirSync(path.join(project, '.opencode'), { recursive: true });
  const paths = resolveNudgeConfigPaths({
    directory: project,
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') },
    home,
  });
  return { root, home, project, paths, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('project defaults/producers override global; project rule wins by id', () => {
  const e = env();
  try {
    fs.writeFileSync(
      e.paths.globalFile,
      JSON.stringify({
        version: 1,
        defaults: { gapMs: 1000 },
        producers: { say: { enabled: true } },
        rules: [{ id: 'a', producer: 'progress.tree', text: 'global a' }],
      })
    );
    fs.writeFileSync(
      e.paths.projectFile,
      JSON.stringify({
        version: 1,
        defaults: { graceMs: 2000 },
        producers: { voice: { enabled: true } },
        rules: [
          { id: 'a', producer: 'progress.tree', text: 'project a' },
          { id: 'b', producer: 'say', text: 'project b' },
        ],
      })
    );
    const result = readNudgeConfig(e.paths);
    assert.deepEqual(result.errors, []);
    assert.equal(result.config.defaults.gapMs, 1000);
    assert.equal(result.config.defaults.graceMs, 2000);
    assert.equal(result.config.producers.say.enabled, true);
    assert.equal(result.config.producers.voice.enabled, true);
    assert.equal(result.config.rules.find((r) => r.id === 'a').text, 'project a');
    assert.ok(result.config.rules.some((r) => r.id === 'b'));
    assert.equal(result.files.length, 2);
  } finally {
    e.cleanup();
  }
});

test('legacy progress-nudge.json is read when nudge.json is absent', () => {
  const e = env();
  try {
    fs.writeFileSync(
      e.paths.legacyGlobalFile,
      JSON.stringify({ version: 1, rules: [{ id: 'old', producer: 'progress.tree', text: 'old' }] })
    );
    const result = readNudgeConfig(e.paths);
    assert.deepEqual(result.errors, []);
    assert.equal(result.config.rules[0].id, 'old');
    assert.ok(result.files.includes(e.paths.legacyGlobalFile));
  } finally {
    e.cleanup();
  }
});

test('unsupported versions and malformed files are reported, not fatal', () => {
  const e = env();
  try {
    fs.writeFileSync(e.paths.globalFile, JSON.stringify({ version: 99, rules: [] }));
    fs.writeFileSync(e.paths.projectFile, '{ bad json');
    const result = readNudgeConfig(e.paths);
    assert.ok(result.errors.some((error) => /unsupported config version 99/.test(error)));
    assert.ok(
      result.errors.some(
        (error) => error.includes(e.paths.projectFile) && /SyntaxError/.test(error)
      )
    );
    assert.equal(result.config.version, 1);
  } finally {
    e.cleanup();
  }
});
