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
const OUT = path.join(os.tmpdir(), `progress-nudge-tool-test-${process.pid}`);
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
const { createNudgeTool } = require(path.join(OUT, 'adapter.cjs'));

function stub() {
  const state = { mutedUntil: 0, standing: undefined, fires: 0 };
  return {
    state,
    adapter: {
      mute: (_sid, minutes) => {
        state.mutedUntil = Date.now() + minutes * 60_000;
      },
      unmute: () => {
        state.mutedUntil = 0;
      },
      clear: (_sid, producer) => {
        if (!producer || state.standing?.source.startsWith(producer)) state.standing = undefined;
      },
      status: (sessionID) => ({ sessionID, ...state }),
    },
  };
}

test('status reports mute, standing reminder, and fire count', async () => {
  const s = stub();
  const tool = createNudgeTool(s.adapter);
  s.state.standing = { severity: 'warn', source: 'progress.tree', text: '[warn] update', hash: 'x', at: 1 };
  s.state.fires = 1;
  const result = await tool.execute({ action: 'status' }, { sessionID: 'ses_a' });
  assert.match(result.content, /Not muted/);
  assert.match(result.content, /\[warn\] progress\.tree/);
  assert.match(result.content, /Fires this session: 1/);
});

test('mute, unmute, and clear actions mutate the adapter', async () => {
  const s = stub();
  const tool = createNudgeTool(s.adapter);
  const muted = await tool.execute({ action: 'mute', minutes: 5 }, { sessionID: 'ses_a' });
  assert.match(muted.content, /muted for 5m/);
  assert.ok(s.state.mutedUntil > Date.now());

  const status = await tool.execute({ action: 'status' }, { sessionID: 'ses_a' });
  assert.match(status.content, /Muted for another 5m/);

  const unmuted = await tool.execute({ action: 'unmute' }, { sessionID: 'ses_a' });
  assert.match(unmuted.content, /unmuted/);
  assert.equal(s.state.mutedUntil, 0);

  s.state.standing = { severity: 'warn', source: 'say', text: '[warn] say', hash: 'y', at: 1 };
  await tool.execute({ action: 'clear' }, { sessionID: 'ses_a' });
  assert.equal(s.state.standing, undefined);
});

test('clear can target one producer', async () => {
  const s = stub();
  const tool = createNudgeTool(s.adapter);
  s.state.standing = { severity: 'warn', source: 'progress.tree', text: '[warn] x', hash: 'z', at: 1 };
  await tool.execute({ action: 'clear', producer: 'say' }, { sessionID: 'ses_a' });
  assert.ok(s.state.standing, 'non-matching producer leaves it');
  await tool.execute({ action: 'clear', producer: 'progress' }, { sessionID: 'ses_a' });
  assert.equal(s.state.standing, undefined);
});
