/**
 * T0 × T1 典型对局逐回合深拆（顶级配将师 · 底层规律论证 配套）
 * 选 4 组代表性对局，跑多种子给出结果分布，并对代表性种子 dump 逐回合兵力曲线 + 关键事件，
 * 用最底层数据解释胜负机理。
 */
import { buildGeneral } from '../web/heroes';
import { runBattle } from '../src/engine/combat';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const benchRaw: any = JSON.parse(readFileSync(join(root, 'web/data/opponent_benchmark.json'), 'utf8'));
const t1Raw: any = JSON.parse(readFileSync(join(root, 'docs/t0t1_roster.json'), 'utf8'));
const RED_POSITIONS = ['大营', '中军', '前锋'] as const;

interface SlotDef { heroId: string; freePoints: any; skillIds: string[]; traits?: string[]; secondaryTroop?: string; }
interface TeamDef { id: string; note: string; tier: string; archetype: string; slots: SlotDef[]; }
const t0: TeamDef[] = benchRaw.entries.map((e: any) => ({ id: e.id, note: e.note, tier: 'T0', archetype: 'T0基准', slots: e.cfg.slots.map((s: any) => ({ heroId: s.heroId, freePoints: { attack: s.addAttack || 0, defense: s.addDefense || 0, strategy: s.addStrategy || 0, speed: s.addSpeed || 0 }, skillIds: s.skillIds || [], traits: s.traits || [], secondaryTroop: s.secondaryTroop })) }));
const t1: TeamDef[] = t1Raw.t1.map((e: any) => ({ id: e.id, note: e.note, tier: 'T1', archetype: e.archetype, slots: e.slots.map((s: any) => ({ heroId: s.heroId, freePoints: s.freePoints || {}, skillIds: s.skillIds || [], traits: s.traits || [], secondaryTroop: s.secondaryTroop })) }));
const ALL: TeamDef[] = [...t0, ...t1];
const byId = new Map(ALL.map(d => [d.id, d]));
function buildTeam(def: TeamDef) { return def.slots.map((s, i) => buildGeneral(s.heroId, s.skillIds, s.freePoints, RED_POSITIONS[i], 0, 40, 120, s.secondaryTroop, s.traits, null)); }
const teams = new Map<string, any[]>();
for (const d of ALL) teams.set(d.id, buildTeam(d));

const SEEDS = 40;
// 4 组代表性对局
const picks: { aId: string; bId: string; why: string }[] = [
  { aId: 't1-caozhang-loutie', bId: 'bench-xunyu-zhangchunhua-caocao', why: '白板强势撸铁(T1) vs 纯控制乌龟队(荀彧张春华曹操,T0软肋)：看增伤引擎如何碾压无增伤体系' },
  { aId: 'bench-zhurong-zhangliao-caocao', bId: 'bench-lvbu-zhangchunhua-zhenluo', why: '两支高爆发菜刀/吕布(T0)互搏：看前3回合爆发窗口如何决定胜负' },
  { aId: 't1-pangtong-shubu', bId: 'bench-xunyu-zhangchunhua-caocao', why: '肉步续航(T1) vs 控制乌龟(T0)：看“打不死”如何把控制流拖成平局/反杀' },
  { aId: 't1-zhangfei-liumang', bId: 'bench-taishici-caozhi-guanyu', why: '张飞流氓(T1,有增伤+续航) vs 太史慈曹植关羽(T0软肋,增伤链仅1.2%)：缺增伤引擎的代价' },
];

const out: any[] = [];
for (const p of picks) {
  const A = byId.get(p.aId)!, B = byId.get(p.bId)!;
  const teamA = teams.get(p.aId)!, teamB = teams.get(p.bId)!;
  let w = 0, l = 0, d = 0;
  let repSeed = -1, repR: any = null;
  let winSeed = -1, winR: any = null;
  for (let g = 0; g < SEEDS; g++) {
    const seed = (1009 * 7 + g * 31 + 3) & 0x7fffffff || 1;
    const dir = g < SEEDS / 2 ? 0 : 1;
    const myTeam = dir === 0 ? teamA : teamB;
    const enTeam = dir === 0 ? teamB : teamA;
    const myDef = dir === 0 ? A : B;
    const r = runBattle({ myTeam, enemyTeam: enTeam, seed, maxRounds: 8 });
    // 以 A 视角统计
    const aWin = dir === 0 ? r.result === 'win' : r.result === 'loss';
    const aDraw = r.result === 'draw';
    if (aWin) w++; else if (aDraw) d++; else l++;
    if (g === 0) { repSeed = seed; repR = r; }
    if (aWin && winSeed < 0) { winSeed = seed; winR = r; }
  }
  // 优先用 A 取胜的决定性种子做拆解；没有胜局则用首个
  const useR = winR || repR;
  const useSeed = winSeed >= 0 ? winSeed : repSeed;
  repR = useR; repSeed = useSeed;
  // 代表性种子逐回合拆解
  const r = repR;
  const rounds: any[] = [];
  let cur = 0;
  let lastCaster: string | null = null;
  const myIds = new Set(r.myTeam.map((g: any) => g.id));
  const oppIds = new Set(r.enemyTeam.map((g: any) => g.id));
  const events: any[] = [];
  for (const ev of r.events as any[]) {
    if (ev.type === 'round_start') cur = ev.round;
    else if (ev.type === 'skill_cast') lastCaster = ev.unitId;
    else if (ev.type === 'attack_hit' && ev.damage >= 1200) events.push({ round: cur, t: '普攻', by: myIds.has(ev.sourceId) ? '我' : '敌', dmg: Math.round(ev.damage) });
    else if (ev.type === 'damage' && ev.damage >= 1200) events.push({ round: cur, t: ev.damageType === 'strategy' ? '谋略' : '物理', by: myIds.has(ev.sourceId) ? '我' : '敌', sk: ev.skillName, dmg: Math.round(ev.damage) });
    else if (ev.type === 'status_inflicted' && ['confusion', 'rampage', 'cowardice', 'hesitation', 'taunt'].includes(ev.statusType)) events.push({ round: cur, t: '控制', by: (lastCaster && myIds.has(lastCaster)) ? '我' : '敌', sk: ev.detail });
    else if (ev.type === 'heal' && ev.amount >= 800) events.push({ round: cur, t: '恢复', by: myIds.has(ev.sourceId) ? '我' : '敌', sk: ev.skillName, amt: Math.round(ev.amount) });
    else if (ev.type === 'round_end') rounds.push({ round: ev.round, my: ev.myTroops.map((x: number) => Math.round(x)), enemy: ev.enemyTroops.map((x: number) => Math.round(x)) });
  }
  out.push({
    matchup: `${A.note}(${A.tier}) vs ${B.note}(${B.tier})`,
    why: p.why,
    resultDist_A_perspective: { win: w, loss: l, draw: d, winRate: +(w / SEEDS * 100).toFixed(1) },
    repSeed,
    finalResult: r.result,
    rounds,
    keyEvents: events.slice(0, 40),
  });
  console.log(`\n### ${A.note} vs ${B.note}`);
  console.log(`  A视角结果分布：胜${w} 负${l} 平${d}（胜率${+(w / SEEDS * 100).toFixed(1)}%）`);
  console.log(`  代表种子${repSeed} 结果=${r.result} 回合=${r.rounds}`);
  console.log(`  回合兵力(我/敌): ${rounds.map(x => 'R' + x.round + '[' + x.my.join('/') + '|' + x.enemy.join('/') + ']').join(' ')}`);
}
writeFileSync(join(root, 'docs/t0t1_cases.json'), JSON.stringify(out, null, 2), 'utf8');
console.log('\n已写出 docs/t0t1_cases.json');
