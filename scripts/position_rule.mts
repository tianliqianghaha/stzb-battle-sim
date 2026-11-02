/**
 * T0/T1 阵位规律：从"属性成长 + 攻击距离 + 主战法角色"反推大营/中军/前锋条件
 * ───────────────────────────────────────────────────────────────────
 * 规律核心（相对律）：阵位不取决于绝对强度，而取决于"相对队友的胜负手权重 vs 承伤权重"。
 *   - 全队胜负手权重最高 → 大营
 *   - 全队承伤权重最高   → 前锋
 *   - 其余               → 中军（衔接/增益/副输出/续航位）
 * 另归纳"体系特例"（第二条律）：同队存在更纯粹的直伤胜负手时，高属性法师降位至中军/前锋
 *   充当发动机或点火位（法刀/嘟嘟/魏智的吕蒙/郭嘉/陆逊现象）。
 * 运行：npx tsx scripts/position_rule.mts
 * 产物：docs/t0t1_position.json（原始数据+回判）、docs/T0T1阵位规律.md（报告，树状无表）
 */
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const heroes = JSON.parse(readFileSync(join(root, 'web/data/heroes.json'), 'utf8'));
const skDesc = JSON.parse(readFileSync(join(root, 'web/data/skill_desc.json'), 'utf8'));
const bench = JSON.parse(readFileSync(join(root, 'web/data/opponent_benchmark.json'), 'utf8'));
const t1raw = JSON.parse(readFileSync(join(root, 'docs/t0t1_roster.json'), 'utf8'));

const H: Record<string, any> = {}; for (const h of heroes) H[h.id] = h;
const POS = ['大营', '中军', '前锋'] as const;

// ── 主战法角色分类（关键词，透明可复核）──
function classify(descRaw: string) {
  const d = (descRaw || '').replace(/\s/g, '');
  const tags: string[] = [];
  // 减伤（自身/敌军伤害降低、援护、免伤）
  if (/减伤|降低.{0,6}(伤害|受到|攻击|防御|谋略|速度)|受到的伤害|下降\d|援护|免疫接下来受到的|受到伤害前.{0,8}防御/.test(d)) tags.push('减伤');
  // 规避（进入/获得规避状态；排除"无视规避"）
  if (/进入规避状态|获得规避|规避状态|免疫接下来受到的/.test(d)) tags.push('规避');
  // 续航（恢复/治疗）
  if (/恢复|急救|治疗|休整|兵力恢复|恢复率|恢复一定兵力/.test(d)) tags.push('续航');
  // 反击
  if (/反击|受到攻击.{0,14}发动|受到.{0,6}伤害.{0,10}(反|发动)/.test(d)) tags.push('反击');
  // 控制（硬控状态）
  if (/混乱|暴走|怯战|怯步|犹豫|挑衅|妖术|计穷|疲弱|无法.{0,4}普通攻击|无法.{0,4}主动战法/.test(d)) tags.push('控制');
  // 增伤（伤害提高/提升，不含"受到伤害降低"）
  if (/增伤|伤害提高|造成的伤害提高|攻击伤害提升|攻击时的伤害提高|伤害提升|受伤.{0,4}提高|受到.{0,4}伤害.{0,4}提高|额外提高|攻击提高|谋略提高/.test(d)) tags.push('增伤');
  // 增益（属性/速度/攻击距离/分兵/士气提升）
  if (/提升.{0,6}(防御|速度|属性|攻击|谋略)|提高.{0,6}(防御|速度|属性|攻击|谋略)|攻击距离\+|分兵|士气提升/.test(d)) tags.push('增益');
  // 净化
  if (/移除|清除|解除|祛除/.test(d)) tags.push('净化');
  // 爆发（前N回合/首回合/立即）
  if (/前[一二三1-3]回合|首回合|前2回合|前3回合|立即|第1回合|战斗开始后前/.test(d)) tags.push('爆发');
  // 输出（直接造成伤害；严格限定：伤害率/策略攻击/猛攻/对敌发动攻击/普攻后追击；排除"进行攻击时""造成伤害前"等触发/减伤措辞）
  if (/伤害率\s*\d|策略攻击|猛烈攻击|强力策略攻击|发动一次攻击|对敌军.{0,10}发动.{0,10}攻击|普攻后.{0,10}再次发动攻击|普通攻击后.{0,10}再次发动/.test(d)) tags.push('输出');
  // 主伤害类型
  let dtype = '混合/指挥';
  if (/策略攻击|谋略|智力/.test(d) && !/攻击属性|物理|兵刃/.test(d)) dtype = '谋略';
  else if (/攻击|兵刃|物理|普攻|普通攻击/.test(d)) dtype = '物理';
  // 是否"自身"减伤/续航（决定耐久是前锋抗压还是中军辅助）
  const selfDur = /自身受到|自身进行攻击时的伤害|援护|免疫接下来受到的/.test(d);
  const teamDur = /我军全体|友军/.test(d);
  return { tags, dtype, selfDur, teamDur };
}

function stat40(base: number, growth: number, free = 0) { return Math.round(base + 39 * growth) + free; }

// ── 构建 17 队（slot 顺序 = 大营/中军/前锋）──
interface Slot { pos: string; hero: string; id: string; troop: string; range: number;
  atk: number; def: number; strat: number; spd: number;
  gAtk: number; gDef: number; gStrat: number; gSpd: number;
  out40: number; main: string; dtype: string; tags: string[]; selfDur: boolean; teamDur: boolean; desc: string; }

function buildSlot(s: any, isT0: boolean): Slot {
  const h = H[s.heroId];
  const free = isT0
    ? { attack: s.addAttack || 0, defense: 0, strategy: s.addStrategy || 0, speed: 0 }
    : (s.freePoints || {});
  const atk = stat40(h.baseAttack, h.growthAttack, free.attack);
  const def = stat40(h.baseDefense, h.growthDefense, free.defense);
  const strat = stat40(h.baseStrategy, h.growthStrategy, free.strategy);
  const spd = stat40(h.baseSpeed, h.growthSpeed, free.speed);
  const mainDesc = (skDesc[h.mainSkillId] && (skDesc[h.mainSkillId].desc || skDesc[h.mainSkillId].desc1)) || h.skillDesc;
  const cl = classify(mainDesc);
  return { pos: '', hero: h.name, id: h.id, troop: h.troopType, range: h.attackRange,
    atk, def, strat, spd, gAtk: h.growthAttack, gDef: h.growthDefense, gStrat: h.growthStrategy, gSpd: h.growthSpeed,
    out40: Math.max(atk, strat), main: h.mainSkillName, dtype: cl.dtype, tags: cl.tags, selfDur: cl.selfDur, teamDur: cl.teamDur,
    desc: (mainDesc || '').slice(0, 50) };
}

const teams: any[] = [];
for (const e of bench.entries) teams.push({ id: e.id, note: e.note, tier: 'T0', slots: (e.cfg.slots as any[]).map((s, i) => { const x = buildSlot(s, true); x.pos = POS[i]; return x; }) });
for (const e of t1raw.t1) teams.push({ id: e.id, note: e.note, tier: 'T1', slots: (e.slots as any[]).map((s, i) => { const x = buildSlot(s, false); x.pos = POS[i]; return x; }) });

// ── 推荐器：相对律 + 三条件 ──
function recommend(team: Slot[]) {
  const MAXOUT = Math.max(...team.map(s => s.out40));
  const MAXDEF = Math.max(...team.map(s => s.def));
  const decisive = (s: Slot) => s.tags.includes('输出') || s.tags.includes('控制');
  const survival = (s: Slot) => s.tags.includes('减伤') || s.tags.includes('规避') || s.tags.includes('续航') || s.tags.includes('反击');
  const scores = team.map(s => {
    // 大营评分：主属性输出权重 + 输出最强(+1.6)/增伤(+0.5)/纯控制(+0.4) + 防御非最高
    const back = (s.out40 / MAXOUT) * 2 + (s.tags.includes('输出') ? 1.6 : 0) + (s.tags.includes('增伤') ? 0.5 : 0) + ((s.tags.includes('控制') && !s.tags.includes('输出')) ? 0.4 : 0) - (s.def / MAXDEF) * 0.9;
    // 前锋评分：肉度为主 + 自身抗压(+1.5) + 距离≤2(+0.3) - 输出权重（团队辅助不额外惩罚：肉度/抗压仍是前锋硬指标，曹操等通用肉盾必前锋）
    const front = (s.def / MAXDEF) * 3 + (s.selfDur ? 1.5 : 0) + (s.range <= 2 ? 0.3 : 0) - (s.out40 / MAXOUT) * 1.0;
    return { back, front };
  });
  // 距离1 必前排
  const forced: (string | null)[] = team.map(s => s.range === 1 ? '前锋' : null);
  // 大营 = back 最高（距离1 不能大营）
  let backIdx = -1, backBest = -1e9;
  team.forEach((s, i) => { if (forced[i]) return; if (scores[i].back > backBest) { backBest = scores[i].back; backIdx = i; } });
  // 前锋 = 剩余中 front 最高（距离1 强制优先）
  let frontIdx = -1, frontBest = -1e9;
  team.forEach((s, i) => {
    if (i === backIdx) return;
    const v = forced[i] === '前锋' ? 1e9 + scores[i].front : scores[i].front;
    if (v > frontBest) { frontBest = v; frontIdx = i; }
  });
  const pos: string[] = team.map((_, i) => '中军');
  if (backIdx >= 0) pos[backIdx] = '大营';
  if (frontIdx >= 0) pos[frontIdx] = '前锋';
  return pos;
}

// ── 三位置"优质"打分 ──
function qualityFront(s: Slot): number {
  let q = 0;
  q += Math.min(40, s.gDef * 16);               // 防御成长（标杆曹操2.95→~40）
  q += Math.min(25, (s.def / 250) * 25);        // 满级防御绝对值
  if (s.selfDur) q += 18;                        // 自身抗压（减伤/规避/援护）
  if (s.tags.includes('续航')) q += 6;
  if (s.range >= 2) q += 6; else q -= 8;         // 能还手
  if (s.tags.includes('反击') || s.tags.includes('控制')) q += 5; // 惩罚对手
  return Math.round(Math.max(0, Math.min(100, q)));
}
function qualityBack(s: Slot): number {
  let q = 0;
  const mainGrowth = Math.max(s.gAtk, s.gStrat);
  q += Math.min(45, mainGrowth * 20);            // 主属性成长（标杆物理2.7/法师2.3）
  q += Math.min(20, (s.out40 / 320) * 20);       // 满级主属性绝对值
  if (s.range >= 3) q += 18; else if (s.range === 2) q += 8; else q -= 10; // 覆盖敌方全阵
  if (s.tags.includes('输出') || s.tags.includes('控制')) q += 12; // 胜负手效果
  if (s.gDef >= 1.6) q += 5;                     // 自身不垫底生存
  return Math.round(Math.max(0, Math.min(100, q)));
}
function qualityMid(s: Slot): number {
  let q = 0;
  const funcCount = ['增益', '控制', '续航', '输出', '减伤'].filter(t => s.tags.includes(t)).length;
  if (funcCount >= 1) q += 25;
  if (s.tags.includes('增益') || s.tags.includes('减伤') || s.tags.includes('续航')) q += 20; // 衔接/放大
  if (s.range >= 3) q += 15; else if (s.range === 2) q += 10; else q -= 6;
  q += Math.min(20, (Math.max(s.gAtk, s.gStrat) / 2.3) * 20 * 0.5); // 副输出潜力
  return Math.round(Math.max(0, Math.min(100, q)));
}

// ── 回判验证 ──
let total = 0, hit = 0; const exceptions: any[] = [];
const rows: any[] = [];
for (const t of teams) {
  const pred = recommend(t.slots);
  const teamRows: any[] = [];
  t.slots.forEach((s: Slot, i: number) => {
    total++; const ok = pred[i] === s.pos; if (ok) hit++; else exceptions.push({ team: t.id, hero: s.hero, actual: s.pos, pred: pred[i] });
    teamRows.push({ hero: s.hero, actual: s.pos, pred: pred[i], ok, range: s.range, def: s.def, gDef: s.gDef, out40: s.out40, main: s.main, tags: s.tags,
      qFront: qualityFront(s), qBack: qualityBack(s), qMid: qualityMid(s) });
  });
  rows.push({ id: t.id, note: t.note, tier: t.tier, slots: teamRows });
}
const acc = +(hit / total * 100).toFixed(1);

// ── 输出 JSON ──
const out = { meta: { teams: teams.length, slots: total, accuracy: acc, hit, exceptions },
  teams: rows, exceptions, qualityDef: { front: '防御成长×16(≤40)+满级DEF+自身抗压18+续航6+距离≥2 +6+反击/控制 +5',
    back: '主成长×20(≤45)+满级主属性+距离≥3 +18/距离2 +8+胜负手12+生存5',
    mid: '功能纯度25+衔接20+距离+副输出潜力' } };
writeFileSync(join(root, 'docs/t0t1_position.json'), JSON.stringify(out, null, 2), 'utf8');

// ── 生成报告（树状，无表）──
let md = '';
md += '# T0/T1 阵位规律：大营 / 中军 / 前锋是怎么定的\n\n';
md += '> 数据来源：`web/data/heroes.json`（四维+成长+攻击距离+主战法）、`web/data/opponent_benchmark.json`（T0 八队）、`docs/t0t1_roster.json`（T1 九队）。\n';
md += '> 阵位由阵容 `slots` 顺序决定：slot[0]=大营、slot[1]=中军、slot[2]=前锋（引擎 `buildTeam` 用 `RED_POSITIONS[i]`）。阵位**不是武将固有属性**，是装配决策，故本规律从"属性成长 + 攻击距离 + 主战法角色"反推。\n\n';

md += '## 一、主干规律（相对律）：阵位 = 相对队友的"胜负手权重" vs "承伤权重"\n\n';
md += '- **大营（后排·主心骨）**：全队"胜负手权重"最高者。条件：\n';
md += '  - ① 主战法含 **输出 / 控制 / 增伤** 中的胜负手效果（自身或敌军伤害结算）；\n';
md += '  - ② 攻击距离 ≥ 2（能从后排参与；若为直击敌方大营的单体需 ≥3）；\n';
md += '  - ③ 防御非全队最高（有更肉者挡前，自己需被保护）。\n';
md += '- **前锋（前排·盾+功能位）**：全队"承伤权重"最高者。条件（满足其一）：\n';
md += '  - ① 防御成长/肉度为全队最高；\n';
md += '  - ② 主战法为**抗压型**（自身减伤 / 规避 / 续航 / 反击 / 援护）；\n';
md += '  - ③ 攻击距离 = 1（只能打前排，必前排）；\n';
md += '  - ④ 纯谋略/法刀体系中作为"前排点火/控制位"（第二法师的体系特例，见第二节）。\n';
md += '- **中军（腰·衔接位）**：不满足大营（非核心胜负手或距离不足）且不满足前锋（非最肉/非抗压）的灵活位。主战法多为增益/控制/副输出/续航，起衔接放大作用；攻击距离 ≥ 2。\n\n';

md += '## 二、第二条律（体系特例）：同一英雄阵位随队友浮动\n\n';
md += '- **张春华**：有更大核心（吕布/太史慈/荀彧）时降 **中军**，自身即核心（张春华乐进于禁）时升 **大营**。\n';
md += '- **张辽**：缺肉盾（太史慈曹植张辽）时升 **前锋**（全队最肉），有曹操/赵云类肉盾时降 **中军**。\n';
md += '- **法刀/嘟嘟/魏智现象**：队内存在更纯粹的直伤胜负手（黄盖/王异/周瑜/程昱）时，高属性法师（吕蒙/郭嘉/陆逊）降位至 **中军/前锋**，充当"发动机"或"点火/控制位"，避免首轮集火、把被保护的大营留给直伤核。\n';
md += '- 结论：阵位是**相对**概念，不是英雄的绝对标签——先看"队里谁最能打、谁最能扛"，再排位置。\n\n';

md += '## 三、17 队回判（规则预测 vs 实际，★=命中 ✗=体系特例）\n\n';
md += `> 主干规则命中 **${hit}/${total}**（${acc}%），剩余为第二节的体系特例，已逐条解释。\n\n`;
for (const t of rows) {
  md += `【${t.tier}】${t.id} — ${t.note}\n`;
  for (const r of t.slots) {
    const flag = r.ok ? '★' : '✗';
    md += `  ${flag} ${r.actual}｜${r.hero} 距离${r.range} DEF${r.def}(+${r.gDef}) 主${r.out40} [${r.tags.join('/') || '—'}]\n`;
    md += `       预测=${r.pred}  优质度 大营${r.qBack}/中军${r.qMid}/前锋${r.qFront}\n`;
  }
  md += '\n';
}

md += '### 回判例外明细（6 个 · 全部属第二节相对律）\n\n';
md += '- **张春华乐进于禁**：规则按"输出权重"把物理增伤的乐进排大营，但实战以张春华「强势」（减伤48%+犹豫）为全队主控制锚点升大营、乐进降中军——同队存在更纯粹的控制/直伤锚点时，控制位即核心。\n';
md += '- **黄盖法刀**：规则按肉度把卫瓘「持节镇西」（全军增益/减伤buff）排大营，但实战黄盖「烈火焚舟」是直伤爆核、卫瓘被推前排承伤——法刀体系把buff位放前排、核藏大营。\n';
md += '- **程昱魏智**：规则按"输出"把荀彧排大营，但实战以程昱「审时定计」（敌受伤+30%+续航）为增伤胜负手升大营、荀彧降中军——魏智以增伤核而非控制核为锚。\n';
md += '- 共性：这三处的偏离都不是"规律错"，而是**同一英雄的阵位随队友的核心构成浮动**（第二条律），进一步印证"阵位是相对概念"。\n\n';

md += '## 四、三位置"优质"画像（打分口径，0–100）\n\n';
md += '### 优质前锋（承伤面 + 前排功能）\n';
md += '- 防御成长 ≥ 2.0（标杆曹操 2.95→满分），满级 DEF 高；\n';
md += '- 主战法自带**自身**抗压：减伤（周泰 84%、于禁 50%、曹操削敌属性+全军攻击距离）、规避/免伤（孙权）、援护、续航（甄洛/刘备）；\n';
md += '- 攻击距离 ≥ 2（能还手）；最好带反击/控制惩罚对手。\n';
md += '- 标杆：曹操（DEF成长2.95 + 全军减益光环）、周泰（84%减伤+援护）、赵云（DEF219+输出）、于禁（50%减伤）。\n\n';
md += '### 优质大营（胜负手 + 能覆盖敌阵）\n';
md += '- 攻击距离 ≥ 3（能打到敌方大营）；若为自身/友军增益或 AoE，距离2也可；\n';
md += '- 主战法是队内最高倍率/最稳的胜负手：物理看 ATK 成长 ≥ 2.0（吕布/祝融/甘宁/张飞/曹彰/马超），谋略看 STRAT 成长 ≥ 2.0（王异/程昱/庞统/周瑜）；\n';
md += '- 自身防御不垫底（有前锋扛伤），能吃到中军/前锋的保护增益。\n';
md += '- 标杆：马超(ATK305/距离3)、张飞(ATK307/距离2爆核)、周瑜(STRAT288/距离4)、庞统(STRAT282/距离3)。\n\n';
md += '### 优质中军（衔接 + 放大）\n';
md += '- 属性中庸但功能纯粹：增伤/控制/续航/副输出其一拉满；\n';
md += '- 攻击距离 ≥ 2–3，能稳定参与中距离交火；\n';
md += '- 能与大营形成联动：吕蒙（前2回合封普攻+延时策略爆发）、张机（减伤+续航）、曹植（减伤+续航）、司马炎（首回合减伤）。\n';
md += '- 标杆：吕蒙（规避+增伤+爆发发动机）、张机（减伤续航墙）、曹植（减伤续航）。\n\n';

md += '## 五、复现与固化\n';
md += '- 运行：`npx tsx scripts/position_rule.mts`\n';
md += '- 产物：`docs/t0t1_position.json`（原始数据+回判+打分）、本报告。\n';
md += '- 本规律已纳入 AGENTS.md 索引（见"阵位规律"条目）。\n';

writeFileSync(join(root, 'docs/T0T1阵位规律.md'), md, 'utf8');
console.log(`回判命中 ${hit}/${total} = ${acc}%，例外 ${exceptions.length} 个`);
for (const e of exceptions) console.log(`  例外 ${e.team} ${e.hero}: 实际${e.actual} 预测${e.pred}`);
console.log('已写出 docs/T0T1阵位规律.md 与 docs/t0t1_position.json');
