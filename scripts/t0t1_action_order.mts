/**
 * T0 回合内行动顺序精拆 —— 始计接通大营验证
 * ───────────────────────────────────────────────────────────────────
 * 对含「始计(shiji)」的 3 支 T0 基准队（吕布·张春华·甄洛 / 太史慈·张春华·周泰 / 张春华·乐进·于禁），
 * 逐场重建回合内行动顺序，回答：张春华的始计 +20% 增伤，到底有没有落在「大营」的攻击上。
 *
 * 判定方法（双保险）：
 *   ① 修饰判定（铁证）：大营每一次伤害事件的 modifiers.caused 中是否含 skillId=shiji 的增伤来源。
 *      含 → 该次攻击吃到了始计 +20%；不含 → 没吃到。
 *   ② 顺序判定（解释）：同一回合内，张春华的 shiji 触发（skill_trigger）是否早于大营的首次攻击。
 *      早 → 完美接通（R1 即生效）；晚 → 大营 R1 空窗、始计延迟到 R2 才接上。
 *
 * 运行：SEEDS=80 npx tsx scripts/t0t1_action_order.mts
 * 调试：DEBUG=1 SEEDS=1 npx tsx scripts/t0t1_action_order.mts   （dump 首场事件流）
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
const SEEDS = parseInt(process.env.SEEDS || '80', 10);
const DEBUG = process.env.DEBUG === '1';

const t0: any[] = benchRaw.entries.map((e: any) => ({
  id: e.id, note: e.note, tier: 'T0',
  slots: e.cfg.slots.map((s: any) => ({ heroId: s.heroId, freePoints: { attack: s.addAttack || 0, defense: s.addDefense || 0, strategy: s.addStrategy || 0, speed: s.addSpeed || 0 }, skillIds: s.skillIds || [], traits: s.traits || [], secondaryTroop: s.secondaryTroop })),
}));
const t1: any[] = t1Raw.t1.map((e: any) => ({ id: e.id, note: e.note, tier: 'T1', archetype: e.archetype, slots: e.slots.map((s: any) => ({ heroId: s.heroId, freePoints: s.freePoints || {}, skillIds: s.skillIds || [], traits: s.traits || [], secondaryTroop: s.secondaryTroop })) }));
const ALL: any[] = [...t0, ...t1];
const teams = new Map<string, any[]>();
for (const d of ALL) teams.set(d.id, d.slots.map((s: any, i: number) => buildGeneral(s.heroId, s.skillIds, s.freePoints, RED_POSITIONS[i], REDNESS, LEVEL, MORALE, s.secondaryTroop, s.traits, null)));

// 找含 始计 的 T0 队
const SHIJI_TEAMS = t0.filter((d) => d.slots.some((s: any) => (s.skillIds || []).includes('shiji')));
console.log('含始计 T0 队：', SHIJI_TEAMS.map((d) => d.note).join(' / '));

interface TeamAcc {
  battles: number;
  dayingAttacks: number; dayingAttacksBuffed: number;          // 大营全部攻击（含策略）
  dayingR1Attacks: number; dayingR1AttacksBuffed: number;      // 大营 R1 攻击
  dayingR1to4Attacks: number; dayingR1to4AttacksBuffed: number;// 大营 前4回合攻击（始计有效期）
  carrierFasterR1: number; carrierSlowerR1: number;            // R1 顺序：始计早于大营攻击 / 晚于
  r1Exists: number;                                            // 大营在 R1 有出手
  carrierSpeed: number; dayingSpeed: number;
  byOpponent: Record<string, { atk: number; buffed: number }>;
}
function newAcc(): TeamAcc {
  return { battles: 0, dayingAttacks: 0, dayingAttacksBuffed: 0, dayingR1Attacks: 0, dayingR1AttacksBuffed: 0, dayingR1to4Attacks: 0, dayingR1to4AttacksBuffed: 0, carrierFasterR1: 0, carrierSlowerR1: 0, r1Exists: 0, carrierSpeed: 0, dayingSpeed: 0, byOpponent: {} };
}
const acc = new Map<string, TeamAcc>();
for (const d of SHIJI_TEAMS) acc.set(d.id, newAcc());

let dbgDone = false;
let total = 0;

for (const T of SHIJI_TEAMS) {
  const tAcc = acc.get(T.id)!;
  const teamT = teams.get(T.id)!;
  // 找出 始计携带者（按配置槽位的 skillIds 定位，两支队的张春华均在中军=slot1）与大营（slot0）
  const carrierIdx = T.slots.findIndex((s: any) => (s.skillIds || []).includes('shiji'));
  const dayingIdx = 0;
  for (const O of ALL) {
    if (O.id === T.id) continue;
    const teamO = teams.get(O.id)!;
    for (let g = 0; g < SEEDS; g++) {
      const seed = ((T.id.length * 131 + O.id.length * 17 + g * 7) & 0x7fffffff) || 1;
      const r = runBattle({ myTeam: teamT, enemyTeam: teamO, seed, maxRounds: 8 });
      total++;
      const carrierId = teamT[carrierIdx].id;
      const dayingId = teamT[dayingIdx].id;
      tAcc.carrierSpeed = teamT[carrierIdx].speed ?? 0;
      tAcc.dayingSpeed = teamT[dayingIdx].speed ?? 0;
      const oppo = (tAcc.byOpponent[O.id] ||= { atk: 0, buffed: 0 });
      tAcc.battles++;

      // 重建回合内顺序
      let curRound = 0; let seq = 0;
      const roundSeq: Record<number, number> = {}; // unitId|event -> order within round (min)
      let lastCaster: string | null = null;
      let shijiRoundSeq: Record<number, number> = {};
      let dayingAtkRoundSeq: Record<number, number> = {};
      const dayingAtkBuffedRound: Record<number, boolean> = {};

      const events = r.events as any[];
      for (const ev of events) {
        if (ev.type === 'round_start') { curRound = ev.round; seq = 0; continue; }
        seq++;
        if (ev.type === 'skill_cast') lastCaster = ev.unitId;
        else if (ev.type === 'skill_trigger') {
          lastCaster = ev.unitId;
          if (ev.unitId === carrierId && ev.skillId === 'shiji') {
            if (!(curRound in shijiRoundSeq)) shijiRoundSeq[curRound] = seq;
          }
        } else if (ev.type === 'attack_hit' || ev.type === 'damage' || ev.type === 'split_damage' || ev.type === 'dot_tick') {
          const src = ev.sourceId || ev.casterId || ev.creditToId;
          if (src === dayingId) {
            if (!(curRound in dayingAtkRoundSeq)) dayingAtkRoundSeq[curRound] = seq;
            // 修饰判定：caused 里是否有 shiji
            const mod = ev.modifiers;
            let buffed = false;
            if (mod && mod.caused) for (const x of mod.caused) if (x.skillId === 'shiji' || x.skillName === '始计') { buffed = true; break; }
            // 累计
            tAcc.dayingAttacks++; oppo.atk++;
            if (buffed) { tAcc.dayingAttacksBuffed++; oppo.buffed++; }
            if (curRound === 1) { tAcc.dayingR1Attacks++; if (buffed) tAcc.dayingR1AttacksBuffed++; tAcc.r1Exists++; }
            if (curRound >= 1 && curRound <= 4) { tAcc.dayingR1to4Attacks++; if (buffed) tAcc.dayingR1to4AttacksBuffed++; }
          }
        }
      }
      // R1 顺序判定（仅大营在 R1 出手时）
      if (1 in dayingAtkRoundSeq) {
        const sShiji = shijiRoundSeq[1];
        const sAtk = dayingAtkRoundSeq[1];
        if (sShiji != null && sAtk != null) {
          if (sShiji < sAtk) tAcc.carrierFasterR1++; else tAcc.carrierSlowerR1++;
        }
      }

      // DEBUG dump 首场
      if (DEBUG && !dbgDone) {
        dbgDone = true;
        console.log('\n===== DEBUG 首场事件流 =====');
        console.log('队伍:', T.note, '| 对手:', O.note, '| seed:', seed, '| 结果:', r.result, '| 回合:', r.rounds);
        console.log('张春华(unitId=', carrierId, 'speed=', tAcc.carrierSpeed, ')  大营=', teamT[dayingIdx].name, '(unitId=', dayingId, 'speed=', tAcc.dayingSpeed, ')');
        let cr = 0, sq = 0;
        for (const ev of events) {
          if (ev.type === 'round_start') { cr = ev.round; sq = 0; console.log(`\n--- 回合 ${cr} ---`); continue; }
          sq++;
          if (ev.type === 'skill_trigger') console.log(`  [${sq}] skill_trigger ${ev.unitId} → ${ev.skillName} success=${ev.success}`);
          else if (ev.type === 'attack_hit' || ev.type === 'damage' || ev.type === 'split_damage') {
            const src = ev.sourceId || ev.casterId || ev.creditToId;
            let buffs = '';
            if (ev.modifiers && ev.modifiers.caused) buffs = ' caused=[' + ev.modifiers.caused.map((x: any) => `${x.skillName}@${(x.rate * 100).toFixed(0)}%`).join(',') + ']';
            console.log(`  [${sq}] ${ev.type} src=${src} tgt=${ev.targetId} dmg=${(ev.damage || 0).toFixed(0)}${buffs}`);
          } else if (ev.type === 'status_inflicted') console.log(`  [${sq}] status ${ev.unitId} ← ${ev.statusType}`);
          else if (ev.type === 'heal') console.log(`  [${sq}] heal src=${ev.sourceId} tgt=${ev.targetId} amt=${(ev.amount || 0).toFixed(0)}`);
        }
      }
    }
  }
}

// 汇总
const out: any[] = [];
for (const T of SHIJI_TEAMS) {
  const a = acc.get(T.id)!;
  const pct = (x: number, y: number) => (y ? +(x / y * 100).toFixed(1) : 0);
  out.push({
    id: T.id, note: T.note, battles: a.battles,
    baseSpeed: { carrier: a.carrierSpeed, daying: a.dayingSpeed },
    speedOrder: (a.carrierFasterR1 > 0 ? '始计先于大营（R1实测）' : a.carrierSlowerR1 > 0 ? '大营先于始计（R1实测，受优先行动/加速覆盖）' : 'R1无出手'),
    dayingAttacks: a.dayingAttacks, dayingAttacksBuffed: a.dayingAttacksBuffed, dayingAttackBuffRate: pct(a.dayingAttacksBuffed, a.dayingAttacks),
    dayingR1Attacks: a.dayingR1Attacks, dayingR1AttacksBuffed: a.dayingR1AttacksBuffed, dayingR1BuffRate: pct(a.dayingR1AttacksBuffed, a.dayingR1Attacks),
    dayingR1to4Attacks: a.dayingR1to4Attacks, dayingR1to4AttacksBuffed: a.dayingR1to4AttacksBuffed, dayingR1to4BuffRate: pct(a.dayingR1to4AttacksBuffed, a.dayingR1to4Attacks),
    r1Order: { carrierFasterR1: a.carrierFasterR1, carrierSlowerR1: a.carrierSlowerR1 },
    byOpponent: Object.fromEntries(Object.entries(a.byOpponent).map(([k, v]: any) => [k, { atk: v.atk, buffed: v.buffed, rate: pct(v.buffed, v.atk) }])),
  });
}
const payload = { meta: { seeds: SEEDS, task: '始计接通大营验证', level: LEVEL, redness: REDNESS, morale: MORALE }, teams: out };
writeFileSync(join(root, 'docs/t0t1_action_order.json'), JSON.stringify(payload, null, 2), 'utf8');
console.log(`\n动作顺序分析完成：总场次=${total}`);
for (const t of out) {
  console.log(`\n${t.note}（${t.speedOrder}）`);
  console.log(`  大营攻击吃始计率：${t.dayingAttackBuffRate}%  (${t.dayingAttacksBuffed}/${t.dayingAttacks})`);
  console.log(`  大营R1攻击吃始计率：${t.dayingR1BuffRate}%  (${t.dayingR1AttacksBuffed}/${t.dayingR1Attacks})`);
  console.log(`  大营前4回合攻击吃始计率：${t.dayingR1to4BuffRate}%  (${t.dayingR1to4AttacksBuffed}/${t.dayingR1to4Attacks})`);
  console.log(`  R1顺序：始计早于大营=${t.r1Order.carrierFasterR1} / 晚于大营=${t.r1Order.carrierSlowerR1}`);
}
