/** HTTP→USB采样的Android时间发生在浏览器before/after之间；不依赖设备墙钟。 */
export interface ClockSample { sample_id: string; browser_before_ms: number; browser_after_ms: number; device_monotonic_ms: number; clock_id: string }
export interface Calibration { phase: 'pre' | 'post'; samples: ClockSample[]; time_origin: number; best: { offset_ms: number; uncertainty_ms: number; clock_id: string; browser_midpoint_ms: number; device_monotonic_ms: number }; verified: boolean; method: 'browser_android_bracket_v1' }
export function calibration(phase: 'pre' | 'post', samples: ClockSample[], timeOrigin: number): Calibration {
  if (samples.length !== 7 || !Number.isFinite(timeOrigin) || samples.some(s => !s.clock_id || ![s.browser_before_ms, s.browser_after_ms, s.device_monotonic_ms].every(Number.isFinite) || s.browser_before_ms < 0 || s.browser_after_ms < s.browser_before_ms)) throw new Error('时钟样本无效。');
  const best = [...samples].sort((a, b) => (a.browser_after_ms - a.browser_before_ms) - (b.browser_after_ms - b.browser_before_ms))[0];
  const midpoint = (best.browser_before_ms + best.browser_after_ms) / 2, uncertainty = (best.browser_after_ms - best.browser_before_ms) / 2;
  return { phase, samples, time_origin: timeOrigin, best: { offset_ms: midpoint - best.device_monotonic_ms, uncertainty_ms: uncertainty + 1, clock_id: best.clock_id, browser_midpoint_ms: midpoint, device_monotonic_ms: best.device_monotonic_ms }, verified: uncertainty + 1 <= 20 && samples.every(s => s.clock_id === best.clock_id), method: 'browser_android_bracket_v1' };
}
type EventLike = { type: string; at?: number | null; data: Record<string, unknown> };
export function resolveNotificationTiming(events: EventLike[]): { onset: number | null; offset: number | null; uncertainty_ms: number; timing_qc: string | null } {
  const unknown = (reason: string) => ({ onset: null, offset: null, uncertainty_ms: 0, timing_qc: reason });
  const calibrations = events.filter(e => e.type === 'device_clock_calibration').map(e => e.data as unknown as Calibration);
  const pre = calibrations.find(c => c.phase === 'pre'), post = calibrations.find(c => c.phase === 'post');
  if (!pre || !post || !pre.verified || !post.verified) return unknown('device_clock_mapping_unverified');
  const a = pre.best, b = post.best;
  if (pre.time_origin !== post.time_origin || a.clock_id !== b.clock_id || b.device_monotonic_ms <= a.device_monotonic_ms) return unknown('device_clock_changed');
  const drift = Math.abs(b.offset_ms - a.offset_ms);
  if (drift > Math.max(10, a.uncertainty_ms + b.uncertainty_ms)) return unknown('device_clock_drift_exceeded');
  const deviceEvents = events.filter(e => e.type === 'device_image_event').map(e => e.data.event as Record<string, unknown>);
  if (events.some(e => e.type === 'device_send_failed') || deviceEvents.some(e => e.kind === 'failed' || e.clock_id !== a.clock_id)) return unknown('device_display_failed_or_clock_changed');
  const drawn = deviceEvents.find(e => e.kind === 'drawn'), hidden = deviceEvents.find(e => e.kind === 'hidden');
  if (!drawn || !hidden || drawn.request_id !== hidden.request_id) return unknown('device_display_evidence_incomplete');
  const start = Number(drawn.device_monotonic_ms), end = Number(hidden.device_monotonic_ms);
  if (![start, end].every(Number.isFinite) || start < a.device_monotonic_ms || end > b.device_monotonic_ms || end <= start) return unknown('device_evidence_outside_calibration');
  const map = (t: number) => t + a.offset_ms + (t - a.device_monotonic_ms) / (b.device_monotonic_ms - a.device_monotonic_ms) * (b.offset_ms - a.offset_ms);
  return { onset: map(start), offset: map(end), uncertainty_ms: Math.max(a.uncertainty_ms, b.uncertainty_ms) + drift / 2, timing_qc: 'device_clock_mapping_verified_software' };
}
export function mapDeviceNotification(events: EventLike[]) {
  const mapped = resolveNotificationTiming(events);
  return { verified: mapped.onset !== null && mapped.offset !== null, onset_ms: mapped.onset, offset_ms: mapped.offset, uncertainty_ms: mapped.uncertainty_ms, reason: mapped.timing_qc ?? 'device_clock_mapping_unverified', method: 'browser_android_bracket_v1' };
}
