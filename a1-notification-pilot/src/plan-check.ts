import type { Block, Plan } from './protocol.ts';

export type PlannedPhase = 'pre' | 'during' | 'post_early' | 'post_late' | 'boundary';
export interface SequenceCheckRow {
  n_level: number | null; phase: Exclude<PlannedPhase, 'boundary'>;
  trial_count: number; targets: number; non_targets: number; eligible: number;
  target_ratio: number | null; target_positions: number[];
  target_position_bins: [number, number, number];
}
/** These are review thresholds, not criteria for drawing another random plan. */
export const SEQUENCE_RULE = Object.freeze({
  version: 'a1-sequence-review-v1', target_ratio: 0.28,
  maximum_ratio_difference: 0.15, maximum_position_share_difference: 0.5,
  minimum_during_targets: 3, generation_attempts: 1,
  regeneration: 'never_automatically; change configuration/seed only before collection and retain prior plan hash',
  phase_window: 'full_response_window_soa; half-open intervals; boundary windows excluded',
  target_allocation: 'per N-or-control x phase: round(eligible * 0.28); seeded shuffle within phase-position thirds; seeded third order cycles until quota, empty thirds spill to first nonempty; no retries',
  target_positions: 'zero-based stimulus indices; phase-position thirds computed within each trial',
  sequence_letters: 'BCDFGHJK; targets equal index-2; other positions exclude index-2; first two positions are ineligible',
});
export function plannedPhase(block: Block, index: number): PlannedPhase {
  const start = index * block.soa_ms, end = start + block.soa_ms;
  const onset = block.pre_ms ?? block.baseline_count * block.soa_ms;
  const offset = onset + block.notification_ms;
  const earlyEnd = offset + (block.post_early_ms ?? 10000);
  if (block.post_ms !== undefined && end > offset + block.post_ms) return 'boundary';
  if (end <= onset) return 'pre';
  if (start >= onset && end <= offset) return 'during';
  if (start >= offset && end <= earlyEnd) return 'post_early';
  if (start >= earlyEnd) return 'post_late';
  return 'boundary';
}
export function checkPlan(plan: Pick<Plan, 'blocks'> & Partial<Pick<Plan, 'primary_modality'>>) {
  const rows: SequenceCheckRow[] = [], warnings: string[] = [];
  let boundary_stimuli = 0;
  const formal = plan.blocks.filter(b => b.kind !== 'practice');
  const groups = [...new Set(formal.map(b => b.kind === 'control' ? null : b.n_level ?? b.round))];
  for (const n_level of groups) for (const phase of ['pre', 'during', 'post_early', 'post_late'] as const) {
    const blocks = formal.filter(b => (b.kind === 'control' ? null : b.n_level ?? b.round) === n_level);
    const row: SequenceCheckRow = { n_level, phase, trial_count: blocks.length, targets: 0, non_targets: 0, eligible: 0, target_ratio: null, target_positions: [], target_position_bins: [0, 0, 0] };
    for (const block of blocks) {
      const positions = block.letters.map((_, i) => i).filter(i => i >= 2 && plannedPhase(block, i) === phase);
      for (const [position, i] of positions.entries()) {
        row.eligible++;
        if (block.letters[i] === block.letters[i - 2]) {
          row.targets++; row.target_positions.push(i);
          row.target_position_bins[Math.min(2, Math.floor(position / positions.length * 3))]++;
        } else row.non_targets++;
      }
    }
    row.target_ratio = row.eligible ? row.targets / row.eligible : null;
    if (phase === 'during' && row.targets < SEQUENCE_RULE.minimum_during_targets) warnings.push(`${n_level === null ? 'control' : `N${n_level}`}: during targets=${row.targets}; sparse target denominator`);
    rows.push(row);
  }
  for (const block of formal) boundary_stimuli += block.letters.filter((_, i) => i >= 2 && plannedPhase(block, i) === 'boundary').length;
  for (const phase of ['pre', 'during', 'post_early', 'post_late'] as const) {
    const comparable = rows.filter(r => r.n_level !== null && r.phase === phase && r.target_ratio !== null);
    const ratios = comparable.map(r => r.target_ratio!);
    if (ratios.length > 1 && Math.max(...ratios) - Math.min(...ratios) > SEQUENCE_RULE.maximum_ratio_difference) warnings.push(`${phase}: N-level target ratio difference exceeds ${SEQUENCE_RULE.maximum_ratio_difference}`);
    for (let bin = 0; bin < 3; bin++) {
      const shares = comparable.filter(r => r.targets > 0).map(r => r.target_position_bins[bin] / r.targets);
      if (shares.length > 1 && Math.max(...shares) - Math.min(...shares) > SEQUENCE_RULE.maximum_position_share_difference) warnings.push(`${phase}: N-level target position bin ${bin + 1} imbalance`);
    }
  }
  if (boundary_stimuli) warnings.push(`${boundary_stimuli} boundary stimuli excluded from planned phase denominators`);
  return { rule: { ...SEQUENCE_RULE, sequence_letters: `${plan.primary_modality === 'auditory_digits' ? '123456789 (spoken Mandarin digits)' : 'BCDFGHJK'}; targets equal index-2; other positions exclude index-2; first two positions are ineligible` }, rows, boundary_stimuli, warnings };
}
