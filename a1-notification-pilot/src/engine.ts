import { randomUUID } from 'node:crypto';
import { Store, HttpError, type Session } from './store.ts';

export class Engine {
  store: Store;
  constructor(store: Store) { this.store = store; }
  view(s: Session) {
    const block = s.snapshot.blocks[s.index], material = s.snapshot.materials.find(m => m.id === block?.material_id);
    const { token_hash, snapshot, ...publicSession } = s;
    const question = s.phase === 'PROBE' && material ? { text: material.question, options: material.options } : null;
    return { ...publicSession, total_blocks: snapshot.blocks.length, preset: snapshot.preset, synthetic: snapshot.synthetic, pilot_round: snapshot.pilot_round,
      block: block ? { id: block.id, kind: block.kind, round: block.round, count: block.letters.length, stimulus_ms: block.stimulus_ms, soa_ms: block.soa_ms } : null,
      question, break_remaining_ms: Math.max(0, (s.break_until ?? 0) - Date.now()), mode: 'mock' };
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
    return { attempt_id: s.attempt_id, block, notification: material ? { id: material.id, text_lines: material.text_lines } : null };
  }
  finish(s: Session, owner: unknown) {
    this.store.requireOwner(s, owner);
    if (s.phase !== 'RUNNING') return this.view(s); // 相同完成请求网络重试不重复推进。
    const block = s.snapshot.blocks[s.index], events = this.store.events(s.id, s.attempt_id!);
    for (let i = 0; i < block.letters.length; i++) {
      if (!events.some(e => e.type === 'stimulus_onset' && e.data.index === i) || !events.some(e => e.type === 'item_end' && e.data.index === i)) throw new HttpError(409, '逐刺激记录未完整保存，先重试上传。');
    }
    if (!events.some(e => e.type === 'run_end')) throw new HttpError(409, '任务结束事件尚未保存。');
    this.store.tx(() => {
      this.store.db.prepare('UPDATE attempts SET status=?,ended_at=? WHERE id=?').run('completed', new Date().toISOString(), s.attempt_id);
      s.phase = block.kind === 'notification' ? 'RECALL' : block.kind === 'practice' ? 'BREAK' : 'EFFORT_GENERAL';
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
