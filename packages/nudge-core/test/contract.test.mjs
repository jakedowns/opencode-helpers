import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const baseline = JSON.parse(
  fs.readFileSync(path.join(here, "fixtures", "progress-baselines.json"), "utf8")
);

test("baseline fixture captures the current progress/say policy", () => {
  assert.equal(baseline.version, 1);
  assert.equal(baseline.delivery.standingKey, "nudge");
  assert.equal(baseline.delivery.legacyKey, "progress-reminder");
  assert.equal(baseline.delivery.syntheticOnlyFor, "block");
  assert.equal(baseline.defaults.nudgeGapMs, 60_000);
  assert.equal(baseline.defaults.nudgeGraceMs, 600_000);
  assert.equal(baseline.defaults.strictThresholdSteps, 3);
  assert.equal(baseline.defaults.wallClockMs, 600_000);
});

test("baseline messages keep their placeholders and severity prefixes", () => {
  for (const [name, text] of Object.entries(baseline.messages)) {
    assert.ok(text.length > 0, `${name} is not empty`);
    assert.match(text, /\{(count|target|targets|excluded|age|tool|seconds|pattern|command|n)\}/, `${name} keeps a placeholder`);
  }
  assert.match(baseline.messages.silentRun, /^\[warn\]/);
  assert.match(baseline.messages.staleEscalation, /^\[block\]/);
  assert.match(baseline.messages.idle, /^\[block\]/);
  assert.match(baseline.messages.wall, /^\[warn\]/);
});
