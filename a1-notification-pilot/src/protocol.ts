import { createHash } from 'node:crypto';

export interface Material {
  id: string; domain: string; text_lines: string[]; iu_count: number;
  question: string; options: string[]; correct: number;
}
export interface Block {
  id: string; kind: 'practice' | 'notification' | 'control'; round: number; material_id: string | null;
  letters: string[]; baseline_count: number; stimulus_ms: number; soa_ms: number;
  notification_ms: number; during_count: number; break_ms: number;
}
export interface Plan {
  protocol_version: string; preset: string; synthetic: true; seed: number; pilot_round: string;
  response_mode: 'target_only'; input_sources: string[]; history_across_notification: 'carry';
  materials: Material[]; blocks: Block[]; hash: string;
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
/** 显式选择目标位置，其余位置排除意外2-back匹配，并限制连续同字母。 */
function letters(count: number, rand: () => number) {
  const targetIndices = new Set(shuffle(Array.from({ length: count - 2 }, (_, i) => i + 2), rand).slice(0, Math.round((count - 2) * 0.28)));
  const sequence: string[] = [];
  for (let i = 0; i < count; i++) {
    const target = targetIndices.has(i);
    const choices = [...'BCDFGHJK'].filter(letter => (!target || letter === sequence[i - 2]) && (target || i < 2 || letter !== sequence[i - 2]) && !(letter === sequence[i - 1] && letter === sequence[i - 2] && letter === sequence[i - 3]));
    if (!choices.length) { targetIndices.delete(i); choices.push(...[...'BCDFGHJK'].filter(letter => letter !== sequence[i - 2])); }
    sequence.push(choices[Math.floor(rand() * choices.length)]);
  }
  return sequence;
}
export function buildPlan(materials: Material[], preset: string, seed: number, pilotRound: string): Plan {
  const rand = random(seed), quick = preset === 'quick';
  const baseline = quick ? 6 : 22, recovery = quick ? 6 : 18;
  const blocks: Block[] = [];
  const append = (kind: Block['kind'], round: number, material: Material | null) => blocks.push({
    id: `B${String(blocks.length + 1).padStart(2, '0')}`, kind, round, material_id: material?.id ?? null,
    letters: letters(kind === 'practice' ? (quick ? 8 : 18) : baseline + Math.ceil(4000 / (quick ? 1200 : 2000)) + recovery, rand), baseline_count: baseline,
    stimulus_ms: 500, soa_ms: quick ? 1200 : 2000,
    notification_ms: 4000, during_count: Math.ceil(4000 / (quick ? 1200 : 2000)), break_ms: quick ? 3000 : kind === 'practice' ? 30000 : 60000,
  });
  append('practice', 0, null);
  if (quick) { append('notification', 1, materials[0]); append('control', 1, null); }
  else for (let round = 1; round <= 3; round++) {
    for (const material of shuffle(materials.filter(m => m.iu_count === round), rand)) append('notification', round, material);
    if (round < 3) append('control', round, null);
  }
  const base = { protocol_version: 'a1-visual-2back-0.1', preset, synthetic: true as const, seed, pilot_round: pilotRound,
    response_mode: 'target_only' as const, input_sources: ['mouse_left', 'space'], history_across_notification: 'carry' as const, materials, blocks };
  return { ...base, hash: hash(base) };
}
