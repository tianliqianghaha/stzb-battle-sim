/**
 * 引擎级验证：用应用自己的 buildGeneral + runBattle，把预置的两支队伍真打一场，
 * 确认武将/战法/宝物/兵种等配置在引擎层全部被认可、能正常产出战报。
 * 运行：npx tsx scripts/verify-teams.mts
 */
import { buildGeneral } from '../web/heroes';
import { runBattle } from '../src/engine/combat';
import { reportToText } from '../src/engine/report';
import type { SlotState } from '../web/teamEditor';

const positions = ['大营', '中军', '前锋'] as const;
const morale = 120;

const redSlots: SlotState[] = [
  { heroId: 'h498', extraSkillIds: ['changbing_fangzhen', 'gongqi_bubei'], freePoints: { attack: 40, defense: 0, strategy: 0, speed: 0 }, redness: 5, level: 40, secondaryTroop: '轻骑兵', secondaryTraits: ['疾行', '出奇'], treasure: { treasureId: 1003, affix: { name: '骁锐', value: 15 } } },
  { heroId: 'h27', extraSkillIds: ['chengsheng_zhuiji', 'weizhen_xiaoyao'], freePoints: { attack: 40, defense: 0, strategy: 0, speed: 0 }, redness: 5, level: 40, secondaryTroop: '轻骑兵', secondaryTraits: ['疾行', '出奇'], treasure: { treasureId: 1084, affix: { name: '骁锐', value: 15 } } },
  { heroId: 'h704', extraSkillIds: ['shiwu_xudong', 'xiaoxiong'], freePoints: { attack: 90, defense: 0, strategy: 0, speed: 0 }, redness: 5, level: 40, secondaryTroop: '轻骑兵', secondaryTraits: ['疾行', '出奇'], treasure: { treasureId: 1102, affix: { name: '骁锐', value: 15 } } },
];

const blueSlots: SlotState[] = [
  { heroId: 'h22', extraSkillIds: ['shengbing_qiuzhan', 'jishi'], freePoints: { attack: 40, defense: 0, strategy: 0, speed: 0 }, redness: 0, level: 40, secondaryTroop: '轻骑兵', secondaryTraits: ['扰后', '挫锐'], treasure: { treasureId: 1087, affix: { name: '熟虑', value: 14 } } },
  { heroId: 'h496', extraSkillIds: ['shiji', 'dingzujiangdong'], freePoints: { attack: 0, defense: 0, strategy: 3, speed: 37 }, redness: 0, level: 40, secondaryTroop: '长弓兵', secondaryTraits: ['地利', '迂回'], treasure: { treasureId: 1057, affix: { name: '天资', value: 10 } } },
  { heroId: 'sunquan', extraSkillIds: ['jixian_yuanjin', 'zhanbi_duanjin'], freePoints: { attack: 0, defense: 15, strategy: 0, speed: 25 }, redness: 0, level: 40, secondaryTroop: '长弓兵', secondaryTraits: ['地利', '迂回'], treasure: { treasureId: 1072, affix: { name: '机敏', value: 6 } } },
];

const build = (slots: SlotState[]) =>
  slots.filter((s) => s.heroId).map((s, i) =>
    buildGeneral(s.heroId!, s.extraSkillIds, s.freePoints, positions[i], s.redness, s.level, morale, s.secondaryTroop, s.secondaryTraits, s.treasure, s.chenshou)
  );

const my = build(redSlots);
const enemy = build(blueSlots);

console.log(`红队(${my.map((g) => g.name).join('·')})  VS  蓝队(${enemy.map((g) => g.name).join('·')})`);
console.log('—'.repeat(40));

const report = runBattle({ myTeam: my, enemyTeam: enemy, seed: 20261031, maxRounds: 8 });
console.log(reportToText(report));
console.log('\n=== 引擎结果 ===');
console.log(`胜负: ${report.result} ｜ 回合数: ${report.rounds} ｜ 种子: ${report.seed}`);
