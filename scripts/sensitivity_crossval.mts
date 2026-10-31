/**
 * 率土之滨 · 影响因子降序表「交叉验证」（稳健性 Proof）
 * ────────────────────────────────────────────────────────────────────
 * 目的：上一版 sensitivity.mts 只用了「一支队伍(庞统蜀步) + 3 对手 + 单方向扰动」，
 *       本脚本用多种方法交叉验证，证明"影响因子降序表"是稳定的、不是噪声：
 *
 *  方法集合：
 *   · 多队伍：4 支不同流派样本队（控制减伤 / 物理爆发 / 菜刀追击 / 法系控制）
 *   · 多对手：每队对抗 6 支多样化对手（非抽样 3 支），并做"半池拆分"检验对手选择敏感性
 *   · 多次重复：同口径跑 2 个独立随机种子块，量化采样噪声
 *   · 不同方法：
 *      ① 同方法复现（庞统蜀步用原扰动+原对手，验证能复现旧数 19.3% 等）
 *      ② 指标互换（胜率 win-rate  vs  非败率 non-loss-rate）
 *      ③ 对手半池互换（前 3  vs  后 3）
 *      ④ 跨队伍共识（4 队取 |杠杆| 均值）
 *   · 定量一致性：用 Spearman 排序相关系数 证明各方法/各队伍得出同一张降序表
 *
 * 运行：npx tsx scripts/sensitivity_crossval.mts
 */
import { buildGeneral } from '../web/heroes';
import { runBattle } from '../src/engine/combat';
import type { SlotState } from '../web/teamEditor';
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
const MORALE = 120, LEVEL = 50, REDNESS = 5;
const TROOP: Record<string, [string, string[]]> = {
  cavalry: ['轻骑兵', ['疾行', '出奇']],
  archer: ['长弓兵', ['地利', '迂回']],
  infantry: ['重步兵', ['守备', '固阵']],
};
const TREASURE: Record<string, number> = { 骁锐: 1003, 天资: 1057, 机敏: 1072, 熟虑: 1087 };

type Slot = {
  name: string; skills: [string, string]; affix: keyof typeof TREASURE;
  pts: { attack?: number; defense?: number; strategy?: number; speed?: number };
  troop?: string; traits?: string[]; treasure?: null; redness?: number;
};
function toSlotState(s: Slot): SlotState {
  const h = heroByName[s.name];
  const sid0 = skillByName[s.skills[0]], sid1 = skillByName[s.skills[1]];
  if (!h) throw new Error(`武将不存在：${s.name}`);
  if (!sid0 || !sid1) throw new Error(`战法不存在：${s.name} → ${s.skills.join('/')}`);
  const [troop, traits] = s.troop ? [s.troop, s.traits!] : (TROOP[h.troopType] ?? TROOP.infantry);
  const treasure = s.treasure === null ? null : { treasureId: TREASURE[s.affix], affix: { name: s.affix, value: 15 } };
  return { heroId: h.id, extraSkillIds: [sid0, sid1], freePoints: s.pts, redness: s.redness ?? REDNESS, level: LEVEL, secondaryTroop: troop, secondaryTraits: traits, treasure };
}
function buildTeam(slots: Slot[]): any[] {
  return slots.map((s, i) => {
    const st = toSlotState(s);
    return buildGeneral(st.heroId, st.extraSkillIds, st.freePoints, POS[i], st.redness, st.level, MORALE, st.secondaryTroop, st.secondaryTraits, st.treasure, undefined);
  });
}

// ───────── 因子 key 顺序（与原始探针一致） ─────────
const FACTOR_ORDER = ['skill', 'speed', 'slotorder', 'redness', 'troop', 'treasure', 'points', 'position', 'traits'];
const FACTOR_LABEL: Record<string, string> = {
  skill: '战法选择', speed: '速度/先手', slotorder: '战法安装顺序', redness: '红度',
  troop: '兵种+克制', treasure: '宝物', points: '加点', position: '站位', traits: '兵种特性',
};

// ───────── 通用扰动生成（对一支 BASE 生成 9 个"弱值"变体） ─────────
function mainStat(pts: Slot['pts']): keyof Slot['pts'] {
  const order: (keyof Slot['pts'])[] = ['strategy', 'attack', 'speed', 'defense'];
  for (const k of order) if ((pts[k] ?? 0) > 0) return k;
  return 'strategy';
}
const OPP: Record<string, keyof Slot['pts']> = { strategy: 'attack', attack: 'strategy', speed: 'defense', defense: 'speed' };
function genericVariants(base: Slot[]): { key: string; slots: Slot[] }[] {
  const out: { key: string; slots: Slot[] }[] = [];
  out.push({ key: 'skill', slots: base.map(s => ({ ...s, skills: ['避其锋芒', '百战无怯'] as [string, string] })) });
  out.push({ key: 'speed', slots: base.map(s => {
    const pts = { ...s.pts }; const m = mainStat(pts);
    if (m === 'speed') pts.speed = Math.max(0, (pts.speed ?? 0) - 30);
    else { pts[m] = (pts[m] ?? 0) - 30; pts.speed = (pts.speed ?? 0) + 30; }
    return { ...s, pts };
  }) });
  out.push({ key: 'slotorder', slots: base.map(s => ({ ...s, skills: [s.skills[1], s.skills[0]] })) });
  out.push({ key: 'redness', slots: base.map(s => ({ ...s, redness: 0 })) });
  out.push({ key: 'troop', slots: base.map(s => {
    const t = heroByName[s.name].troopType;
    let nt: string, ntr: string[];
    if (t === 'cavalry') { nt = '长弓兵'; ntr = ['地利', '迂回']; }
    else if (t === 'archer') { nt = '重步兵'; ntr = ['守备', '固阵']; }
    else { nt = '轻骑兵'; ntr = ['疾行', '出奇']; }
    return { ...s, troop: nt, traits: ntr };
  }) });
  out.push({ key: 'treasure', slots: base.map(s => ({ ...s, treasure: null })) });
  out.push({ key: 'points', slots: base.map(s => {
    const m = mainStat(s.pts); const w = OPP[m];
    return { ...s, pts: { [w]: 100 } as Slot['pts'] };
  }) });
  out.push({ key: 'position', slots: [...base].reverse() });
  out.push({ key: 'traits', slots: base.map(s => ({ ...s, traits: [] })) });
  return out;
}

// ───────── 4 支样本队 BASE ─────────
const PROBES: { label: string; base: Slot[]; control?: boolean }[] = [
  // 控制（庞统蜀步）使用"原始探针"的精确变体，用于同方法复现
  {
    label: '庞统蜀步', control: true, base: [
      { name: '庞统', skills: ['正始之变', '三术奇谋'], affix: '天资', pts: { strategy: 100 } },
      { name: 'XP程昱', skills: ['无心恋战', '火烧连营'], affix: '天资', pts: { strategy: 100 } },
      { name: '张机', skills: ['当阳桥', '垒实迎击'], affix: '熟虑', pts: { strategy: 100 } },
    ],
  },
  {
    label: '流氓队', base: [
      { name: '吕布', skills: ['一骑当千', '击势'], affix: '骁锐', pts: { attack: 100 } },
      { name: '孙权', skills: ['始计', '浑水摸鱼'], affix: '机敏', pts: { speed: 100 } },
      { name: '张机', skills: ['垒实迎击', '绝水遏敌'], affix: '熟虑', pts: { strategy: 100 } },
    ],
  },
  {
    label: '豹纹刀', base: [
      { name: '文鸯', skills: ['长兵方阵', '威震逍遥'], affix: '骁锐', pts: { attack: 100 } },
      { name: '张辽', skills: ['枭雄', '攻其不备'], affix: '机敏', pts: { speed: 100 } },
      { name: '曹纯', skills: ['远攻秘策', '钝兵挫锐'], affix: '机敏', pts: { speed: 100 } },
    ],
  },
  {
    label: '程昱魏智', base: [
      { name: '荀彧', skills: ['众谋不懈', '三术奇谋'], affix: '天资', pts: { strategy: 100 } },
      { name: 'XP程昱', skills: ['磐阵善守', '河内世泽'], affix: '天资', pts: { strategy: 100 } },
      { name: '郭嘉', skills: ['战必断金', '当阳桥'], affix: '机敏', pts: { speed: 100 } },
    ],
  },
];
// 庞统蜀步"原始探针"精确 9 变体（复现用）
const PANGTONG_VARIANTS: { key: string; slots: Slot[] }[] = [
  { key: 'skill', slots: [{ name: '庞统', skills: ['战必断金', '反计之策'], affix: '天资', pts: { strategy: 100 } }, { name: 'XP程昱', skills: ['无心恋战', '火烧连营'], affix: '天资', pts: { strategy: 100 } }, { name: '张机', skills: ['当阳桥', '垒实迎击'], affix: '熟虑', pts: { strategy: 100 } }] },
  { key: 'speed', slots: [{ name: '庞统', skills: ['正始之变', '三术奇谋'], affix: '天资', pts: { strategy: 70, speed: 30 } }, { name: 'XP程昱', skills: ['无心恋战', '火烧连营'], affix: '天资', pts: { strategy: 70, speed: 30 } }, { name: '张机', skills: ['当阳桥', '垒实迎击'], affix: '熟虑', pts: { strategy: 70, speed: 30 } }] },
  { key: 'slotorder', slots: [{ name: '庞统', skills: ['三术奇谋', '正始之变'], affix: '天资', pts: { strategy: 100 } }, { name: 'XP程昱', skills: ['无心恋战', '火烧连营'], affix: '天资', pts: { strategy: 100 } }, { name: '张机', skills: ['当阳桥', '垒实迎击'], affix: '熟虑', pts: { strategy: 100 } }] },
  { key: 'redness', slots: [{ name: '庞统', skills: ['正始之变', '三术奇谋'], affix: '天资', pts: { strategy: 100 }, redness: 0 }, { name: 'XP程昱', skills: ['无心恋战', '火烧连营'], affix: '天资', pts: { strategy: 100 }, redness: 0 }, { name: '张机', skills: ['当阳桥', '垒实迎击'], affix: '熟虑', pts: { strategy: 100 }, redness: 0 }] },
  { key: 'troop', slots: [{ name: '庞统', skills: ['正始之变', '三术奇谋'], affix: '天资', pts: { strategy: 100 }, troop: '重步兵', traits: ['守备', '固阵'] }, { name: 'XP程昱', skills: ['无心恋战', '火烧连营'], affix: '天资', pts: { strategy: 100 } }, { name: '张机', skills: ['当阳桥', '垒实迎击'], affix: '熟虑', pts: { strategy: 100 } }] },
  { key: 'treasure', slots: [{ name: '庞统', skills: ['正始之变', '三术奇谋'], affix: '天资', pts: { strategy: 100 }, treasure: null }, { name: 'XP程昱', skills: ['无心恋战', '火烧连营'], affix: '天资', pts: { strategy: 100 }, treasure: null }, { name: '张机', skills: ['当阳桥', '垒实迎击'], affix: '熟虑', pts: { strategy: 100 }, treasure: null }] },
  { key: 'points', slots: [{ name: '庞统', skills: ['正始之变', '三术奇谋'], affix: '天资', pts: { attack: 100 } }, { name: 'XP程昱', skills: ['无心恋战', '火烧连营'], affix: '天资', pts: { attack: 100 } }, { name: '张机', skills: ['当阳桥', '垒实迎击'], affix: '熟虑', pts: { attack: 100 } }] },
  { key: 'position', slots: [{ name: '张机', skills: ['当阳桥', '垒实迎击'], affix: '熟虑', pts: { strategy: 100 } }, { name: 'XP程昱', skills: ['无心恋战', '火烧连营'], affix: '天资', pts: { strategy: 100 } }, { name: '庞统', skills: ['正始之变', '三术奇谋'], affix: '天资', pts: { strategy: 100 } }] },
  { key: 'traits', slots: [{ name: '庞统', skills: ['正始之变', '三术奇谋'], affix: '天资', pts: { strategy: 100 }, traits: [] }, { name: 'XP程昱', skills: ['无心恋战', '火烧连营'], affix: '天资', pts: { strategy: 100 }, traits: [] }, { name: '张机', skills: ['当阳桥', '垒实迎击'], affix: '熟虑', pts: { strategy: 100 }, traits: [] }] },
];

// ───────── 6 支多样化对手（均与 4 样本队不重叠） ─────────
const POOL_LABELS = ['肉步', '黄盖法刀', '斩龙刀', '都督队', '砍王队', 'AI·神赏陆逊'];
const POOL: { label: string; slots: Slot[] }[] = [
  { label: '肉步', slots: [{ name: '陆抗', skills: ['深谋远虑', '十面埋伏'], affix: '天资', pts: { strategy: 100 } }, { name: '刘备', skills: ['重整旗鼓', '桃园结义'], affix: '熟虑', pts: { strategy: 100 } }, { name: '周泰', skills: ['垒实迎击', '妖术'], affix: '熟虑', pts: { defense: 100 } }] },
  { label: '黄盖法刀', slots: [{ name: '吕蒙', skills: ['反计之策', '河内世泽'], affix: '天资', pts: { strategy: 100 } }, { name: '卫瓘', skills: ['神兵天降', '大赏三军'], affix: '机敏', pts: { speed: 100 } }, { name: '黄盖', skills: ['先驱突击', '击势'], affix: '天资', pts: { strategy: 100 } }] },
  { label: '斩龙刀', slots: [{ name: '祝融夫人', skills: ['先驱突击', '文伐'], affix: '骁锐', pts: { attack: 100 } }, { name: '华雄', skills: ['衡轭', '反计之策'], affix: '骁锐', pts: { attack: 100 } }, { name: '曹操', skills: ['神兵天降', '大赏三军'], affix: '天资', pts: { strategy: 100 } }] },
  { label: '都督队', slots: [{ name: '陆逊', skills: ['深谋远虑', '十面埋伏'], affix: '天资', pts: { strategy: 100 } }, { name: '周瑜', skills: ['浑水摸鱼', '始计'], affix: '天资', pts: { strategy: 100 } }, { name: '吕蒙', skills: ['反计之策', '河内世泽'], affix: '天资', pts: { strategy: 100 } }] },
  { label: '砍王队', slots: [{ name: '马超', skills: ['一骑当千', '击势'], affix: '骁锐', pts: { attack: 100 } }, { name: '魏延', skills: ['全军突击', '战必断金'], affix: '骁锐', pts: { attack: 100 } }, { name: '曹操', skills: ['神兵天降', '大赏三军'], affix: '天资', pts: { strategy: 100 } }] },
  { label: 'AI·神赏陆逊', slots: [{ name: '陆逊', skills: ['深谋远虑', '十面埋伏'], affix: '天资', pts: { strategy: 100 } }, { name: '吕蒙', skills: ['反计之策', '河内世泽'], affix: '天资', pts: { strategy: 100 } }, { name: '卫瓘', skills: ['神兵天降', '大赏三军'], affix: '机敏', pts: { speed: 100 } }] },
];
// 庞统蜀步"原始探针"3 对手（复现用）
const REPRO_OPP: { label: string; slots: Slot[] }[] = [
  { label: '流氓队', slots: [{ name: '吕布', skills: ['一骑当千', '击势'], affix: '骁锐', pts: { attack: 100 } }, { name: '孙权', skills: ['始计', '浑水摸鱼'], affix: '机敏', pts: { speed: 100 } }, { name: '张机', skills: ['垒实迎击', '绝水遏敌'], affix: '熟虑', pts: { strategy: 100 } }] },
  { label: '豹纹刀', slots: [{ name: '文鸯', skills: ['长兵方阵', '威震逍遥'], affix: '骁锐', pts: { attack: 100 } }, { name: '张辽', skills: ['枭雄', '攻其不备'], affix: '机敏', pts: { speed: 100 } }, { name: '曹纯', skills: ['远攻秘策', '钝兵挫锐'], affix: '机敏', pts: { speed: 100 } }] },
  { label: '肉步', slots: [{ name: '陆抗', skills: ['深谋远虑', '十面埋伏'], affix: '天资', pts: { strategy: 100 } }, { name: '刘备', skills: ['重整旗鼓', '桃园结义'], affix: '熟虑', pts: { strategy: 100 } }, { name: '周泰', skills: ['垒实迎击', '妖术'], affix: '熟虑', pts: { defense: 100 } }] },
];

const N = 50; // 每对场数
function measure(mySlots: Slot[], oppSlots: Slot[], seedBase: number): { w: number; d: number } {
  const enemy = buildTeam(oppSlots); // 对手只建一次（与原探针一致，runBattle 不破坏敌方状态）
  let w = 0, d = 0;
  for (let g = 0; g < N; g++) {
    const seed = ((seedBase * 1000003) ^ (g * 2654435761)) & 0x7fffffff;
    const r = runBattle({ myTeam: buildTeam(mySlots), enemyTeam: enemy, seed, maxRounds: 8 });
    if (r.result === 'win') w++; else if (r.result === 'draw') d++;
  }
  return { w, d };
}
// 杠杆（win 或非败）对一组对手取均值
function lever(base: Record<string, { w: number; d: number }>, vari: Record<string, { w: number; d: number }>, oppIdx: number[], metric: 'win' | 'nonloss'): number {
  const rate = (o: { w: number; d: number }) => metric === 'win' ? o.w / N : (o.w + o.d) / N;
  const bAvg = oppIdx.reduce((s, i) => s + rate(base[POOL_LABELS[i]]), 0) / oppIdx.length;
  const vAvg = oppIdx.reduce((s, i) => s + rate(vari[POOL_LABELS[i]]), 0) / oppIdx.length;
  return vAvg - bAvg;
}

// Spearman 排序相关（按值降序排名，rank1=最高）
function spearman(keys: string[], valA: Record<string, number>, valB: Record<string, number>): number {
  const rankOf = (val: Record<string, number>) => {
    const sorted = [...keys].sort((x, y) => val[y] - val[x]);
    const r: Record<string, number> = {}; sorted.forEach((k, i) => (r[k] = i + 1)); return r;
  };
  const ra = rankOf(valA), rb = rankOf(valB);
  const n = keys.length;
  const ma = keys.reduce((s, k) => s + ra[k], 0) / n, mb = keys.reduce((s, k) => s + rb[k], 0) / n;
  let num = 0, da = 0, db = 0;
  for (const k of keys) { num += (ra[k] - ma) * (rb[k] - mb); da += (ra[k] - ma) ** 2; db += (rb[k] - mb) ** 2; }
  return num / Math.sqrt(da * db);
}

function runOne(seedBase: number) {
  // 每队：base 对 6 对手；9 变体对 6 对手
  const perTeam: Record<string, { base: Record<string, { w: number; d: number }>; vari: Record<string, Record<string, { w: number; d: number }>> }> = {};
  for (const p of PROBES) {
    const base: Record<string, { w: number; d: number }> = {};
    for (const o of POOL) base[o.label] = measure(p.base, o.slots, seedBase);
    const variants = p.control ? PANGTONG_VARIANTS : genericVariants(p.base);
    const vari: Record<string, Record<string, { w: number; d: number }>> = {};
    for (const v of variants) {
      const rec: Record<string, { w: number; d: number }> = {};
      for (const o of POOL) rec[o.label] = measure(v.slots, o.slots, seedBase);
      vari[v.key] = rec;
    }
    perTeam[p.label] = { base, vari };
  }
  return perTeam;
}

function consensus(perTeam: any, metric: 'win' | 'nonloss', oppIdx: number[]): Record<string, number> {
  const acc: Record<string, number[]> = {};
  for (const p of PROBES) {
    const { base, vari } = perTeam[p.label];
    for (const k of FACTOR_ORDER) {
      const l = lever(base, vari[k], oppIdx, metric);
      (acc[k] = acc[k] ?? []).push(Math.abs(l));
    }
  }
  const out: Record<string, number> = {};
  for (const k of FACTOR_ORDER) out[k] = acc[k].reduce((s, v) => s + v, 0) / acc[k].length;
  return out;
}
function perTeamRank(perTeam: any, label: string, metric: 'win' | 'nonloss', oppIdx: number[]): Record<string, number> {
  const { base, vari } = perTeam[label];
  const out: Record<string, number> = {};
  for (const k of FACTOR_ORDER) out[k] = Math.abs(lever(base, vari[k], oppIdx, metric));
  return out;
}

const t0 = Date.now();
const run1 = runOne(1);
const run2 = runOne(2);
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

const ALL = [0, 1, 2, 3, 4, 5];
const HALF_A = [0, 1, 2], HALF_B = [3, 4, 5];

// ───── 共识表（胜率，全池） ─────
const consWin = consensus(run1, 'win', ALL);
const consWinR2 = consensus(run2, 'win', ALL);
const consNonloss = consensus(run1, 'nonloss', ALL);
const consHalfA = consensus(run1, 'win', HALF_A);
const consHalfB = consensus(run1, 'win', HALF_B);

const ranked = (obj: Record<string, number>) => [...FACTOR_ORDER].sort((a, b) => obj[b] - obj[a]);

// ───── 同方法复现：庞统蜀步 原扰动 vs 原 3 对手 ─────
function reproMethodI(seedBase: number): Record<string, number> {
  const base: Record<string, { w: number; d: number }> = {};
  for (const o of REPRO_OPP) base[o.label] = measure(PROBES[0].base, o.slots, seedBase);
  const out: Record<string, number> = {};
  for (const v of PANGTONG_VARIANTS) {
    const rec: Record<string, { w: number; d: number }> = {};
    for (const o of REPRO_OPP) rec[o.label] = measure(v.slots, o.slots, seedBase);
    const bAvg = REPRO_OPP.reduce((s, o) => s + base[o.label].w / N, 0) / 3;
    const vAvg = REPRO_OPP.reduce((s, o) => s + rec[o.label].w / N, 0) / 3;
    out[v.key] = Math.abs(vAvg - bAvg);
  }
  return out;
}
const repro1 = reproMethodI(1);
const reproRanked = [...FACTOR_ORDER].sort((a, b) => repro1[b] - repro1[a]);

// ───── 打印报告 ─────
const L = (s = '') => console.log(s);
L('═'.repeat(78));
L('率土之滨 · 影响因子降序表「交叉验证」报告');
L(`方法：4 样本队 × 6 对手 × 9 因子 × ${N} 场，双种子块重复；指标胜率/非败率；对手半池拆分`);
L('═'.repeat(78));

L('\n【A. 各样本队 实测杠杆（胜率 |Δ|%，全池 6 对手）】');
for (const p of PROBES) {
  const r = perTeamRank(run1, p.label, 'win', ALL);
  L(`· ${p.label.padEnd(8)}：` + FACTOR_ORDER.map(k => `${FACTOR_LABEL[k]}${(r[k] * 100).toFixed(1)}`).join('  '));
}

L('\n【B. 共识降序表（4 队 |Δ| 均值，胜率口径）】');
ranked(consWin).forEach((k, i) => L(`${(i + 1).toString().padStart(2)}. ${FACTOR_LABEL[k].padEnd(8)} 杠杆 ${(consWin[k] * 100).toFixed(1)}%`));

L('\n【C. 同方法复现（庞统蜀步 原扰动 + 原 3 对手，验证旧数）】');
const OLD: Record<string, number> = { points: 22.0, skill: 19.3, position: 10.0, treasure: 6.7, speed: 4.7, redness: 2.0, slotorder: 0, troop: 0, traits: 0 };
reproRanked.forEach((k, i) => L(`${(i + 1).toString().padStart(2)}. ${FACTOR_LABEL[k].padEnd(8)} 本次 ${(repro1[k] * 100).toFixed(1).padStart(5)}%  ｜ 旧探针 ${(OLD[k]).toFixed(1).padStart(5)}%`));

L('\n【D. 多方法一致性（Spearman 排序相关，1.0=完全一致）】');
const sp = (a: Record<string, number>, b: Record<string, number>) => spearman(FACTOR_ORDER, a, b);
L(`· 双种子重复（全池胜率）：            run1 vs run2 = ${sp(consWin, consWinR2).toFixed(3)}`);
L(`· 指标互换（胜率 vs 非败率）：         = ${sp(consWin, consNonloss).toFixed(3)}`);
L(`· 对手半池 A（前3） vs 全池：          = ${sp(consWin, consHalfA).toFixed(3)}`);
L(`· 对手半池 B（后3） vs 全池：          = ${sp(consWin, consHalfB).toFixed(3)}`);
L(`· 同方法复现 vs 共识（全池）：         = ${sp(repro1, consWin).toFixed(3)}`);
L(`· 各样本队排名 vs 共识（多队伍一致性）：`);
for (const p of PROBES) L(`    - ${p.label.padEnd(8)} = ${sp(perTeamRank(run1, p.label, 'win', ALL), consWin).toFixed(3)}`);

L('\n【E. 结论】');
L('若上述 Spearman ≥ 0.9，说明"影响因子降序表"在 多队伍 / 多对手 / 双种子重复 /');
L('指标互换 下高度一致 → 排序稳健、非噪声。数值（杠杆大小）会随队伍/对手波动，');
L('但"谁大谁小"的层级结构稳定。');
L('═'.repeat(78));
L(`耗时 ${elapsed}s ｜ 总对战 ≈ ${4 * 10 * 6 * N * 2 + 2 * 10 * 3 * N} 场`);
