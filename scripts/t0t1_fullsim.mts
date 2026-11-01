/**
 * T0 × T1 全 17 队 · 全双向循环均值战报 + 全战法覆盖深读底座
 * ───────────────────────────────────────────────────────────────────
 * - 17 队全双向循环（272 组有向配对 × 40 种子 = 10880 场），逐场聚合均值
 *   （胜平负率 / 场均伤 / 物理谋略 / 爆发% / 增伤活跃度 / 减伤 / 控制 / 续航），
 *   消除单局随机性。
 * - 单位 id 加 A:/B: 前缀，修正"跨队重复英雄(曹操/张辽/吕蒙…)同边错算"隐患。
 * - 逐场记录"本场出现的所有战法(main+carry 经事件命中)"，用于贪心最小覆盖：
 *   选最少场次，使 80 个不重复战法全部在深读样本里至少上场一次。
 * 运行：SEEDS=40 npx tsx scripts/t0t1_fullsim.mts
 * 产物：docs/t0t1_fullsim.json（均值矩阵+17队画像+逐场技能集合）
 *       docs/t0t1_deepread.json（覆盖全 80 战法的最少深读战报+完整事件流）
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

const heroByName: Record<string, { id: string; troopType: string }> = {};
for (const h of heroesData) { heroByName[h.name] = { id: h.id, troopType: h.troopType }; heroByName['XP' + h.name] = { id: h.id, troopType: h.troopType }; }
const RED_POSITIONS = ['大营', '中军', '前锋'] as const;
const MORALE = 120, LEVEL = 40, REDNESS = 0;
const SEEDS = parseInt(process.env.SEEDS || '40', 10);

interface SlotDef { heroId: string; freePoints: any; skillIds: string[]; traits?: string[]; secondaryTroop?: string; }
interface TeamDef { id: string; note: string; tier: string; archetype: string; slots: SlotDef[]; }

const t0: TeamDef[] = benchRaw.entries.map((e: any) => ({
  id: e.id, note: e.note, tier: 'T0', archetype: 'T0基准',
  slots: e.cfg.slots.map((s: any) => ({ heroId: s.heroId, freePoints: { attack: s.addAttack || 0, defense: s.addDefense || 0, strategy: s.addStrategy || 0, speed: s.addSpeed || 0 }, skillIds: s.skillIds || [], traits: s.traits || [], secondaryTroop: s.secondaryTroop })),
}));
const t1: TeamDef[] = t1Raw.t1.map((e: any) => ({ id: e.id, note: e.note, tier: 'T1', archetype: e.archetype, slots: e.slots.map((s: any) => ({ heroId: s.heroId, freePoints: s.freePoints || {}, skillIds: s.skillIds || [], traits: s.traits || [], secondaryTroop: s.secondaryTroop })) }));
const ALL: TeamDef[] = [...t0, ...t1];

// 所有不重复战法（main+carry）
const hById: Record<string, any> = {}; for (const h of heroesData) hById[h.id] = h;
const ALL_SKILLS: string[] = []; const skillSeen = new Set<string>();
const mainOf: Record<string, string> = {};
for (const d of ALL) for (const s of d.slots) {
  const main = hById[s.heroId]?.mainSkillId;
  if (main && !skillSeen.has(main)) { skillSeen.add(main); ALL_SKILLS.push(main); mainOf[s.heroId] = main; }
  for (const c of (s.skillIds || [])) if (!skillSeen.has(c)) { skillSeen.add(c); ALL_SKILLS.push(c); }
}

// 队伍构建（加 side 前缀，修正跨边错算）
function buildTeam(side: string, def: TeamDef): any[] {
  return def.slots.map((s, i) => { const g: any = buildGeneral(s.heroId, s.skillIds, s.freePoints, RED_POSITIONS[i], REDNESS, LEVEL, MORALE, s.secondaryTroop, s.traits, null); g.id = side + ':' + g.id; return g; });
}
const teams = new Map<string, any[]>();
for (const d of ALL) teams.set(d.id, buildTeam('A', d)); // 仅用于取英雄构成；实际对战每边独立 build 带前缀

function buildSide(side: string, def: TeamDef) { return buildTeam(side, def); }

// 底层维度剖面
const CONTROLS = new Set(['confusion', 'rampage', 'cowardice', 'hesitation', 'taunt']);
function sideStats(report: any, selfIds: Set<string>) {
  let dmgDealt = 0, dmgTaken = 0, physDealt = 0, stratDealt = 0, earlyDealt = 0, heal = 0, control = 0;
  let buffMag = 0, reduceMag = 0; let curRound = 0; let lastCaster: string | null = null;
  const sumMod = (mod: any) => { let m = 0; if (!mod) return 0; for (const x of (mod.caused || [])) if (selfIds.has(x.unitId)) m += x.rate; for (const x of (mod.taken || [])) if (!selfIds.has(x.unitId)) m += x.rate; return m; };
  const sumReduce = (mod: any) => { let m = 0; if (!mod) return 0; for (const x of (mod.reduce || [])) m += x.rate; return m; };
  for (const ev of report.events as any[]) {
    if (ev.type === 'round_start') curRound = ev.round;
    else if (ev.type === 'skill_cast') lastCaster = ev.unitId;
    else if (ev.type === 'attack_hit') { if (selfIds.has(ev.sourceId)) { dmgDealt += ev.damage; physDealt += ev.damage; if (curRound <= 3) earlyDealt += ev.damage; buffMag += sumMod(ev.modifiers); } if (selfIds.has(ev.targetId)) { dmgTaken += ev.damage; reduceMag += sumReduce(ev.modifiers); } }
    else if (ev.type === 'damage') { const dt = ev.damageType === 'strategy' ? 'strat' : 'phys'; if (selfIds.has(ev.sourceId)) { dmgDealt += ev.damage; if (dt === 'phys') physDealt += ev.damage; else stratDealt += ev.damage; if (curRound <= 3) earlyDealt += ev.damage; buffMag += sumMod(ev.modifiers); } if (selfIds.has(ev.targetId)) { dmgTaken += ev.damage; reduceMag += sumReduce(ev.modifiers); } }
    else if (ev.type === 'split_damage') { if (selfIds.has(ev.sourceId)) { dmgDealt += ev.damage; physDealt += ev.damage; if (curRound <= 3) earlyDealt += ev.damage; buffMag += sumMod(ev.modifiers); } }
    else if (ev.type === 'dot_tick') { if (selfIds.has(ev.sourceId) || selfIds.has(ev.casterId)) { dmgDealt += ev.damage; stratDealt += ev.damage; if (curRound <= 3) earlyDealt += ev.damage; buffMag += sumMod(ev.modifiers); } }
    else if (ev.type === 'heal') { if (selfIds.has(ev.sourceId)) heal += ev.amount; }
    else if (ev.type === 'status_inflicted' && CONTROLS.has(ev.statusType)) { if (lastCaster && selfIds.has(lastCaster)) control++; }
  }
  return { dmgDealt, dmgTaken, physDealt, stratDealt, earlyDealt, heal, control, buffMag, reduceMag };
}

// ── 主循环：全双向循环 ──
const N = ALL.length;
// pairStats[i][j] = i 攻击 j 时，i(A) 与 j(B) 的累计
const pairStats: any[][] = Array.from({ length: N }, () => Array.from({ length: N }, () => null));
for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) if (i !== j) pairStats[i][j] = { a: blankPair(), b: blankPair() };
const teamAgg: any[] = ALL.map(() => blankTeam());
function blankPair() { return { plays: 0, win: 0, loss: 0, draw: 0, dmgDealt: 0, dmgTaken: 0, phys: 0, strat: 0, early: 0, dmgTot: 0, heal: 0, control: 0, buff: 0, reduce: 0 }; }
function blankTeam() { return { plays: 0, win: 0, loss: 0, draw: 0, dmgDealt: 0, dmgTaken: 0, phys: 0, strat: 0, early: 0, dmgTot: 0, heal: 0, control: 0, buff: 0, reduce: 0 }; }
function addPair(p: any, s: any, won: number) { p.plays++; if (won === 1) p.win++; else if (won === -1) p.loss++; else p.draw++; p.dmgDealt += s.dmgDealt; p.dmgTaken += s.dmgTaken; p.phys += s.physDealt; p.strat += s.stratDealt; p.early += s.earlyDealt; p.dmgTot += s.dmgDealt; p.heal += s.heal; p.control += s.control; p.buff += s.buffMag; p.reduce += s.reduceMag; }
function addTeam(t: any, s: any, won: number) { t.plays++; if (won === 1) t.win++; else if (won === -1) t.loss++; else t.draw++; t.dmgDealt += s.dmgDealt; t.dmgTaken += s.dmgTaken; t.phys += s.physDealt; t.strat += s.stratDealt; t.early += s.earlyDealt; t.dmgTot += s.dmgDealt; t.heal += s.heal; t.control += s.control; t.buff += s.buffMag; t.reduce += s.reduceMag; }

// 覆盖：每场出现的战法集合
const coverage: { i: number; j: number; seed: number; skills: Set<string> }[] = [];

console.log(`开始全循环：${N} 队 × ${N - 1} 对手 × ${SEEDS} 种子 = ${N * (N - 1) * SEEDS} 场`);
let done = 0;
for (let i = 0; i < N; i++) {
  for (let j = 0; j < N; j++) {
    if (i === j) continue;
    const teamA = buildSide('A', ALL[i]);
    const teamB = buildSide('B', ALL[j]);
    const aIds = new Set(teamA.map((u: any) => u.id));
    const bIds = new Set(teamB.map((u: any) => u.id));
    for (let g = 0; g < SEEDS; g++) {
      const seed = ((g * 1009 + i * 131 + j * 17 + 7) & 0x7fffffff) || 1;
      const r: any = runBattle({ myTeam: teamA, enemyTeam: teamB, seed, maxRounds: 8 });
      const sA = sideStats(r, aIds);
      const sB = sideStats(r, bIds);
      const res = r.result === 'win' ? 1 : r.result === 'loss' ? -1 : 0;
      // 攻击者 i 视角：win→i胜(1)，loss→i负(-1)，draw→0
      const iWon = res; const jWon = -res;
      addPair(pairStats[i][j].a, sA, iWon); addPair(pairStats[i][j].b, sB, jWon);
      addTeam(teamAgg[i], sA, iWon); addTeam(teamAgg[j], sB, jWon);
      // 覆盖战法集合：main(双方英雄) + carry(双方英雄, 含被动战法) + 事件中出现的 skillId
      // 注：被动型战法(先驱突击/青囊秘要等)不产生 skill_trigger 事件，但只要携带英雄上场即"上场"，故无条件计入 carry
      const sk = new Set<string>();
      for (const s of ALL[i].slots) { const m = mainOf[s.heroId]; if (m) sk.add(m); for (const c of (s.skillIds || [])) sk.add(c); }
      for (const s of ALL[j].slots) { const m = mainOf[s.heroId]; if (m) sk.add(m); for (const c of (s.skillIds || [])) sk.add(c); }
      for (const ev of r.events as any[]) {
        if (ev.type === 'skill_trigger' && ev.skillId) sk.add(ev.skillId);
        else if ((ev.type === 'attack_hit' || ev.type === 'damage') && ev.modifiers) {
          for (const x of (ev.modifiers.caused || [])) if (x.skillId) sk.add(x.skillId);
          for (const x of (ev.modifiers.taken || [])) if (x.skillId) sk.add(x.skillId);
          for (const x of (ev.modifiers.reduce || [])) if (x.skillId) sk.add(x.skillId);
        }
      }
      coverage.push({ i, j, seed, skills: sk });
      done++;
    }
  }
  console.log(`  队 ${i + 1}/${N} 完成（累计 ${done} 场）`);
}

// ── 贪心最小覆盖：覆盖全部 80 战法的最少场次 ──
const totalSet = new Set(ALL_SKILLS);
let remaining = new Set(totalSet);
const selectedIdx: number[] = [];
let guard = 0;
while (remaining.size > 0 && guard++ < 200) {
  let best = -1, bestCover = 0;
  for (let k = 0; k < coverage.length; k++) {
    let c = 0; for (const s of coverage[k].skills) if (remaining.has(s)) c++;
    if (c > bestCover) { bestCover = c; best = k; }
  }
  if (best < 0 || bestCover === 0) break;
  selectedIdx.push(best);
  for (const s of coverage[best].skills) remaining.delete(s);
}
// 强制：17 队都至少出现在一场深读里
const teamSeen = new Set<number>();
for (const k of selectedIdx) { teamSeen.add(coverage[k].i); teamSeen.add(coverage[k].j); }
for (let t = 0; t < N; t++) if (!teamSeen.has(t)) {
  // 找一场含 t 的战斗（优先决定胜负清晰）
  for (let k = 0; k < coverage.length; k++) { if (coverage[k].i === t || coverage[k].j === t) { selectedIdx.push(k); teamSeen.add(t); break; } }
}
const coveredAfter = new Set<string>();
for (const k of selectedIdx) for (const s of coverage[k].skills) coveredAfter.add(s);
const stillMissing = [...totalSet].filter(s => !coveredAfter.has(s));

console.log(`最小覆盖：选中 ${selectedIdx.length} 场，覆盖战法 ${coveredAfter.size}/${totalSet.size}`);
if (stillMissing.length) console.log(`  ! 仍有 ${stillMissing.length} 个战法未被任何战斗覆盖：${stillMissing.join(',')}`);

// ── 写出均值数据 ──
function avgPair(p: any) { const n = p.plays || 1; return { winRate: +(p.win / n * 100).toFixed(1), lossRate: +(p.loss / n * 100).toFixed(1), drawRate: +(p.draw / n * 100).toFixed(1), dmgDealt: Math.round(p.dmgDealt / n), dmgTaken: Math.round(p.dmgTaken / n), phys: Math.round(p.phys / n), strat: Math.round(p.strat / n), earlyBurstPct: +(p.early / (p.dmgTot || 1) * 100).toFixed(1), heal: Math.round(p.heal / n), control: +(p.control / n).toFixed(1), 增伤活跃度: +(p.buff / n / 8).toFixed(2), 减伤活跃度: +(p.reduce / n / 8).toFixed(2) }; }
function avgTeam(t: any) { const n = t.plays || 1; return { winRate: +(t.win / n * 100).toFixed(1), lossRate: +(t.loss / n * 100).toFixed(1), drawRate: +(t.draw / n * 100).toFixed(1), dmgDealt: Math.round(t.dmgDealt / n), dmgTaken: Math.round(t.dmgTaken / n), phys: Math.round(t.phys / n), strat: Math.round(t.strat / n), earlyBurstPct: +(t.early / (t.dmgTot || 1) * 100).toFixed(1), heal: Math.round(t.heal / n), control: +(t.control / n).toFixed(1), 增伤活跃度: +(t.buff / n / 8).toFixed(2), 减伤活跃度: +(t.reduce / n / 8).toFixed(2) }; }

const pairOut: any = {};
for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) if (i !== j) pairOut[`${ALL[i].id}__${ALL[j].id}`] = { a: avgPair(pairStats[i][j].a), b: avgPair(pairStats[i][j].b) };
const teamOut = ALL.map((d, i) => ({ id: d.id, note: d.note, tier: d.tier, archetype: d.archetype, profile: avgTeam(teamAgg[i]) }));

const fullsim = {
  meta: { seeds: SEEDS, battles: N * (N - 1) * SEEDS, generatedAt: new Date().toISOString(), totalSkills: ALL_SKILLS.length, skillCoverNote: '单位id加A:/B:前缀修正跨边错算；均值覆盖全272有向配对×'+SEEDS+'种子' },
  teams: teamOut,
  pairs: pairOut,
  skillCoverage: { selectedBattles: selectedIdx.length, coveredSkills: coveredAfter.size, totalSkills: totalSet.size, stillMissing },
};
writeFileSync(join(root, 'docs/t0t1_fullsim.json'), JSON.stringify(fullsim, null, 2), 'utf8');
console.log(`已写出 docs/t0t1_fullsim.json`);

// ── 重跑选中战斗，抽取完整事件流（用于深读）──
function fmtMods(mod: any) {
  if (!mod) return null;
  const out: any = {};
  const pack = (arr: any[], dir: string) => (arr || []).map((x: any) => ({ skill: x.skillName || x.skillId, rate: +(x.rate * 100).toFixed(0) }));
  out.caused = pack(mod.caused, 'caused'); out.taken = pack(mod.taken, 'taken'); out.reduce = pack(mod.reduce, 'reduce');
  if (!out.caused.length && !out.taken.length && !out.reduce.length) return null;
  return out;
}
function fmtEvent(ev: any, nameOf: (id: string) => string) {
  switch (ev.type) {
    case 'skill_trigger': return { t: 'trigger', r: ev.round, who: nameOf(ev.unitId), skill: ev.skillName, ok: ev.success, rate: ev.rate };
    case 'attack_hit': return { t: 'hit', r: ev.round, src: nameOf(ev.sourceId), tgt: nameOf(ev.targetId), dmg: ev.damage, dtype: '物理', mods: fmtMods(ev.modifiers) };
    case 'damage': return { t: 'dmg', r: ev.round, src: nameOf(ev.sourceId), tgt: nameOf(ev.targetId), dmg: ev.damage, dtype: ev.damageType === 'strategy' ? '谋略' : '物理', mods: fmtMods(ev.modifiers) };
    case 'split_damage': return { t: 'split', r: ev.round, src: nameOf(ev.sourceId), tgt: nameOf(ev.targetId), dmg: ev.damage, dtype: '物理' };
    case 'dot_tick': return { t: 'dot', r: ev.round, src: nameOf(ev.sourceId || ev.casterId), tgt: nameOf(ev.targetId), dmg: ev.damage, dtype: '谋略' };
    case 'heal': return { t: 'heal', r: ev.round, src: nameOf(ev.sourceId), tgt: nameOf(ev.targetId), amt: ev.amount };
    case 'status_inflicted': return { t: 'ctrl', r: ev.round, who: nameOf(ev.unitId), status: ev.statusType, detail: ev.detail };
    case 'round_end': return { t: 'round', r: ev.round, my: ev.myTroops, en: ev.enemyTroops, myW: ev.myWounded, enW: ev.enemyWounded, myD: ev.myDead, enD: ev.enemyDead };
    case 'battle_end': return { t: 'end', res: ev.result, rounds: ev.rounds };
    default: return null;
  }
}
function teamPortrait(def: TeamDef) {
  return def.slots.map((s, i) => { const h = hById[s.heroId] || {}; return { pos: RED_POSITIONS[i], hero: h.name || s.heroId, heroId: s.heroId, main: { id: h.mainSkillId, name: h.mainSkillName }, carry: (s.skillIds || []).map((id: string) => ({ id, name: (skillDesc[id] && skillDesc[id].name) || id })) }; });
}
const deep: any[] = [];
for (const k of selectedIdx) {
  const c = coverage[k];
  const teamA = buildSide('A', ALL[c.i]); const teamB = buildSide('B', ALL[c.j]);
  const aIds = new Set(teamA.map((u: any) => u.id)); const bIds = new Set(teamB.map((u: any) => u.id));
  const r: any = runBattle({ myTeam: teamA, enemyTeam: teamB, seed: c.seed, maxRounds: 8 });
  const nameOf = (id: string) => { const base = id.split(':')[1]; const m = [...r.myTeam, ...r.enemyTeam].find((u: any) => u.id === id); return m ? m.name : (hById[base]?.name || base); };
  const rounds: any[] = []; let cur: any = null;
  for (const ev of r.events as any[]) { if (ev.type === 'round_start') { cur = { round: ev.round, events: [] }; rounds.push(cur); } else { const f = fmtEvent(ev, nameOf); if (f) { if (!cur) { cur = { round: ev.round || 0, events: [] }; rounds.push(cur); } cur.events.push(f); } } }
  deep.push({
    seed: c.seed, i: c.i, j: c.j, teamAId: ALL[c.i].id, teamBId: ALL[c.j].id,
    teamA: { id: ALL[c.i].id, note: ALL[c.i].note, tier: ALL[c.i].tier, portrait: teamPortrait(ALL[c.i]) },
    teamB: { id: ALL[c.j].id, note: ALL[c.j].note, tier: ALL[c.j].tier, portrait: teamPortrait(ALL[c.j]) },
    result: r.result, rounds: r.rounds, finalMy: r.finalMyTroops, finalEn: r.finalEnemyTroops,
    skillsPresent: [...c.skills],
    roundsEvents: rounds,
  });
}
writeFileSync(join(root, 'docs/t0t1_deepread.json'), JSON.stringify({ meta: { selectedBattles: deep.length, coveredSkills: coveredAfter.size, totalSkills: totalSet.size, stillMissing }, battles: deep }, null, 2), 'utf8');
console.log(`已写出 docs/t0t1_deepread.json（${deep.length} 场深读，覆盖战法 ${coveredAfter.size}/${totalSet.size}）`);
if (stillMissing.length) console.log('未覆盖战法：', stillMissing.join(','));
