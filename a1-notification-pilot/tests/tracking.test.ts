import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { buildPlan, type Material } from '../src/protocol.ts';
import { Store, type ClientEvent } from '../src/store.ts';
import { Engine } from '../src/engine.ts';
import { analyze } from '../src/export.ts';
const materials = JSON.parse(readFileSync(new URL('../content/materials.json', import.meta.url), 'utf8')) as Material[];

test('追踪正式计划固定9通知与1对照、N各3条，冻结时序和扰动种子', () => {
  const plan = buildPlan(materials, 'sop', 20261024, 'round1');
  assert.equal(plan.primary_modality, 'compensatory_tracking');
  assert.equal(plan.blocks.length, 11);
  assert.equal(plan.blocks.filter(b => b.kind === 'control').length, 1);
  for (const n of [1, 2, 3]) assert.equal(plan.blocks.filter(b => b.kind === 'notification' && b.n_level === n).length, 3);
  assert.deepEqual(plan.questionnaire, { recall: false });
  assert.equal(plan.timing?.post_ms, 15000);
  assert.equal(plan.blocks[1].duration_ms, 43500);
  assert.ok(plan.blocks.every(b => b.letters.length === 0 && Number.isInteger(b.tracking_seed)));
  assert.equal(plan.hash, buildPlan(materials, 'sop', 20261024, 'round1').hash);
});

test('完整连续记录直接进入理解题，分析保留真实输入数量与15个恢复窗口', () => {
  const store = new Store(':memory:');
  try {
    const engine = new Engine(store), plan = buildPlan(materials, 'sop', 9, 'round1');
    const { session_id } = store.create('QA_TRACK', plan), session = store.get(session_id);
    session.index = plan.blocks.findIndex(b => b.kind === 'notification'); store.save(session);
    const owner = randomUUID(), run = engine.start(session, owner), duration = run.block.duration_ms!;
    const events: ClientEvent[] = [];
    const add = (type: string, at: number, data = {}) => events.push({ id: randomUUID(), type, at, seq: events.length, data });
    add('tracking_started', 1000); add('notification_onset', 21000); add('notification_offset', 29500);
    add('tracking_input', 1100, { samples: [{ mouse_dx: 2 }, { mouse_dx: 3 }] });
    for (let elapsed = 0; elapsed <= duration; elapsed += 50) add('tracking_sample', 1000 + elapsed, { x: .1, y: 0 });
    add('tracking_ended', 1000 + duration); add('run_end', 1000 + duration);
    for (let i = 0; i < events.length; i += 100) store.append(session, run.attempt_id, owner, events.slice(i, i + 100));
    assert.equal(engine.finish(session, owner).phase, 'PROBE');
    const result = analyze(store, store.get(session_id));
    assert.equal(result.tracking_recovery.length, 15);
    assert.equal(result.trials[0].raw_input_count, 2);
    const during = result.tracking_summary.find(r => r.window === 'during')!;
    assert.ok(Math.abs(Number(during.rmse) - .1) < 1e-9);
    assert.equal(during.valid_duration_ms, 8500);
    assert.deepEqual(during.qc_flags, []);
  } finally { store.db.close(); }
});

test('不完整追踪记录不得推进到问卷', () => {
  const store = new Store(':memory:');
  try {
    const engine = new Engine(store), { session_id } = store.create('QA_MISSING', buildPlan(materials, 'quick', 1, 'round1'));
    const session = store.get(session_id), owner = randomUUID(); engine.start(session, owner);
    assert.throws(() => engine.finish(session, owner), /采样不足/);
    assert.equal(store.get(session_id).phase, 'RUNNING');
  } finally { store.db.close(); }
});
