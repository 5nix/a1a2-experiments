import { createHash } from 'node:crypto';
import { checkPlan, plannedPhase, SEQUENCE_RULE } from './plan-check.ts';

export interface Material {
  material_version?: string;
  id: string; domain: string; text_lines: string[]; iu_count?: number; n_count?: number;
  question: string; options: string[]; correct: number;
  synthetic?: boolean; source_label?: string; line_count?: number; character_count?: number;
  n_units?: string[]; render_image?: string; image_sha256?: string;
  source_ref?: Record<string, unknown>; source_warnings?: string[];
}
export interface Block {
  id: string; kind: 'practice' | 'notification' | 'control'; round: number; material_id: string | null;
  letters: string[]; baseline_count: number; stimulus_ms: number; soa_ms: number;
  notification_ms: number; during_count: number; break_ms: number;
  duration_ms?: number; tracking_seed?: number;
  n_level?: number | null; material_domain?: string | null; pre_ms?: number; post_ms?: number; post_early_ms?: number;
}
export type PrimaryModality = 'auditory_digits' | 'visual_letters' | 'compensatory_tracking';
export interface AudioClip {
  digit: string | number; symbol?: string; url: string; sha256: string; duration_ms: number;
  [key: string]: unknown;
}
export interface AudioManifest {
  version: string; clips: AudioClip[];
  [key: string]: unknown;
}
/** Missing modality belongs to an existing visual snapshot; never infer from its tokens. */
export const primaryModality = (plan: { primary_modality?: PrimaryModality }): PrimaryModality => plan.primary_modality ?? 'visual_letters';
export interface Plan {
  protocol_version: string; preset: string; synthetic: boolean; seed: number; pilot_round: string;
  material_version?: string;
  primary_modality?: PrimaryModality; audio_manifest?: AudioManifest;
  questionnaire?: { recall: boolean }; tracking?: Record<string, number | string>; debug?: boolean;
  delivery_mode?: 'mock' | 'rayneo'; device_id?: string;
  response_mode: 'target_only' | 'continuous_tracking'; input_sources: string[]; history_across_notification: 'carry';
  materials: Material[]; blocks: Block[]; hash: string;
  timing?: TimingConfig; configuration_status?: string; timing_candidates?: Record<string, number[]>;
  allocation?: { index: number; source: string; quota: number[]; control_positions: number[] };
  sequence_check?: ReturnType<typeof checkPlan>; material_precheck?: ReturnType<typeof checkMaterials>;
}
function freezeMetadata<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) freezeMetadata(nested);
    Object.freeze(value);
  }
  return value;
}
/** 理解题的两个"无内容"选项：编码固定为负数，与材料选项下标（0起）互不冲突；计为未答对，另以 response_type 区分。 */
export const PROBE_FALLBACKS = Object.freeze([
  Object.freeze({ code: -1, type: 'dont_remember', text: '不记得了' }),
  Object.freeze({ code: -2, type: 'not_seen', text: '没看见 / 没看清' }),
]);
export function probeResponseType(answer: unknown) {
  return PROBE_FALLBACKS.find(f => f.code === answer)?.type ?? 'option';
}
export const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function random(seed: number) {
  let state = seed >>> 0;
  return () => { state += 0x6D2B79F5; let t = state; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function shuffle<T>(values: T[], rand: () => number) {
  for (let i = values.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [values[i], values[j]] = [values[j], values[i]]; }
  return values;
}
export interface TimingConfig {
  notification_ms: number; soa_ms: number; stimulus_ms: number;
  pre_ms: number; post_ms: number; post_early_ms: number; break_ms: number; practice_break_ms: number;
}
export interface PlanOptions { participant_id?: string; allocation_index?: number; timing?: Partial<TimingConfig>; primary_modality?: PrimaryModality; audio_manifest?: AudioManifest; tracking?: Record<string, number | string>; debug?: boolean }
export const DEFAULT_TIMING: Readonly<TimingConfig> = Object.freeze({ notification_ms: 8500, soa_ms: 2000, stimulus_ms: 500, pre_ms: 20000, post_ms: 15000, post_early_ms: 10000, break_ms: 60000, practice_break_ms: 30000 });
export function checkMaterials(materials: Material[]) {
  const warnings: string[] = [], ids = new Set<string>();
  for (const m of materials) {
    if (ids.has(m.id)) warnings.push(`${m.id}: duplicate material ID`);
    ids.add(m.id);
    for (const warning of m.source_warnings ?? []) warnings.push(`${m.id}: ${warning}`);
    if (![1, 2, 3].includes(m.n_count ?? m.iu_count ?? 0)) warnings.push(`${m.id}: invalid N level`);
    if (!m.domain) warnings.push(`${m.id}: missing business category`);
    if (!m.n_units || m.n_units.length !== (m.n_count ?? m.iu_count)) warnings.push(`${m.id}: N-unit labels absent or count mismatch`);
    if (!Number.isInteger(m.correct) || m.correct < 0 || m.correct >= m.options.length) warnings.push(`${m.id}: invalid answer index`);
    if (!m.question || m.options.length < 2 || m.options.some(option => !option.trim())) warnings.push(`${m.id}: question/options incomplete`);
  }
  return { warnings, counts: [1, 2, 3].map(n_level => ({ n_level, available: materials.filter(m => (m.n_count ?? m.iu_count) === n_level).length })) };
}
function allocationIndex(seed: number, options: PlanOptions) {
  if (options.allocation_index !== undefined) {
    if (!Number.isSafeInteger(options.allocation_index) || options.allocation_index < 0) throw new Error('allocation_index must be a nonnegative integer');
    return { index: options.allocation_index, source: 'explicit_index' };
  }
  if (options.participant_id) {
    const suffix = /([0-9]+)$/.exec(options.participant_id);
    if (suffix && Number.isSafeInteger(Number(suffix[1]))) return { index: Math.max(0, Number(suffix[1]) - 1), source: 'participant_numeric_suffix_minus_one' };
    return { index: Number.parseInt(hash(options.participant_id).slice(0, 8), 16), source: 'participant_id_hash; exact cohort balance requires sequential allocation_index' };
  }
  return { index: seed, source: 'seed_fallback; pass participant_id or allocation_index for cohort rotation' };
}
/** One seeded draw. Review warnings never trigger outcome-dependent retries. */
export function buildPlan(materials: Material[], preset: string, seed: number, pilotRound: string, deliveryMode: 'mock' | 'rayneo' = 'mock', deviceId?: string, options: PlanOptions = {}): Plan {
  const versions = [...new Set(materials.map(m => m.material_version).filter(Boolean))];
  if (versions.length > 1) throw new Error('通知材料包含多个版本');
  const material_version = versions[0] ?? 'unversioned-materials';
  const rand = random(seed), quick = preset === 'quick';
  const primary_modality = options.primary_modality ?? 'compensatory_tracking';
  if (!['auditory_digits', 'visual_letters', 'compensatory_tracking'].includes(primary_modality)) throw new Error('invalid primary_modality');
  const audio_manifest = primary_modality === 'auditory_digits' && options.audio_manifest ? freezeMetadata(structuredClone(options.audio_manifest)) : undefined;
  const isTracking = primary_modality === 'compensatory_tracking';
  const tracking = isTracking ? { model: 'compensatory-2d-v1', disturbance_rms: 0.16, disturbance_hz: 0.22, input_gain: 1, target_radius: 0.08, cursor_radius: 0.02, display_scale: 1.5, sample_interval_ms: 50, practice_ms: quick ? 6000 : 20000, ...options.tracking } : undefined;
  if (tracking) {
    for (const key of ['disturbance_rms', 'disturbance_hz', 'input_gain', 'target_radius', 'cursor_radius', 'display_scale', 'sample_interval_ms', 'practice_ms'] as const) {
      const value = tracking[key];
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`invalid tracking: ${key}`);
    }
    if (tracking.sample_interval_ms > tracking.practice_ms || tracking.target_radius > 1) throw new Error('invalid tracking relationship');
  }
  const alphabet = primary_modality === 'auditory_digits' ? '123456789' : 'BCDFGHJK';
  const timing: TimingConfig = { ...DEFAULT_TIMING, ...(quick ? { notification_ms: 4000, soa_ms: 1200, pre_ms: 7200, post_ms: 8000, post_early_ms: 3600, break_ms: 3000, practice_break_ms: 3000 } : {}), ...options.timing };
  for (const [key, value] of Object.entries(timing)) if (!(isTracking && ['soa_ms', 'stimulus_ms'].includes(key)) && (!Number.isFinite(value) || value < 0 || (!['break_ms', 'practice_break_ms', 'post_early_ms'].includes(key) && value === 0))) throw new Error(`invalid timing: ${key}`);
  if (timing.post_early_ms > timing.post_ms || (!isTracking && (timing.stimulus_ms > timing.soa_ms || timing.pre_ms < 2 * timing.soa_ms))) throw new Error('invalid timing relationship');
  const tail = isTracking ? 0 : (timing.pre_ms + timing.notification_ms + timing.post_ms) % timing.soa_ms;
  if (!isTracking && tail > 0 && tail < Math.max(100, timing.stimulus_ms)) throw new Error('末项反应窗口短于刺激显示时长；请调整时长，使末项至少100ms且足以呈现刺激。');
  const allocation = allocationIndex(seed, options);
  const quota = [3, 3, 3];
  const control_positions = [allocation.index % 10 + 1];
  const blocks: Block[] = [];
  const append = (kind: Block['kind'], n: number, material: Material | null) => blocks.push({
    id: `B${String(blocks.length + 1).padStart(2, '0')}`, kind, round: n, material_id: material?.id ?? null,
    n_level: kind === 'notification' ? n : null, material_domain: material?.domain ?? null,
    ...(isTracking ? { duration_ms: kind === 'practice' ? Number(tracking!.practice_ms) : timing.pre_ms + timing.notification_ms + timing.post_ms, tracking_seed: Number.parseInt(hash({ seed, block_id: blocks.length + 1, model: tracking!.model }).slice(0, 8), 16) } : {}),
    letters: isTracking ? [] : Array.from({ length: kind === 'practice' ? (quick ? 8 : 18) : Math.ceil((timing.pre_ms + timing.notification_ms + timing.post_ms) / timing.soa_ms) }, () => ''),
    baseline_count: isTracking ? 0 : Math.ceil(timing.pre_ms / timing.soa_ms), ...timing,
    during_count: isTracking ? 0 : Math.ceil(timing.notification_ms / timing.soa_ms), break_ms: kind === 'practice' ? timing.practice_break_ms : timing.break_ms,
  });
  append('practice', 0, null);
  if (quick) { if (!materials[0]) throw new Error('quick requires a material'); append('notification', materials[0].n_count ?? materials[0].iu_count ?? 1, materials[0]); append('control', 0, null); }
  else {
    if (new Set(materials.map(m => m.id)).size !== materials.length) throw new Error('duplicate material IDs');
    const pools = [1, 2, 3].map(n => shuffle(materials.filter(m => (m.n_count ?? m.iu_count) === n), rand));
    for (let n = 0; n < 3; n++) if (pools[n].length < quota[n]) throw new Error(`N${n + 1} requires ${quota[n]} unique materials`);
    const firstN = allocation.index % 3, order = [firstN, (firstN + 1) % 3, (firstN + 2) % 3];
    const nOrder = [...order, ...order, ...order];
    for (let position = 1, cursor = 0; position <= 10; position++) {
      if (control_positions.includes(position)) append('control', 0, null);
      else { const n = nOrder[cursor++]; append('notification', n + 1, pools[n].pop()!); }
    }
  }
  // Balance target totals independently in each N × phase, then spread positions
  // across phase thirds. The deterministic one-pass rule is versioned in the plan.
  const targetSets = new Map(blocks.map(b => [b.id, new Set<number>()]));
  const groupKeys = [...new Set(blocks.map(b => b.kind === 'practice' ? 'practice' : b.kind === 'control' ? 'control' : `N${b.n_level}`))];
  for (const key of groupKeys) for (const phase of ['pre', 'during', 'post_early', 'post_late', 'boundary'] as const) {
    const bins: { block: Block; index: number }[][] = [[], [], []];
    for (const block of blocks.filter(b => (b.kind === 'practice' ? 'practice' : b.kind === 'control' ? 'control' : `N${b.n_level}`) === key)) {
      const positions = block.letters.map((_, i) => i).filter(i => i >= 2 && plannedPhase(block, i) === phase);
      for (const [j, index] of positions.entries()) bins[Math.min(2, Math.floor(j / positions.length * 3))].push({ block, index });
    }
    bins.forEach(bin => shuffle(bin, rand));
    const count = Math.round(bins.reduce((sum, bin) => sum + bin.length, 0) * SEQUENCE_RULE.target_ratio);
    const binOrder = shuffle([0, 1, 2], rand);
    for (let j = 0; j < count; j++) {
      const preferred = binOrder[j % 3], bin = bins[preferred].length ? bins[preferred] : bins.find(b => b.length)!;
      const position = bin.pop()!; targetSets.get(position.block.id)!.add(position.index);
    }
  }
  for (const block of blocks) for (let i = 0; i < block.letters.length; i++) {
    const target = targetSets.get(block.id)!.has(i);
    const choices = [...alphabet].filter(letter => target ? letter === block.letters[i - 2] : i < 2 || letter !== block.letters[i - 2]);
    block.letters[i] = choices[Math.floor(rand() * choices.length)];
  }
  const base = { protocol_version: 'a1-0.7-compensatory-tracking', primary_modality, tracking, audio_manifest, questionnaire: { recall: false }, preset, synthetic: materials.every(m => m.synthetic !== false), material_version, delivery_mode: deliveryMode, device_id: deviceId, seed, pilot_round: pilotRound,
    response_mode: isTracking ? 'continuous_tracking' as const : 'target_only' as const, input_sources: isTracking ? ['mouse_relative'] : ['mouse_left', 'space'], history_across_notification: 'carry' as const, materials, blocks, timing,
    configuration_status: 'pilot_unfrozen; latest requested defaults: 10 formal trials (3/3/3 notifications + 1 control), Pre 20s / notice 8.5s / Post 15s; quick uses abbreviated timings',
    timing_candidates: { notification_ms: [8500], soa_ms: [2000, 1500], pre_ms: [20000], post_ms: [15000], post_early_ms: [10000] },
    allocation: { ...allocation, quota: quick ? [1, 2, 3].map(n => blocks.filter(b => b.kind === 'notification' && b.n_level === n).length) : quota, control_positions: quick ? [2] : control_positions }, material_precheck: checkMaterials(materials), ...(isTracking ? {} : { sequence_check: checkPlan({ blocks, primary_modality }) }), ...(options.debug ? { debug: true } : {}) };
  return { ...base, hash: hash(base) };
}
