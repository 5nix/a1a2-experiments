/** Count first, then calculate rates. Missing denominators stay null in JSON/blank in CSV. */
export type AnalysisRow = Record<string, unknown>;
export const analysisWindows = ['pre', 'during', 'post', 'post_early', 'post_late', 'boundary', 'unknown', 'practice'] as const;
export function performance(rows: AnalysisRow[]) {
  const valid = rows.filter(r => r.valid === true);
  const count = (classification: string) => valid.filter(r => r.classification === classification).length;
  const hit = count('hit'), miss = count('miss'), false_alarm = count('false_alarm'), correct_rejection = count('correct_rejection');
  const target_n = hit + miss, non_target_n = false_alarm + correct_rejection, eligible = target_n + non_target_n;
  const rt = valid.filter(r => r.classification === 'hit' && typeof r.rt_ms === 'number' && Number.isFinite(r.rt_ms)).map(r => Number(r.rt_ms)).sort((a, b) => a - b);
  const hit_rate = target_n ? hit / target_n : null, false_alarm_rate = non_target_n ? false_alarm / non_target_n : null;
  return { eligible, accuracy_denominator: eligible, target_n, non_target_n, hit_rate_denominator: target_n, false_alarm_rate_denominator: non_target_n,
    hit, miss, false_alarm, correct_rejection, accuracy: eligible ? (hit + correct_rejection) / eligible : null, hit_rate, false_alarm_rate,
    balanced_accuracy: hit_rate !== null && false_alarm_rate !== null ? (hit_rate + 1 - false_alarm_rate) / 2 : null,
    hit_rt_n: rt.length, hit_rt_mean_ms: rt.length ? rt.reduce((a, b) => a + b, 0) / rt.length : null,
    hit_rt_median_ms: rt.length ? (rt[Math.floor((rt.length - 1) / 2)] + rt[Math.floor(rt.length / 2)]) / 2 : null };
}
export function inWindow(row: AnalysisRow, window: string) { return row.window === window || row.post_window === window; }
export function poolItems(items: AnalysisRow[]) {
  const groups = new Map<string, AnalysisRow[]>();
  for (const row of items.filter(r => r.block_type !== 'practice')) {
    const key = JSON.stringify([row.participant_id, row.n_count, row.block_type, row.analysis_condition ?? null]);
    const group = groups.get(key) ?? []; group.push(row); groups.set(key, group);
  }
  return [...groups.values()].flatMap(rows => analysisWindows.filter(w => w !== 'practice').map(window => ({
    primary_modality: rows[0].primary_modality ?? 'visual_letters', audio_manifest_sha256: rows[0].audio_manifest_sha256 ?? null,
    analysis_condition: rows[0].analysis_condition ?? null, participant_id: rows[0].participant_id, n_count: rows[0].n_count, block_type: rows[0].block_type, window,
    session_ids: [...new Set(rows.map(r => r.session_id))], attempt_n: new Set(rows.filter(r => inWindow(r, window) && r.valid === true).map(r => r.attempt_id)).size,
    ...performance(rows.filter(r => inWindow(r, window))),
  })));
}
export function phaseForInterval(start: number, end: number | null, onset: number | null, offset: number | null, earlyMs: number, uncertaintyMs = 0) {
  if (onset === null || offset === null || offset < onset || end === null || end <= start) return { window: 'unknown', post_window: null, boundary_onset: false, boundary_offset: false, boundary_post_split: false };
  const boundary_onset = start < onset + uncertaintyMs && end > onset - uncertaintyMs, boundary_offset = start < offset + uncertaintyMs && end > offset - uncertaintyMs;
  const split = offset + earlyMs, boundary_post_split = start < split + uncertaintyMs && end > split - uncertaintyMs;
  const window = boundary_onset || boundary_offset ? 'boundary' : start < onset ? 'pre' : start < offset ? 'during' : 'post';
  return { window, post_window: window === 'post' ? boundary_post_split ? 'post_boundary' : start < split ? 'post_early' : 'post_late' : null, boundary_onset, boundary_offset, boundary_post_split };
}
export function performanceChanges(rows: AnalysisRow[], keys: string[]) {
  const groups = new Map<string, AnalysisRow[]>();
  for (const row of rows) { const key = JSON.stringify(keys.map(k => row[k])); const group = groups.get(key) ?? []; group.push(row); groups.set(key, group); }
  return [...groups.values()].flatMap(group => {
    const pre = group.find(r => r.window === 'pre');
    return ['during', 'post', 'post_early', 'post_late'].map(window => {
      const other = group.find(r => r.window === window), a = pre?.accuracy, b = other?.accuracy;
      const result: AnalysisRow = { ...Object.fromEntries(keys.map(k => [k, group[0][k]])), window, baseline_eligible: pre?.eligible ?? 0, window_eligible: other?.eligible ?? 0,
        baseline_accuracy: a ?? null, window_accuracy: b ?? null, accuracy_drop_percentage_points: typeof a === 'number' && typeof b === 'number' ? (a - b) * 100 : null,
        relative_accuracy_drop: typeof a === 'number' && a > 0 && typeof b === 'number' ? (a - b) / a : null };
      for (const metric of ['hit_rate', 'false_alarm_rate', 'balanced_accuracy', 'hit_rt_mean_ms', 'hit_rt_median_ms']) {
        const before = pre?.[metric], after = other?.[metric];
        result[`baseline_${metric}`] = before ?? null; result[`window_${metric}`] = after ?? null;
        result[`${metric}_change`] = typeof before === 'number' && typeof after === 'number' ? after - before : null;
      }
      return result;
    });
  });
}
