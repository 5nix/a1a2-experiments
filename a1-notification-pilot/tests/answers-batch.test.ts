import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildPlan, type Material } from '../src/protocol.ts';
import { Store } from '../src/store.ts';
import { Engine } from '../src/engine.ts';
const materials = JSON.parse(readFileSync(new URL('../content/materials.json', import.meta.url), 'utf8')) as Material[];

function setup() {
  const store = new Store(':memory:'), engine = new Engine(store);
  const { session_id } = store.create('P900', buildPlan(materials, 'sop', 7, 'round1'));
  return { store, engine, session_id };
}
const timing = () => ({ shown_at: 1, submitted_at: 2, time_origin: 3 });

test('同页批量提交：理解题＋两个努力量表按原单项事件落盘并进入休息', () => {
  const { store, engine, session_id } = setup();
  const s = store.get(session_id);
  const index = s.snapshot.blocks.findIndex(b => b.kind === 'notification');
  Object.assign(s, { index, phase: 'PROBE', attempt_id: null }); store.save(s);
  assert.equal(engine.view(s).effort_recovery, true);
  const items = [{ phase: 'PROBE', answer: 1 }, { phase: 'EFFORT_GENERAL', answer: 5 }, { phase: 'EFFORT_RECOVERY', answer: 7 }];
  const view = engine.submitBatch(s, items, timing);
  assert.equal(view.phase, 'BREAK');
  const saved = store.events(session_id).filter(e => e.type === 'answer_saved').map(e => [e.data.phase, e.data.answer, e.data.batch]);
  assert.deepEqual(saved, [['PROBE', 1, true], ['EFFORT_GENERAL', 5, true], ['EFFORT_RECOVERY', 7, true]]);
});

test('批量提交拒绝缺项、乱序和越界，且不写入任何答案', () => {
  const { store, engine, session_id } = setup();
  const s = store.get(session_id);
  Object.assign(s, { index: s.snapshot.blocks.findIndex(b => b.kind === 'notification'), phase: 'PROBE' }); store.save(s);
  assert.throws(() => engine.submitBatch(s, [{ phase: 'PROBE', answer: 1 }, { phase: 'EFFORT_GENERAL', answer: 5 }], timing), /顺序/);
  assert.throws(() => engine.submitBatch(s, [{ phase: 'EFFORT_GENERAL', answer: 5 }, { phase: 'PROBE', answer: 1 }, { phase: 'EFFORT_RECOVERY', answer: 7 }], timing), /顺序/);
  assert.throws(() => engine.submitBatch(s, [{ phase: 'PROBE', answer: 1 }, { phase: 'EFFORT_GENERAL', answer: 10 }, { phase: 'EFFORT_RECOVERY', answer: 7 }], timing), /1—9/);
  assert.equal(store.events(session_id).filter(e => e.type === 'answer_saved').length, 0);
});

test('理解题接受"不记得了"(-1)与"没看见/没看清"(-2)：计为未答对并记录作答类型；其他越界编码仍拒绝', () => {
  for (const [answer, type] of [[-1, 'dont_remember'], [-2, 'not_seen']] as const) {
    const { store, engine, session_id } = setup();
    const s = store.get(session_id);
    Object.assign(s, { index: s.snapshot.blocks.findIndex(b => b.kind === 'notification'), phase: 'PROBE', attempt_id: null }); store.save(s);
    assert.deepEqual(engine.view(s).question?.fallbacks.map(f => f.code), [-1, -2]);
    engine.submitBatch(s, [{ phase: 'PROBE', answer }, { phase: 'EFFORT_GENERAL', answer: 5 }, { phase: 'EFFORT_RECOVERY', answer: 7 }], timing);
    const probe = store.events(session_id).find(e => e.type === 'answer_saved' && e.data.phase === 'PROBE')!.data;
    assert.equal(probe.answer, answer); assert.equal(probe.correct, false); assert.equal(probe.response_type, type);
  }
  const { store, engine, session_id } = setup();
  const s = store.get(session_id);
  Object.assign(s, { index: s.snapshot.blocks.findIndex(b => b.kind === 'notification'), phase: 'PROBE' }); store.save(s);
  for (const answer of [4, -3]) assert.throws(() => engine.submitBatch(s, [{ phase: 'PROBE', answer }, { phase: 'EFFORT_GENERAL', answer: 5 }, { phase: 'EFFORT_RECOVERY', answer: 7 }], timing), /请选择一个答案/);
});
