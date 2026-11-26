'use strict';

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const ESBUILD = process.env.ESBUILD_BIN || path.join(ROOT, 'node_modules', '.bin', 'esbuild');
const OUT = path.join(os.tmpdir(), `progress-nudge-host-test-${process.pid}`);
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
const { attachNudge } = require(path.join(OUT, 'adapter.cjs'));

function fakeContext(initialTools = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-nudge-host-'));
  const hooks = new Map();
  const puts = [];
  const removes = [];
  const synthetics = [];
  const registered = [];
  const tools = initialTools.map((id) => ({ id }));
  const ctx = {
    location: { directory: dir },
    session: {
      hook: (name, handler) => {
        hooks.set(name, handler);
        return { dispose: () => hooks.delete(name) };
      },
      instructions: {
        entry: {
          put: (input) => puts.push(input),
          remove: (input) => removes.push(input),
        },
      },
      synthetic: (input) => synthetics.push(input),
    },
    tool: {
      list: async () => tools,
      transform: async (build) => {
        build({
          add: (tool) => {
            if (tool?.name === 'nudge') registered.push('nudge');
          },
        });
        return { dispose: () => {} };
      },
      hook: () => ({ dispose: () => {} }),
    },
  };
  return {
    ctx,
    dir,
    hooks,
    puts,
    removes,
    synthetics,
    registered,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test('prompt hook resets and removes the standing key', async () => {
  const f = fakeContext();
  try {
    const attached = await attachNudge(f.ctx, { statePath: path.join(f.dir, 'state.json'), tickMs: 1000 });
    await attached.adapter.submit({
      sessionId: 'ses_a', producer: 'progress.tree', ruleId: 'x', severity: 'warn',
      text: 'update', channel: 'context', at: 1,
    });
    assert.ok(attached.adapter.status('ses_a').standing);
    f.hooks.get('prompt')({ sessionID: 'ses_a' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(attached.adapter.status('ses_a').standing, undefined);
    assert.ok(f.removes.some((r) => r.key === 'nudge'));
    await attached.dispose();
  } finally {
    f.cleanup();
  }
});

test('registers one nudge tool and skips when already taken', async () => {
  const free = fakeContext();
  try {
    const attached = await attachNudge(free.ctx, { statePath: path.join(free.dir, 'state.json') });
    assert.deepEqual(free.registered, ['nudge']);
    await attached.dispose();
  } finally {
    free.cleanup();
  }

  const taken = fakeContext(['nudge']);
  try {
    const attached = await attachNudge(taken.ctx, { statePath: path.join(taken.dir, 'state.json') });
    assert.deepEqual(taken.registered, []);
    await attached.dispose();
  } finally {
    taken.cleanup();
  }
});
