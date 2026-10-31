/**
 * 率土之滨 2026年10月 · 理论驱动横评：T0(7) + T1(4) + AI原创(4) 循环赛
 * ────────────────────────────────────────────────────────────────────
 * 思路（见 AGENTS.md「D3. 理论驱动配队」）：组合爆炸无法穷举，故：
 *  1) 多源调研当月 T0/T1 阵容（网易大神/公众号/头条/番茄/18183 等）；
 *  2) 反推底层逻辑框架（流派框架 + 武将特征框架 + 四类协同链）；
 *  3) 由框架"生成式"原创 4 支队伍（非抄已知队，含 1 支跨流派杂交）；
 *  4) 全部进循环赛，每对双向各 50 场共 100 场，统计胜率矩阵 + 排名；
 *  5) 检验"框架推导队"能否站住、哪类框架有效。
 *
 * 配置口径：纯强度横评，允许撞将（每队独立成将），统一满红(5红)+等级50+士气120。
 * 运行：npx tsx scripts/roundrobin.mts
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

// 中文名将 → { id, troopType }
const heroByName: Record<string, { id: string; troopType: string }> = {};
for (const h of heroes) heroByName[h.name] = { id: h.id, troopType: h.troopType };
// 中文战法名 → skillId
const skillByName: Record<string, string> = {};
for (const [id, s] of Object.entries(skillDesc)) skillByName[(s as any).name] = id;

const POS = ['大营', '中军', '前锋'] as const;
const MORALE = 120;
const LEVEL = 50;
const REDNESS = 5;

// 兵种（二级兵种按英雄本兵种大类映射）+ 兵系通用特性
const TROOP: Record<string, [string, string[]]> = {
  cavalry: ['轻骑兵', ['疾行', '出奇']],
  archer: ['长弓兵', ['地利', '迂回']],
  infantry: ['重步兵', ['守备', '固阵']],
};
// 宝物（已验证合法的 词条名 → treasureId 配对）
const TREASURE: Record<string, number> = { 骁锐: 1003, 天资: 1057, 机敏: 1072, 熟虑: 1087 };

type Slot = {
  name: string;
  skills: [string, string];
  affix: keyof typeof TREASURE;
  pts: { attack?: number; defense?: number; strategy?: number; speed?: number };
};

// ───────────────────────── T0（7 支，多源共识，此前已验证） ─────────────────────────
// 程昱魏智 / 豹纹刀 / 黄盖法刀 / 斩龙刀 / 庞统蜀步 / 流氓队 / 肉步
// ───────────────────────── T1（4 支，2026-10 多源共识二线） ─────────────────────────
// 都督队 / 砍王队 / 甘宁刀 / 蜀骑
// ───────────────────────── AI 原创（4 支，由框架反推生成，非抄已知队） ─────────────────────────
// A 神赏·陆逊核（神赏法刀变种：增伤链+双封，大营换陆逊）
// B 攻其·曹彰核（攻其菜刀变种：一速挂增伤+追击，大营换曹彰）
// C 流氓·赵云核（流氓变种：规避+单核爆发，大营换赵云）
// D 减伤追击混编（跨流派杂交：肉步续航脊背 + 菜刀追击 + 典韦反击，测试混编是否站得住）

const TEAMS: { label: string; tier: string; slots: Slot[] }[] = [
  // ── T0 ──
  {
    label: '程昱魏智', tier: 'T0',
    slots: [
      { name: '荀彧', skills: ['众谋不懈', '三术奇谋'], affix: '天资', pts: { strategy: 100 } },
      { name: 'XP程昱', skills: ['磐阵善守', '河内世泽'], affix: '天资', pts: { strategy: 100 } },
      { name: '郭嘉', skills: ['战必断金', '当阳桥'], affix: '机敏', pts: { speed: 100 } },
    ],
  },
  {
    label: '豹纹刀', tier: 'T0',
    slots: [
      { name: '文鸯', skills: ['长兵方阵', '威震逍遥'], affix: '骁锐', pts: { attack: 100 } },
      { name: '张辽', skills: ['枭雄', '攻其不备'], affix: '机敏', pts: { speed: 100 } },
      { name: '曹纯', skills: ['远攻秘策', '钝兵挫锐'], affix: '机敏', pts: { speed: 100 } },
    ],
  },
  {
    label: '黄盖法刀', tier: 'T0',
    slots: [
      { name: '吕蒙', skills: ['反计之策', '河内世泽'], affix: '天资', pts: { strategy: 100 } },
      { name: '卫瓘', skills: ['神兵天降', '大赏三军'], affix: '机敏', pts: { speed: 100 } },
      { name: '黄盖', skills: ['先驱突击', '击势'], affix: '天资', pts: { strategy: 100 } },
    ],
  },
  {
    label: '斩龙刀', tier: 'T0',
    slots: [
      { name: '祝融夫人', skills: ['先驱突击', '文伐'], affix: '骁锐', pts: { attack: 100 } },
      { name: '华雄', skills: ['衡轭', '反计之策'], affix: '骁锐', pts: { attack: 100 } },
      { name: '曹操', skills: ['神兵天降', '大赏三军'], affix: '天资', pts: { strategy: 100 } },
    ],
  },
  {
    label: '庞统蜀步', tier: 'T0',
    slots: [
      { name: '庞统', skills: ['正始之变', '三术奇谋'], affix: '天资', pts: { strategy: 100 } },
      { name: 'XP程昱', skills: ['无心恋战', '火烧连营'], affix: '天资', pts: { strategy: 100 } },
      { name: '张机', skills: ['当阳桥', '垒实迎击'], affix: '熟虑', pts: { strategy: 100 } },
    ],
  },
  {
    label: '流氓队', tier: 'T0',
    slots: [
      { name: '吕布', skills: ['一骑当千', '击势'], affix: '骁锐', pts: { attack: 100 } },
      { name: '孙权', skills: ['始计', '浑水摸鱼'], affix: '机敏', pts: { speed: 100 } },
      { name: '张机', skills: ['垒实迎击', '绝水遏敌'], affix: '熟虑', pts: { strategy: 100 } },
    ],
  },
  {
    label: '肉步', tier: 'T0',
    slots: [
      { name: '陆抗', skills: ['深谋远虑', '十面埋伏'], affix: '天资', pts: { strategy: 100 } },
      { name: '刘备', skills: ['重整旗鼓', '桃园结义'], affix: '熟虑', pts: { strategy: 100 } },
      { name: '周泰', skills: ['垒实迎击', '妖术'], affix: '熟虑', pts: { defense: 100 } },
    ],
  },
  // ── T1 ──
  {
    label: '都督队', tier: 'T1',
    slots: [
      { name: '陆逊', skills: ['深谋远虑', '十面埋伏'], affix: '天资', pts: { strategy: 100 } },
      { name: '周瑜', skills: ['浑水摸鱼', '始计'], affix: '天资', pts: { strategy: 100 } },
      { name: '吕蒙', skills: ['反计之策', '河内世泽'], affix: '天资', pts: { strategy: 100 } },
    ],
  },
  {
    label: '砍王队', tier: 'T1',
    slots: [
      { name: '马超', skills: ['一骑当千', '击势'], affix: '骁锐', pts: { attack: 100 } },
      { name: '魏延', skills: ['全军突击', '战必断金'], affix: '骁锐', pts: { attack: 100 } },
      { name: '曹操', skills: ['神兵天降', '大赏三军'], affix: '天资', pts: { strategy: 100 } },
    ],
  },
  {
    label: '甘宁刀', tier: 'T1',
    slots: [
      { name: '甘宁', skills: ['一骑当千', '击势'], affix: '骁锐', pts: { attack: 100 } },
      { name: '司马炎', skills: ['避其锋芒', '久战熟谋'], affix: '天资', pts: { strategy: 100 } },
      { name: '周泰', skills: ['垒实迎击', '妖术'], affix: '熟虑', pts: { defense: 100 } },
    ],
  },
  {
    label: '蜀骑', tier: 'T1',
    slots: [
      { name: '马岱', skills: ['磐阵善守', '白刃'], affix: '骁锐', pts: { attack: 100 } },
      { name: '关羽', skills: ['全军突击', '战必断金'], affix: '骁锐', pts: { attack: 100 } },
      { name: '张绣', skills: ['兵无常势', '疾战'], affix: '天资', pts: { strategy: 100 } },
    ],
  },
  // ── AI 原创（框架反推生成） ──
  {
    label: 'AI·神赏陆逊', tier: 'AI',
    slots: [
      { name: '陆逊', skills: ['深谋远虑', '十面埋伏'], affix: '天资', pts: { strategy: 100 } },
      { name: '吕蒙', skills: ['反计之策', '河内世泽'], affix: '天资', pts: { strategy: 100 } },
      { name: '卫瓘', skills: ['神兵天降', '大赏三军'], affix: '机敏', pts: { speed: 100 } },
    ],
  },
  {
    label: 'AI·攻其曹彰', tier: 'AI',
    slots: [
      { name: '曹彰', skills: ['一骑当千', '击势'], affix: '骁锐', pts: { attack: 100 } },
      { name: '张辽', skills: ['攻其不备', '枭雄'], affix: '机敏', pts: { speed: 100 } },
      { name: '曹操', skills: ['反计之策', '单骑救主'], affix: '天资', pts: { strategy: 100 } },
    ],
  },
  {
    label: 'AI·流氓赵云', tier: 'AI',
    slots: [
      { name: '赵云', skills: ['一骑当千', '击势'], affix: '骁锐', pts: { attack: 100 } },
      { name: '孙权', skills: ['始计', '浑水摸鱼'], affix: '机敏', pts: { speed: 100 } },
      { name: '张机', skills: ['垒实迎击', '绝水遏敌'], affix: '熟虑', pts: { strategy: 100 } },
    ],
  },
  {
    label: 'AI·混编马刘典', tier: 'AI',
    slots: [
      { name: '马超', skills: ['一骑当千', '击势'], affix: '骁锐', pts: { attack: 100 } },
      { name: '刘备', skills: ['重整旗鼓', '桃园结义'], affix: '熟虑', pts: { strategy: 100 } },
      { name: '典韦', skills: ['百战无怯', '愈战愈勇'], affix: '熟虑', pts: { defense: 100 } },
    ],
  },
];

function toSlotState(s: Slot): SlotState {
  const h = heroByName[s.name];
  if (!h) throw new Error(`武将不存在：${s.name}`);
  const sid0 = skillByName[s.skills[0]];
  const sid1 = skillByName[s.skills[1]];
  if (!sid0 || !sid1) throw new Error(`战法不存在：${s.name} → ${s.skills.join('/')}`);
  const [troop, traits] = TROOP[h.troopType] ?? TROOP.infantry;
  return {
    heroId: h.id,
    extraSkillIds: [sid0, sid1],
    freePoints: s.pts,
    redness: REDNESS,
    level: LEVEL,
    secondaryTroop: troop,
    secondaryTraits: traits,
    treasure: { treasureId: TREASURE[s.affix], affix: { name: s.affix, value: 15 } },
  };
}

function buildTeam(slots: Slot[]): General[] {
  return slots.map((s, i) => {
    const st = toSlotState(s);
    return buildGeneral(st.heroId, st.extraSkillIds, st.freePoints, POS[i], st.redness, st.level, MORALE, st.secondaryTroop, st.secondaryTraits, st.treasure, undefined);
  });
}

// ───────────────────────── 打印阵容摘要 ─────────────────────────
console.log('═'.repeat(72));
console.log('率土之滨 2026年10月 · 理论驱动横评：T0(7)+T1(4)+AI原创(4) 满红顶配 每对100场');
console.log('═'.repeat(72));
TEAMS.forEach((t, i) => {
  const line = t.slots
    .map((s) => {
      const h = heroByName[s.name];
      const [troop] = TROOP[h.troopType] ?? TROOP.infantry;
      return `${s.name}(${troop})[${s.skills.join('+')}]`;
    })
    .join('  ');
  console.log(`队${String(i + 1).padStart(2)} [${t.tier}] ${t.label}： ${line}`);
});
console.log('═'.repeat(72));

// ───────────────────────── 跑循环赛 ─────────────────────────
const N = TEAMS.length;
const PER_PAIR = 100;
const wins = new Array(N).fill(0);
const draws = new Array(N).fill(0);
const matrix: number[][] = Array.from({ length: N }, () => new Array(N).fill(0));

const t0 = Date.now();
for (let i = 0; i < N; i++) {
  for (let j = i + 1; j < N; j++) {
    let iWins = 0;
    let jWins = 0;
    let d = 0;
    for (let g = 0; g < PER_PAIR; g++) {
      const dir = g < PER_PAIR / 2 ? 0 : 1;
      const my = dir === 0 ? buildTeam(TEAMS[i].slots) : buildTeam(TEAMS[j].slots);
      const enemy = dir === 0 ? buildTeam(TEAMS[j].slots) : buildTeam(TEAMS[i].slots);
      const seed = (i * 131 + j * 977 + g * 13 + 7) & 0x7fffffff;
      const r = runBattle({ myTeam: my, enemyTeam: enemy, seed, maxRounds: 8 });
      if (dir === 0) {
        if (r.result === 'win') iWins++;
        else if (r.result === 'loss') jWins++;
        else d++;
      } else {
        if (r.result === 'loss') iWins++;
        else if (r.result === 'win') jWins++;
        else d++;
      }
    }
    matrix[i][j] = iWins / PER_PAIR;
    matrix[j][i] = jWins / PER_PAIR;
    wins[i] += iWins;
    wins[j] += jWins;
    draws[i] += d;
    draws[j] += d;
    console.log(
      `${TEAMS[i].label.padEnd(10)} vs ${TEAMS[j].label.padEnd(10)}： ` +
        `${TEAMS[i].label} ${(iWins / PER_PAIR * 100).toFixed(1)}% / ` +
        `${TEAMS[j].label} ${(jWins / PER_PAIR * 100).toFixed(1)}%` +
        (d ? ` （平局 ${(d / PER_PAIR * 100).toFixed(1)}%）` : '')
    );
  }
}
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

// ───────────────────────── 汇总：胜率矩阵 + 排名 ─────────────────────────
const totalPerTeam = (N - 1) * PER_PAIR;
const ranking = TEAMS.map((t, i) => ({
  label: t.label, tier: t.tier, winRate: wins[i] / totalPerTeam, wins: wins[i], draws: draws[i],
}))
  .sort((a, b) => b.winRate - a.winRate);

// 非败率（含平局 = 1 - 被击败率）
const lossRate = TEAMS.map((t, i) => 1 - (totalPerTeam - wins[i] - draws[i]) / totalPerTeam);

console.log('\n' + '═'.repeat(72));
console.log('【胜率矩阵】行=红队(先手方) 列=蓝队 ｜ 数值=红队胜率%');
const head = '红＼蓝'.padEnd(12) + TEAMS.map((t) => t.label.slice(0, 5).padStart(8)).join('');
console.log(head);
for (let i = 0; i < N; i++) {
  const row = TEAMS[i].label.slice(0, 5).padEnd(12) +
    matrix[i].map((v, j) => (j === i ? '  —  ' : (v * 100).toFixed(0).padStart(8))).join('');
  console.log(row);
}

console.log('\n' + '═'.repeat(72));
console.log('【强弱排名】（每队对全部其他 14 队、共 ' + totalPerTeam + ' 场的总胜率）');
ranking.forEach((r, i) => {
  const idx = TEAMS.findIndex(t => t.label === r.label);
  console.log(
    `${(i + 1).toString().padStart(2)}. [${r.tier}] ${r.label.padEnd(10)} 胜率 ${(r.winRate * 100).toFixed(1)}% ` +
    `（${r.wins}/${totalPerTeam} 胜，平 ${r.draws}） 非败率 ${(lossRate[idx] * 100).toFixed(1)}%`
  );
});
console.log('═'.repeat(72));
console.log(`耗时 ${elapsed}s ｜ 总计 ${N * (N - 1) / 2 * PER_PAIR} 场对战`);
