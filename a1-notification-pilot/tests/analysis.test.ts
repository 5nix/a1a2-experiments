import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
import { performance, poolItems, phaseForInterval, performanceChanges } from '../src/analysis.ts';
import { analyze, bundle } from '../src/export.ts';
import { Store } from '../src/store.ts';
import { buildPlan, type Material } from '../src/protocol.ts';

const item = (classification: string, extra: Record<string, unknown> = {}) => ({ participant_id: 'P1', session_id: 'S1', attempt_id: 'A1', block_type: 'notification', n_count: 1, window: 'during', valid: true, classification, ...extra });
test('pooled rates use combined counts rather than averaging trial percentages; RT uses hits only', () => {
  const items = [item('hit', { rt_ms: 300 }), ...Array.from({ length: 9 }, () => item('miss', { attempt_id: 'A2' })), item('false_alarm', { rt_ms: 20 }), item('correct_rejection')];
  const row = poolItems(items).find(r => r.window === 'during')!;
  assert.equal(row.hit_rate, .1); assert.equal(row.false_alarm_rate, .5); assert.equal(row.accuracy, 2 / 12); assert.ok(Math.abs(Number(row.balanced_accuracy) - .3) < 1e-10);
  assert.equal(row.target_n, 10); assert.equal(row.non_target_n, 2); assert.equal(row.hit_rt_mean_ms, 300); assert.equal(row.hit_rt_median_ms, 300); assert.equal(row.hit_rt_n, 1); assert.equal(row.attempt_n, 2);
});
test('missing denominators and no hit RT stay null; invalid attempts are excluded', () => {
  const row = performance([item('correct_rejection'), item('hit', { valid: false, rt_ms: 10 })]);
  assert.equal(row.hit_rate, null); assert.equal(row.balanced_accuracy, null); assert.equal(row.false_alarm_rate, 0); assert.equal(row.hit_rt_mean_ms, null); assert.equal(row.hit_rt_median_ms, null); assert.equal(row.hit_rt_n, 0);
  assert.equal(performance([]).accuracy, null);
  assert.equal(performance([item('hit', { rt_ms: 100 }), item('hit', { rt_ms: 600 })]).hit_rt_median_ms, 350);
});
test('actual intervals mark notification and recovery boundaries, including mapping uncertainty', () => {
  assert.equal(phaseForInterval(90, 110, 100, 200, 100).window, 'boundary');
  assert.equal(phaseForInterval(100, 200, 100, 200, 100).window, 'during');
  assert.equal(phaseForInterval(200, 250, 100, 200, 100).post_window, 'post_early');
  assert.equal(phaseForInterval(300, 350, 100, 200, 100).post_window, 'post_late');
  assert.equal(phaseForInterval(290, 310, 100, 200, 100).post_window, 'post_boundary');
  assert.equal(phaseForInterval(100, 180, 100, 200, 100, 2).window, 'boundary');
  assert.equal(phaseForInterval(20, null, 100, 200, 100).window, 'unknown');
  assert.equal(phaseForInterval(20, 40, null, null, 100).window, 'unknown');
});
test('phase changes retain missing values and use separate denominators', () => {
  const rows = performanceChanges([{ participant_id: 'P', window: 'pre', eligible: 10, accuracy: .8, hit_rate: null }, { participant_id: 'P', window: 'post_early', eligible: 2, accuracy: .5, hit_rate: .5 }], ['participant_id']);
  const post = rows.find(r => r.window === 'post_early')!; assert.ok(Math.abs(Number(post.accuracy_drop_percentage_points) - 30) < 1e-8); assert.equal(post.baseline_eligible, 10); assert.equal(post.window_eligible, 2); assert.equal(post.hit_rate_change, null);
});
const material: Material = { id: 'M1', domain: '设备', text_lines: ['电量20%'], n_count: 1, n_units: ['电量'], question: '电量？', options: ['20%', '30%', '40%', '50%'], correct: 0 };
test('unmapped real glasses never exports browser-intended during; full plan includes unattempted trials and answers', () => {
  const store = new Store(':memory:');
  try {
    const plan = buildPlan([material], 'quick', 2, 'pilot', 'rayneo', undefined, { primary_modality: 'visual_letters' });
    const created = store.create('P-real', plan), s = store.get(created.session_id);
    store.db.prepare('INSERT INTO attempts(id,session_id,block_index,owner,status,started_at) VALUES (?,?,?,?,?,?)').run('attempt', s.id, 1, 'owner', 'completed', 'now');
    let seq = 0; const add = (type: string, at: number, data: Record<string, unknown>) => store.db.prepare('INSERT INTO events(id,session_id,attempt_id,type,at,seq,data,fingerprint,received_at) VALUES (?,?,?,?,?,?,?,?,?)').run(`event-${seq}`, s.id, 'attempt', type, at, seq++, JSON.stringify(data), '', 'now');
    add('notification_onset', 100, {}); add('notification_offset', 200, {});
    add('stimulus_onset', 120, { index: 2 }); add('item_end', 150, { index: 2 });
    add('answer_saved', 300, { phase: 'RECALL', answer: '电量20%' }); add('answer_saved', 350, { phase: 'PROBE', answer: 0, correct: true });
    const result = analyze(store, s); assert.equal(result.items[0].window, 'unknown'); assert.equal(result.summaries.find(r => r.window === 'during')?.eligible, 0); assert.equal(result.trials[0].recall, '电量20%');
    const files = unzipSync(bundle(store, [s])); for (const name of ['pooled_summary.csv', 'sequence_balance.csv', 'full_trial_plan.csv', 'pooled_changes.csv']) assert.ok(files[name]);
    const full = strFromU8(files['full_trial_plan.csv']); assert.match(full, /电量20%/); assert.match(full, /B01/); assert.match(full, /B03/); assert.match(full, /n_units/);
  } finally { store.db.close(); }
});
test('mock scoring uses observed edges, not planned counts, and flags completed response intervals that cross them', () => {
  const store = new Store(':memory:');
  try {
    const created = store.create('P-mock', buildPlan([material], 'quick', 1, 'pilot', 'mock', undefined, { primary_modality: 'visual_letters' }));
    const s = store.get(created.session_id);
    store.db.prepare('INSERT INTO attempts(id,session_id,block_index,owner,status,started_at) VALUES (?,?,?,?,?,?)').run('mock-attempt', s.id, 1, 'owner', 'completed', 'now');
    let seq = 0; const add = (type: string, at: number, data: Record<string, unknown>) => store.db.prepare('INSERT INTO events(id,session_id,attempt_id,type,at,seq,data,fingerprint,received_at) VALUES (?,?,?,?,?,?,?,?,?)').run(`mock-${seq}`, s.id, 'mock-attempt', type, at, seq++, JSON.stringify(data), '', 'now');
    add('notification_onset', 100, {}); add('notification_offset', 200, {});
    for (const [index, start, end] of [[2, 40, 80], [3, 90, 110], [4, 120, 150], [5, 210, 240], [6, 4000, 4100]]) { add('stimulus_onset', start, { index }); add('item_end', end, { index }); }
    const result = analyze(store, s);
    assert.deepEqual(result.items.map(r => r.window), ['pre', 'boundary', 'during', 'post', 'post']);
    assert.equal(result.items[3].post_window, 'post_early'); assert.equal(result.items[4].post_window, 'post_late');
    assert.equal(result.trials[0].notification_onset_ms, 100); assert.equal(result.trials[0].notification_duration_actual_ms, 100);
    assert.equal(result.pooled_summaries.find(r => r.window === 'post')?.eligible, 2);
    assert.equal(result.pooled_summaries.find(r => r.window === 'boundary')?.eligible, 1);
  } finally { store.db.close(); }
});

test('different pilot timing or presentation conditions are not silently pooled together', () => {
  const rows = poolItems([item('hit', { analysis_condition: 'soa1500' }), item('miss', { analysis_condition: 'soa2000' })]).filter(r => r.window === 'during');
  assert.equal(rows.length, 2); assert.deepEqual(rows.map(r=>r.accuracy),[1,0]);
});
test('truncated final reaction window is retained in raw items but excluded from scores', () => {
  const store = new Store(':memory:');
  try {
    const s=store.get(store.create('partial', buildPlan([material], 'quick', 1, 'pilot', 'mock', undefined, { primary_modality: 'visual_letters' })).session_id);
    store.db.prepare('INSERT INTO attempts(id,session_id,block_index,owner,status,started_at) VALUES (?,?,?,?,?,?)').run('partial',s.id,1,'owner','completed','now');
    store.log(s.id,'partial','notification_onset',{}); store.log(s.id,'partial','notification_offset',{});
    for (const [id,type,at,data] of [['start','stimulus_onset',120,{index:2}],['end','item_end',150,{index:2,partial_response_window:true}]] as const) store.db.prepare('INSERT INTO events(id,session_id,attempt_id,type,at,data,fingerprint,received_at) VALUES (?,?,?,?,?,?,?,?)').run(id,s.id,'partial',type,at,JSON.stringify(data),'','now');
    const result=analyze(store,s); assert.equal(result.items[0].partial_response_window,true); assert.equal(result.items[0].valid,false);
  } finally { store.db.close(); }
});
