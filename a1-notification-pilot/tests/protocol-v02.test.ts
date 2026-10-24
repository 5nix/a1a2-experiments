import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildPlan, hash, type Material } from '../src/protocol.ts';
import { checkPlan, plannedPhase } from '../src/plan-check.ts';
const materials = JSON.parse(readFileSync(new URL('../content/materials.json', import.meta.url), 'utf8')) as Material[];

test('V0.2 has 10 unique interleaved notifications and 2 controls, with cohort quota/position balance', () => {
  const totals = [0, 0, 0], controlCounts = Array(12).fill(0);
  for (let index = 0; index < 6; index++) {
    const plan = buildPlan(materials, 'sop', 70, 'round1', 'mock', undefined, { participant_id: `P00${index + 1}` });
    const formal = plan.blocks.filter(b => b.kind !== 'practice');
    const notices = formal.filter(b => b.kind === 'notification');
    assert.equal(formal.length, 12); assert.equal(notices.length, 10);
    assert.equal(new Set(notices.map(b => b.material_id)).size, 10);
    const expected = [[3, 3, 4], [3, 4, 3], [4, 3, 3]][index % 3];
    assert.deepEqual(plan.allocation?.quota, expected);
    for (let n = 1; n <= 3; n++) { const count = notices.filter(b => b.n_level === n).length; assert.equal(count, expected[n - 1]); totals[n - 1] += count; }
    notices.forEach((b, i) => { if (i) assert.notEqual(b.n_level, notices[i - 1].n_level); assert.ok(b.material_domain); });
    formal.forEach((b, i) => { if (b.kind === 'control') controlCounts[i]++; });
  }
  assert.deepEqual(totals, [20, 20, 20]); assert.deepEqual(controlCounts, Array(12).fill(1));
});

test('timing is configurable, boundaries are reviewable, and no candidate is silently frozen', () => {
  const plan = buildPlan(materials, 'sop', 1, 'round1', 'mock', undefined, { timing: { notification_ms: 8500, soa_ms: 1500, stimulus_ms: 450, pre_ms: 24500, post_ms: 20000, post_early_ms: 10000 } });
  const block = plan.blocks[1];
  assert.equal(block.pre_ms, 24500); assert.equal(block.notification_ms, 8500); assert.equal(block.soa_ms, 1500);
  assert.equal(block.letters.length, Math.ceil(53000 / 1500));
  assert.equal(plannedPhase(block, 16), 'boundary');
  assert.ok(plan.sequence_check!.boundary_stimuli > 0);
  assert.match(plan.configuration_status!, /unfrozen/);
  assert.equal(buildPlan(materials, 'sop', 1, 'round1').timing!.notification_ms, 4000);
  assert.throws(() => buildPlan(materials, 'sop', 1, 'round1', 'mock', undefined, { timing: { stimulus_ms: 2500 } }), /timing/);
});

test('single seeded generation has inspectable exact targets, denominators, positions, and hash', () => {
  const plan = buildPlan(materials, 'sop', 99, 'round1');
  assert.deepEqual(buildPlan(materials, 'sop', 99, 'round1'), plan);
  const { hash: digest, ...base } = plan; assert.equal(digest, hash(base));
  assert.equal(plan.sequence_check!.rule.generation_attempts, 1);
  assert.deepEqual(checkPlan(plan), plan.sequence_check);
  for (const row of plan.sequence_check!.rows) {
    assert.equal(row.targets + row.non_targets, row.eligible);
    assert.equal(row.target_positions.length, row.targets);
    assert.equal(row.target_position_bins.reduce((a, b) => a + b, 0), row.targets);
    assert.equal(row.targets, Math.round(row.eligible * 0.28));
    assert.equal(row.target_ratio, row.eligible ? row.targets / row.eligible : null);
  }
  assert.ok(plan.sequence_check!.warnings.some(w => w.includes('sparse target denominator')));
});

test('quick keeps its three-block smoke flow; insufficient/duplicate materials fail clearly', () => {
  const quick = buildPlan(materials, 'quick', 1, 'round1');
  assert.deepEqual(quick.blocks.map(b => b.kind), ['practice', 'notification', 'control']);
  assert.equal(quick.blocks[0].letters.length, 8); assert.equal(quick.timing!.soa_ms, 1200);
  assert.throws(() => buildPlan(materials.slice(0, 1), 'sop', 1, 'round1'), /requires/);
  assert.throws(() => buildPlan([...materials, materials[0]], 'sop', 1, 'round1'), /duplicate/);
});

test('unrenderably short fractional final windows are rejected before collection', () => {
  assert.throws(() => buildPlan(materials, 'sop', 1, 'round1', 'mock', undefined, { timing: { pre_ms: 24000, notification_ms: 4001, post_ms: 20000, soa_ms: 2000 } }), /末项反应窗口/);
});
