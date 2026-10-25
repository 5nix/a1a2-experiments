import type { Session } from './store.ts';
import type { Block } from './protocol.ts';
import { hash } from './protocol.ts';
import { mapDeviceNotification } from './clock-mapping.ts';

export type TrackingRow = Record<string, unknown>;
export interface TrackingEvent { id?: string; type: string; at: number | null; data: Record<string, unknown> }
export interface TrackingAttempt { id: string; block_index: number; status: string }
interface Interval { start: number; end: number; e0: number; e1: number; window: string; valid: boolean; reason: string | null }
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const GAP_MS = 200;
const DISRUPTIONS = ['window_blur', 'visibility_hidden', 'timing_gap', 'local_storage_failed', 'attempt_interrupted', 'session_aborted', 'tracking_interrupted', 'tracking_failed', 'tracking_pointer_unlocked', 'pointer_lock_lost', 'tracking_context_failed', 'tracking_input_failed', 'tracking_missing_input', 'tracking_render_failed', 'viewport_changed'];

/** Linear interpolation between observed error samples; milliseconds are weights,
 * never independent observations. Recovery bins clip eligible intervals analytically.
 * Notification-boundary intervals and gaps >=200ms are excluded before clipping. */
function metrics(intervals: Interval[], radius: number | null, start = -Infinity, end = Infinity) {
  let duration = 0, errorArea = 0, squareArea = 0, inTargetTime = 0, interval_n = 0;
  let excluded_duration_ms = 0, excluded_interval_n = 0;
  for (const interval of intervals) {
    const a = Math.max(start, interval.start), b = Math.min(end, interval.end);
    if (b <= a) continue;
    if (!interval.valid) { excluded_duration_ms += b - a; excluded_interval_n++; continue; }
    const span = interval.end - interval.start, dt = b - a;
    const e0 = interval.e0 + (interval.e1 - interval.e0) * (a - interval.start) / span;
    const e1 = interval.e0 + (interval.e1 - interval.e0) * (b - interval.start) / span;
    duration += dt; errorArea += dt * (e0 + e1) / 2;
    // Exact integral of squared linearly interpolated scalar radial error.
    squareArea += dt * (e0 * e0 + e0 * e1 + e1 * e1) / 3;
    if (radius !== null) {
      const low = Math.min(e0, e1), high = Math.max(e0, e1);
      inTargetTime += dt * (high <= radius ? 1 : low >= radius ? 0 : (radius - low) / (high - low));
    }
    interval_n++;
  }
  return { valid_duration_ms: duration, interval_n, excluded_duration_ms, excluded_interval_n,
    rmse: duration ? Math.sqrt(squareArea / duration) : null, mean_error: duration ? errorArea / duration : null,
    in_target_fraction: duration && radius !== null ? inTargetTime / duration : null,
    target_radius: radius, valid: duration > 0 };
}

export function analyzeTrackingAttempt(session: Session, block: Block, attempt: TrackingAttempt, events: TrackingEvent[]) {
  const material = session.snapshot.materials.find(m => m.id === block.material_id);
  const isDevice = session.snapshot.delivery_mode === 'rayneo' && block.kind === 'notification';
  const mapping = isDevice ? mapDeviceNotification(events) : null;
  const edge = (kind: string) => events.find(e => e.type === `notification_${kind}` || e.type === `sham_${kind}`)?.at ?? null;
  const onset = isDevice ? mapping!.onset_ms : edge('onset'), offset = isDevice ? mapping!.offset_ms : edge('offset');
  const timingVerified = isDevice ? mapping!.verified : finite(onset) && finite(offset) && offset > onset;
  const uncertainty = mapping?.uncertainty_ms ?? 0;
  const radiusValue = session.snapshot.tracking?.target_radius, radius = finite(radiusValue) && radiusValue > 0 ? radiusValue : null;
  const began = events.find(e => e.type === 'tracking_started'), ended = events.find(e => e.type === 'tracking_ended');
  const validRecording = finite(began?.at) && finite(ended?.at) && ended.at > began.at && events.some(e => e.type === 'run_end');
  const raw = events.filter(e => e.type === 'tracking_sample');
  const firstAt = raw[0]?.at, lastAt = raw[raw.length - 1]?.at;
  const leadingGap = finite(firstAt) && finite(began?.at) ? firstAt - began.at : null;
  const trailingGap = finite(lastAt) && finite(ended?.at) ? ended.at - lastAt : null;
  // 只有记录期内的干扰才作废追踪：倒计时里的视口跳变、追踪结束后才发生的主试中止（partial=false）都不影响已记录的样本。
  // 没有页面时间戳的服务端事件按 partial 判断；记录起止缺失时全部计入。
  const disrupts = (e: TrackingEvent) => !finite(e.at) ? e.data.partial !== false
    : !finite(began?.at) || !finite(ended?.at) || e.at >= began!.at! && e.at <= ended!.at!;
  const qc = [...new Set(events.filter(e => DISRUPTIONS.includes(e.type) && disrupts(e)).map(e => e.type))];
  if (attempt.status !== 'completed') qc.push(`attempt_${attempt.status}`);
  if (!validRecording) qc.push('tracking_recording_incomplete');
  if (raw.length < 2) qc.push('tracking_samples_incomplete');
  if (leadingGap !== null && leadingGap >= GAP_MS || trailingGap !== null && trailingGap >= GAP_MS) qc.push('tracking_endpoint_gap');
  if (radius === null) qc.push('target_radius_missing_or_invalid');
  const attemptValid = attempt.status === 'completed' && validRecording && qc.length === 0;
  const answer = (phase: string) => events.find(e => e.type === 'answer_saved' && e.data.phase === phase)?.data;
  const common: TrackingRow = { session_id: session.id, participant_id: session.participant_id, pilot_round: session.snapshot.pilot_round,
    primary_modality: 'compensatory_tracking', attempt_id: attempt.id, block_id: block.id, block_index: attempt.block_index, block_type: block.kind,
    material_id: block.material_id, material_version: session.snapshot.material_version ?? null, n_count: material?.n_count ?? material?.iu_count ?? null,
    domain: material?.domain ?? null, n_units: material?.n_units ?? null, question: material?.question ?? null, question_correct_answer: material?.correct ?? null,
    comprehension_answer: answer('PROBE')?.answer ?? null, comprehension_correct: answer('PROBE')?.correct ?? null,
    comprehension_timing: answer('PROBE') ?? null, effort_general: answer('EFFORT_GENERAL')?.answer ?? null, effort_recovery: answer('EFFORT_RECOVERY')?.answer ?? null,
    tracking_seed: block.tracking_seed ?? null, tracking_config: session.snapshot.tracking ?? null, plan_hash: session.snapshot.hash,
    analysis_condition: hash({ modality: 'compensatory_tracking', tracking: session.snapshot.tracking, pre_ms: block.pre_ms, notification_ms: block.notification_ms, post_ms: block.post_ms, mode: session.snapshot.delivery_mode }),
    notification_onset_ms: timingVerified ? onset : null, notification_offset_ms: timingVerified ? offset : null,
    notification_duration_actual_ms: timingVerified ? offset! - onset! : null, timing_verified: timingVerified,
    timing_qc: isDevice ? mapping!.reason : block.kind === 'practice' ? 'practice_no_notification' : timingVerified ? 'browser_actual_events' : 'notification_timing_missing',
    clock_mapping_uncertainty_ms: isDevice ? uncertainty : null, attempt_status: attempt.status, qc_flags: qc,
    tracking_start_ms: began?.at ?? null, tracking_end_ms: ended?.at ?? null,
    leading_unobserved_ms: leadingGap, trailing_unobserved_ms: trailingGap,
    analysis_unit: 'participant_trial; samples_are_not_independent_participants', error_units: 'normalized_task_coordinates',
    integration_method: 'scalar_radial_error_linear_interpolation; exact_integral_of_squared_linear_error; time_weights_ms', gap_exclusion_ms: GAP_MS };
  const intervals: Interval[] = [], samples: TrackingRow[] = [];
  const errorFor = (e: TrackingEvent) => finite(e.data.x) && finite(e.data.y) && (e.data.target_x == null || finite(e.data.target_x)) && (e.data.target_y == null || finite(e.data.target_y))
    ? Math.hypot(e.data.x - Number(e.data.target_x ?? 0), e.data.y - Number(e.data.target_y ?? 0)) : null;
  for (let index = 0; index < raw.length; index++) {
    const current = raw[index], previous = raw[index - 1];
    const e1 = errorFor(current), e0 = previous ? errorFor(previous) : null;
    const start = previous?.at ?? null, end = current.at;
    let window = block.kind === 'practice' ? 'practice' : 'unknown', reason: string | null = null;
    const dt = finite(start) && finite(end) ? end - start : null;
    if (!previous) reason = 'first_sample_no_interval';
    else if (!finite(start) || !finite(end) || dt === null || dt <= 0) reason = 'nonmonotonic_or_missing_timestamp';
    else if (e0 === null || e1 === null) reason = 'invalid_position';
    else if (dt >= GAP_MS) reason = 'sample_gap';
    else if (!validRecording || start < began!.at! || end > ended!.at!) reason = 'outside_recording_or_incomplete';
    if (finite(start) && finite(end) && timingVerified && block.kind !== 'practice') {
      const crosses = (t: number) => start < t + uncertainty && end > t - uncertainty;
      window = crosses(onset!) || crosses(offset!) ? 'boundary' : end <= onset! ? 'pre' : start >= offset! ? 'post' : 'during';
      if (window === 'boundary' && reason === null) reason = 'notification_boundary';
    }
    if (!attemptValid && reason === null) reason = 'invalid_attempt';
    const valid = reason === null;
    if (finite(start) && finite(end) && end > start) intervals.push({ start, end, e0: e0 ?? 0, e1: e1 ?? 0, window, valid, reason });
    samples.push({ ...common, ...current.data, event_id: current.id ?? null, sample_index: index, at_ms: current.at,
      reported_error: current.data.error ?? null, error: e1, relative_to_notification_offset_ms: timingVerified && finite(end) ? end - offset! : null,
      interval_start_ms: start, interval_end_ms: end, interval_duration_ms: dt, window, valid, exclusion_reason: reason });
  }
  const summary = (block.kind === 'practice' ? ['practice'] : ['pre', 'during', 'post', 'boundary', 'unknown']).map(window => ({ ...common, window,
    ...metrics(intervals.filter(i => i.window === window), radius) }));
  const baseline = summary.find(r => r.window === 'pre');
  for (const row of summary) for (const metric of ['rmse', 'mean_error', 'in_target_fraction'] as const) {
    const before = baseline?.[metric], after = row[metric];
    Object.assign(row, { [`baseline_${metric}`]: before ?? null, [`${metric}_delta`]: finite(before) && finite(after) ? after - before : null });
  }
  const recovery: TrackingRow[] = [];
  const postMs = block.post_ms ?? session.snapshot.timing?.post_ms ?? 15000;
  // Unknown real-device timing never produces a recovery row or invented offset.
  if (timingVerified && block.kind !== 'practice') for (let relativeStart = 0; relativeStart < postMs; relativeStart += 1000) {
    const relativeEnd = Math.min(relativeStart + 1000, postMs);
    const result = metrics(intervals.filter(i => i.window === 'post'), radius, offset! + relativeStart, offset! + relativeEnd);
    const row: TrackingRow = { ...common, window: 'post_recovery', relative_start_ms: relativeStart, relative_end_ms: relativeEnd,
      bin_start_ms: offset! + relativeStart, bin_end_ms: offset! + relativeEnd, ...result };
    for (const metric of ['rmse', 'mean_error', 'in_target_fraction'] as const) {
      const before = baseline?.[metric], after = result[metric];
      row[`baseline_${metric}`] = before ?? null;
      row[`${metric}_delta`] = finite(before) && finite(after) ? after - before : null;
    }
    row.baseline_valid_duration_ms = baseline?.valid_duration_ms ?? 0;
    recovery.push(row);
  }
  const trial: TrackingRow = { ...common, ...metrics(intervals, radius), sample_n: raw.length,
    raw_input_count: events.filter(e => e.type === 'tracking_input').reduce((count, event) => count + (Array.isArray(event.data.samples) ? event.data.samples.length : 1), 0), tracking_attempt_valid: attemptValid,
    gap_interval_n: intervals.filter(i => i.reason === 'sample_gap').length,
    gap_duration_ms: intervals.filter(i => i.reason === 'sample_gap').reduce((sum, i) => sum + i.end - i.start, 0) };
  return { samples, summary, recovery, trial };
}
