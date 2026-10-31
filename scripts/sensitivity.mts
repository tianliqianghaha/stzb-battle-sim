/**
 * 率土之滨 · 引擎敏感性探针（校准"影响配将因子"的实测排序）
 * ────────────────────────────────────────────────────────────────────
 * 目的（见 AGENTS.md「E. 通用配将&优化顺序框架」第 3 层）：
 *   以一支样本队（庞统蜀步，满红顶配）为基线，对"影响配将的因子"逐个做
 *   "冻结其余、只把该因子拨到弱值"的对照，对抗固定的 3 支代表对手
 *   （流氓队=爆发控制 / 豹纹刀=物理爆发 / 肉步=坦克），每对 50 场，
 *   测每因子的胜率 Δ（= 弱值 − 基线）。|Δ| 越大，说明该因子在本引擎里
 *   "配错"的代价越高 → 即该因子的实测杠杆，用来校准预估降序。
 *
 * 运行：npx tsx scripts/sensitivity.mts
 */
import { buildGeneral } from '../web/heroes';
import { runBattle } from '../src/engine/combat';
import type { SlotState } from '../web/teamEditor';
import type { General } from '../src/engine/types';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const heroes: any[] = JSON.parse(readFileSync(join(__dirname, '../web/data/heroes.json'), 'utf8'));
const skillDesc: Record<string, any> = JSON.parse(readFileSync(join(__dirname, '../web/data/skill_desc.json'), 'utf8'));

const heroByName: Record<string, { id: string; troopType: string }> = {};
for (const h of heroes) heroByName[h.name] = { id: h.id, troopType: h.troopType };
const skillByName: Record<string, string> = {};
for (const [id, s] of Object.entries(skillDesc)) skillByName[(s as any).name] = id;

const POS = ['大营', '中军', '前锋'] as const;
const MORALE = 120;
const LEVEL = 50;
const REDNESS = 5;
const TROOP: Record<string, [string, string[]]> = {
  cavalry: ['轻骑兵', ['疾行', '出奇']],
  archer: ['长弓兵', ['地利', '迂回']],
  infantry: ['重步兵', ['守备', '固阵']],
};
const TREASURE: Record<string, number> = { 骁锐: 1003, 天资: 1057, 机敏: 1072, 熟虑: 1087 };

type Slot = {
  name: string;
  skills: [string, string];
  affix: keyof typeof TREASURE;
  pts: { attack?: number; defense?: number; strategy?: number; speed?: number };
  troop?: string;
  traits?: string[];
  treasure?: null;
  redness?: number;
};

function toSlotState(s: Slot): SlotState {
  const h = heroByName[s.name];
  const sid0 = skillByName[s.skills[0]];
  const sid1 = skillByName[s.skills[1]];
  if (!h) throw new Error(`武将不存在：${s.name}`);
  if (!sid0 || !sid1) throw new Error(`战法不存在：${s.name} → ${s.skills.join('/')}`);
  const [troop, traits] = s.troop ? [s.troop, s.traits!] : (TROOP[h.troopType] ?? TROOP.infantry);
  const treasure = s.treasure === null ? null : { treasureId: TREASURE[s.affix], affix: { name: s.affix, value: 15 } };
  return {
    heroId: h.id,
    extraSkillIds: [sid0, sid1],
    freePoints: s.pts,
    redness: s.redness ?? REDNESS,
    level: LEVEL,
    secondaryTroop: troop,
    secondaryTraits: traits,
    treasure,
  };
}
function buildTeam(slots: Slot[]): General[] {
  return slots.map((s, i) =>
    buildGeneral(toSlotState(s).heroId, toSlotState(s).extraSkillIds, toSlotState(s).freePoints,
      POS[i], toSlotState(s).redness, toSlotState(s).level, MORALE,
      toSlotState(s).secondaryTroop, toSlotState(s).secondaryTraits, toSlotState(s).treasure, undefined)
  );
}

// ───────────────────────── 基线：庞统蜀步（满红顶配） ─────────────────────────
const BASE: Slot[] = [
  { name: '庞统', skills: ['正始之变', '三术奇谋'], affix: '天资', pts: { strategy: 100 } },
  { name: 'XP程昱', skills: ['无心恋战', '火烧连营'], affix: '天资', pts: { strategy: 100 } },
  { name: '张机', skills: ['当阳桥', '垒实迎击'], affix: '熟虑', pts: { strategy: 100 } },
];

// ───────────────────────── 固定代表对手（3 种风格） ─────────────────────────
const OPPONENTS: { label: string; slots: Slot[] }[] = [
  { label: '流氓队', slots: [
    { name: '吕布', skills: ['一骑当千', '击势'], affix: '骁锐', pts: { attack: 100 } },
    { name: '孙权', skills: ['始计', '浑水摸鱼'], affix: '机敏', pts: { speed: 100 } },
    { name: '张机', skills: ['垒实迎击', '绝水遏敌'], affix: '熟虑', pts: { strategy: 100 } },
  ] },
  { label: '豹纹刀', slots: [
    { name: '文鸯', skills: ['长兵方阵', '威震逍遥'], affix: '骁锐', pts: { attack: 100 } },
    { name: '张辽', skills: ['枭雄', '攻其不备'], affix: '机敏', pts: { speed: 100 } },
    { name: '曹纯', skills: ['远攻秘策', '钝兵挫锐'], affix: '机敏', pts: { speed: 100 } },
  ] },
  { label: '肉步', slots: [
    { name: '陆抗', skills: ['深谋远虑', '十面埋伏'], affix: '天资', pts: { strategy: 100 } },
    { name: '刘备', skills: ['重整旗鼓', '桃园结义'], affix: '熟虑', pts: { strategy: 100 } },
    { name: '周泰', skills: ['垒实迎击', '妖术'], affix: '熟虑', pts: { defense: 100 } },
  ] },
];

// ───────────────────────── 9 个因子的"弱值"变体 ─────────────────────────
const VARIANTS: { key: string; label: string; slots: Slot[] }[] = [
  { key: 'skill', label: '战法选择（核心将配错战法）',
    slots: [
      { name: '庞统', skills: ['战必断金', '反计之策'], affix: '天资', pts: { strategy: 100 } },
      { name: 'XP程昱', skills: ['无心恋战', '火烧连营'], affix: '天资', pts: { strategy: 100 } },
      { name: '张机', skills: ['当阳桥', '垒实迎击'], affix: '熟虑', pts: { strategy: 100 } },
    ] },
  { key: 'speed', label: '速度/先手（谋略→速度 各挪30）',
    slots: [
      { name: '庞统', skills: ['正始之变', '三术奇谋'], affix: '天资', pts: { strategy: 70, speed: 30 } },
      { name: 'XP程昱', skills: ['无心恋战', '火烧连营'], affix: '天资', pts: { strategy: 70, speed: 30 } },
      { name: '张机', skills: ['当阳桥', '垒实迎击'], affix: '熟虑', pts: { strategy: 70, speed: 30 } },
    ] },
  { key: 'slotorder', label: '战法安装顺序（核心将两战法对调）',
    slots: [
      { name: '庞统', skills: ['三术奇谋', '正始之变'], affix: '天资', pts: { strategy: 100 } },
      { name: 'XP程昱', skills: ['无心恋战', '火烧连营'], affix: '天资', pts: { strategy: 100 } },
      { name: '张机', skills: ['当阳桥', '垒实迎击'], affix: '熟虑', pts: { strategy: 100 } },
    ] },
  { key: 'redness', label: '红度（全员 5红→0红）',
    slots: [
      { name: '庞统', skills: ['正始之变', '三术奇谋'], affix: '天资', pts: { strategy: 100 }, redness: 0 },
      { name: 'XP程昱', skills: ['无心恋战', '火烧连营'], affix: '天资', pts: { strategy: 100 }, redness: 0 },
      { name: '张机', skills: ['当阳桥', '垒实迎击'], affix: '熟虑', pts: { strategy: 100 }, redness: 0 },
    ] },
  { key: 'troop', label: '兵种+克制（核心将 弓→步）',
    slots: [
      { name: '庞统', skills: ['正始之变', '三术奇谋'], affix: '天资', pts: { strategy: 100 }, troop: '重步兵', traits: ['守备', '固阵'] },
      { name: 'XP程昱', skills: ['无心恋战', '火烧连营'], affix: '天资', pts: { strategy: 100 } },
      { name: '张机', skills: ['当阳桥', '垒实迎击'], affix: '熟虑', pts: { strategy: 100 } },
    ] },
  { key: 'treasure', label: '宝物（全员摘除宝物）',
    slots: [
      { name: '庞统', skills: ['正始之变', '三术奇谋'], affix: '天资', pts: { strategy: 100 }, treasure: null },
      { name: 'XP程昱', skills: ['无心恋战', '火烧连营'], affix: '天资', pts: { strategy: 100 }, treasure: null },
      { name: '张机', skills: ['当阳桥', '垒实迎击'], affix: '熟虑', pts: { strategy: 100 }, treasure: null },
    ] },
  { key: 'points', label: '加点错误（谋略→攻击 全错配）',
    slots: [
      { name: '庞统', skills: ['正始之变', '三术奇谋'], affix: '天资', pts: { attack: 100 } },
      { name: 'XP程昱', skills: ['无心恋战', '火烧连营'], affix: '天资', pts: { attack: 100 } },
      { name: '张机', skills: ['当阳桥', '垒实迎击'], affix: '熟虑', pts: { attack: 100 } },
    ] },
  { key: 'position', label: '站位（核心将 大营↔前锋）',
    slots: [
      { name: '张机', skills: ['当阳桥', '垒实迎击'], affix: '熟虑', pts: { strategy: 100 } },
      { name: 'XP程昱', skills: ['无心恋战', '火烧连营'], affix: '天资', pts: { strategy: 100 } },
      { name: '庞统', skills: ['正始之变', '三术奇谋'], affix: '天资', pts: { strategy: 100 } },
    ] },
  { key: 'traits', label: '兵种特性（全员清空特性）',
    slots: [
      { name: '庞统', skills: ['正始之变', '三术奇谋'], affix: '天资', pts: { strategy: 100 }, traits: [] },
      { name: 'XP程昱', skills: ['无心恋战', '火烧连营'], affix: '天资', pts: { strategy: 100 }, traits: [] },
      { name: '张机', skills: ['当阳桥', '垒实迎击'], affix: '熟虑', pts: { strategy: 100 }, traits: [] },
    ] },
];

// ───────────────────────── 跑胜率 ─────────────────────────
const M = 50;
function winRateAgainst(team: Slot[], opp: Slot[]): number {
  const enemy = buildTeam(opp);
  let w = 0;
  for (let g = 0; g < M; g++) {
    const seed = (g * 2654435761 + opp.length * 40503) & 0x7fffffff;
    const r = runBattle({ myTeam: buildTeam(team), enemyTeam: enemy, seed, maxRounds: 8 });
    if (r.result === 'win') w++;
  }
  return w / M;
}

console.log('═'.repeat(72));
console.log('率土之滨 · 引擎敏感性探针：庞统蜀步(基线) vs 3 代表对手，每对 50 场');
console.log('═'.repeat(72));

const baseWR: Record<string, number> = {};
let baseAvg = 0;
for (const o of OPPONENTS) {
  const wr = winRateAgainst(BASE, o.slots);
  baseWR[o.label] = wr;
  baseAvg += wr;
}
baseAvg /= OPPONENTS.length;
console.log(`【基线 庞统蜀步】 平均胜率 ${(baseAvg * 100).toFixed(1)}%` +
  ` ｜ 流氓 ${(baseWR['流氓队']*100).toFixed(0)}% 豹纹 ${(baseWR['豹纹刀']*100).toFixed(0)}% 肉步 ${(baseWR['肉步']*100).toFixed(0)}%`);
console.log('─'.repeat(72));

const rows: { label: string; delta: number; perOpp: Record<string, number> }[] = [];
for (const v of VARIANTS) {
  const perOpp: Record<string, number> = {};
  let avg = 0;
  for (const o of OPPONENTS) {
    const wr = winRateAgainst(v.slots, o.slots);
    perOpp[o.label] = wr;
    avg += wr;
  }
  avg /= OPPONENTS.length;
  const delta = avg - baseAvg;
  rows.push({ label: v.label, delta, perOpp });
  console.log(
    `${v.label.padEnd(22)} Δ ${(delta*100>=0?'+':'')}${(delta*100).toFixed(1)}% ` +
    `｜ 流氓 ${((perOpp['流氓队']??0)*100).toFixed(0)}% 豹纹 ${((perOpp['豹纹刀']??0)*100).toFixed(0)}% 肉步 ${((perOpp['肉步']??0)*100).toFixed(0)}%`
  );
}

console.log('═'.repeat(72));
console.log('【实测杠杆排序】 |Δ| 越大 = 该因子"配错"在本引擎代价越高（按降序）');
rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
rows.forEach((r, i) => {
  console.log(`${(i+1).toString().padStart(2)}. ${r.label.padEnd(22)} 杠杆 ${(Math.abs(r.delta)*100).toFixed(1)}%  (Δ ${(r.delta*100>=0?'+':'')}${(r.delta*100).toFixed(1)}%)`);
});
console.log('═'.repeat(72));
console.log('注：Δ = 弱值胜率 − 基线胜率；负值=该因子配错会掉胜率，正值=弱值反而更高(多为噪声/样本波动)。');
