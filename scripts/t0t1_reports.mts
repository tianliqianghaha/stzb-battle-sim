/**
 * T0 × T1 全混战 · 高质量战报精选与精读底座
 * ───────────────────────────────────────────────────────────────────
 * 针对 6 组代表性配对（覆盖 5 条底层定律 + 始计时序结论 + 诚实跨梯队），
 * 双向 × 多种子扫描，挑选最具说明性的一场（明确胜负 / 平局），
 * 抽取完整事件流并按回合格式化为「可读战报」，附双方底层维度剖面。
 * 运行：SEEDS=60 npx tsx scripts/t0t1_reports.mts
 * 产物：docs/t0t1_reports.json
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
const SEEDS = parseInt(process.env.SEEDS || '60', 10);

interface SlotDef { heroId: string; freePoints: any; skillIds: string[]; traits?: string[]; secondaryTroop?: string; }
interface TeamDef { id: string; note: string; tier: string; archetype: string; slots: SlotDef[]; }

const t0: TeamDef[] = benchRaw.entries.map((e: any) => ({
  id: e.id, note: e.note, tier: 'T0', archetype: 'T0基准',
  slots: e.cfg.slots.map((s: any) => ({ heroId: s.heroId, freePoints: { attack: s.addAttack || 0, defense: s.addDefense || 0, strategy: s.addStrategy || 0, speed: s.addSpeed || 0 }, skillIds: s.skillIds || [], traits: s.traits || [], secondaryTroop: s.secondaryTroop })),
}));
const t1: TeamDef[] = t1Raw.t1.map((e: any) => ({ id: e.id, note: e.note, tier: 'T1', archetype: e.archetype, slots: e.slots.map((s: any) => ({ heroId: s.heroId, freePoints: s.freePoints || {}, skillIds: s.skillIds || [], traits: s.traits || [], secondaryTroop: s.secondaryTroop })) }));
const ALL: TeamDef[] = [...t0, ...t1];
const byId: Record<string, TeamDef> = {}; for (const d of ALL) byId[d.id] = d;

function buildTeam(def: TeamDef) {
  return def.slots.map((s, i) => buildGeneral(s.heroId, s.skillIds, s.freePoints, RED_POSITIONS[i], REDNESS, LEVEL, MORALE, s.secondaryTroop, s.traits, null));
}
const teams = new Map<string, any[]>();
for (const d of ALL) teams.set(d.id, buildTeam(d));

// 队伍文字画像（英雄 + 主战法 + 携带战法）
const hById: Record<string, any> = {}; for (const h of heroesData) hById[h.id] = h;
function teamPortrait(def: TeamDef) {
  return def.slots.map((s, i) => {
    const h = hById[s.heroId] || {};
    const main = { id: h.mainSkillId, name: h.mainSkillName };
    const carry = (s.skillIds || []).map((id: string) => ({ id, name: (skillDesc[id] && skillDesc[id].name) || id }));
    return { pos: RED_POSITIONS[i], hero: h.name || s.heroId, heroId: s.heroId, main, carry };
  });
}

// ── 事件格式化（可读战报）──
function fmtMods(mod: any) {
  if (!mod) return null;
  const out: any = {};
  const pack = (arr: any[], dir: string) => (arr || []).map((x: any) => ({ skill: x.skillName || x.skillId, rate: +(x.rate * 100).toFixed(0) }));
  out.caused = pack(mod.caused, 'caused');
  out.taken = pack(mod.taken, 'taken');
  out.reduce = pack(mod.reduce, 'reduce');
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

// 底层维度剖面（双方）
const CONTROLS = new Set(['confusion', 'rampage', 'cowardice', 'hesitation', 'taunt']);
function sideStats(report: any, selfIds: Set<string>, oppIds: Set<string>) {
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
  return { dmgDealt, dmgTaken, physDealt, stratDealt, earlyBurstPct: dmgDealt ? +(earlyDealt / dmgDealt * 100).toFixed(1) : 0, heal, control, 增伤活跃度: +(buffMag / 8).toFixed(2), 减伤活跃度: +(reduceMag / 8).toFixed(2) };
}

// ── 6 组代表性配对 ──
const PLANS = [
  { key: 'law1_zhurong_vs_xunyu', law: '定律1 · 增伤引擎分水岭', winner: 'bench-zhurong-zhangliao-caocao', desired: 'win',
    A: 'bench-zhurong-zhangliao-caocao', B: 'bench-xunyu-zhangchunhua-caocao',
    why: '增伤成型(祝融7.0) vs 增伤恒0(荀彧) —— 同一梯队内部, 增伤引擎有无直接决定胜负' },
  { key: 'law2_zhurong_vs_zhangchunhua', law: '定律2 · 爆发窗口 vs 减伤续航', winner: 'bench-zhurong-zhangliao-caocao', desired: 'win',
    A: 'bench-zhurong-zhangliao-caocao', B: 'bench-zhangchunhua-yuejin-yujin',
    why: 'R1-R3 爆发队 能否撕开 减伤+续航拖局队 的盾' },
  { key: 'law3_lvbu_vs_zhurong', law: '定律3 · 纯控制/减伤缺失陷阱', winner: 'bench-zhurong-zhangliao-caocao', desired: 'win',
    A: 'bench-lvbu-zhangchunhua-zhenluo', B: 'bench-zhurong-zhangliao-caocao',
    why: '控制覆盖高但无增伤无减伤 的吕布队, 被增伤爆发队反杀' },
  { key: 'law4_zhangfei_vs_zhangchunhua', law: '定律4 · 平局成因(8回合上限+双存活)', winner: null, desired: 'draw',
    A: 't1-zhangfei-liumang', B: 'bench-zhangchunhua-yuejin-yujin',
    why: '两个都偏拖局(张飞84%平 / 张春华减伤持续) —— 双方同存活到R8 成平' },
  { key: 'law5_caozhang_vs_zhouyu', law: '定律5 · 伤害类型揭示流派DNA', winner: 't1-caozhang-loutie', desired: 'win',
    A: 't1-caozhang-loutie', B: 't1-zhouyu-dudu',
    why: '纯物理流(曹彰) vs 纯谋略流(周瑜) —— 伤害类型对抗' },
  { key: 'honest_taishici_vs_caozhang', law: '诚实跨梯队 · 弱T0不敌强T1', winner: 't1-caozhang-loutie', desired: 'win',
    A: 'bench-taishici-caozhi-guanyu', B: 't1-caozhang-loutie',
    why: '增伤恒0的垫底T0(太史慈关羽) vs 增伤成型的强T1(曹彰) —— 梯队不是全局结论, 增伤维度才是' },
  { key: 'shiji_taishici_vs_zhurong', law: '始计时序验证 · 太史慈R1始计0%接通', winner: 'bench-zhurong-zhangliao-caocao', desired: 'win',
    A: 'bench-taishici-zhangchunhua-zhoutai', B: 'bench-zhurong-zhangliao-caocao',
    why: '太史慈带始计但先驱突击强制先动→R1始计0%接通(v2硬编码), 增伤薄(0.3)被增伤成型祝融碾压' },
];

function runSelected(plan: any) {
  const teamA = teams.get(plan.A)!, teamB = teams.get(plan.B)!;
  let best: any = null;
  for (let g = 0; g < SEEDS; g++) {
    for (const dir of [0, 1]) {
      const myDef = dir === 0 ? plan.A : plan.B;
      const enDef = dir === 0 ? plan.B : plan.A;
      const myTeam = dir === 0 ? teamA : teamB;
      const enTeam = dir === 0 ? teamB : teamA;
      const seed = ((g * 1009 + (dir + 1) * 131 + 7) & 0x7fffffff) || 1;
      const r = runBattle({ myTeam, enemyTeam: enTeam, seed, maxRounds: 8 });
      // 判定 desired 是否满足（从 winner 视角）
      let winOk = false, drawOk = false;
      if (plan.desired === 'draw') { drawOk = r.result === 'draw'; }
      else {
        // winner 视角是否胜
        const winnerIsMy = plan.winner === myDef;
        winOk = winnerIsMy ? r.result === 'win' : r.result === 'loss';
      }
      if (!winOk && !drawOk) continue;
      // 评分：决定战场取兵力差最大(清脆); 平局场取双方存活和最大
      const myTroops = r.finalMyTroops.reduce((a: number, b: number) => a + Math.max(0, b), 0);
      const enTroops = r.finalEnemyTroops.reduce((a: number, b: number) => a + Math.max(0, b), 0);
      const score = plan.desired === 'draw' ? (myTroops + enTroops) : Math.abs(myTroops - enTroops);
      if (!best || score > best.score) {
        // 构建可读战报
        const nameOf = (id: string) => { const m = [...r.myTeam, ...r.enemyTeam].find((u: any) => u.id === id); return m ? m.name : id; };
        const rounds: any[] = [];
        let cur: any = null;
        for (const ev of r.events as any[]) {
          if (ev.type === 'round_start') { cur = { round: ev.round, events: [] }; rounds.push(cur); }
          else { const f = fmtEvent(ev, nameOf); if (f) { if (!cur) { cur = { round: ev.round || 0, events: [] }; rounds.push(cur); } cur.events.push(f); } }
        }
        best = { score, dir, seed, report: r, rounds, myTroops, enTroops, myNameOf: nameOf };
      }
    }
  }
  return best;
}

const out: any = { meta: { seeds: SEEDS, generatedAt: new Date().toISOString() }, matchups: [] };
for (const plan of PLANS) {
  console.log(`扫描 ${plan.key} ...`);
  const sel = runSelected(plan);
  if (!sel) { console.log(`  ! 未找到满足 ${plan.desired} 的战报`); continue; }
  const r = sel.report;
  const myIds = new Set(r.myTeam.map((g: any) => g.id));
  const enIds = new Set(r.enemyTeam.map((g: any) => g.id));
  // 方向还原 A/B 归属
  const AisMy = sel.dir === 0;
  const A_ids = AisMy ? myIds : enIds;
  const B_ids = AisMy ? enIds : myIds;
  const A_stats = sideStats(r, A_ids, B_ids);
  const B_stats = sideStats(r, B_ids, A_ids);
  const A_def = byId[plan.A], B_def = byId[plan.B];
  out.matchups.push({
    key: plan.key, law: plan.law, why: plan.why,
    direction: AisMy ? `${A_def.note} 为攻方` : `${B_def.note} 为攻方`,
    selectedSeed: sel.seed, result: r.result, rounds: r.rounds,
    teamA: { id: plan.A, note: A_def.note, tier: A_def.tier, portrait: teamPortrait(A_def) },
    teamB: { id: plan.B, note: B_def.note, tier: B_def.tier, portrait: teamPortrait(B_def) },
    statsA: A_stats, statsB: B_stats,
    finalA: AisMy ? r.finalMyTroops : r.finalEnemyTroops,
    finalB: AisMy ? r.finalEnemyTroops : r.finalMyTroops,
    rounds: sel.rounds,
  });
  console.log(`  选定 seed=${sel.seed} dir=${sel.dir} result=${r.result} rounds=${r.rounds}`);
}
writeFileSync(join(root, 'docs/t0t1_reports.json'), JSON.stringify(out, null, 2), 'utf8');
console.log(`已写出 docs/t0t1_reports.json （${out.matchups.length} 组战报）`);
