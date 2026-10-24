import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { buildPlan, type Material } from '../src/protocol.ts';
import { Store } from '../src/store.ts';
import { Engine } from '../src/engine.ts';
const materials = JSON.parse(readFileSync(new URL('../content/materials.json', import.meta.url), 'utf8')) as Material[];

test('追踪默认参数冻结显示放大与圆点半径；调试标记进入哈希', () => {
  const plan = buildPlan(materials, 'sop', 1, 'round1');
  assert.equal(plan.tracking?.display_scale, 1.5);
  assert.equal(plan.tracking?.cursor_radius, 0.02);
  assert.equal(plan.tracking?.target_radius, 0.08);
  assert.equal(plan.debug, undefined);
  const debug = buildPlan(materials, 'sop', 1, 'round1', 'mock', undefined, { debug: true });
  assert.equal(debug.debug, true);
  assert.notEqual(debug.hash, plan.hash);
});

test('只有调试会话可以跳关；运行中拒绝；跳关记录 debug_jump 并回到 READY', () => {
  const store = new Store(':memory:');
  try {
    const engine = new Engine(store);
    const normal = store.get(store.create('N1', buildPlan(materials, 'quick', 1, 'round1')).session_id);
    assert.throws(() => engine.jump(normal, 1), /仅调试会话/);
    assert.equal(engine.view(normal).debug, false);
    assert.equal(engine.view(normal).debug_blocks, undefined);

    const { session_id } = store.create('D1', buildPlan(materials, 'quick', 1, 'round1', 'mock', undefined, { debug: true }));
    const s = store.get(session_id);
    assert.equal(engine.view(s).debug_blocks?.length, s.snapshot.blocks.length);
    engine.start(s, randomUUID());
    assert.throws(() => engine.jump(s, 2), /进行中/);
    engine.interrupt(s, 'test');
    assert.throws(() => engine.jump(s, 99), /关卡无效/);
    const view = engine.jump(s, 2);
    assert.equal(view.index, 2); assert.equal(view.phase, 'READY');
    const jump = store.events(session_id).find(e => e.type === 'debug_jump');
    assert.deepEqual([jump?.data.from_index, jump?.data.to_index], [0, 2]);
  } finally { store.db.close(); }
});
