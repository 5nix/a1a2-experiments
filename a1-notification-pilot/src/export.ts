import { strToU8, zipSync } from 'fflate';
import type { Session, Store } from './store.ts';
import { checkPlan } from './plan-check.ts';
import { hash, primaryModality } from './protocol.ts';
import { mapDeviceNotification } from './clock-mapping.ts';
import { analyzeTrackingAttempt } from './tracking-analysis.ts';
import { analysisWindows, inWindow, performance, performanceChanges, phaseForInterval, poolItems } from './analysis.ts';
type Row = Record<string, unknown>;
function csv(rows: Row[], columns?: string[]) {
  const headers = columns ?? [...new Set(rows.flatMap(Object.keys))];
  const cell = (v: unknown) => { let t = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); if (typeof v === 'string' && /^[=+\-@\t\r]/.test(t)) t = "'" + t; return '"' + t.replaceAll('"', '""') + '"'; };
  return '\uFEFF' + [headers.map(cell).join(','), ...rows.map(r => headers.map(h => cell(r[h])).join(','))].join('\r\n') + '\r\n';
}
/** 由原始刺激/输入事件重算，只对完整的有效尝试评分，边界项独立标记。 */
export function analyze(store: Store, session: Session) {
  const modality = primaryModality(session.snapshot), audioManifest = session.snapshot.audio_manifest;
  const all = store.events(session.id), items: Row[] = [], summaries: Row[] = [], trials: Row[] = [];
  const tracking_samples: Row[] = [], tracking_summary: Row[] = [], tracking_recovery: Row[] = [];
  const attempts = store.db.prepare('SELECT * FROM attempts WHERE session_id=? ORDER BY rowid').all(session.id) as { id: string; block_index: number; status: string }[];
  for (const attempt of attempts) {
    const block = session.snapshot.blocks[attempt.block_index], events = all.filter(e => e.attempt_id === attempt.id);
    if (modality === 'compensatory_tracking') {
      const tracking = analyzeTrackingAttempt(session, block, attempt, events);
      tracking_samples.push(...tracking.samples); tracking_summary.push(...tracking.summary); tracking_recovery.push(...tracking.recovery); trials.push(tracking.trial);
      continue;
    }
    const material = session.snapshot.materials.find(m => m.id === block.material_id);
    const deviceNotification = session.snapshot.delivery_mode === 'rayneo' && block.kind === 'notification';
    const deviceTiming = deviceNotification ? mapDeviceNotification(events) : null;
    const edge = (kind: 'onset' | 'offset') => events.find(e => e.type === `notification_${kind}` || e.type === `sham_${kind}`);
    const onset = deviceNotification ? deviceTiming!.onset_ms : edge('onset')?.at ?? null;
    const offset = deviceNotification ? deviceTiming!.offset_ms : edge('offset')?.at ?? null;
    const uncertainty = deviceTiming?.uncertainty_ms ?? 0;
    const timingVerified = deviceNotification ? deviceTiming!.verified : onset !== null && offset !== null && offset >= onset;
    const earlyMs = block.post_early_ms ?? session.snapshot.timing?.post_early_ms ?? 10000;
    const answer = (phase: string) => events.find(e => e.type === 'answer_saved' && e.data.phase === phase)?.data;
    const linked = { recall: answer('RECALL')?.answer ?? null, comprehension_answer: answer('PROBE')?.answer ?? null, comprehension_correct: answer('PROBE')?.correct ?? null,
      effort_general: answer('EFFORT_GENERAL')?.answer ?? null, effort_recovery: answer('EFFORT_RECOVERY')?.answer ?? null,
      n_units: material?.n_units ?? null, question: material?.question ?? null, question_correct_answer: material?.correct ?? null };
    const audioScheduleIncomplete = modality === 'auditory_digits' && block.letters.some((_, index) => !events.some(e => e.type === 'audio_scheduled' && e.data.index === index));
    const common = { qc_audio_schedule_incomplete: audioScheduleIncomplete, primary_modality: modality, audio_manifest_version: audioManifest?.version ?? null, audio_manifest_sha256: audioManifest ? hash(audioManifest) : null,
      analysis_condition: hash({ primary_modality: modality, audio_manifest_sha256: audioManifest ? hash(audioManifest) : null, pilot_round: session.snapshot.pilot_round, mode: session.snapshot.delivery_mode ?? 'mock', stimulus_ms: block.stimulus_ms, soa_ms: block.soa_ms, pre_ms: block.pre_ms ?? block.baseline_count * block.soa_ms, notification_ms: block.notification_ms, post_ms: block.post_ms ?? null, post_early_ms: earlyMs }), session_id: session.id, participant_id: session.participant_id, attempt_id: attempt.id, block_id: block.id, block_type: block.kind,
      material_id: block.material_id, n_count: material?.n_count ?? material?.iu_count ?? null, domain: material?.domain ?? null,
      notification_onset_ms: onset, notification_offset_ms: offset, notification_duration_actual_ms: timingVerified ? offset! - onset! : null,
      post_early_ms: earlyMs, timing_verified: timingVerified, timing_qc: deviceNotification ? deviceTiming!.reason : null, clock_mapping_uncertainty_ms: deviceTiming?.uncertainty_ms ?? null, ...linked };
    const disrupted = audioScheduleIncomplete || events.some(e => ['window_blur', 'visibility_hidden', 'timing_gap', 'local_storage_failed', 'audio_interrupted', 'audio_schedule_failed', 'audio_context_failed', 'audio_asset_failed', 'audio_decode_failed', 'audio_hash_mismatch'].includes(e.type));
    const attemptItems: Row[] = [];
    for (let i = 0; i < block.letters.length; i++) {
      const start = events.find(e => e.type === 'stimulus_onset' && e.data.index === i);
      if (!start || start.at === null) continue;
      const end = events.find(e => e.type === 'item_end' && e.data.index === i);
      const inputs = events.filter(e => e.type === 'response' && e.data.index === i && e.data.accepted === true && e.at !== null && e.at >= start.at! && (end?.at == null || e.at < end.at));
      const response = inputs.sort((a, b) => a.at! - b.at!)[0];
      const target = i >= 2 && block.letters[i] === block.letters[i - 2];
      const warmup = i < 2;
      const audioSchedule = events.find(e => e.type === 'audio_scheduled' && e.data.index === i);
      const clip = audioManifest?.clips.find(c => String(c.symbol ?? c.digit) === block.letters[i]);
      const audioEvidence = modality === 'auditory_digits' ? {
        audio_schedule_event_at_ms: audioSchedule?.at ?? null, audio_software_onset_ms: start.at, audio_observed_at_ms: start.data.observed_at ?? null,
        audio_context_time: start.data.audio_context_time ?? audioSchedule?.data.audio_context_time ?? null,
        planned_audio_time: start.data.planned_audio_time ?? audioSchedule?.data.planned_audio_time ?? null, audio_schedule_data: audioSchedule?.data ?? null,
        audio_reported_sha256: start.data.audio_sha256 ?? audioSchedule?.data.audio_sha256 ?? null,
        audio_schedule_evidence_present: !!audioSchedule, audio_onset_event_data: start.data, audio_clip_url: clip?.url ?? null, audio_clip_sha256: clip?.sha256 ?? null, audio_clip_duration_ms: clip?.duration_ms ?? null,
        acoustic_onset_ms: null, acoustic_onset_verified: false, audio_timing_basis: 'browser_software_schedule; acoustic onset is unmeasured',
      } : {};
      const classification = warmup ? 'unscored' : target ? response ? 'hit' : 'miss' : response ? 'false_alarm' : 'correct_rejection';
      const phases = phaseForInterval(start.at, end?.at ?? null, timingVerified ? onset : null, timingVerified ? offset : null, earlyMs, uncertainty);
      const window = block.kind === 'practice' ? 'practice' : phases.window;
      attemptItems.push({ ...common, ...audioEvidence, ...phases, session_id: session.id, participant_id: session.participant_id, pilot_round: session.snapshot.pilot_round,
        attempt_id: attempt.id, block_id: block.id, block_type: block.kind, material_id: block.material_id,
        n_count: material?.n_count ?? material?.iu_count ?? null, line_count: material?.line_count ?? material?.text_lines.length ?? null,
        character_count: material?.character_count ?? null, domain: material?.domain ?? null, material_version: session.snapshot.material_version ?? 'synthetic-v1',
        index: i, stimulus: block.letters[i], is_target: target, response: !!response, input_source: response?.data.source ?? null,
        rt_ms: response?.at != null ? response.at - start.at : null, classification,
        correct: warmup || !end ? null : classification === 'hit' || classification === 'correct_rejection',
        partial_response_window: end?.data.partial_response_window === true,
        valid: !warmup && (modality !== 'auditory_digits' || !!audioSchedule) && end?.data.partial_response_window !== true && end?.at != null && end.at > start.at && attempt.status === 'completed' && !disrupted,
        onset_ms: start.at, planned_onset_ms: start.data.planned_at, end_ms: end?.at ?? null,
        window, attempt_status: attempt.status, qc_disrupted: disrupted, clock: 'browser_performance', presentation: session.snapshot.delivery_mode === 'rayneo' ? 'rayneo_image' : 'mock_browser',
        timing_qc: common.timing_qc });
    }
    items.push(...attemptItems);
    trials.push({ ...common, block_index: attempt.block_index, attempt_status: attempt.status, letters: block.letters, ...performance(attemptItems), qc_disrupted: disrupted });
    for (const window of analysisWindows) summaries.push({ ...common, window, ...performance(attemptItems.filter(r => inWindow(r, window))) });
  }

  return { events: all, items, summaries, attempts, trials, tracking_samples, tracking_summary, tracking_recovery, pooled: poolItems(items), pooled_summaries: poolItems(items), balance: sequenceBalance(session) };
}
export function bundle(store: Store, sessions: Session[]) {
  const data = sessions.map(s => ({ session: s, analysis: analyze(store, s) }));
  const raw = data.flatMap(d => d.analysis.events.map(e => ({ ...e, session_id: d.session.id, participant_id: d.session.participant_id })));
  const files: Record<string, string> = {
    'audio_events.csv': csv(raw.filter(e => e.type.startsWith('audio_') || e.type === 'run_start' || e.type === 'stimulus_onset').map(e => ({ session_id: e.session_id, participant_id: e.participant_id, attempt_id: e.attempt_id, type: e.type, browser_event_at_ms: e.at, received_at: e.received_at, ...e.data }))),
    'audio_manifests.json': JSON.stringify(data.map(d => ({ session_id: d.session.id, primary_modality: primaryModality(d.session.snapshot), audio_manifest: d.session.snapshot.audio_manifest ?? null, audio_manifest_sha256: d.session.snapshot.audio_manifest ? hash(d.session.snapshot.audio_manifest) : null })), null, 2),
    'tracking_samples.csv': csv(data.flatMap(d => d.analysis.tracking_samples)),
    'tracking_summary.csv': csv(data.flatMap(d => d.analysis.tracking_summary)),
    'tracking_recovery.csv': csv(data.flatMap(d => d.analysis.tracking_recovery)),
    'tracking_inputs.csv': csv(raw.filter(e => e.type.startsWith('tracking_') && e.type !== 'tracking_sample').flatMap(e => {
      const { samples, ...payload } = e.data;
      const batched = e.type === 'tracking_input' && Array.isArray(samples);
      const inputs = batched ? samples as Row[] : [payload];
      return inputs.map((input, index) => ({ ...payload, ...input,
        session_id: e.session_id, participant_id: e.participant_id, attempt_id: e.attempt_id,
        event_id: e.id, type: e.type, at_ms: e.at, batch_event_at_ms: e.at,
        input_index_in_event: e.type === 'tracking_input' ? index : null,
        input_count_in_event: e.type === 'tracking_input' ? inputs.length : null,
      }));
    })),
    'events.jsonl': raw.map(e => JSON.stringify(e)).join('\n') + '\n',
    'primary_items.csv': csv(data.flatMap(d => d.analysis.items)),
    'summary.csv': csv(data.flatMap(d => d.analysis.summaries)),
    'accuracy_changes.csv': csv(data.flatMap(d => performanceChanges(d.analysis.summaries, ['session_id', 'participant_id', 'attempt_id', 'block_id', 'block_type', 'n_count']))),
    'pooled_summary.csv': csv(poolItems(data.flatMap(d => d.analysis.items))),
    'pooled_changes.csv': csv(performanceChanges(poolItems(data.flatMap(d => d.analysis.items)), ['participant_id', 'n_count', 'block_type', 'analysis_condition'])),
    'sequence_balance.csv': csv(data.flatMap(d => d.analysis.balance)),
    'full_trial_plan.csv': csv(data.flatMap(d => fullTrialPlan(d.session, d.analysis.trials))),
    'answers.csv': csv(raw.filter(e => e.type === 'answer_saved').map(e => ({ session_id: e.session_id, participant_id: e.participant_id, attempt_id: e.attempt_id, received_at: e.received_at, ...e.data }))),
    'notifications.csv': csv(raw.filter(e => ['notification_onset', 'notification_offset', 'sham_onset', 'sham_offset', 'device_image_event', 'device_clock_calibration'].includes(e.type)).map(e => ({ session_id: e.session_id, attempt_id: e.attempt_id, type: e.type, at_ms: e.at, ...e.data }))),
    'plan.json': JSON.stringify(data.map(d => ({ session_id: d.session.id, participant_id: d.session.participant_id, plan: d.session.snapshot })), null, 2),
    'materials.json': JSON.stringify(data.map(d => ({ session_id: d.session.id, material_version: d.session.snapshot.material_version ?? 'synthetic-v1', materials: d.session.snapshot.materials })), null, 2),
    'device_requests.json': JSON.stringify((store.db.prepare('SELECT data FROM device_requests ORDER BY rowid').all() as { data: string }[]).map(r => JSON.parse(r.data)).filter(r => sessions.some(s => s.id === r.session_id)), null, 2),
    'session_qc.json': JSON.stringify(data.map(d => ({ session_id: d.session.id, phase: d.session.phase, attempts: d.analysis.attempts, disruptions: d.analysis.events.filter(e => ['window_blur', 'visibility_hidden', 'timing_gap', 'attempt_interrupted', 'device_send_failed', 'audio_interrupted', 'audio_schedule_failed', 'audio_context_failed', 'audio_asset_failed', 'audio_decode_failed', 'audio_hash_mismatch', 'tracking_interrupted', 'tracking_missing_input', 'tracking_render_failed', 'viewport_changed'].includes(e.type)), synthetic: d.session.snapshot.synthetic, material_version: d.session.snapshot.material_version ?? 'synthetic-v1', real_glasses: d.session.snapshot.delivery_mode === 'rayneo', timing_qc: d.analysis.trials.map(t => ({ attempt_id: t.attempt_id, timing_qc: t.timing_qc, uncertainty_ms: t.clock_mapping_uncertainty_ms })) })), null, 2),
    'manifest.json': JSON.stringify({ schema_version: 'a1-0.7-tracking', primary_modalities: [...new Set(sessions.map(s => primaryModality(s.snapshot)))], audio_timing: 'AudioContext/浏览器调度及原始事件为软件证据；不等于扬声器或耳机声学onset，未测量的acoustic_onset保留null；听觉异常尝试排除统计。', created_at: new Date().toISOString(), presentation: [...new Set(sessions.map(s => s.snapshot.delivery_mode ?? 'mock'))], synthetic: data.every(d => d.session.snapshot.synthetic), real_glasses: sessions.some(s => s.snapshot.delivery_mode === 'rayneo'),
      timing: '客户端performance原值与time_origin保留于事件。Mock使用同浏览器模拟时间。RayNeo独立保存设备uptime/clock_id与浏览器请求意图，采用任务前后browser→Android括号采样和drawn/hidden事件进行软件时钟映射；验证失败时窗口标unknown，保留误差界并扩展边界；不代表光学精度。',
      tracking_scoring: '追踪样本按实际间隔加权，以相邻径向误差线性插值积分计算RMSE、平均误差和目标区域内时间比例；样本不是独立被试。>=200ms gap、通知边界及异常/中断尝试排除；真实通知时钟未知不生成During或恢复曲线。恢复分窗相对实际offset按1s切分有效post区间并与Pre比较；不推定恢复时间。',
      scoring: '旧2back快照使用target_only：鼠标左键/空格同为匹配；前两项不评分；额外输入不改变首响应；RT仅对实际按键记录，未响应为空。失焦/时序异常尝试排除；边界项单列。被试×N×阶段先合并有效计数再计算accuracy、hit、FA、balanced accuracy；命中RT给均值/中位数/n。无分母或无命中RT为null/CSV空白；post早晚跨界刺激保留post汇总但不进入早晚分窗。' }, null, 2),
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, value]) => [name, strToU8(value)])), { level: 1 });
}

/** Planned exposure counts are reviewable separately from observed/scored data. */
export function sequenceBalance(session: Session) {
  if (primaryModality(session.snapshot) === 'compensatory_tracking') return [];
  const check = checkPlan(session.snapshot);
  return check.rows.map(row => ({ session_id: session.id, participant_id: session.participant_id,
    seed: session.snapshot.seed, primary_modality: primaryModality(session.snapshot), plan_hash: session.snapshot.hash, ...row,
    n_count: row.n_level, window: row.phase, stimulus_n: row.eligible, target_n: row.targets, non_target_n: row.non_targets,
    boundary_stimuli: check.boundary_stimuli, warnings: check.warnings, rule: check.rule }));
}

function fullTrialPlan(session: Session, trials: Row[]) {
  return session.snapshot.blocks.flatMap((block, block_index) => {
    const material = session.snapshot.materials.find(m => m.id === block.material_id);
    const attempts = trials.filter(t => t.block_id === block.id);
    return (attempts.length ? attempts : [{}]).map(attempt => ({ session_id: session.id, participant_id: session.participant_id,
      seed: session.snapshot.seed, tracking_config: session.snapshot.tracking ?? null, primary_modality: primaryModality(session.snapshot), audio_manifest_version: session.snapshot.audio_manifest?.version ?? null, plan_hash: session.snapshot.hash, block_index, ...block,
      n_count: material?.n_count ?? material?.iu_count ?? null, domain: material?.domain ?? null, n_units: material?.n_units ?? null,
      text_lines: material?.text_lines ?? null, question: material?.question ?? null, options: material?.options ?? null, question_correct_answer: material?.correct ?? null,
      planned_notification_onset_ms: (block.pre_ms ?? block.baseline_count * block.soa_ms), planned_notification_offset_ms: (block.pre_ms ?? block.baseline_count * block.soa_ms) + block.notification_ms,
      ...attempt }));
  });
}
