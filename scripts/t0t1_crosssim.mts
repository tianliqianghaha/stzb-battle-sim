/**
 * T0 × T1 全面混战模拟器（顶级配将师 · 底层规律论证 v1）
 * ───────────────────────────────────────────────────────────────────
 * 把「8 支 T0 基准 + 9 支网搜 T1」共 17 队两两互打，双向各半、多种子，
 * 从 BattleReport 事件流提取底层指标，回答「为什么是 T0 / 为什么是 T1」。
 * 提取维度：
 *   胜平负率、场均伤害(总/物/谋)、平均结束回合、前3回合爆发占比、
 *   增伤链(caused+taken) / 减伤链(reduce) 归因、控制覆盖、续航恢复、战法发动率vs期望、平局成因。
 * 运行：npx tsx scripts/t0t1_crosssim.mts
 *   预算：SEEDS(默认80) —— 136 配对 × 80 = 10880 场。
 * 产物：docs/t0t1_crosssim.json
 */
import { buildGeneral } from '../web/heroes';
import { runBattle } from '../src/engine/combat';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const heroesData: any[] = JSON.parse(readFileSync(join(root, 'web/data/heroes.json'), 'utf8'));
const skillDesc: Record<string, any> = JSON.parse(readFileSync(join(root, 'web/data/skill_desc.json'), 'utf8'));
const benchRaw: any = JSON.parse(readFileSync(join(root, 'web/data/opponent_benchmark.json'), 'utf8'));
const t1Raw: any = JSON.parse(readFileSync(join(root, 'docs/t0t1_roster.json'), 'utf8'));

// 名称 → 引擎 id（按名字解析；曹操/荀彧/刘备 等规范 id 已在 roster 直接用 id）
const heroByName: Record<string, { id: string; troopType: string }> = {};
for (const h of heroesData) { heroByName[h.name] = { id: h.id, troopType: h.troopType }; heroByName['XP' + h.name] = { id: h.id, troopType: h.troopType }; }
const skillByName: Record<string, string> = {};
for (const [id, s] of Object.entries(skillDesc)) skillByName[(s as any).name] = id;

const RED_POSITIONS = ['大营', '中军', '前锋'] as const;
const MORALE = 120;
const LEVEL = 40;
const REDNESS = 0;
const SEEDS = parseInt(process.env.SEEDS || '80', 10);

interface SlotDef { heroId: string; freePoints: any; skillIds: string[]; traits?: string[]; secondaryTroop?: string; }
interface TeamDef { id: string; note: string; tier: string; archetype: string; slots: SlotDef[]; }

// ── 读取 T0（bench 格式 → TeamDef，统一 40级白板/无宝物）──
const t0: TeamDef[] = benchRaw.entries.map((e: any) => ({
  id: e.id,
  note: e.note,
  tier: 'T0',
  archetype: 'T0基准',
  slots: e.cfg.slots.map((s: any) => ({
    heroId: s.heroId,
    freePoints: { attack: s.addAttack || 0, defense: s.addDefense || 0, strategy: s.addStrategy || 0, speed: s.addSpeed || 0 },
    skillIds: s.skillIds || [],
    traits: s.traits || [],
    secondaryTroop: s.secondaryTroop,
  })),
}));

// ── 读取 T1（已是 TeamDef 风格）──
const t1: TeamDef[] = t1Raw.t1.map((e: any) => ({
  id: e.id, note: e.note, tier: 'T1', archetype: e.archetype,
  slots: e.slots.map((s: any) => ({ heroId: s.heroId, freePoints: s.freePoints || {}, skillIds: s.skillIds || [], traits: s.traits || [], secondaryTroop: s.secondaryTroop })),
}));

const ALL: TeamDef[] = [...t0, ...t1];
console.log(`载入队伍：T0=${t0.length}  T1=${t1.length}  合计=${ALL.length}`);

// ── 构建所有队伍 ──
function buildTeam(def: TeamDef) {
  return def.slots.map((s, i) =>
    buildGeneral(s.heroId, s.skillIds, s.freePoints, RED_POSITIONS[i], REDNESS, LEVEL, MORALE, s.secondaryTroop, s.traits, null)
  );
}
const teams = new Map<string, any[]>();
for (const d of ALL) teams.set(d.id, buildTeam(d));

// ── 每队累加器 ──
const CONTROLS = new Set(['confusion', 'rampage', 'cowardice', 'hesitation', 'taunt']);
interface Acc {
  battles: number; w: number; l: number; d: number;
  dmgDealt: number; dmgTaken: number; physDealt: number; stratDealt: number;
  earlyDealt: number; roundsSum: number;
  controlDealt: number; controlTaken: number;
  healDealt: number; healTaken: number;
  buffMag: number; // 我方造成的伤害上：caused + taken(敌方被上神兵) 之和
  reduceMag: number; // 我方受到的伤害上：reduce(我方减伤) 之和
  drawRoundsSum: number; drawCount: number; drawSurviveSum: number;
  skills: Record<string, { name: string; attempts: number; success: number; sumRate: number; sumBase: number }>;
}
function newAcc(): Acc {
  return { battles: 0, w: 0, l: 0, d: 0, dmgDealt: 0, dmgTaken: 0, physDealt: 0, stratDealt: 0, earlyDealt: 0, roundsSum: 0, controlDealt: 0, controlTaken: 0, healDealt: 0, healTaken: 0, buffMag: 0, reduceMag: 0, drawRoundsSum: 0, drawCount: 0, drawSurviveSum: 0, skills: {} };
}
const acc = new Map<string, Acc>();
for (const d of ALL) acc.set(d.id, newAcc());

// 配对胜平负矩阵
const matchup: Record<string, Record<string, { w: number; l: number; d: number }>> = {};
for (const d of ALL) matchup[d.id] = {};

function sideOf(id: string, my: Set<string>) { return my.has(id) ? 'my' : 'enemy'; }

function extract(report: any, teamIdSide: 'my' | 'enemy') {
  const myIds = new Set(report.myTeam.map((g: any) => g.id));
  const enemyIds = new Set(report.enemyTeam.map((g: any) => g.id));
  // teamIdSide: 'my' 表示我们要统计的队伍在 report.myTeam 一侧
  const selfIds = teamIdSide === 'my' ? myIds : enemyIds;
  const oppIds = teamIdSide === 'my' ? enemyIds : myIds;

  let dmgDealt = 0, dmgTaken = 0, physDealt = 0, stratDealt = 0, earlyDealt = 0;
  let controlDealt = 0, controlTaken = 0, healDealt = 0, healTaken = 0;
  let buffMag = 0, reduceMag = 0;
  const skills: Acc['skills'] = {};
  let curRound = 0;
  let lastCaster: string | null = null;

  for (const ev of report.events as any[]) {
    if (ev.type === 'round_start') curRound = ev.round;
    else if (ev.type === 'skill_cast') lastCaster = ev.unitId;
    else if (ev.type === 'skill_trigger') { lastCaster = ev.unitId; const k = skills[ev.skillId] || (skills[ev.skillId] = { name: ev.skillName, attempts: 0, success: 0, sumRate: 0, sumBase: 0 }); k.attempts++; if (ev.success) k.success++; if (typeof ev.rate === 'number') k.sumRate += ev.rate; if (typeof ev.baseRate === 'number') k.sumBase += ev.baseRate; }
    else if (ev.type === 'attack_hit') {
      const onSelf = selfIds.has(ev.targetId); const bySelf = selfIds.has(ev.sourceId);
      if (bySelf) { dmgDealt += ev.damage; physDealt += ev.damage; if (curRound <= 3) earlyDealt += ev.damage; if (ev.modifiers) buffMag += sumMod(ev.modifiers, selfIds, ev.sourceId, 'gain'); }
      if (onSelf) { dmgTaken += ev.damage; if (ev.modifiers) reduceMag += sumModReduce(ev.modifiers); }
    } else if (ev.type === 'damage') {
      const bySelf = selfIds.has(ev.sourceId); const onSelf = selfIds.has(ev.targetId);
      const dt = ev.damageType === 'strategy' ? 'strat' : 'phys';
      if (bySelf) { dmgDealt += ev.damage; if (dt === 'phys') physDealt += ev.damage; else stratDealt += ev.damage; if (curRound <= 3) earlyDealt += ev.damage; if (ev.modifiers) buffMag += sumMod(ev.modifiers, selfIds, ev.sourceId, 'gain'); }
      if (onSelf) { dmgTaken += ev.damage; if (ev.modifiers) reduceMag += sumModReduce(ev.modifiers); }
    } else if (ev.type === 'split_damage') {
      const bySelf = selfIds.has(ev.sourceId);
      if (bySelf) { dmgDealt += ev.damage; physDealt += ev.damage; if (curRound <= 3) earlyDealt += ev.damage; if (ev.modifiers) buffMag += sumMod(ev.modifiers, selfIds, ev.sourceId, 'gain'); }
    } else if (ev.type === 'dot_tick') {
      const bySelf = selfIds.has(ev.sourceId) || selfIds.has(ev.casterId);
      if (bySelf) { dmgDealt += ev.damage; stratDealt += ev.damage; if (curRound <= 3) earlyDealt += ev.damage; if (ev.modifiers) buffMag += sumMod(ev.modifiers, selfIds, ev.sourceId, 'gain'); }
    } else if (ev.type === 'heal') {
      if (selfIds.has(ev.sourceId)) healDealt += ev.amount;
      if (selfIds.has(ev.targetId)) healTaken += ev.amount; // 我方受到的恢复（续航兜底）
    } else if (ev.type === 'status_inflicted' && CONTROLS.has(ev.statusType)) {
      if (lastCaster && selfIds.has(lastCaster)) controlDealt++;
      if (lastCaster && oppIds.has(lastCaster)) controlTaken++;
    }
  }
  return { dmgDealt, dmgTaken, physDealt, stratDealt, earlyDealt, controlDealt, controlTaken, healDealt, healTaken, buffMag, reduceMag, skills };
}

// 我方"造成"伤害时，统计增强我方输出的归因（caused=我方增伤战法；taken=敌方被上神兵/受伤提高）
function sumMod(mod: any, selfIds: Set<string>, srcId: string, _mode: string): number {
  if (!mod) return 0;
  let m = 0;
  for (const x of (mod.caused || [])) if (selfIds.has(x.unitId)) m += x.rate; // 大赏三军等（施加者在我方）
  for (const x of (mod.taken || [])) if (!selfIds.has(x.unitId)) m += x.rate; // 神兵天降施加在敌方 → 放大我方输出
  return m;
}
// 我方"受到"伤害时，统计我方减伤（reduce，施加者在我方）
function sumModReduce(mod: any): number {
  if (!mod) return 0;
  let m = 0;
  for (const x of (mod.reduce || [])) m += x.rate;
  return m;
}

// ── 主循环：全配对 × 双向 × SEEDS ──
let total = 0;
for (let i = 0; i < ALL.length; i++) {
  for (let j = i + 1; j < ALL.length; j++) {
    const A = ALL[i], B = ALL[j];
    const teamA = teams.get(A.id)!, teamB = teams.get(B.id)!;
    for (let g = 0; g < SEEDS; g++) {
      const dir = g < SEEDS / 2 ? 0 : 1;
      const myDef = dir === 0 ? A : B;
      const enDef = dir === 0 ? B : A;
      const myTeam = dir === 0 ? teamA : teamB;
      const enTeam = dir === 0 ? teamB : teamA;
      const seed = ((i * 1009 + j * 131 + g * 17) & 0x7fffffff) || 1;
      const r = runBattle({ myTeam, enemyTeam: enTeam, seed, maxRounds: 8 });
      total++;

      // 统计 myDef 视角
      const exMine = extract(r, 'my');
      const mineAcc = acc.get(myDef.id)!;
      mineAcc.battles++;
      if (r.result === 'win') mineAcc.w++; else if (r.result === 'loss') mineAcc.l++; else mineAcc.d++;
      if (r.result === 'draw') { mineAcc.drawRoundsSum += r.rounds; mineAcc.drawCount++; const surv = r.finalMyTroops.reduce((a: number, b: number) => a + Math.max(0, b), 0); mineAcc.drawSurviveSum += surv; }
      mineAcc.dmgDealt += exMine.dmgDealt; mineAcc.dmgTaken += exMine.dmgTaken; mineAcc.physDealt += exMine.physDealt; mineAcc.stratDealt += exMine.stratDealt;
      mineAcc.earlyDealt += exMine.earlyDealt; mineAcc.roundsSum += r.rounds;
      mineAcc.controlDealt += exMine.controlDealt; mineAcc.controlTaken += exMine.controlTaken;
      mineAcc.healDealt += exMine.healDealt; mineAcc.healTaken += exMine.healTaken;
      mineAcc.buffMag += exMine.buffMag; mineAcc.reduceMag += exMine.reduceMag;
      for (const [sid, k] of Object.entries(exMine.skills)) { const t = mineAcc.skills[sid] || (mineAcc.skills[sid] = { name: k.name, attempts: 0, success: 0, sumRate: 0, sumBase: 0 }); t.attempts += k.attempts; t.success += k.success; t.sumRate += k.sumRate; t.sumBase += k.sumBase; }

      // 统计 enDef 视角
      const exOpp = extract(r, 'enemy');
      const oppAcc = acc.get(enDef.id)!;
      oppAcc.battles++;
      if (r.result === 'win') oppAcc.l++; else if (r.result === 'loss') oppAcc.w++; else oppAcc.d++;
      if (r.result === 'draw') { oppAcc.drawRoundsSum += r.rounds; oppAcc.drawCount++; const surv = r.finalEnemyTroops.reduce((a: number, b: number) => a + Math.max(0, b), 0); oppAcc.drawSurviveSum += surv; }
      oppAcc.dmgDealt += exOpp.dmgDealt; oppAcc.dmgTaken += exOpp.dmgTaken; oppAcc.physDealt += exOpp.physDealt; oppAcc.stratDealt += exOpp.stratDealt;
      oppAcc.earlyDealt += exOpp.earlyDealt; oppAcc.roundsSum += r.rounds;
      oppAcc.controlDealt += exOpp.controlDealt; oppAcc.controlTaken += exOpp.controlTaken;
      oppAcc.healDealt += exOpp.healDealt; oppAcc.healTaken += exOpp.healTaken;
      oppAcc.buffMag += exOpp.buffMag; oppAcc.reduceMag += exOpp.reduceMag;
      for (const [sid, k] of Object.entries(exOpp.skills)) { const t = oppAcc.skills[sid] || (oppAcc.skills[sid] = { name: k.name, attempts: 0, success: 0, sumRate: 0, sumBase: 0 }); t.attempts += k.attempts; t.success += k.success; t.sumRate += k.sumRate; t.sumBase += k.sumBase; }

      // 矩阵（A 视角）
      const mk = matchup[A.id][B.id] || (matchup[A.id][B.id] = { w: 0, l: 0, d: 0 });
      if (dir === 0) { if (r.result === 'win') mk.w++; else if (r.result === 'loss') mk.l++; else mk.d++; }
      else { if (r.result === 'win') mk.l++; else if (r.result === 'loss') mk.w++; else mk.d++; }
    }
  }
}
console.log(`模拟完成：总场次=${total}`);

// ── 汇总每队指标 ──
const teams_out: any[] = [];
for (const d of ALL) {
  const a = acc.get(d.id)!;
  const b = a.battles || 1;
  const skills_out: any[] = Object.entries(a.skills).map(([sid, k]) => ({
    skillId: sid, name: k.name, attempts: k.attempts, success: k.success,
    actualRate: k.attempts ? +(k.success / k.attempts * 100).toFixed(1) : 0,
    expectRate: k.attempts ? +(k.sumBase / k.attempts).toFixed(1) : 0,
  })).sort((x, y) => y.attempts - x.attempts);
  teams_out.push({
    id: d.id, note: d.note, tier: d.tier, archetype: d.archetype,
    winRate: +(a.w / b * 100).toFixed(1), lossRate: +(a.l / b * 100).toFixed(1), drawRate: +(a.d / b * 100).toFixed(1),
    avgRounds: +(a.roundsSum / b).toFixed(2),
    dmgDealt: Math.round(a.dmgDealt / b), dmgTaken: Math.round(a.dmgTaken / b),
    physDealt: Math.round(a.physDealt / b), stratDealt: Math.round(a.stratDealt / b),
    earlyBurstPct: a.dmgDealt ? +(a.earlyDealt / a.dmgDealt * 100).toFixed(1) : 0,
    controlDealt: +(a.controlDealt / b).toFixed(2), controlTaken: +(a.controlTaken / b).toFixed(2),
    healDealt: Math.round(a.healDealt / b), healTaken: Math.round(a.healTaken / b),
    buffMagPct: a.battles ? +(a.buffMag / a.battles * 100).toFixed(1) : 0,
    reduceMagPct: a.battles ? +(a.reduceMag / a.battles * 100).toFixed(1) : 0,
    drawAvgRounds: a.drawCount ? +(a.drawRoundsSum / a.drawCount).toFixed(2) : 0,
    drawAvgSurvive: a.drawCount ? Math.round(a.drawSurviveSum / a.drawCount) : 0,
    topSkills: skills_out.slice(0, 6),
  });
}
teams_out.sort((x, y) => y.winRate - x.winRate);

// 分层平均
function avgTier(tier: string, key: string) {
  const arr = teams_out.filter(t => t.tier === tier);
  return +(arr.reduce((s, t) => s + (t as any)[key], 0) / (arr.length || 1)).toFixed(2);
}
const tierSummary = ['T0', 'T1'].map(t => ({
  tier: t, n: teams_out.filter(x => x.tier === t).length,
  winRate: avgTier(t, 'winRate'), lossRate: avgTier(t, 'lossRate'), drawRate: avgTier(t, 'drawRate'),
  dmgDealt: avgTier(t, 'dmgDealt'), dmgTaken: avgTier(t, 'dmgTaken'),
  earlyBurstPct: avgTier(t, 'earlyBurstPct'), buffMagPct: avgTier(t, 'buffMagPct'), reduceMagPct: avgTier(t, 'reduceMagPct'),
  controlDealt: avgTier(t, 'controlDealt'), healDealt: avgTier(t, 'healDealt'),
}));

// ── 分层交叉胜率（T0 打 T1 vs T1 打 T0）──
const tierOf: Record<string, string> = {};
for (const d of ALL) tierOf[d.id] = d.tier;
let t0vst1 = { games: 0, t0w: 0, t0l: 0, t0d: 0 }; // T0 视角对阵 T1
let t1vst0 = { games: 0, t1w: 0, t1l: 0, t1d: 0 };
// 每队分阵营胜率
const vsTier: Record<string, { vsT0: { b: number; w: number }; vsT1: { b: number; w: number } }> = {};
for (const d of ALL) vsTier[d.id] = { vsT0: { b: 0, w: 0 }, vsT1: { b: 0, w: 0 } };
for (let i = 0; i < ALL.length; i++) {
  for (let j = i + 1; j < ALL.length; j++) {
    const A = ALL[i], B = ALL[j];
    const mk = matchup[A.id][B.id];
    if (!mk) continue;
    const games = mk.w + mk.l + mk.d;
    // A 视角：w=胜,l=负,d=平
    vsTier[A.id][tierOf[B.id] === 'T0' ? 'vsT0' : 'vsT1'].b += games;
    vsTier[A.id][tierOf[B.id] === 'T0' ? 'vsT0' : 'vsT1'].w += mk.w;
    vsTier[B.id][tierOf[A.id] === 'T0' ? 'vsT0' : 'vsT1'].b += games;
    vsTier[B.id][tierOf[A.id] === 'T0' ? 'vsT0' : 'vsT1'].w += mk.l; // B 视角：A 的负 = B 的胜
    if (tierOf[A.id] !== tierOf[B.id]) {
      if (tierOf[A.id] === 'T0') { t0vst1.games += games; t0vst1.t0w += mk.w; t0vst1.t0l += mk.l; t0vst1.t0d += mk.d; }
      else { t1vst0.games += games; t1vst0.t1w += mk.w; t1vst0.t1l += mk.l; t1vst0.t1d += mk.d; }
    }
  }
}
const crossTier = {
  t0_vs_t1: { games: t0vst1.games, t0_winRate: +(t0vst1.t0w / (t0vst1.games || 1) * 100).toFixed(1), t0_lossRate: +(t0vst1.t0l / (t0vst1.games || 1) * 100).toFixed(1), t0_drawRate: +(t0vst1.t0d / (t0vst1.games || 1) * 100).toFixed(1) },
  t1_vs_t0: { games: t1vst0.games, t1_winRate: +(t1vst0.t1w / (t1vst0.games || 1) * 100).toFixed(1), t1_lossRate: +(t1vst0.t1l / (t1vst0.games || 1) * 100).toFixed(1), t1_drawRate: +(t1vst0.t1d / (t1vst0.games || 1) * 100).toFixed(1) },
};
// 把分阵营胜率写回 teams_out
for (const t of teams_out) {
  const v = vsTier[t.id];
  t.vsT0_winRate = v.vsT0.b ? +(v.vsT0.w / v.vsT0.b * 100).toFixed(1) : 0;
  t.vsT1_winRate = v.vsT1.b ? +(v.vsT1.w / v.vsT1.b * 100).toFixed(1) : 0;
}

const out = {
  meta: { seeds: SEEDS, teams: ALL.length, t0Count: t0.length, t1Count: t1.length, level: LEVEL, redness: REDNESS, morale: MORALE, treasure: null, generatedAt: new Date().toISOString(), version: t1Raw.version },
  tierSummary,
  crossTier,
  teams: teams_out,
  matchup,
};
writeFileSync(join(root, 'docs/t0t1_crosssim.json'), JSON.stringify(out, null, 2), 'utf8');
console.log('已写出 docs/t0t1_crosssim.json');
// 控制台速览
console.log('\n=== 分层平均（T0 vs T1，全混战视角）===');
for (const t of tierSummary) console.log(JSON.stringify(t));
console.log('\n=== 胜率排行（Top 全部）===');
for (const t of teams_out) console.log(`${t.tier} 胜${t.winRate}% 非败${(100 - t.lossRate).toFixed(1)}% 平${t.drawRate}%  ${t.note} [${t.archetype}]`);
