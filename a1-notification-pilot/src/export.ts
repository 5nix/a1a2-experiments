import { strToU8, zipSync } from 'fflate';
import type { Session, Store } from './store.ts';
type Row = Record<string, unknown>;
function csv(rows: Row[], columns?: string[]) {
  const headers = columns ?? [...new Set(rows.flatMap(Object.keys))];
  const cell = (v: unknown) => { let t = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); if (typeof v === 'string' && /^[=+\-@\t\r]/.test(t)) t = "'" + t; return '"' + t.replaceAll('"', '""') + '"'; };
  return '\uFEFF' + [headers.map(cell).join(','), ...rows.map(r => headers.map(h => cell(r[h])).join(','))].join('\r\n') + '\r\n';
}
/** 由原始刺激/输入事件重算，只对完整的有效尝试评分，边界项独立标记。 */
export function analyze(store: Store, session: Session) {
  const all = store.events(session.id), items: Row[] = [], summaries: Row[] = [];
  const attempts = store.db.prepare('SELECT * FROM attempts WHERE session_id=? ORDER BY rowid').all(session.id) as { id: string; block_index: number; status: string }[];
  for (const attempt of attempts) {
    const block = session.snapshot.blocks[attempt.block_index], events = all.filter(e => e.attempt_id === attempt.id);
    const onset = events.find(e => e.type === 'notification_onset' || e.type === 'sham_onset')?.at;
    const offset = events.find(e => e.type === 'notification_offset' || e.type === 'sham_offset')?.at;
    const disrupted = events.some(e => ['window_blur', 'visibility_hidden', 'timing_gap', 'local_storage_failed'].includes(e.type));
    const attemptItems: Row[] = [];
    for (let i = 0; i < block.letters.length; i++) {
      const start = events.find(e => e.type === 'stimulus_onset' && e.data.index === i);
      if (!start || start.at === null) continue;
      const end = events.find(e => e.type === 'item_end' && e.data.index === i);
      const inputs = events.filter(e => e.type === 'response' && e.data.index === i && e.data.accepted === true && e.at !== null && e.at >= start.at! && (end?.at == null || e.at < end.at));
      const response = inputs.sort((a, b) => a.at! - b.at!)[0];
      const target = i >= 2 && block.letters[i] === block.letters[i - 2];
      const warmup = i < 2;
      const classification = warmup ? 'unscored' : target ? response ? 'hit' : 'miss' : response ? 'false_alarm' : 'correct_rejection';
      const boundary = onset != null && offset != null && end?.at != null && ((start.at < onset && end.at > onset) || (start.at < offset && end.at > offset));
      const window = block.kind === 'practice' ? 'practice' : onset == null || offset == null ? 'unknown' : boundary ? 'boundary' : start.at < onset ? 'pre' : start.at < offset ? 'during' : 'post';
      attemptItems.push({ session_id: session.id, participant_id: session.participant_id, pilot_round: session.snapshot.pilot_round,
        attempt_id: attempt.id, block_id: block.id, block_type: block.kind, material_id: block.material_id,
        index: i, stimulus: block.letters[i], is_target: target, response: !!response, input_source: response?.data.source ?? null,
        rt_ms: response?.at != null ? response.at - start.at : null, classification,
        correct: warmup || !end ? null : classification === 'hit' || classification === 'correct_rejection',
        valid: !warmup && !!end && attempt.status === 'completed' && !disrupted,
        onset_ms: start.at, planned_onset_ms: start.data.planned_at, end_ms: end?.at ?? null,
        window, attempt_status: attempt.status, qc_disrupted: disrupted, clock: 'browser_performance', presentation: 'mock_browser' });
    }
    items.push(...attemptItems);
    for (const window of ['pre', 'during', 'post', 'boundary', 'practice']) {
      const eligible = attemptItems.filter(r => r.window === window && r.valid === true), rt = eligible.filter(r => r.classification === 'hit' && typeof r.rt_ms === 'number').map(r => Number(r.rt_ms));
      summaries.push({ session_id: session.id, participant_id: session.participant_id, attempt_id: attempt.id, block_id: block.id, block_type: block.kind, window,
        eligible: eligible.length, accuracy: eligible.length ? eligible.filter(r => r.correct).length / eligible.length : null,
        hit_rt_mean_ms: rt.length ? rt.reduce((a, b) => a + b, 0) / rt.length : null,
        hit: eligible.filter(r => r.classification === 'hit').length, miss: eligible.filter(r => r.classification === 'miss').length,
        false_alarm: eligible.filter(r => r.classification === 'false_alarm').length, correct_rejection: eligible.filter(r => r.classification === 'correct_rejection').length });
    }
  }
  return { events: all, items, summaries, attempts };
}
export function bundle(store: Store, sessions: Session[]) {
  const data = sessions.map(s => ({ session: s, analysis: analyze(store, s) }));
  const raw = data.flatMap(d => d.analysis.events.map(e => ({ ...e, session_id: d.session.id, participant_id: d.session.participant_id })));
  const files: Record<string, string> = {
    'events.jsonl': raw.map(e => JSON.stringify(e)).join('\n') + '\n',
    'primary_items.csv': csv(data.flatMap(d => d.analysis.items)),
    'summary.csv': csv(data.flatMap(d => d.analysis.summaries)),
    'accuracy_changes.csv': csv(data.flatMap(d => d.analysis.attempts.flatMap(attempt => {
      const rows = d.analysis.summaries.filter(r => r.attempt_id === attempt.id), pre = rows.find(r => r.window === 'pre');
      return ['during', 'post'].map(window => {
        const other = rows.find(r => r.window === window), a = pre?.accuracy, b = other?.accuracy;
        return { session_id: d.session.id, participant_id: d.session.participant_id, attempt_id: attempt.id, window,
          baseline_eligible: pre?.eligible ?? 0, window_eligible: other?.eligible ?? 0,
          baseline_accuracy: a ?? null, window_accuracy: b ?? null,
          accuracy_drop_percentage_points: typeof a === 'number' && typeof b === 'number' ? (a - b) * 100 : null,
          relative_accuracy_drop: typeof a === 'number' && a > 0 && typeof b === 'number' ? (a - b) / a : null,
          relative_drop_semantics: '(pre-window)/pre; pre=0或缺数据时留空；负值表示提高，不截为0' };
      });
    }))),
    'answers.csv': csv(raw.filter(e => e.type === 'answer_saved').map(e => ({ session_id: e.session_id, participant_id: e.participant_id, attempt_id: e.attempt_id, received_at: e.received_at, ...e.data }))),
    'notifications.csv': csv(raw.filter(e => ['notification_onset', 'notification_offset', 'sham_onset', 'sham_offset'].includes(e.type)).map(e => ({ session_id: e.session_id, attempt_id: e.attempt_id, type: e.type, at_ms: e.at, ...e.data }))),
    'plan.json': JSON.stringify(data.map(d => ({ session_id: d.session.id, participant_id: d.session.participant_id, plan: d.session.snapshot })), null, 2),
    'session_qc.json': JSON.stringify(data.map(d => ({ session_id: d.session.id, phase: d.session.phase, attempts: d.analysis.attempts, disruptions: d.analysis.events.filter(e => ['window_blur', 'visibility_hidden', 'timing_gap', 'attempt_interrupted'].includes(e.type)), synthetic: true, real_glasses: false })), null, 2),
    'manifest.json': JSON.stringify({ schema_version: 'a1-0.1', created_at: new Date().toISOString(), presentation: 'mock_browser', synthetic: true, real_glasses: false,
      timing: '客户端performance原值与time_origin保留于事件；通知为同浏览器模拟显示。服务器接收时间不能代替实际呈现时间；不代表真机或光学精度。',
      scoring: 'target_only：鼠标左键/空格同为匹配；前两项不评分；额外输入不改变首响应；RT仅对实际按键记录，未响应为空。失焦/时序异常尝试排除；边界项单列。正式基线下降率用准确率差和明确分母派生。' }, null, 2),
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, value]) => [name, strToU8(value)])), { level: 1 });
}
