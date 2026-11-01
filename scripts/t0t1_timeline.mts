/**
 * T0 战法时序联动抽取器（动态基底）
 * ───────────────────────────────────────────────────────────────────
 * 对每支 T0 基准队（攻方）vs 全 16 对手 × SEEDS(默认20)，逐场抽取：
 *   · 每回合 增伤幅度(buff=我方caused+敌方taken) / 减伤幅度(reduce) / 控制次数 / 伤害输出 / 续航恢复
 *   · 每个战法的「首次激活回合」分布 + 各回合触发次数直方图（识别 准备战法 R2 生效、增伤达峰回合等）
 * 产物：docs/t0t1_timeline.json
 * 运行：SEEDS=20 npx tsx scripts/t0t1_timeline.mts
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

const RED_POSITIONS = ['大营', '中军', '前锋'] as const;
const MORALE = 120, LEVEL = 40, REDNESS = 0;
const SEEDS = parseInt(process.env.SEEDS || '20', 10);
const CONTROLS = new Set(['confusion', 'rampage', 'cowardice', 'hesitation', 'taunt']);
const CTRL_NAME: Record<string, string> = { confusion: '混乱', rampage: '暴走', cowardice: '怯战', hesitation: '犹豫', taunt: '挑衅' };

interface SlotDef { heroId: string; freePoints: any; skillIds: string[]; traits?: string[]; secondaryTroop?: string; }
interface TeamDef { id: string; note: string; tier: string; archetype: string; slots: SlotDef[]; }

const t0: TeamDef[] = benchRaw.entries.map((e: any) => ({
  id: e.id, note: e.note, tier: 'T0', archetype: 'T0基准',
  slots: e.cfg.slots.map((s: any) => ({ heroId: s.heroId, freePoints: { attack: s.addAttack || 0, defense: s.addDefense || 0, strategy: s.addStrategy || 0, speed: s.addSpeed || 0 }, skillIds: s.skillIds || [], traits: s.traits || [], secondaryTroop: s.secondaryTroop })),
}));
const t1: TeamDef[] = t1Raw.t1.map((e: any) => ({ id: e.id, note: e.note, tier: 'T1', archetype: e.archetype, slots: e.slots.map((s: any) => ({ heroId: s.heroId, freePoints: s.freePoints || {}, skillIds: s.skillIds || [], traits: s.traits || [], secondaryTroop: s.secondaryTroop })) }));
const ALL: TeamDef[] = [...t0, ...t1];
const teams = new Map<string, any[]>();
for (const d of ALL) teams.set(d.id, d.slots.map((s, i) => buildGeneral(s.heroId, s.skillIds, s.freePoints, RED_POSITIONS[i], REDNESS, LEVEL, MORALE, s.secondaryTroop, s.traits, null)));

function sumMod(mod: any, selfIds: Set<string>): number {
  if (!mod) return 0; let m = 0;
  for (const x of (mod.caused || [])) if (selfIds.has(x.unitId)) m += x.rate;
  for (const x of (mod.taken || [])) if (!selfIds.has(x.unitId)) m += x.rate;
  return m;
}
function sumModReduce(mod: any): number { if (!mod) return 0; let m = 0; for (const x of (mod.reduce || [])) m += x.rate; return m; }

// 每支 T0 队的聚合器
interface TAcc {
  battles: number;
  roundsReached: number[]; // 到第R回合仍进行的场次数
  dmgDealt: number[]; dmgTaken: number[]; buff: number[]; reduce: number[]; control: number[]; heal: number[];
  ctrlByType: Record<string, number[]>;
  skills: Record<string, { name: string; attempts: number; success: number; firstRound: Record<number, number>; prepared: boolean }>;
}
function newTAcc(): TAcc {
  return { battles: 0, roundsReached: new Array(9).fill(0), dmgDealt: new Array(9).fill(0), dmgTaken: new Array(9).fill(0), buff: new Array(9).fill(0), reduce: new Array(9).fill(0), control: new Array(9).fill(0), heal: new Array(9).fill(0), ctrlByType: {}, skills: {} };
}
const acc = new Map<string, TAcc>();
for (const d of t0) acc.set(d.id, newTAcc());

let total = 0;
for (const T of t0) {
  const tAcc = acc.get(T.id)!;
  const teamT = teams.get(T.id)!;
  for (const O of ALL) {
    if (O.id === T.id) continue;
    const teamO = teams.get(O.id)!;
    for (let g = 0; g < SEEDS; g++) {
      const seed = ((T.id.length * 131 + O.id.length * 17 + g * 7) & 0x7fffffff) || 1;
      const r = runBattle({ myTeam: teamT, enemyTeam: teamO, seed, maxRounds: 8 });
      total++;
      const myIds = new Set(r.myTeam.map((g2: any) => g2.id));
      const selfIds = myIds;
      const ex = extractTimeline(r, selfIds);
      // 累加
      tAcc.battles++;
      for (let R = 1; R <= r.rounds; R++) tAcc.roundsReached[R]++;
      for (let R = 1; R <= 8; R++) { tAcc.dmgDealt[R] += ex.dmgDealt[R]; tAcc.dmgTaken[R] += ex.dmgTaken[R]; tAcc.buff[R] += ex.buff[R]; tAcc.reduce[R] += ex.reduce[R]; tAcc.control[R] += ex.control[R]; tAcc.heal[R] += ex.heal[R]; }
      for (const [st, arr] of Object.entries(ex.ctrlByType)) for (let R = 1; R <= 8; R++) { (tAcc.ctrlByType[st] ||= new Array(9).fill(0))[R] += arr[R]; }
      for (const [sid, k] of Object.entries(ex.skills)) {
        const t = tAcc.skills[sid] || (tAcc.skills[sid] = { name: k.name, attempts: 0, success: 0, firstRound: {}, prepared: k.prepared });
        t.attempts += k.attempts; t.success += k.success;
        for (const [R, c] of Object.entries(k.firstRound)) t.firstRound[+R] = (t.firstRound[+R] || 0) + c;
      }
    }
  }
}
console.log(`时序抽取完成：总场次=${total}`);

// 汇总输出
const out: any[] = [];
for (const T of t0) {
  const a = acc.get(T.id)!;
  const B = a.battles || 1;
  const avg = (arr: number[]) => { const o: any = {}; for (let R = 1; R <= 8; R++) o[R] = a.roundsReached[R] ? +(arr[R] / a.roundsReached[R]).toFixed(1) : 0; return o; };
  const skills_out = Object.entries(a.skills).map(([sid, k]) => {
    const fr = k.firstRound; const total2 = Object.values(fr).reduce((s: number, x: any) => s + x, 0) || 1;
    // 首次激活众数回合
    let modeR = 0, modeC = -1; for (const [R, c] of Object.entries(fr)) if ((c as number) > modeC) { modeC = c as number; modeR = +R; }
    const fireByRound: any = {}; for (let R = 1; R <= 8; R++) fireByRound[R] = fr[R] || 0;
    return { skillId: sid, name: k.name, prepared: k.prepared, attempts: k.attempts, success: k.success, actualRate: k.attempts ? +(k.success / k.attempts * 100).toFixed(1) : 0, firstRoundMode: modeR, fireByRound };
  }).sort((x, y) => (y.prepared ? 1 : 0) - (x.prepared ? 1 : 0) || y.attempts - x.attempts);
  // 关键时序节点
  const buffArr = a.buff, peakBuffR = argmaxRound(buffArr), peakDmgR = argmaxRound(a.dmgDealt);
  let firstCtrlR = 0; for (let R = 1; R <= 8; R++) if (a.control[R] > 0) { firstCtrlR = R; break; }
  let firstReduceR = 0; for (let R = 1; R <= 8; R++) if (a.reduce[R] > 0) { firstReduceR = R; break; }
  out.push({
    id: T.id, note: T.note, battles: B,
    roundsReached: a.roundsReached.slice(1),
    curves: { dmgDealt: avg(a.dmgDealt), dmgTaken: avg(a.dmgTaken), buff: avg(a.buff), reduce: avg(a.reduce), control: avg(a.control), heal: avg(a.heal) },
    ctrlByType: Object.fromEntries(Object.entries(a.ctrlByType).map(([st, arr]) => [st, avg(arr as number[])])),
    timing: { peakBuffRound: peakBuffR, peakDmgRound: peakDmgR, firstCtrlRound: firstCtrlR, firstReduceRound: firstReduceR },
    skills: skills_out,
  });
}
const payload = { meta: { seeds: SEEDS, level: LEVEL, redness: REDNESS, morale: MORALE, treasure: null, t0Count: t0.length, opponentsPerTeam: ALL.length - 1, generatedAt: new Date().toISOString() }, teams: out };
writeFileSync(join(root, 'docs/t0t1_timeline.json'), JSON.stringify(payload, null, 2), 'utf8');
console.log('已写出 docs/t0t1_timeline.json');
for (const t of out) console.log(`${t.note}: 增伤达峰R${t.timing.peakBuffRound} 伤害达峰R${t.timing.peakDmgRound} 首控R${t.timing.firstCtrlRound} 首减伤R${t.timing.firstReduceRound} 准备战法=${t.skills.filter(s=>s.prepared).map(s=>s.name).join('/')||'无'}`);

function argmaxRound(arr: number[]): number { let m = -1, r = 0; for (let R = 1; R <= 8; R++) if (arr[R] > m) { m = arr[R]; r = R; } return r; }

function extractTimeline(report: any, selfIds: Set<string>) {
  const dmgDealt = new Array(9).fill(0), dmgTaken = new Array(9).fill(0), buff = new Array(9).fill(0), reduce = new Array(9).fill(0), control = new Array(9).fill(0), heal = new Array(9).fill(0);
  const ctrlByType: Record<string, number[]> = {};
  const skills: Record<string, { name: string; attempts: number; success: number; firstRound: Record<number, number>; prepared: boolean }> = {};
  let curRound = 0; let lastCaster: string | null = null;
  const firedThisBattle = new Set<string>();
  for (const ev of report.events as any[]) {
    if (ev.type === 'round_start') curRound = ev.round;
    else if (ev.type === 'skill_cast') lastCaster = ev.unitId;
    else if (ev.type === 'skill_trigger') {
      lastCaster = ev.unitId;
      if (!selfIds.has(ev.unitId)) continue; // 只统计我方(T0)侧战法
      const k = skills[ev.skillId] || (skills[ev.skillId] = { name: ev.skillName, attempts: 0, success: 0, firstRound: {}, prepared: !!(skillDesc[ev.skillId] && /准备/.test(skillDesc[ev.skillId].desc || '')) });
      k.attempts++; if (ev.success) k.success++;
      if (!firedThisBattle.has(ev.skillId)) { firedThisBattle.add(ev.skillId); k.firstRound[curRound] = (k.firstRound[curRound] || 0) + 1; } // 每场仅记首次激活回合
    } else if (ev.type === 'attack_hit' || ev.type === 'damage' || ev.type === 'split_damage' || ev.type === 'dot_tick') {
      const dmg = ev.damage || 0;
      if (selfIds.has(ev.sourceId) || (ev.casterId && selfIds.has(ev.casterId))) {
        dmgDealt[curRound] += dmg;
        const mod = ev.modifiers; if (mod) buff[curRound] += sumMod(mod, selfIds);
      }
      if (selfIds.has(ev.targetId)) {
        dmgTaken[curRound] += dmg;
        const mod = ev.modifiers; if (mod) reduce[curRound] += sumModReduce(mod);
      }
    } else if (ev.type === 'heal') {
      if (selfIds.has(ev.sourceId)) heal[curRound] += ev.amount;
    } else if (ev.type === 'status_inflicted' && CONTROLS.has(ev.statusType)) {
      if (lastCaster && selfIds.has(lastCaster)) { control[curRound]++; (ctrlByType[ev.statusType] ||= new Array(9).fill(0))[curRound]++; }
    }
  }
  return { dmgDealt, dmgTaken, buff, reduce, control, heal, ctrlByType, skills };
}
