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
const OUT = path.join(os.tmpdir(), `progress-nudge-adapter-test-${process.pid}`);
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
const { createNudgeAdapter } = require(path.join(OUT, 'adapter.cjs'));

function harness(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-nudge-state-'));
  let clock = 1_000_000_000;
  const puts = [];
  const removes = [];
  const synthetics = [];
  const logs = [];
  const host = {
    putContext: (sessionID, key, text) => puts.push({ sessionID, key, text }),
    removeContext: (sessionID, key) => removes.push({ sessionID, key }),
    synthetic: (sessionID, text) => synthetics.push({ sessionID, text }),
    log: (event) => logs.push(event),
    now: () => clock,
  };
  const adapter = createNudgeAdapter(host, {
    producer: 'test',
    statePath: path.join(dir, 'state.json'),
    gapMs: 0,
    graceMs: 0,
    capPerSession: 0,
    ...overrides,
  });
  return {
    dir,
    adapter,
    puts,
    removes,
    synthetics,
    logs,
    now: () => clock,
    setNow: (value) => (clock = value),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

const candidate = (overrides = {}) => ({
  sessionId: 'ses_a',
  producer: 'progress.tree',
  ruleId: 'stale',
  severity: 'warn',
  text: 'update the tree',
  channel: 'context',
  at: 1_000_000_000,
  ...overrides,
});

test('context delivery writes the nudge key and clears the legacy key', async () => {
  const h = harness();
  try {
    const result = await h.adapter.submit(candidate());
    assert.equal(result.applied, true);
    assert.equal(h.puts.length, 1);
    assert.equal(h.puts[0].key, 'nudge');
    assert.match(h.puts[0].text, /^\[warn\]/);
    assert.deepEqual(h.removes, [{ sessionID: 'ses_a', key: 'progress-reminder' }]);
    assert.equal(h.adapter.status('ses_a').fires, 1);
  } finally {
    h.cleanup();
  }
});

test('mute suppresses non-block only', async () => {
  const h = harness();
  try {
    await h.adapter.mute('ses_a', 30);
    assert.equal((await h.adapter.submit(candidate())).reason, 'muted');
    const block = await h.adapter.submit(candidate({ severity: 'block', channel: 'synthetic' }));
    assert.equal(block.applied, true);
    assert.equal(h.synthetics.length, 1);
    await h.adapter.unmute('ses_a');
    await h.adapter.clear('ses_a');
    assert.equal((await h.adapter.submit(candidate({ at: h.now() + 1000 }))).applied, true);
  } finally {
    h.cleanup();
  }
});

test('gap suppresses non-block, block bypasses', async () => {
  const h = harness({ gapMs: 60_000 });
  try {
    assert.equal((await h.adapter.submit(candidate())).applied, true);
    assert.equal((await h.adapter.submit(candidate({ at: h.now() + 1000 }))).reason, 'gap');
    assert.equal(
      (await h.adapter.submit(candidate({ at: h.now() + 2000, severity: 'block' }))).applied,
      true
    );
  } finally {
    h.cleanup();
  }
});

test('grace is keyed per producer group', async () => {
  const h = harness({ graceMs: 600_000 });
  try {
    await h.adapter.touch('ses_a'); // progress write
    assert.equal((await h.adapter.submit(candidate())).reason, 'grace');
    // A progress write does not buy silence for say.
    assert.equal(
      (await h.adapter.submit(candidate({ producer: 'say', at: h.now() + 1 }))).applied,
      true
    );

    await h.adapter.touch('ses_a', 'say');
    assert.equal(
      (await h.adapter.submit(candidate({ producer: 'say', text: 'note again', at: h.now() + 2 }))).reason,
      'grace'
    );
    assert.equal(
      (
        await h.adapter.submit(
          candidate({ producer: 'custom.rule', ruleId: 'x', text: 'custom text', at: h.now() + 3 })
        )
      ).applied,
      true
    );

    const status = h.adapter.status('ses_a');
    assert.equal(status.activity.say, h.now());
    assert.equal(status.activity['progress.tree'], h.now());
  } finally {
    h.cleanup();
  }
});

test('cap applies to strict/say and block bypasses it', async () => {
  const h = harness({ capPerSession: 2 });
  try {
    await h.adapter.submit(candidate({ at: h.now() }));
    await h.adapter.submit(candidate({ at: h.now() + 1000, text: 'second' }));
    assert.equal((await h.adapter.submit(candidate({ at: h.now() + 2000, text: 'third' }))).reason, 'cap');
    assert.equal(
      (await h.adapter.submit(candidate({ at: h.now() + 3000, severity: 'block', text: 'stop' }))).applied,
      true
    );
  } finally {
    h.cleanup();
  }
});

test('dedupe and priority', async () => {
  const h = harness();
  try {
    await h.adapter.submit(candidate());
    assert.equal((await h.adapter.submit(candidate({ at: h.now() + 1 }))).reason, 'duplicate');
    assert.equal(
      (await h.adapter.submit(candidate({ at: h.now() + 2, severity: 'info', text: 'tip' }))).reason,
      'lower-priority'
    );
    assert.equal(
      (await h.adapter.submit(candidate({ at: h.now() + 3, severity: 'block', text: 'stop' }))).applied,
      true
    );
  } finally {
    h.cleanup();
  }
});

test('synthetic is block-only; clear removes the standing key', async () => {
  const h = harness();
  try {
    await h.adapter.submit(candidate({ severity: 'warn', channel: 'synthetic', text: 'warn synthetic' }));
    assert.equal(h.synthetics.length, 0, 'warn downgraded to context');

    await h.adapter.submit(candidate({ severity: 'block', channel: 'synthetic', text: 'block synthetic' }));
    assert.equal(h.synthetics.length, 1);

    await h.adapter.clear('ses_a');
    assert.equal(h.adapter.status('ses_a').standing, undefined);
    assert.equal(h.removes.filter((r) => r.key === 'nudge').length, 1);
  } finally {
    h.cleanup();
  }
});

test('clear only removes the matching producer source', async () => {
  const h = harness();
  try {
    await h.adapter.submit(candidate({ producer: 'progress.tree' }));
    await h.adapter.clear('ses_a', 'say');
    assert.ok(h.adapter.status('ses_a').standing, 'non-matching clear leaves it');
    assert.equal(h.removes.filter((r) => r.key === 'nudge').length, 0);
    await h.adapter.clear('ses_a', 'progress');
    assert.equal(h.adapter.status('ses_a').standing, undefined);
    assert.equal(h.removes.filter((r) => r.key === 'nudge').length, 1);
  } finally {
    h.cleanup();
  }
});

test('shadow mode records the gate decision but never writes the host', async () => {
  const h = harness({ shadow: true });
  try {
    const result = await h.adapter.submit(candidate());
    assert.equal(result.applied, true);
    assert.equal(h.puts.length, 0);
    assert.equal(h.removes.length, 0);
    assert.equal(h.synthetics.length, 0);
    assert.ok(h.adapter.status('ses_a').standing);
    assert.ok(h.logs.some((event) => event.event === 'nudge-shadow'));
  } finally {
    h.cleanup();
  }
});
