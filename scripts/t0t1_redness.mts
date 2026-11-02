/**
 * 红度放大效应 · 鲁棒验证（多个队伍 × 多个维度）
 * ─────────────────────────────────────────────────────
 * 建模：满红 = 红度 5（兵力 9000→10000，每英雄 +50 自由点投到主战属性），
 *       等级固定 40 以隔离"红度"的边际效应（与全谱 0 红基准同口径）。
 * 三种验证：
 *   A. 单队边际：仅把目标队升满红，对手固定 0 红 → 该队场地胜率增益 Δ1
 *   B. 全员满红：17 队全升满红 → 重排场地胜率，看梯队离散度是否拉大
 *   C. 招牌对局：曹彰vs荀彧 / 祝融vs太史慈关羽 / 庞统vs张春华乐进，
 *      仅强侧升满红，看胜负 margin 是否拉大（验证"强者增益更大"）
 * 运行：SEEDS=30 npx tsx scripts/t0t1_redness.mts
 * 产物：docs/t0t1_redness.json
 */
import { buildGeneral } from '../web/heroes';
import { runBattle } from '../src/engine/combat';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const heroesData: any[] = JSON.parse(readFileSync(join(root, 'web/data/heroes.json'), 'utf8'));
const benchRaw: any = JSON.parse(readFileSync(join(root, 'web/data/opponent_benchmark.json'), 'utf8'));
const t1Raw: any = JSON.parse(readFileSync(join(root, 'docs/t0t1_roster.json'), 'utf8'));
const fullsim: any = JSON.parse(readFileSync(join(root, 'docs/t0t1_fullsim.json'), 'utf8'));

const hById: Record<string, any> = {}; for (const h of heroesData) hById[h.id] = h;
function primaryStat(heroId: string): 'attack' | 'strategy' {
  const h = hById[heroId]; if (!h) return 'attack';
  const a = h.attack || 0, s = h.strategy || 0; return a >= s ? 'attack' : 'strategy';
}

const RED_POSITIONS = ['大营', '中军', '前锋'] as const;
const SEEDS = parseInt(process.env.SEEDS || '30', 10);

interface SlotDef { heroId: string; freePoints: any; skillIds: string[]; traits?: string[]; secondaryTroop?: string; }
interface TeamDef { id: string; note: string; tier: string; archetype: string; slots: SlotDef[]; }

const t0: TeamDef[] = benchRaw.entries.map((e: any) => ({
  id: e.id, note: e.note, tier: 'T0', archetype: 'T0基准',
  slots: e.cfg.slots.map((s: any) => ({ heroId: s.heroId, freePoints: { attack: s.addAttack || 0, defense: s.addDefense || 0, strategy: s.addStrategy || 0, speed: s.addSpeed || 0 }, skillIds: s.skillIds || [], traits: s.traits || [], secondaryTroop: s.secondaryTroop })),
}));
const t1: TeamDef[] = t1Raw.t1.map((e: any) => ({ id: e.id, note: e.note, tier: 'T1', archetype: e.archetype, slots: e.slots.map((s: any) => ({ heroId: s.heroId, freePoints: s.freePoints || {}, skillIds: s.skillIds || [], traits: s.traits || [], secondaryTroop: s.secondaryTroop })) }));
const ALL: TeamDef[] = [...t0, ...t1];
const N = ALL.length;

function buildSide(side: string, defIdx: number, redness: number): any[] {
  const def = ALL[defIdx];
  return def.slots.map((s, i) => {
    const fp: any = { ...(s.freePoints || {}) };
    if (redness > 0) { const st = primaryStat(s.heroId); fp[st] = (fp[st] || 0) + 50; }
    const g: any = buildGeneral(s.heroId, s.skillIds, fp, RED_POSITIONS[i], redness, 40, 120, s.secondaryTroop, s.traits, null);
    g.id = side + ':' + g.id;
    return g;
  });
}

const CONTROLS = new Set(['confusion', 'rampage', 'cowardice', 'hesitation', 'taunt']);
function sidePlain(report: any, selfIds: Set<string>) {
  let win = 0;
  // 仅用于统计胜负（不放维度）
  return null;
}

function runPair(i: number, j: number, redI: number, redJ: number, seed: number) {
  const A = buildSide('A', i, redI), B = buildSide('B', j, redJ);
  const aIds = new Set(A.map(u => u.id)), bIds = new Set(B.map(u => u.id));
  const r: any = runBattle({ myTeam: A, enemyTeam: B, seed, maxRounds: 8 });
  const res = r.result === 'win' ? 1 : r.result === 'loss' ? -1 : 0;
  return { iWon: res, jWon: -res, A, B };
}

// ── 基线 0 红（来自全谱）──
const baseWin: number[] = ALL.map((_, i) => fullsim.teams[i].profile.winRate);
const baseDmg: number[] = ALL.map((_, i) => fullsim.teams[i].profile['增伤活跃度']);

// ── A. 单队边际：仅 i 升满红，对手固定 0 红 ──
const redOnly: any[] = ALL.map(() => ({ plays: 0, win: 0, loss: 0, draw: 0 }));
console.log(`[A] 单队边际：每队满红 vs 0红对手域，共 ${N}×(N-1)×2×${SEEDS} 场`);
let doneA = 0;
for (let i = 0; i < N; i++) {
  for (let j = 0; j < N; j++) {
    if (i === j) continue;
    for (let g = 0; g < SEEDS; g++) {
      const seed = ((g * 1009 + i * 131 + j * 17 + 3) & 0x7fffffff) || 1;
      const { iWon } = runPair(i, j, 5, 0, seed);
      const t = redOnly[i]; t.plays++; if (iWon === 1) t.win++; else if (iWon === -1) t.loss++; else t.draw++;
      doneA++;
    }
  }
  console.log(`  A 队 ${i + 1}/${N} 完成（${doneA} 场）`);
}

// ── B. 全员满红：i 满红 vs j 满红 ──
const bothRed: any[] = ALL.map(() => ({ plays: 0, win: 0, loss: 0, draw: 0 }));
console.log(`[B] 全员满红重排：共 ${N}×(N-1)×2×${SEEDS} 场`);
let doneB = 0;
for (let i = 0; i < N; i++) {
  for (let j = 0; j < N; j++) {
    if (i === j) continue;
    for (let g = 0; g < SEEDS; g++) {
      const seed = ((g * 1009 + i * 131 + j * 17 + 5) & 0x7fffffff) || 1;
      const { iWon } = runPair(i, j, 5, 5, seed);
      const t = bothRed[i]; t.plays++; if (iWon === 1) t.win++; else if (iWon === -1) t.loss++; else t.draw++;
      doneB++;
    }
  }
  console.log(`  B 队 ${i + 1}/${N} 完成（${doneB} 场）`);
}

function pct(t: any) { const n = t.plays || 1; return { winRate: +(t.win / n * 100).toFixed(1), lossRate: +(t.loss / n * 100).toFixed(1), drawRate: +(t.draw / n * 100).toFixed(1) }; }

// ── 汇总：Δ1（单队边际）、Δ2（全员满红相对0红）──
const rows = ALL.map((d, i) => {
  const a = pct(redOnly[i]), b = pct(bothRed[i]);
  return {
    id: d.id, note: d.note, tier: d.tier,
    base0red: baseWin[i], 增伤0red: baseDmg[i],
    redOnlyWin: a.winRate, delta1: +(a.winRate - baseWin[i]).toFixed(1),
    bothRedWin: b.winRate, delta2: +(b.winRate - baseWin[i]).toFixed(1),
  };
});

// ── C. 招牌对局 margin（仅强侧升满红）──
const marqueeDefs = [
  { name: '曹彰(强/T1增伤) vs 荀彧(弱/T0无增伤)', i: ALL.findIndex(t => t.id === 't1-caozhang-loutie'), j: ALL.findIndex(t => t.id === 'bench-xunyu-zhangchunhua-caocao') },
  { name: '祝融张辽曹操(强/T0增伤3.46) vs 太史慈曹植关羽(弱/T0无增伤)', i: ALL.findIndex(t => t.id === 'bench-zhurong-zhangliao-caocao'), j: ALL.findIndex(t => t.id === 'bench-taishici-caozhi-guanyu') },
  { name: '庞统蜀步(减伤墙) vs 张春华乐进于禁(中)', i: ALL.findIndex(t => t.id === 't1-pangtong-shubu'), j: ALL.findIndex(t => t.id === 'bench-zhangchunhua-yuejin-yujin') },
];
const marquee: any[] = [];
for (const m of marqueeDefs) {
  // 0红基准 margin
  let w00 = 0, w01 = 0, n = 0;
  for (let g = 0; g < SEEDS; g++) { const s = ((g * 1009 + m.i * 131 + m.j * 17 + 9) & 0x7fffffff) || 1; const { iWon } = runPair(m.i, m.j, 0, 0, s); n++; if (iWon === 1) w00++; else if (iWon === -1) w00 += 0; }
  // 仅强侧(i)满红
  let wR0 = 0; for (let g = 0; g < SEEDS; g++) { const s = ((g * 1009 + m.i * 131 + m.j * 17 + 11) & 0x7fffffff) || 1; const { iWon } = runPair(m.i, m.j, 5, 0, s); if (iWon === 1) wR0++; }
  marquee.push({ name: m.name, base_iWinRate: +(w00 / n * 100).toFixed(1), redStrong_iWinRate: +(wR0 / n * 100).toFixed(1), marginGain: +((wR0 - w00) / n * 100).toFixed(1) });
}
console.log('[C] 招牌对局 margin 完成');

// 离散度（梯队拉大验证）
const spread0 = Math.max(...baseWin) - Math.min(...baseWin);
const spreadB = Math.max(...bothRed.map(pct).map(p => p.winRate)) - Math.min(...bothRed.map(p => p.winRate));
const meanDelta1 = rows.reduce((a, r) => a + r.delta1, 0) / rows.length;
const strongDelta = rows.filter(r => r.base0red >= 40).map(r => r.delta1);
const weakDelta = rows.filter(r => r.base0red < 10).map(r => r.delta1);

const out = {
  meta: { seeds: SEEDS, rednessModel: 'redness=5, troops9000->10000, +50自由点投主战属性, level=40固定', baseline: 'docs/t0t1_fullsim.json 0红' },
  rows, marquee,
  spread: { base0red_spread: +spread0.toFixed(1), bothRed_spread: +spreadB.toFixed(1) },
  deltaSummary: { meanDelta1: +meanDelta1.toFixed(2), strongTeamsDelta1_avg: +(strongDelta.reduce((a, b) => a + b, 0) / (strongDelta.length || 1)).toFixed(2), weakTeamsDelta1_avg: +(weakDelta.reduce((a, b) => a + b, 0) / (weakDelta.length || 1)).toFixed(2) },
};
writeFileSync(join(root, 'docs/t0t1_redness.json'), JSON.stringify(out, null, 2), 'utf8');
console.log('已写出 docs/t0t1_redness.json');
console.log('梯队离散度 0红=', spread0.toFixed(1), ' 全员满红=', spreadB.toFixed(1));
console.log('平均Δ1=', meanDelta1.toFixed(2), ' 强队(≥40%)Δ1均值=', (strongDelta.reduce((a, b) => a + b, 0) / (strongDelta.length || 1)).toFixed(2), ' 弱队(<10%)Δ1均值=', (weakDelta.reduce((a, b) => a + b, 0) / (weakDelta.length || 1)).toFixed(2));
console.log('--- 逐队 Δ1（满红边际胜率增益）---');
rows.slice().sort((a, b) => b.delta1 - a.delta1).forEach(r => console.log(`  ${r.note.padEnd(20)} 0红${r.base0red}% -> 满红${r.redOnlyWin}%  Δ1=${r.delta1}  增伤0红${r.增伤0red}`));
