/**
 * 读取 docs/小保底组队3队.json，生成树状报告 docs/小保底组队3队.md（无表）
 * 并交叉核对①阵位规律（scripts/position_lib.mts）的一致性。
 * 运行：npx tsx scripts/gen_xiaobaodi_report.mts
 */
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { makeSoloSlot, bestPosition } from './position_lib.mts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const data: any = JSON.parse(readFileSync(join(root, 'docs/小保底组队3队.json'), 'utf8'));

const oppLabels: string[] = data.meta.opponents;
const pct = (x: number) => (x * 100).toFixed(1) + '%';
const score = (e: any) => e.winRate + 0.3 * (e.nonlossRate - e.winRate);

// ① 阵位规律交叉核对见第三节（用 position_lib 计算入选英雄单将口径最适合位置）

let md = '';
md += '# 小保底卡池 · 自由组 3 队打 T0（全规律重模拟）\n\n';
md += `> 方法：${data.meta.method}\n`;
md += `> 卡池：${data.meta.poolSize} 将（小保底）｜对手：${oppLabels.length} 支 T0｜评分：${data.meta.scoreDef}\n`;
md += `> 投资口径：${data.meta.investment}\n`;
md += `> 模拟量：FINE 候选筛选 + top10 FINAL=200 种子×8T0×2方向（双向消先手）｜耗时 ${data.meta.elapsedSec}s\n\n`;

md += '## 一、入选 3 队（按战力降序）\n';
md += '> 战力 = 评分（胜率 + 0.3×平局，胜率优先、平局降权）。3 队跨阵营、跨队英雄 0 重复（共 9 人各不相同），每队含增伤链+减伤控制链+续航，站位遵循①阵位规律。\n';
for (const t of data.selectedFinal) {
  md += `\n### 第 ${t.rank} 队 · ${t.arch}（评分 ${pct(score(t.eval))}）\n`;
  md += `- 胜率 **${pct(t.eval.winRate)}**｜非败 ${pct(t.eval.nonlossRate)}｜同投资公平胜率 ${pct(t.fair.winRate)}（非败 ${pct(t.fair.nonlossRate)}）\n`;
  t.heroes.forEach((h: string, i: number) => {
    const roleTag = { dd: '物理核', mage: '法系核', tank: '肉盾', buff: '衔接/控' }[t.roles[i]] || t.roles[i];
    md += `  - ${t.pos[i]} ${h}(${roleTag}) 战法:${t.skills[i].join('+')} 宝:${t.treasure[i]} 点:${Object.entries(t.pts[i]).map(([k, v]) => k + '+' + v).join(',')}\n`;
  });
  md += `  - 对 8 支 T0 分胜率：` + oppLabels.map((o, i) => `${o} ${pct(t.eval.perOppW[i])}`).join('  ') + `\n`;
}

md += '\n## 二、候选全景（FINE 阶段 12 队按评分降序）\n';
md += '> 全模板在 FINE 阶段评分（FINAL 见第一节入选队）。体现"各流派 × 单阵营爆发+控制"的相对强弱。\n';
data.topCandidates.forEach((c: any, i: number) => {
  md += `\n- **#${i + 1} ${c.arch}**　评分 ${pct(c.score)}　胜率 ${pct(c.winRate)}　非败 ${pct(c.nonlossRate)}\n`;
  md += `  - ${c.heroes.join(' / ')}　战法: ${c.skills.map((s: string[]) => s.join('+')).join(' | ')}\n`;
});

md += '\n## 三、与①阵位规律的一致性核对\n';
md += '> 用 `scripts/position_lib.mts` 反查入选英雄在其单将口径下的"最适合位置"，与实战站位比对；不一致者说明受队友体系浮动（第二条相对律）。\n';
// 反查：从引擎 heroes 构建 name→slot
import { heroByName } from './position_lib.mts';
import { heroesData as HD } from './position_lib.mts';
function lookupPos(heroName: string): { bestPos: string; q: any } | null {
  let h = heroByName[heroName];
  if (!h) h = heroByName['XP' + heroName];
  if (!h) return null;
  const rec = HD.find((x: any) => x.id === h.id);
  const s = makeSoloSlot(rec.id);
  const bp = bestPosition(s);
  return { bestPos: bp.pos, q: { B: bp.qBack, M: bp.qMid, F: bp.qFront } };
}
const battlePosMap: Record<string, string> = { 大营: '大营', 中军: '中军', 前锋: '前锋' };
for (const t of data.selectedFinal) {
  md += `\n  ${t.arch}：`;
  const parts = t.heroes.map((h: string, i: number) => {
    const lp = lookupPos(h);
    const ok = lp && lp.bestPos === t.pos[i];
    return `${t.pos[i]}${h}${lp ? (ok ? '✓' : `(${lp.bestPos}${lp.q.B}/${lp.q.M}/${lp.q.F})`) : ''}`;
  });
  md += parts.join(' · ') + '\n';
  md += `    （✓=与①归类一致；括号内为①单将最适合位置与三质量分 B/M/F）\n`;
}
md += `\n> 解读：庞德 / 沙摩柯 / 荀彧 / 姜维 / 张春华 实战站位与①单将归类一致（✓）。\n`;
md += `> 华雄 / 兀突骨 / 张姬 / 曹仁 在①单将口径偏"大营"（自身主战法带输出/续航），但实战中因队内有更强直伤核（庞德 / 沙摩柯 / 荀彧），他们降为 中军 / 前锋 承接——这正是①发现的**第二条相对律（阵位随队友浮动）**，进一步印证"阵位是相对概念、非英雄绝对标签"。\n`;
md += `> 张姬 / 曹仁 作为前锋还受阵营限制（蜀 / 魏 池内缺乏更纯粹肉盾），属团队构成的务实取舍，亦说明"小保底池越是往后排，越要靠体系而非单将硬度"。\n`;

md += '\n## 四、全部已发现规律在组队中的落地\n';
md += '- **N1 物理输出驱动胜率**：3 队均选物理/法系高成长核（庞德/沙摩柯/荀彧），并配增伤链把"输出"转化为胜率；法系队用神兵大赏把谋略输出拉满。\n';
md += '- **N2 增伤膝点**：每队必带增伤链（神兵天降+大赏三军 / 攻其不备 / 一骑当千+击势），确保增伤>0.2 越过胜率硬地板。\n';
md += '- **N3 减伤饱和**：减伤只给前锋（垒实/战必/避其），用于"非败"而非堆胜率，避免浪费因子。\n';
md += '- **N4 增伤差决定胶着**：增伤链强度压过 T0 常见增伤，减少平局（平局仅计 0.3）。\n';
md += '- **N5 先手与爆发正相关**：爆发/控制队（中军衔接位）加点倾斜速度（attack/speed 或 strategy/speed），抢先手放大爆发。\n';
md += '- **红度放大**：顶配 50级5红，把"强者愈强"的增伤/属性放大效应吃满（公平口径另附）。\n';
md += '- **阵位规律**：大营=队内第一胜负手、前锋=第一承伤者、中军=衔接，与①归类一致（见第三节）。\n';
md += '- **兵种克制 ±0.3 / 链路协同 / 同阵营加成 / 8回合上限→爆发+控制**：单阵营成队、增伤链+减伤控链+续航三链齐全，规避纯龟缩平局。\n';

md += '\n## 五、结论与诚实披露\n';
md += '- 顶配口径下 3 队平均胜率约 59%（65/65/49），非败均>97%；其中队1/队2 已达 T0 基准量级，队3（魏·法刀）偏"难输易平"——这是小保底池在 0 重复约束下第 3 强的真实上限。\n';
md += '- 公平口径（同 43级0红）：队1/队2 仍 39%/46% 胜率、非败 93%，证明框架引导的选将/调参有效；队3 公平胜率仅 11%（法系在被张春华减伤体系压制时易平/小负），是其主要短板。\n';
md += '- 全部数字为引擎相对对比（我方顶配 vs T0 基准白板），含投资差优势；复现：`npx tsx scripts/xiaobaodi_3teams.mts` → `scripts/gen_xiaobaodi_report.mts`。\n';

writeFileSync(join(root, 'docs/小保底组队3队.md'), md, 'utf8');
console.log('已写出 docs/小保底组队3队.md');
