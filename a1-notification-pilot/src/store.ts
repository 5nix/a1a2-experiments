import { DatabaseSync } from 'node:sqlite';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { hash, type Plan } from './protocol.ts';

export type Phase = 'READY' | 'RUNNING' | 'RECALL' | 'PROBE' | 'EFFORT_GENERAL' | 'EFFORT_RECOVERY' | 'BREAK' | 'COMPLETED' | 'ABORTED';
export interface Session { id: string; participant_id: string; token_hash: string; snapshot: Plan; index: number; phase: Phase; attempt_id: string | null; break_until: number | null; created_at: string; deleted_at?: string }
export interface ClientEvent { id: string; type: string; at: number; seq: number; data: Record<string, unknown> }
export class HttpError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true }); this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_entries (session_id TEXT PRIMARY KEY REFERENCES sessions(id), url TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS device_requests(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS device_audit(seq INTEGER PRIMARY KEY AUTOINCREMENT,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), block_index INTEGER NOT NULL, owner TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT);
      CREATE TABLE IF NOT EXISTS events (position INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id), attempt_id TEXT REFERENCES attempts(id), type TEXT NOT NULL, at REAL, seq INTEGER, data TEXT NOT NULL, fingerprint TEXT NOT NULL, received_at TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS event_sequence ON events(attempt_id,seq) WHERE seq IS NOT NULL;
      CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'append-only'); END;
      CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'append-only'); END;`);
  }
  tx<T>(work: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const value = work(); this.db.exec('COMMIT'); return value; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  all(includeDeleted = false) { return (this.db.prepare('SELECT data FROM sessions ORDER BY rowid DESC').all() as { data: string }[]).map(r => JSON.parse(r.data) as Session).filter(s => includeDeleted || !s.deleted_at); }
  get(id: string, includeDeleted = false) { const row = this.db.prepare('SELECT data FROM sessions WHERE id=?').get(id) as { data: string } | undefined; if (!row) throw new HttpError(404, '会话不存在。'); const s = JSON.parse(row.data) as Session; if (s.deleted_at && !includeDeleted) throw new HttpError(404, '会话已删除。'); return s; }
  deleteSession(id: string) {
    this.tx(() => {
      const s = this.get(id, true);
      if (s.deleted_at) return;
      if (!['COMPLETED', 'ABORTED'].includes(s.phase)) throw new HttpError(409, '请先结束会话，再删除。');
      s.deleted_at = new Date().toISOString(); this.save(s);
      this.log(s.id, s.attempt_id, 'session_deleted', { deleted_at: s.deleted_at });
    });
  }
  restoreSession(id: string) {
    this.tx(() => {
      const s = this.get(id, true);
      if (!s.deleted_at) return;
      delete s.deleted_at; this.save(s); this.log(s.id, s.attempt_id, 'session_restored', {});
    });
  }
  save(s: Session) { this.db.prepare('INSERT INTO sessions VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(s.id, JSON.stringify(s)); }
  create(participant: string, plan: Plan) {
    if (this.all().some(s => s.participant_id === participant && !['COMPLETED', 'ABORTED'].includes(s.phase))) throw new HttpError(409, '此编号已有进行中的会话，请选择已有会话。');
    const token = randomBytes(32).toString('hex');
    const s: Session = { id: randomUUID(), participant_id: participant, token_hash: hash(token), snapshot: plan, index: 0, phase: 'READY', attempt_id: null, break_until: null, created_at: new Date().toISOString() };
    const participant_url = `/experiment#session=${s.id}&token=${token}`;
    this.tx(() => { this.save(s); this.db.prepare('INSERT INTO session_entries VALUES (?,?)').run(s.id, participant_url); this.log(s.id, null, 'session_created', { config_hash: plan.hash, synthetic: plan.synthetic, material_version: plan.material_version ?? 'synthetic-v1', mode: plan.delivery_mode ?? 'mock', device_id: plan.device_id, response_mode: plan.response_mode, primary_modality: plan.primary_modality, input_sources: plan.input_sources }); });
    return { session_id: s.id, participant_url };
  }
  entry(id: string) { return (this.db.prepare('SELECT url FROM session_entries WHERE session_id=?').get(id) as { url: string } | undefined)?.url ?? null; }
  setting<T>(key: string): T | undefined { const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined; return row ? JSON.parse(row.value) as T : undefined; }
  setSetting(key: string, value: unknown) { this.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  auth(id: string, token: string) {
    const s = this.get(id), a = Buffer.from(hash(token)), b = Buffer.from(s.token_hash);
    if (!token || !timingSafeEqual(a, b)) throw new HttpError(401, '会话入口无效，请从后台重新打开。'); return s;
  }
  log(session: string, attempt: string | null, type: string, data: Record<string, unknown>) {
    this.db.prepare('INSERT INTO events(id,session_id,attempt_id,type,at,seq,data,fingerprint,received_at) VALUES (?,?,?,?,NULL,NULL,?,?,?)').run(randomUUID(), session, attempt, type, JSON.stringify(data), hash(data), new Date().toISOString());
  }
  attempt(id: string) { return this.db.prepare('SELECT * FROM attempts WHERE id=?').get(id) as { id: string; session_id: string; block_index: number; owner: string; status: string; started_at: string; ended_at: string | null } | undefined; }
  requireOwner(s: Session, owner: unknown) {
    const a = s.attempt_id ? this.attempt(s.attempt_id) : undefined;
    if (!a || typeof owner !== 'string' || a.owner !== owner) throw new HttpError(409, '本段任务由另一个页面控制；请返回原页面，或在后台中断后重跑。'); return a;
  }
  events(session: string, attempt?: string) {
    const rows = attempt ? this.db.prepare('SELECT * FROM events WHERE session_id=? AND attempt_id=? ORDER BY position').all(session, attempt) : this.db.prepare('SELECT * FROM events WHERE session_id=? ORDER BY position').all(session);
    return (rows as { id: string; type: string; at: number | null; seq: number | null; data: string; attempt_id: string | null; received_at: string }[]).map(r => ({ ...r, data: JSON.parse(r.data) as Record<string, unknown> }));
  }
  append(s: Session, attemptId: unknown, owner: unknown, events: ClientEvent[]) {
    const attempt = typeof attemptId === 'string' ? this.attempt(attemptId) : undefined;
    if (!attempt || attempt.session_id !== s.id || attempt.owner !== owner) throw new HttpError(409, '事件尝试或页面标识不匹配。');
    if (!Array.isArray(events) || events.length > 100) throw new HttpError(422, '事件批次无效。');
    this.tx(() => {
      for (const e of events) {
        if (!e || typeof e.id !== 'string' || e.id.length > 80 || !/^[a-z_]{1,60}$/.test(e.type) || !Number.isFinite(e.at) || e.at < 0 || !Number.isSafeInteger(e.seq) || e.seq < 0 || !e.data || typeof e.data !== 'object' || Array.isArray(e.data) || JSON.stringify(e.data).length > 10000) throw new HttpError(422, '事件字段无效。');
        const fingerprint = hash(e), prior = this.db.prepare('SELECT fingerprint,session_id,attempt_id FROM events WHERE id=?').get(e.id) as { fingerprint: string; session_id: string; attempt_id: string } | undefined;
        if (prior) { if (prior.fingerprint !== fingerprint || prior.session_id !== s.id || prior.attempt_id !== attempt.id) throw new HttpError(409, '重复事件内容冲突。'); continue; }
        if (attempt.status === 'completed') throw new HttpError(409, '完整尝试不能追加新事件。');
        this.db.prepare('INSERT INTO events(id,session_id,attempt_id,type,at,seq,data,fingerprint,received_at) VALUES (?,?,?,?,?,?,?,?,?)').run(e.id, s.id, attempt.id, e.type, e.at, e.seq, JSON.stringify(e.data), fingerprint, new Date().toISOString());
      }
    });
  }
}
