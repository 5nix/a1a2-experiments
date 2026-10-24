import { randomUUID } from 'node:crypto';
import { primaryModality } from './protocol.ts';
import { Store, HttpError, type Session } from './store.ts';

export class Engine {
  store: Store;
  constructor(store: Store) { this.store = store; }
  view(s: Session) {
    const block = s.snapshot.blocks[s.index], material = s.snapshot.materials.find(m => m.id === block?.material_id);
    const { token_hash, snapshot, ...publicSession } = s;
    const question = s.phase === 'PROBE' && material ? { text: material.question, options: material.options } : null;
    return { ...publicSession, tracking: snapshot.tracking ?? null, questionnaire: snapshot.questionnaire ?? { recall: true }, primary_modality: primaryModality(snapshot), audio_manifest: snapshot.audio_manifest ?? null, total_blocks: snapshot.blocks.length, preset: snapshot.preset, synthetic: snapshot.synthetic, pilot_round: snapshot.pilot_round, material_version: snapshot.material_version ?? 'synthetic-v1',
      block: block ? { id: block.id, kind: block.kind, round: block.round, count: block.letters.length, duration_ms: block.duration_ms, tracking_seed: block.tracking_seed, stimulus_ms: block.stimulus_ms, soa_ms: block.soa_ms } : null,
      question, effort_recovery: Boolean(material), break_remaining_ms: Math.max(0, (s.break_until ?? 0) - Date.now()), mode: snapshot.delivery_mode ?? 'mock',
      debug: snapshot.debug === true,
      debug_blocks: snapshot.debug === true ? snapshot.blocks.map(b => { const m = snapshot.materials.find(m => m.id === b.material_id); return { id: b.id, kind: b.kind, material_id: b.material_id ?? null, n_count: m?.n_count ?? m?.iu_count ?? null }; }) : undefined };
  }
  /** 调试会话专用：未在运行时跳到任意关卡。记录 debug_jump，不修改任何已有尝试。 */
  jump(s: Session, index: unknown) {
    if (s.snapshot.debug !== true) throw new HttpError(403, '仅调试会话可以选择关卡。');
    if (s.phase === 'RUNNING') throw new HttpError(409, '任务进行中不能切换关卡。');
    if (s.phase === 'ABORTED') throw new HttpError(409, '会话已结束。');
    if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index >= s.snapshot.blocks.length) throw new HttpError(422, '关卡无效。');
    this.store.tx(() => {
      this.store.log(s.id, s.attempt_id, 'debug_jump', { from_index: s.index, from_phase: s.phase, to_index: index, to_block_id: s.snapshot.blocks[index].id });
      s.index = index; s.phase = 'READY'; s.attempt_id = null; s.break_until = null; this.store.save(s);
    });
    return this.view(s);
  }
  start(s: Session, owner: unknown) {
    if (typeof owner !== 'string' || owner.length < 20 || owner.length > 80) throw new HttpError(422, '页面控制标识无效。');
    if (s.phase === 'RUNNING') { this.store.requireOwner(s, owner); return this.running(s); }
    if (s.phase !== 'READY') throw new HttpError(409, '当前不可开始任务。');
    const id = randomUUID();
    this.store.tx(() => {
      this.store.db.prepare('INSERT INTO attempts(id,session_id,block_index,owner,status,started_at) VALUES (?,?,?,?,?,?)').run(id, s.id, s.index, owner, 'running', new Date().toISOString());
      s.attempt_id = id; s.phase = 'RUNNING'; this.store.save(s);
      this.store.log(s.id, id, 'attempt_started', { block_id: s.snapshot.blocks[s.index].id, attempt_id: id });
    });
    return this.running(s);
  }
  running(s: Session) {
    const block = s.snapshot.blocks[s.index], material = s.snapshot.materials.find(m => m.id === block.material_id);
    return { attempt_id: s.attempt_id, tracking: s.snapshot.tracking ?? null, questionnaire: s.snapshot.questionnaire ?? { recall: true }, primary_modality: primaryModality(s.snapshot), audio_manifest: s.snapshot.audio_manifest ?? null, block, mode: s.snapshot.delivery_mode ?? 'mock', notification: material ? { id: material.id, text_lines: material.text_lines, render_image: material.render_image ?? null, source_label: material.source_label ?? null, n_count: material.n_count ?? material.iu_count, line_count: material.line_count ?? material.text_lines.length } : null };
  }
  finish(s: Session, owner: unknown) {
    this.store.requireOwner(s, owner);
    if (s.phase !== 'RUNNING') return this.view(s); // 相同完成请求网络重试不重复推进。
    const block = s.snapshot.blocks[s.index], events = this.store.events(s.id, s.attempt_id!);
    if (primaryModality(s.snapshot) === 'compensatory_tracking') {
      const begin = events.find(e => e.type === 'tracking_started');
      const end = events.find(e => e.type === 'tracking_ended');
      const duration = block.duration_ms;
      const interval = Number(s.snapshot.tracking?.sample_interval_ms ?? 50);
      const samples = events.filter(e => e.type === 'tracking_sample' && typeof e.at === 'number' && Number.isFinite(e.at)).sort((a, b) => a.at! - b.at!);
      const first = samples[0], last = samples.at(-1);
      if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0 || !Number.isFinite(interval) || interval <= 0 || begin?.at == null || end?.at == null || !first || !last || samples.length < Math.max(2, Math.ceil(duration / interval * 0.8)) || first.at! < begin.at || first.at! - begin.at > interval * 2 || last.at! < begin.at + duration - 1 || last.at! > end.at || end.at < begin.at + duration - 1 || samples.some((e, i) => !Number.isFinite(e.data.x) || !Number.isFinite(e.data.y) || i > 0 && e.at! <= samples[i - 1].at!)) throw new HttpError(409, '追踪记录未完整覆盖本段时长或采样不足，先重试上传。');
    } else for (let i = 0; i < block.letters.length; i++) {
      if (!events.some(e => e.type === 'stimulus_onset' && e.data.index === i) || !events.some(e => e.type === 'item_end' && e.data.index === i)) throw new HttpError(409, '逐刺激记录未完整保存，先重试上传。');
    }
    if (!events.some(e => e.type === 'run_end')) throw new HttpError(409, '任务结束事件尚未保存。');
    this.store.tx(() => {
      this.store.db.prepare('UPDATE attempts SET status=?,ended_at=? WHERE id=?').run('completed', new Date().toISOString(), s.attempt_id);
      s.phase = block.kind === 'notification' ? primaryModality(s.snapshot) === 'compensatory_tracking' || s.snapshot.questionnaire?.recall === false ? 'PROBE' : 'RECALL' : block.kind === 'practice' ? 'BREAK' : 'EFFORT_GENERAL';
      if (s.phase === 'BREAK') s.break_until = Date.now() + block.break_ms;
      this.store.save(s); this.store.log(s.id, s.attempt_id, 'attempt_completed', { block_id: block.id });
    }); return this.view(s);
  }
  submit(s: Session, phase: unknown, answer: unknown, timing: Record<string, unknown>) {
    const prior = this.store.events(s.id, s.attempt_id ?? undefined).find(e => e.type === 'answer_saved' && e.data.phase === phase);
    if (prior && prior.attempt_id === s.attempt_id) {
      if (JSON.stringify(prior.data.answer) !== JSON.stringify(answer)) throw new HttpError(409, '该页已经提交，不能覆盖原答案。'); return this.view(s);
    }
    if (phase !== s.phase) throw new HttpError(409, '页面已变化，请刷新。');
    if (s.phase === 'RECALL' && (typeof answer !== 'string' || answer.length > 10000)) throw new HttpError(422, '复述内容格式无效。');
    if (s.phase === 'PROBE' && (!Number.isInteger(answer) || Number(answer) < 0 || Number(answer) > 3)) throw new HttpError(422, '请选择一个答案。');
    if (['EFFORT_GENERAL', 'EFFORT_RECOVERY'].includes(s.phase) && (!Number.isInteger(answer) || Number(answer) < 1 || Number(answer) > 9)) throw new HttpError(422, '请选择1—9的评分。');
    if (!['RECALL', 'PROBE', 'EFFORT_GENERAL', 'EFFORT_RECOVERY'].includes(s.phase)) throw new HttpError(409, '当前不能提交答案。');
    const material = s.snapshot.materials.find(m => m.id === s.snapshot.blocks[s.index].material_id);
    this.store.tx(() => {
      this.store.log(s.id, s.attempt_id, 'answer_saved', { phase: s.phase, answer, correct: s.phase === 'PROBE' ? answer === material?.correct : null, ...timing });
      s.phase = s.phase === 'RECALL' ? 'PROBE' : s.phase === 'PROBE' ? 'EFFORT_GENERAL' : s.phase === 'EFFORT_GENERAL' && material ? 'EFFORT_RECOVERY' : 'BREAK';
      if (s.phase === 'BREAK') s.break_until = Date.now() + s.snapshot.blocks[s.index].break_ms;
      this.store.save(s);
    }); return this.view(s);
  }
  /** 同页提交多项（理解题＋努力量表）：先整体校验顺序与格式，再按原单项流程逐项落盘，保持原事件格式与幂等。 */
  submitBatch(s: Session, items: unknown, timing: (raw: unknown) => Record<string, unknown>) {
    if (!Array.isArray(items) || !items.length || items.length > 3) throw new HttpError(422, '批量答案无效。');
    const order = ['PROBE', 'EFFORT_GENERAL', 'EFFORT_RECOVERY'];
    const material = s.snapshot.materials.find(m => m.id === s.snapshot.blocks[s.index]?.material_id);
    if (!order.includes(items[0]?.phase)) throw new HttpError(422, '批量答案的页面顺序无效。');
    const expected = order.slice(order.indexOf(items[0].phase)).filter(p => p !== 'EFFORT_RECOVERY' || material);
    if (items.length !== expected.length || items.some((item, i) => item?.phase !== expected[i])) throw new HttpError(422, '批量答案的页面顺序无效。');
    for (const item of items) {
      if (item.phase === 'PROBE' && (!Number.isInteger(item.answer) || item.answer < 0 || item.answer > 3)) throw new HttpError(422, '请选择一个答案。');
      if (item.phase !== 'PROBE' && (!Number.isInteger(item.answer) || item.answer < 1 || item.answer > 9)) throw new HttpError(422, '请选择1—9的评分。');
    }
    let view = this.view(s);
    for (const item of items) view = this.submit(s, item.phase, item.answer, { ...timing(item.timing), batch: true });
    return view;
  }
  next(s: Session) {
    if (s.phase !== 'BREAK') throw new HttpError(409, '当前不是休息阶段。');
    this.store.tx(() => {
      this.store.log(s.id, s.attempt_id, 'break_ended', { remaining_ms: Math.max(0, (s.break_until ?? 0) - Date.now()), planned_ms: s.snapshot.blocks[s.index].break_ms });
      s.index++; s.phase = s.index >= s.snapshot.blocks.length ? 'COMPLETED' : 'READY'; s.attempt_id = null; s.break_until = null; this.store.save(s);
    }); return this.view(s);
  }
  interrupt(s: Session, reason: string, abort = false) {
    this.store.tx(() => {
      if (s.attempt_id && s.phase === 'RUNNING') this.store.db.prepare('UPDATE attempts SET status=?,ended_at=? WHERE id=?').run('invalid', new Date().toISOString(), s.attempt_id);
      this.store.log(s.id, s.attempt_id, abort ? 'session_aborted' : 'attempt_interrupted', { reason, partial: s.phase === 'RUNNING' });
      s.phase = abort ? 'ABORTED' : 'READY'; s.attempt_id = null; this.store.save(s);
    }); return this.view(s);
  }
}
