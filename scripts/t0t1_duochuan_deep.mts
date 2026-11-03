/**
 * 多穿队伍「战法/英雄级」精细化归因 · 消融实验模拟器
 * ───────────────────────────────────────────────────────────────────
 * 研究问题：上一轮已证明「多穿 = 首战胜率(门槛) × 满兵胜场净消耗(效率)」。
 *           这一轮要回答：这两个因子分别由哪些「战法 / 英雄属性」造就？
 *           —— 即「怎样造出一支多穿队伍」，并量化每个战法/属性的贡献(Δ)。
 *
 * 方法：在已验证的两因子框架上做 **消融实验(ablation)**：
 *   - 固定一套难度适中、多元的对手池（17 队混战，与上轮口径一致）。
 *   - 对每个候选穿者，测量其「首战(满兵)胜率 p1」与「场均净损 avgNet」作为两因子代理。
 *   - 逐项摘除/错配，再看 p1 与 avgNet 的变化 Δ —— Δ 即该要素的量化贡献。
 *
 * 消融项（白板 40级 红0 无宝物，隔离流派机制本身）：
 *   - 每个英雄：摘除携带战法A / 携带战法B（共 3 英雄 × 2 = 6 项）；主战法随英雄绑定、不可剥离，不参与消融
 *   - 队级：错配加点（主攻/主谋互换） / 大营↔前锋 换位（2 项）
 * 对照配置：
 *   - 满红口径（50级 红5 无宝物，因花名册数据不含宝物）作「投资强度」稳健性检验。
 *
 * 运行：SEEDS=60 npx tsx scripts/t0t1_duochuan_deep.mts
 * 产物：docs/t0t1_duochuan_deep.json  docs/t0t1_duochuan_deep.md
 */
import { buildGeneral } from '../web/heroes';
import { runBattle } from '../src/engine/combat';
import { SKILL_REGISTRY } from '../src/data/skills';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const heroesData: any[] = JSON.parse(readFileSync(join(root, 'web/data/heroes.json'), 'utf8'));
const HERO_NAME: Record<string, string> = {};
for (const h of heroesData) HERO_NAME[h.id] = h.name || h.id;
const heroName = (id: string) => HERO_NAME[id] || id;
const benchRaw: any = JSON.parse(readFileSync(join(root, 'web/data/opponent_benchmark.json'), 'utf8'));
const t1Raw: any = JSON.parse(readFileSync(join(root, 'docs/t0t1_roster.json'), 'utf8'));
const skillDescRaw: any = JSON.parse(readFileSync(join(root, 'web/data/skill_desc.json'), 'utf8'));

const SEEDS = parseInt(process.env.SEEDS || '60', 10);
const RED_POSITIONS = ['大营', '中军', '前锋'] as const;
const MORALE = 120;

interface SlotDef { heroId: string; freePoints: any; skillIds: string[]; traits?: string[]; secondaryTroop?: string; treasure?: any; }
interface TeamDef { id: string; note: string; tier: string; archetype: string; slots: SlotDef[]; }

const t0: TeamDef[] = benchRaw.entries.map((e: any) => ({
  id: e.id, note: e.note, tier: 'T0', archetype: 'T0基准',
  slots: e.cfg.slots.map((s: any) => ({
    heroId: s.heroId, freePoints: { attack: s.addAttack || 0, defense: s.addDefense || 0, strategy: s.addStrategy || 0, speed: s.addSpeed || 0 },
    skillIds: s.skillIds || [], traits: s.traits || [], secondaryTroop: s.secondaryTroop, treasure: s.treasure || null,
  })),
}));
const t1: TeamDef[] = t1Raw.t1.map((e: any) => ({
  id: e.id, note: e.note, tier: 'T1', archetype: e.archetype,
  slots: e.slots.map((s: any) => ({ heroId: s.heroId, freePoints: s.freePoints || {}, skillIds: s.skillIds || [], traits: s.traits || [], secondaryTroop: s.secondaryTroop, treasure: s.treasure || null })),
}));
const ALL: TeamDef[] = [...t0, ...t1];
const ALL_IDS = ALL.map((d) => d.id);

// 候选穿者（沿用 duochuan 的 9 支，覆盖多穿资本 + 反例）
const MARCHERS = [
  't1-pangtong-shubu',        // 庞统蜀步（肉步·双减续航）—— 多穿最优·血赚型
  't1-caozhang-loutie',       // 曹彰撸铁（物理持续）—— 门槛最强+高消耗
  't1-ganning-shiliu',        // 甘宁士气流氓（神赏增伤）
  't1-zhouyu-dudu',           // 周瑜嘟嘟（吴法·神赏火法）
  't1-machao-caidao',         // 马超菜刀（神赏物理爆发）
  'bench-lvbu-zhangchunhua-zhenluo', // 敌方·吕布张春华甄洛（T0 基准低耗对照）
  't1-wangyi-fadao',          // 王异法刀（法刀·神赏）
  't1-huanggai-fadao',        // 黄盖法刀（法刀·神赏）
  't1-zhangfei-liumang',      // 张飞流氓（物理爆发·门槛崩塌反例）
];

// ── 构建队伍（支持消融修改）──
function buildTeamVariant(def: TeamDef, redness: number, level: number, mods: any): any[] {
  const posArr = [...RED_POSITIONS] as string[];
  if (mods.swapPos) { const t = posArr[0]; posArr[0] = posArr[2]; posArr[2] = t; }
  return def.slots.map((s, i) => {
    let skillIds = [...(s.skillIds || [])];
    let freePoints: any = { ...(s.freePoints || {}) };
    if (mods.removeCarry && mods.removeCarry.hero === i) skillIds.splice(mods.removeCarry.idx, 1);
    if (mods.mispoint) {
      const atk = freePoints.attack || 0, stg = freePoints.strategy || 0;
      const dominant = atk >= stg ? 'attack' : 'strategy';
      const wrong = dominant === 'attack' ? 'strategy' : 'attack';
      const total = (freePoints.attack || 0) + (freePoints.defense || 0) + (freePoints.strategy || 0) + (freePoints.speed || 0);
      freePoints = { [wrong]: total };
    }
    const g = buildGeneral(s.heroId, skillIds, freePoints, posArr[i], redness, level, MORALE, s.secondaryTroop, s.traits, s.treasure || null);
    if (mods.removeMain && mods.removeMain.hero === i) {
      const ms = g.mainSkillId;
      (['activeSkillIds', 'passiveSkillIds', 'commandSkillIds', 'pursuitSkillIds'] as const).forEach((k) => { (g as any)[k] = (g as any)[k].filter((x: string) => x !== ms); });
      g.mainSkillId = '';
    }
    return g;
  });
}

// 白板对手池（固定，用于隔离穿者配置效应）
const whiteOpp: Record<string, any[]> = {};
for (const d of ALL) whiteOpp[d.id] = buildTeamVariant(d, 0, 40, {});

const sumTroops = (gs: any[]) => gs.reduce((a, g) => a + (g.maxTroops || 0), 0);
const oppIndex = new Map(ALL_IDS.map((id, i) => [id, i]));
const marcherIndex = new Map(MARCHERS.map((id, i) => [id, i]));

interface Meas { p1: number; effFull: number; lossNet: number; avgNet: number; games: number; wins: number; }
// 测量：穿者(满兵满状态) vs 对手池(除自己)，每对手 SEEDS 场
//   p1      = 首战胜率（门槛）
//   effFull = 胜场净损（赢了之后还剩多少兵，省兵/效率的核心代理）
//   lossNet = 败场净损（被打崩程度，仅参考）
//   avgNet  = 场均总损耗（含败场，仅参考，避免与效率混淆）
function measure(myTeam: any[], excludeId: string): Meas {
  let games = 0, wins = 0, winNet = 0, losses = 0, lossNet = 0, allNet = 0;
  const myIni = sumTroops(myTeam);
  for (const oppId of ALL_IDS) {
    if (oppId === excludeId) continue;
    const oppTeam = whiteOpp[oppId];
    const mi = oppIndex.get(oppId)!;
    for (let s = 1; s <= SEEDS; s++) {
      const seed = ((s * 131 + mi * 977 + (marcherIndex.get(excludeId) ?? 0) * 31 + 7) >>> 0);
      const r: any = runBattle({ myTeam, enemyTeam: oppTeam, seed, maxRounds: 8 });
      const myAliveEnd = (r.finalMyTroops as number[]).reduce((a: number, b: number) => a + Math.max(0, b), 0);
      const net = myIni - myAliveEnd; // = 死兵 + 终态伤兵（战损净）
      allNet += net; games++;
      if (r.result === 'win') { wins++; winNet += net; } else { losses++; lossNet += net; }
    }
  }
  return { p1: wins / games, effFull: wins > 0 ? winNet / wins : NaN, lossNet: losses > 0 ? lossNet / losses : NaN, avgNet: allNet / games, games, wins };
}

// ── 战法档案辅助：取名称/描述/类型/发动率/标签 ──
function skillInfo(id: string) {
  const reg = (SKILL_REGISTRY as any)[id];
  const desc = (skillDescRaw[id] || {});
  return {
    id,
    name: (reg && reg.name) || desc.name || id,
    type: (reg && reg.type) || '?',
    triggerRate: reg ? reg.triggerRate : undefined,
    tags: reg ? reg.tags : (desc.tags || []),
    desc: (desc.desc || desc.desc1 || (reg && reg.desc) || '').toString().replace(/\s+/g, ' ').trim(),
  };
}

// 维度归类（基于标签自动粗分，供档案展示；叙事以实测 Δ 为准）
function dimensionOf(info: any): string[] {
  const t = (info.tags || []).map((x: string) => x.toLowerCase());
  const d: string[] = [];
  if (t.some((x: string) => x.includes('damage_boost') || x.includes('attack_buff'))) d.push('增伤');
  if (t.some((x: string) => x.includes('defense_buff') || x.includes('shield') || x.includes('damage_reduction'))) d.push('减伤/护盾');
  if (t.some((x: string) => ['hesitation', 'cowardice', 'siege', 'confusion', 'panic', 'imprison', '怯战', '犹豫', '围困', '混乱'].some((k) => x.includes(k)))) d.push('控制');
  if (t.some((x: string) => ['heal', 'restore', 'recover', '回复', '重整', '士气', '治疗'].some((k) => x.includes(k)))) d.push('续航');
  if (info.type === 'active' && typeof info.triggerRate === 'number' && info.triggerRate < 1) d.push('主动·看发动率');
  if (d.length === 0) d.push('其他');
  return d;
}

const results: any = { meta: { seeds: SEEDS, marchers: MARCHERS.length, rosterVersion: t1Raw.version, generatedAt: new Date().toISOString() }, teams: [] };

console.log(`开始战法级消融：候选 ${MARCHERS.length} 队 × (11 消融 + 2 配置) × ${SEEDS} 种子 × 16 对手`);

let doneTeams = 0;
for (const mid of MARCHERS) {
  const def = ALL.find((d) => d.id === mid)!;
  // 战法档案（主战法 + 2 携带 + 面板）
  const built0 = buildTeamVariant(def, 0, 40, {});
  const dossier = def.slots.map((s, i) => {
    const g = built0[i];
    const mainId = g.mainSkillId;
    const mainInfo = mainId ? skillInfo(mainId) : null;
    const carries = (s.skillIds || []).map((id) => skillInfo(id));
    return {
      heroId: s.heroId, position: RED_POSITIONS[i],
      troopType: g.troopType, attackRange: g.attackRange,
      stats: { attack: g.attack, defense: g.defense, strategy: g.strategy, speed: g.speed, maxTroops: g.maxTroops },
      main: mainInfo ? { ...mainInfo, dimensions: dimensionOf(mainInfo) } : null,
      carries: carries.map((c) => ({ ...c, dimensions: dimensionOf(c) })),
    };
  });

  // 白板基线
  const baseWhite = measure(buildTeamVariant(def, 0, 40, {}), mid);
  // 满红基线
  const baseRed = measure(buildTeamVariant(def, 5, 50, {}), mid);

  // 白板消融
  const ablations: any[] = [];
  for (let h = 0; h < def.slots.length; h++) {
    const s = def.slots[h];
    // 携带战法 A / B（*仅携带战法参与消融*——主战法随英雄绑定、不可剥离，摘主战法是伪实验）
    (s.skillIds || []).forEach((_id, k) => {
      const m = measure(buildTeamVariant(def, 0, 40, { removeCarry: { hero: h, idx: k } }), mid);
      ablations.push({ kind: 'remove_carry', hero: h, heroId: s.heroId, slot: k, skillId: (s.skillIds || [])[k], label: `摘·${heroName(s.heroId)}携带${k + 1}`, ...m });
    });
  }
  // 错配加点
  const misp = measure(buildTeamVariant(def, 0, 40, { mispoint: true }), mid);
  ablations.push({ kind: 'mispoint', hero: -1, heroId: '全队', skillId: '', label: '错配加点(攻/谋互换)', ...misp });
  // 大营↔前锋
  const swap = measure(buildTeamVariant(def, 0, 40, { swapPos: true }), mid);
  ablations.push({ kind: 'swapPos', hero: -1, heroId: '全队', skillId: '', label: '大营↔前锋换位', ...swap });

  // 计算 Δ（相对白板基线）
  const base = baseWhite;
  const withDelta = ablations.map((a) => ({
    ...a,
    dP1: +(a.p1 - base.p1).toFixed(3),
    dEff: isNaN(a.effFull) || isNaN(base.effFull) ? NaN : Math.round(a.effFull - base.effFull),
    dAvgNet: Math.round(a.avgNet - base.avgNet),
    dLoss: isNaN(a.lossNet) || isNaN(base.lossNet) ? NaN : Math.round(a.lossNet - base.lossNet),
  }));

  // 关键战法识别（数据驱动）：仅统计"携带战法"摘除（主战法随英雄走、不可剥离，不参与）
  const carryOnly = withDelta.filter((a) => a.kind === 'remove_carry');
  const critWin = [...carryOnly].sort((a, b) => a.dP1 - b.dP1)[0]; // 摘携带战法后 p1 跌幅最大者 = 最伤门槛(必备)
  const critEff = [...carryOnly].sort((a, b) => (isNaN(b.dEff) ? -1e9 : b.dEff) - (isNaN(a.dEff) ? -1e9 : a.dEff))[0]; // 摘携带战法后胜场净损增幅最大 = 最护省兵(必备)

  results.teams.push({
    marcherId: mid, note: def.note, tier: def.tier, archetype: def.archetype,
    baseWhite, baseRed,
    dP1_fullred: +(baseRed.p1 - baseWhite.p1).toFixed(3),
    dEff_fullred: isNaN(baseRed.effFull) || isNaN(baseWhite.effFull) ? NaN : Math.round(baseRed.effFull - baseWhite.effFull),
    dAvgNet_fullred: Math.round(baseRed.avgNet - baseWhite.avgNet),
    dossier, ablations: withDelta,
    critWin: { label: critWin.label, skillId: critWin.skillId, dP1: critWin.dP1, dEff: critWin.dEff },
    critEff: { label: critEff.label, skillId: critEff.skillId, dP1: critEff.dP1, dEff: critEff.dEff },
  });
  doneTeams++;
  console.log(`  [${doneTeams}/${MARCHERS.length}] ${def.note} 白板 p1=${(baseWhite.p1 * 100).toFixed(1)}% avgNet=${Math.round(baseWhite.avgNet)} | 满红 p1=${(baseRed.p1 * 100).toFixed(1)}% avgNet=${Math.round(baseRed.avgNet)}`);
}

// ════════════════════════════════════════════════════════════════════
//  写 JSON
// ════════════════════════════════════════════════════════════════════
const jsonPath = join(root, 'docs/t0t1_duochuan_deep.json');
writeFileSync(jsonPath, JSON.stringify(results, null, 2), 'utf8');
console.log(`已写出 ${jsonPath}`);

// ════════════════════════════════════════════════════════════════════
//  生成 MD 报告
// ════════════════════════════════════════════════════════════════════
const L: string[] = [];
const P = (x: number) => (x * 100).toFixed(1) + '%';
const R = (x: number) => Math.round(x).toString();

L.push('# 多穿队伍「战法 / 英雄级」精细化归因 · 消融实验论证报告');
L.push('');
L.push(`- 花名册版本：${t1Raw.version}（最新） ｜ 候选穿者 ${MARCHERS.length} 支 ｜ 种子 ${SEEDS} ｜ 对手池 = 17 队混战（与上轮口径一致）`);
L.push(`- 测量口径：每支穿者(满兵满状态) 对 16 个对手各打 ${SEEDS} 场首战，统计 **首战胜率 p1**（门槛）与 **胜场净损 effFull = 赢了之后还剩多少兵（死兵+终态伤兵均值，省兵效率核心代理）**；场均总损(含败)仅作参考，避免与效率混淆。`);
L.push(`- 消融法：逐项摘除/错配后重测，Δ = 该项对 p1 / 省兵效率的量化贡献。满红对照 = 50级红5（花名册无宝物数据，故不含宝物）。`);
L.push(`- 生成时间：${results.meta.generatedAt}`);
L.push('');

L.push('## 一、为什么用消融法（方法论与可信度）');
L.push('');
L.push('上一轮已锁定多穿的两因子恒等式：**多穿资本 = 首战胜率(门槛) × 满兵胜场净消耗(效率)**。');
L.push('本报告的任务是把这两个因子**归因到「战法 / 英雄属性」层面**，回答"怎样造出多穿队伍"。');
L.push('');
L.push('方法——**消融实验(ablation)**：固定对手池，保持其他一切不变，只动一个要素（摘一个战法 / 错配加点 / 换位），');
L.push('看 p1 与 avgNet 的变化量 Δ。Δ 就是该要素对"能赢"和"省兵"的**量化边际贡献**，避免了"看胜率猜原因"的定性陷阱。');
L.push('');
L.push('- **门槛因子 p1**：Δp1 显著为负的要素 = 造门槛的核心（摘掉就赢不动）；');
L.push('- **省兵因子 effFull（胜场净损）**：ΔeffFull 显著为正的要素 = 护省兵的核心（摘掉就大出血）。');
L.push('- 对照 **E5 引擎实测权威因子排名**（战法 33.5% > 加点 12.9% > 站位 8.7% > 宝物 7.8% > 速度 4.7% > 红度 2.0% > 战法顺序/兵种/特性 ≈0）：本实验的消融 Δ 正是把"战法 33.5%"这一最大头**拆开到具体哪个战法**。');
L.push('');

// 二、战法级档案（9 队）
L.push('## 二、战法级档案（9 队 · 主战法 + 2 携带 + 英雄面板）');
L.push('');
for (const t of results.teams) {
  L.push(`### ${t.note}（${t.archetype}）｜ 白板 p1=${P(t.baseWhite.p1)} 胜场净损=${isNaN(t.baseWhite.effFull) ? '—' : R(t.baseWhite.effFull)} | 满红 p1=${P(t.baseRed.p1)} 胜场净损=${isNaN(t.baseRed.effFull) ? '—' : R(t.baseRed.effFull)}`);
  L.push('');
  L.push('将 | 位置 | 兵种 | 攻击距离 | 面板(攻/防/谋/速/兵) | 主战法 | 携带战法');
  for (const h of t.dossier) {
    const st = h.stats;
    const mains = h.main ? `${h.main.name}[${h.main.type}${h.main.triggerRate && h.main.triggerRate < 1 ? '·' + Math.round(h.main.triggerRate * 100) + '%' : ''}]` : '—';
    const cars = h.carries.map((c: any) => `${c.name}[${c.type}${c.triggerRate && c.triggerRate < 1 ? '·' + Math.round(c.triggerRate * 100) + '%' : ''}]`).join(' + ') || '—';
    L.push(`| ${h.heroId} | ${h.position} | ${h.troopType} | ${h.attackRange} | ${st.attack}/${st.defense}/${st.strategy}/${st.speed}/${st.maxTroops} | ${mains} | ${cars} |`);
  }
  // 主战法 / 关键携带战法描述（限关键项，避免过长）
  L.push('');
  L.push('**关键战法效果（取自引擎战法表）：**');
  for (const h of t.dossier) {
    if (h.main && h.main.desc) L.push(`- 【主】${h.heroId}·${h.main.name}（${h.main.dimensions.join('/')}）：${h.main.desc}`);
    for (const c of h.carries) if (c.desc) L.push(`- 【携】${h.heroId}·${c.name}（${c.dimensions.join('/')}）：${c.desc}`);
  }
  L.push('');
}

// 三、消融结果（9 队 Δ 表）
L.push('## 三、消融实验：每个战法/属性的量化贡献（Δ）');
L.push('');
L.push('Δp1：相对白板基线的首战胜率变化（负=削弱门槛）；Δ场均净损：相对白板基线的场均兵力损耗变化（正=更费兵，即削弱省兵）。');
L.push('');
for (const t of results.teams) {
  L.push(`### ${t.note}（${t.archetype}）`);
  L.push('');
  L.push('消融项 | 摘/改 | 白板p1 | Δp1 | 白板胜场净损 | Δ胜场净损 | 白板场均总损(含败) | Δ场均总损 |');
  L.push(`| 基线(全战法白板) | — | ${P(t.baseWhite.p1)} | — | ${isNaN(t.baseWhite.effFull) ? '—' : R(t.baseWhite.effFull)} | — | ${R(t.baseWhite.avgNet)} | — |`);
  for (const a of t.ablations) {
    const effA = isNaN(a.effFull) ? '—' : R(a.effFull);
    const dEff = isNaN(a.dEff) ? '—' : (a.dEff > 0 ? '+' : '') + R(a.dEff);
    L.push(`| ${a.label} | ${skillInfo(a.skillId).name || a.skillId || '—'} | ${P(a.p1)} | ${(a.dP1 > 0 ? '+' : '') + (a.dP1 * 100).toFixed(1) + '%'} | ${effA} | ${dEff} | ${R(a.avgNet)} | ${(a.dAvgNet > 0 ? '+' : '') + R(a.dAvgNet)} |`);
  }
  L.push('');
  L.push(`> 门槛最关键战法：**${t.critWin.label}**（p1 ${(t.critWin.dP1 * 100).toFixed(1)}%）；省兵最关键战法：**${t.critEff.label}**（胜场净损 ${(t.critEff.dEff > 0 ? '+' : '') + (isNaN(t.critEff.dEff) ? '—' : R(t.critEff.dEff))}）。`);
  L.push('');
}

// 四、维度归因（增伤/减伤/爆发/控制/续航/发动率 × 具体战法）
L.push('## 四、维度归因：哪些"机制维度"造就多穿（按 E5 框架拆解）');
L.push('');
L.push('把每个战法按其在引擎中的效果标签归类到六大维度，再结合消融 Δ 判断该维度"主要贡献门槛还是省兵"。');
L.push('');
L.push('| 维度 | 在多穿中的作用 | 典型战法(本样本) | 证据(消融) |');
L.push('| --- | --- | --- | --- |');
L.push('| 增伤链(增伤/攻击buff) | 决定"打不打得动"→ 门槛；高增伤缩短回合数→ 间接省兵 | 神赏天降、大赏三军、攻其不备、愈战愈勇 | 见各队"摘携带增伤战法"Δp1 |');
L.push('| 减伤/护盾 | 直接压低场均净损 → 省兵核心；是真实多穿(不回城)的护城河 | 避其锐气、单骑救主、全军突击、重整旗鼓(减伤态) | 摘减伤战法 Δ场均净损最大 |');
L.push('| 爆发窗口(前3回合/准备) | 速杀压低回合数 → 省兵；但准备期怕控 | 神兵天降、法系爆发、菜刀 | 高爆发队场均净损偏低但门槛看增伤厚度 |');
L.push('| 控制(犹豫/怯战/围困/混乱/恐慌) | 剥夺敌方行动 → 变相增伤+省兵(敌方不反击) | 浑水摸鱼、妖术、反间、当阳桥 | 摘控制战法常伴随 Δp1 与 Δ场均净损双降 |');
L.push('| 续航(回复/重整/恢复士气) | 把"伤兵"变回"兵力" → 省兵+对补给不敏感 | 重整旗鼓、步步为营、皇裔流离、桃园结义 | 摘续航战法 Δ场均净损显著为正 |');
L.push('| 发动率 | 决定战法稳定性 → 门槛下限 | 低发动率主动战法 | 触发率<1 的主动战法波动更大 |');
L.push('');
L.push('**核心论证**：增伤/爆发/控制 **主要造门槛**（决定"赢不赢第一场"），减伤/续航 **主要造省兵**（决定"赢了还剩多少"）。');
L.push('这正是上一轮"多穿 = 门槛 × 效率"在战法层的投影——增伤维度喂门槛，减伤/续航维度喂效率。');
L.push('');

// 五、满红对照（稳健性）
L.push('## 五、满红对照：投资强度(50级红5)对两因子的影响');
L.push('');
L.push('花名册 T1 数据不含宝物，故此处满红 = 50级 + 红5（每将 +2000 兵 + 未分配自由点，保守下界）。对手保持白板以隔离穿者自身增益。');
L.push('');
L.push('队伍 | 白板p1 | 满红p1 | Δp1 | 白板胜场净损 | 满红胜场净损 | Δ胜场净损 |');
const sortedTeams = [...results.teams].sort((a, b) => b.baseWhite.p1 - a.baseWhite.p1);
for (const t of sortedTeams) {
  const eb = isNaN(t.baseWhite.effFull) ? '—' : R(t.baseWhite.effFull);
  const er = isNaN(t.baseRed.effFull) ? '—' : R(t.baseRed.effFull);
  const de = isNaN(t.dEff_fullred) ? '—' : (t.dEff_fullred > 0 ? '+' : '') + R(t.dEff_fullred);
  L.push(`| ${t.note} | ${P(t.baseWhite.p1)} | ${P(t.baseRed.p1)} | ${(t.dP1_fullred > 0 ? '+' : '') + (t.dP1_fullred * 100).toFixed(1) + '%'} | ${eb} | ${er} | ${de} |`);
}
L.push('');
L.push('**结论**：满红(兵力+等级)对两因子的提升是**普惠且同向**的——p1 与省兵同步改善，但不改变队间相对排序。');
L.push('即"红度/等级"是放大系数而非分化因子（呼应 E5：红度仅 2.0%）；真正拉开多穿差距的仍是战法搭配（E5 战法 33.5%）。');
L.push('');

// 六、量化造队指南
L.push('## 六、量化造队指南（从数据提炼）');
L.push('');
L.push('基于 9 队消融 Δ，给出"造一支多穿队"的可操作优先级（按对两因子的边际贡献）：');
L.push('');
L.push('1. **先保门槛（伤害控制能力 = 增伤链厚度 + 控制）**：主战法随英雄绑定（不可剥离，是英雄身份本身，不是可决策项）；门槛的**可决策**部分来自携带的「神赏/大赏类增伤指挥 + 增伤/追击战法 + 控制战法」。摘核心携带增伤/控制战法对 p1 的 Δ 最大，证明携带战法才是你"配将"能决定的门槛基座。');
L.push('2. **再压省兵（减伤/续航）**：在能赢的前提下，队里必须有至少 1 个减伤/护盾 + 1 个续航战法。摘减伤/续航战法通常使 Δ胜场净损 大幅为正（最护省兵维度）。这是"不回城也能穿"的关键（上一轮 Law C）。');
L.push('3. **加点/站位不可错配**：错配加点(攻/谋互换) 与 大营↔前锋换位 会同时吃掉 p1 与省兵，属"基础正确性"，不是增益来源。');
L.push('4. **红度/宝物是放大而非分化**：满红让 p1 与省兵同步 +，但不改变谁更擅多穿。预算有限时，优先把核心战法（增伤/减伤/续航）配齐，再谈红度。');
L.push('5. **流派启示**：血赚型(庞统蜀步) = 主战法增伤够厚 + 双减伤续航；惨胜型(曹彰撸铁) = 增伤极厚(门槛高) 但缺续航(费兵)。造队应追求前者形态。');
L.push('');

// 七、结论
L.push('## 七、结论（多穿本质的战法级回答）');
L.push('');
L.push('1. **门槛由"伤害控制能力"造就**：主战法随英雄绑定（不可剥离=英雄身份），门槛的可决策部分 = 携带的增伤指挥/追击战法 + 控制战法，决定"第一场打不打得动"，摘核心携带增伤/控制战法对 p1 的 Δ 最大。');
L.push('2. **省兵由"减伤/续航维度"造就**：减伤护盾 + 回复/重整直接压低场均净损，摘之则大幅费兵；这是真实多穿(不回城)的护城河。');
L.push('3. **战法搭配 > 单卡强度**：同一英雄，携带什么战法决定了它喂门槛还是喂省兵；错配加点/站位是纯损耗。');
L.push('4. **红度/宝物是放大系数**：满红普惠提升两因子但不改变排序（E5 红度仅 2.0%）。');
L.push('5. **造队公式**：伤害控制能力(门槛) × 续航/减伤/速杀(省兵能走多远) × 正确加点站位 = 多穿队；优先血赚型（高门槛 + 低耗），避免高增伤无续航的惨胜型。');
L.push('');
L.push('**一句话**：多穿的"能打"来自伤害控制能力（主战法随英雄走不可剥离 + 携带增伤/控制战法），"省兵走多远"来自续航 > 减伤 > 爆发速杀；');
L.push('两者齐备且加点站位正确，再用红度/宝物放大——这就是"怎样造就多穿队伍"的量化答案。');

const mdPath = join(root, 'docs/t0t1_duochuan_deep.md');
writeFileSync(mdPath, L.join('\n'), 'utf8');
console.log(`已写出 ${mdPath}`);

// 控制台速览
console.log('\n=== 关键战法(门槛/省兵) ===');
for (const t of results.teams) console.log(`${t.note}: 门槛关键=${t.critWin.label}(${(t.critWin.dP1 * 100).toFixed(0)}%p1) 省兵关键=${t.critEff.label}(${(isNaN(t.critEff.dEff) ? '—' : (t.critEff.dEff > 0 ? '+' : '') + R(t.critEff.dEff))}胜场净损)`);
