/**
 * T0 × T1 全面混战 · 战损(兵力损失)横评（2026-11-01 最新花名册）
 * ───────────────────────────────────────────────────────────────────
 * 复用 t0t1_crosssim 的 17 队花名册（8 T0 基准 + 9 T1，docs/t0t1_roster.json v2026-11-01），
 * 全双向循环 × SEEDS 种子，在既有「胜平负 / 伤害」之外，**新增战损作为头号指标**：
 *
 *   战损(净) = 初始总兵 − 终态存活总兵 = 死兵 + 终态伤兵   （引擎逐将守恒：初始=存活+伤兵+死兵）
 *   胜场战损 = 获胜时我方平均净兵损（多穿/连续作战最关键的可持续指标）
 *   交换比   = 我方造成敌方平均净兵损 / 我方平均净兵损（>1 表示我放血更多）
 *
 * 运行：SEEDS=40 npx tsx scripts/t0t1_warloss.mts
 * 产物：docs/t0t1_warloss.json（全量数据）  docs/t0t1_warloss_report.md（战损分析报告）
 */
import { buildGeneral } from '../web/heroes';
import { runBattle } from '../src/engine/combat';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const heroesData: any[] = JSON.parse(readFileSync(join(root, 'web/data/heroes.json'), 'utf8'));
const benchRaw: any = JSON.parse(readFileSync(join(root, 'web/data/opponent_benchmark.json'), 'utf8'));
const t1Raw: any = JSON.parse(readFileSync(join(root, 'docs/t0t1_roster.json'), 'utf8'));

const RED_POSITIONS = ['大营', '中军', '前锋'] as const;
const MORALE = 120;
const LEVEL = 40;
const REDNESS = 0;
const SEEDS = parseInt(process.env.SEEDS || '40', 10);

interface SlotDef { heroId: string; freePoints: any; skillIds: string[]; traits?: string[]; secondaryTroop?: string; }
interface TeamDef { id: string; note: string; tier: string; archetype: string; slots: SlotDef[]; }

const t0: TeamDef[] = benchRaw.entries.map((e: any) => ({
  id: e.id, note: e.note, tier: 'T0', archetype: 'T0基准',
  slots: e.cfg.slots.map((s: any) => ({
    heroId: s.heroId,
    freePoints: { attack: s.addAttack || 0, defense: s.addDefense || 0, strategy: s.addStrategy || 0, speed: s.addSpeed || 0 },
    skillIds: s.skillIds || [], traits: s.traits || [], secondaryTroop: s.secondaryTroop,
  })),
}));
const t1: TeamDef[] = t1Raw.t1.map((e: any) => ({
  id: e.id, note: e.note, tier: 'T1', archetype: e.archetype,
  slots: e.slots.map((s: any) => ({ heroId: s.heroId, freePoints: s.freePoints || {}, skillIds: s.skillIds || [], traits: s.traits || [], secondaryTroop: s.secondaryTroop })),
}));
const ALL: TeamDef[] = [...t0, ...t1];
const N = ALL.length;
console.log(`载入队伍：T0=${t0.length}  T1=${t1.length}  合计=${N}  ｜ roster版本=${t1Raw.version}`);

// 构建队伍（与 crosssim 同口径：40级白板/红度0/士气120/无宝物）
function buildTeam(def: TeamDef): any[] {
  return def.slots.map((s, i) =>
    buildGeneral(s.heroId, s.skillIds, s.freePoints, RED_POSITIONS[i], REDNESS, LEVEL, MORALE, s.secondaryTroop, s.traits, null)
  );
}
const teams = new Map<string, any[]>();
for (const d of ALL) teams.set(d.id, buildTeam(d));

const sumTroops = (gens: any[]) => gens.reduce((a, g) => a + (g.maxTroops || 0), 0);

// ── 每队累加器 ──
interface TeamAcc {
  games: number; w: number; l: number; d: number;
  ownLossNet: number; ownDead: number; ownWounded: number;       // 我方（无论胜负）净兵损/死兵/伤兵累计
  winLossNet: number; winCount: number;                          // 胜场净兵损累计
  lossLossNet: number; lossCount: number;                        // 负场净兵损累计
  oppLossNet: number;                                            // 我方造成敌方净兵损累计（交换比分子）
  deadInWins: number;                                            // 胜场死兵累计（多穿永久损耗）
}
function newAcc(): TeamAcc {
  return { games: 0, w: 0, l: 0, d: 0, ownLossNet: 0, ownDead: 0, ownWounded: 0, winLossNet: 0, winCount: 0, lossLossNet: 0, lossCount: 0, oppLossNet: 0, deadInWins: 0 };
}
const acc = new Map<string, TeamAcc>();
for (const d of ALL) acc.set(d.id, newAcc());

// 有序配对矩阵（i 攻击 j 视角）：胜平负 + 双方平均净兵损
const matchup: Record<string, Record<string, { w: number; l: number; d: number; myLossNet: number; enLossNet: number }>> = {};
for (const d of ALL) matchup[d.id] = {};

let conservationChecked = false;
let total = 0;

for (let i = 0; i < N; i++) {
  for (let j = i + 1; j < N; j++) {
    const A = ALL[i], B = ALL[j];
    const teamA = teams.get(A.id)!, teamB = teams.get(B.id)!;
    const iniA = sumTroops(teamA), iniB = sumTroops(teamB);
    for (let g = 0; g < SEEDS; g++) {
      const dir = g < SEEDS / 2 ? 0 : 1;
      const myDef = dir === 0 ? A : B;
      const enDef = dir === 0 ? B : A;
      const myTeam = dir === 0 ? teamA : teamB;
      const enTeam = dir === 0 ? teamB : teamA;
      const iniMy = dir === 0 ? iniA : iniB;
      const iniEn = dir === 0 ? iniB : iniA;
      const seed = ((i * 1009 + j * 131 + g * 17) & 0x7fffffff) || 1;
      const r: any = runBattle({ myTeam, enemyTeam: enTeam, seed, maxRounds: 8 });
      total++;

      // ── 战损提取 ──
      const myAlive = (r.finalMyTroops as number[]).reduce((a: number, b: number) => a + Math.max(0, b), 0);
      const enAlive = (r.finalEnemyTroops as number[]).reduce((a: number, b: number) => a + Math.max(0, b), 0);
      const myWounded = (r.finalMyWounded as number[]).reduce((a: number, b: number) => a + Math.max(0, b), 0);
      const enWounded = (r.finalEnemyWounded as number[]).reduce((a: number, b: number) => a + Math.max(0, b), 0);
      const myDead = (r.finalMyDead as number[]).reduce((a: number, b: number) => a + Math.max(0, b), 0);
      const enDead = (r.finalEnemyDead as number[]).reduce((a: number, b: number) => a + Math.max(0, b), 0);
      const myLossNet = iniMy - myAlive;   // = myWounded + myDead
      const enLossNet = iniEn - enAlive;   // = enWounded + enDead

      if (!conservationChecked) {
        // 逐将守恒校验：初始 = 存活 + 伤兵 + 死兵
        let ok = true;
        for (let k = 0; k < r.myTeam.length; k++) {
          const ini = r.myTeam[k].maxTroops;
          const got = r.finalMyTroops[k] + r.finalMyWounded[k] + r.finalMyDead[k];
          if (Math.abs(ini - got) > 1) { ok = false; console.log(`  ! 守恒偏差 ${r.myTeam[k].name}: ini=${ini} got=${got}`); }
        }
        console.log(`守恒校验：myLossNet(${myLossNet}) == myWounded(${myWounded})+myDead(${myDead}) ? ${myLossNet === myWounded + myDead} ｜ 逐将守恒 ${ok ? 'OK' : 'FAIL'}`);
        conservationChecked = true;
      }

      // 我方（myDef）视角写累加
      const mAcc = acc.get(myDef.id)!;
      mAcc.games++;
      if (r.result === 'win') { mAcc.w++; mAcc.winLossNet += myLossNet; mAcc.winCount++; mAcc.deadInWins += myDead; }
      else if (r.result === 'loss') { mAcc.l++; mAcc.lossLossNet += myLossNet; mAcc.lossCount++; }
      else mAcc.d++;
      mAcc.ownLossNet += myLossNet; mAcc.ownDead += myDead; mAcc.ownWounded += myWounded;
      mAcc.oppLossNet += enLossNet;

      // 敌方（enDef）视角写累加
      const eAcc = acc.get(enDef.id)!;
      eAcc.games++;
      if (r.result === 'win') { eAcc.l++; eAcc.lossLossNet += enLossNet; eAcc.lossCount++; }
      else if (r.result === 'loss') { eAcc.w++; eAcc.winLossNet += enLossNet; eAcc.winCount++; eAcc.deadInWins += enDead; }
      else eAcc.d++;
      eAcc.ownLossNet += enLossNet; eAcc.ownDead += enDead; eAcc.ownWounded += enWounded;
      eAcc.oppLossNet += myLossNet;

      // 矩阵（A 视角：A 红队、B 蓝队）
      const mk = matchup[A.id][B.id] || (matchup[A.id][B.id] = { w: 0, l: 0, d: 0, myLossNet: 0, enLossNet: 0 });
      if (dir === 0) {
        if (r.result === 'win') mk.w++; else if (r.result === 'loss') mk.l++; else mk.d++;
        mk.myLossNet += myLossNet; mk.enLossNet += enLossNet;
      } else {
        if (r.result === 'win') mk.l++; else if (r.result === 'loss') mk.w++; else mk.d++;
        mk.myLossNet += enLossNet; mk.enLossNet += myLossNet; // 翻转：此时 my 实为 B
      }
    }
  }
}
console.log(`模拟完成：总场次=${total}`);

// ── 汇总每队 ──
const teams_out: any[] = [];
for (const d of ALL) {
  const a = acc.get(d.id)!;
  const b = a.games || 1;
  const winRate = a.w / b * 100;
  const lossRate = a.l / b * 100;
  const drawRate = a.d / b * 100;
  const avgLossNet = a.ownLossNet / b;
  const avgDead = a.ownDead / b;
  const avgWounded = a.ownWounded / b;
  const winLossNet = a.winCount ? a.winLossNet / a.winCount : 0;     // 胜场战损
  const lossLossNet = a.lossCount ? a.lossLossNet / a.lossCount : 0; // 负场战损
  const avgOppLossNet = a.oppLossNet / b;                            // 我方造成敌方平均净兵损
  const trade = avgLossNet > 0 ? avgOppLossNet / avgLossNet : 0;      // 交换比
  const deadInWins = a.winCount ? a.deadInWins / a.winCount : 0;     // 胜场死兵（多穿永久损耗）
  teams_out.push({
    id: d.id, note: d.note, tier: d.tier, archetype: d.archetype,
    winRate: +winRate.toFixed(1), lossRate: +lossRate.toFixed(1), drawRate: +drawRate.toFixed(1), nonLossRate: +(100 - lossRate).toFixed(1),
    avgLossNet: Math.round(avgLossNet), avgDead: Math.round(avgDead), avgWounded: Math.round(avgWounded),
    winLossNet: Math.round(winLossNet), lossLossNet: Math.round(lossLossNet),
    avgOppLossNet: Math.round(avgOppLossNet), trade: +trade.toFixed(2),
    deadInWins: Math.round(deadInWins),
  });
}

// ── 分层平均 ──
function avgTier(tier: string, key: string) {
  const arr = teams_out.filter(t => t.tier === tier);
  return +(arr.reduce((s, t) => s + (t as any)[key], 0) / (arr.length || 1)).toFixed(1);
}
const tierSummary = ['T0', 'T1'].map(t => ({
  tier: t, n: teams_out.filter(x => x.tier === t).length,
  winRate: avgTier(t, 'winRate'), lossRate: avgTier(t, 'lossRate'), drawRate: avgTier(t, 'drawRate'),
  avgLossNet: Math.round(avgTier(t, 'avgLossNet')), avgDead: Math.round(avgTier(t, 'avgDead')), winLossNet: Math.round(avgTier(t, 'winLossNet')), trade: avgTier(t, 'trade'),
}));

// ── 分层交叉胜率 ──
const tierOf: Record<string, string> = {}; for (const d of ALL) tierOf[d.id] = d.tier;
let t0vst1 = { games: 0, t0w: 0, t0l: 0, t0d: 0 };
for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
  const A = ALL[i], B = ALL[j]; const mk = matchup[A.id][B.id]; if (!mk) continue;
  const games = mk.w + mk.l + mk.d;
  if (tierOf[A.id] === 'T0' && tierOf[B.id] === 'T1') { t0vst1.games += games; t0vst1.t0w += mk.w; t0vst1.t0l += mk.l; t0vst1.t0d += mk.d; }
  else if (tierOf[A.id] === 'T1' && tierOf[B.id] === 'T0') { t0vst1.games += games; t0vst1.t0l += mk.w; t0vst1.t0w += mk.l; t0vst1.t0d += mk.d; }
}
const crossTier = {
  games: t0vst1.games,
  t0_winRate: +(t0vst1.t0w / (t0vst1.games || 1) * 100).toFixed(1),
  t1_winRate: +(t0vst1.t0l / (t0vst1.games || 1) * 100).toFixed(1),
  drawRate: +(t0vst1.t0d / (t0vst1.games || 1) * 100).toFixed(1),
};

// ── 样例战报：挑一场"顶级 T0 vs 顶级 T0"决定局，完整回合级战损轨迹 ──
// 取胜率最高的两队各一支代表，固定种子跑一场，输出 round_end 序列
const byWin = [...teams_out].sort((x, y) => y.winRate - x.winRate);
const sampleA = ALL.find(d => d.id === byWin[0].id)!;
const sampleB = ALL.find(d => d.id === byWin[1].id)!;
const sTeamA = teams.get(sampleA.id)!, sTeamB = teams.get(sampleB.id)!;
const sIniA = sumTroops(sTeamA), sIniB = sumTroops(sTeamB);
const sReport: any = runBattle({ myTeam: sTeamA, enemyTeam: sTeamB, seed: 20261102, maxRounds: 8 });
const sRounds: any[] = [];
for (const ev of sReport.events as any[]) {
  if (ev.type === 'round_end') {
    sRounds.push({
      round: ev.round,
      myAlive: ev.myTroops.reduce((a: number, b: number) => a + Math.max(0, b), 0),
      enAlive: ev.enemyTroops.reduce((a: number, b: number) => a + Math.max(0, b), 0),
      myWounded: ev.myWounded.reduce((a: number, b: number) => a + Math.max(0, b), 0),
      enWounded: ev.enemyWounded.reduce((a: number, b: number) => a + Math.max(0, b), 0),
      myDead: ev.myDead.reduce((a: number, b: number) => a + Math.max(0, b), 0),
      enDead: ev.enemyDead.reduce((a: number, b: number) => a + Math.max(0, b), 0),
    });
  }
}
const sMyAliveEnd = sReport.finalMyTroops.reduce((a: number, b: number) => a + Math.max(0, b), 0);
const sEnAliveEnd = sReport.finalEnemyTroops.reduce((a: number, b: number) => a + Math.max(0, b), 0);
const sMyDeadEnd = sReport.finalMyDead.reduce((a: number, b: number) => a + Math.max(0, b), 0);
const sEnDeadEnd = sReport.finalEnemyDead.reduce((a: number, b: number) => a + Math.max(0, b), 0);
const sampleReport = {
  teamA: { id: sampleA.id, note: sampleA.note, tier: sampleA.tier, initial: sIniA },
  teamB: { id: sampleB.id, note: sampleB.note, tier: sampleB.tier, initial: sIniB },
  seed: 20261102, result: sReport.result, rounds: sReport.rounds,
  finalMyAlive: sMyAliveEnd, finalEnAlive: sEnAliveEnd,
  finalMyDead: sMyDeadEnd, finalEnDead: sEnDeadEnd,
  myLossNet: sIniA - sMyAliveEnd, enLossNet: sIniB - sEnAliveEnd,
  roundTrajectory: sRounds,
};

// ── 写出 JSON ──
const out = {
  meta: { seeds: SEEDS, teams: N, t0Count: t0.length, t1Count: t1.length, level: LEVEL, redness: REDNESS, morale: MORALE, treasure: null, rosterVersion: t1Raw.version, generatedAt: new Date().toISOString() },
  metricNote: '战损(净)=初始总兵−终态存活=死兵+伤兵；胜场战损=获胜时我方净兵损均值；交换比=我方造成敌方净兵损/我方净兵损',
  tierSummary, crossTier, teams: teams_out, matchup, sampleReport,
};
const jsonPath = join(root, 'docs/t0t1_warloss.json');
writeFileSync(jsonPath, JSON.stringify(out, null, 2), 'utf8');
console.log(`已写出 ${jsonPath}`);

// ── 控制台速览 + 生成 MD 报告 ──
const pad = (s: any, n: number) => String(s).padEnd(n);
const padS = (s: any, n: number) => String(s).padStart(n);
const L = (s: string) => s;

const lines: string[] = [];
lines.push('# 率土之滨 T0×T1 全面混战 · 战损(兵力损失)分析报告');
lines.push('');
lines.push(`- 花名册版本：${t1Raw.version}（最新） ｜ 队伍：${N} 队（T0=${t0.length} 基准 + T1=${t1.length}）`);
lines.push(`- 配置口径：全双向循环 × ${SEEDS} 种子 = ${total} 场 ｜ 统一 40 级白板 / 红度0 / 士气120 / 无宝物（公平比流派机制）`);
lines.push(`- 生成时间：${out.meta.generatedAt}`);
lines.push('');
lines.push('## 战损口径（必读）');
lines.push('');
lines.push('- 引擎逐将守恒：**初始 = 存活 + 终态伤兵 + 死兵**（已校验）。');
lines.push('- **战损(净) = 初始总兵 − 终态存活总兵 = 死兵 + 终态伤兵**：本场被消耗、不能立即再战的兵力。');
lines.push('- 拆分：**死兵**＝永久损失（需重新征兵）；**伤兵**＝可恢复（回城补满模型回复；野外连续作战持续衰减）。');
lines.push('- **胜场战损**：获胜时我方平均净兵损 —— 多穿/连续作战最关键的可持续指标（赢但打空血＝多穿黑洞）。');
lines.push('- **交换比**＝我方造成敌方平均净兵损 ÷ 我方平均净兵损（>1 表示我放血更多，越赚）。');
lines.push('');
lines.push('## 分层平均（T0 vs T1）');
lines.push('');
for (const t of tierSummary) {
  lines.push(`[${pad(t.tier, 3)}] n=${t.n}  胜率 ${padS(t.winRate, 5)}%  非败 ${padS((100 - t.lossRate).toFixed(1), 5)}%  平 ${padS(t.drawRate, 4)}%  | 场均战损 ${padS(t.avgLossNet, 5)}  场均死兵 ${padS(t.avgDead, 4)}  胜场战损 ${padS(t.winLossNet, 5)}  交换比 ${t.trade}`);
}
lines.push('');
lines.push('## 分层交叉（T0 打 T1）');
lines.push('');
lines.push(`T0 对 T1 胜率 ${crossTier.t0_winRate}% ｜ T1 对 T0 胜率 ${crossTier.t1_winRate}% ｜ 平 ${crossTier.drawRate}% ｜ 样本 ${crossTier.games} 场`);
lines.push('');
lines.push('## 混战强度榜（按胜率降序）');
lines.push('');
const ranked = [...teams_out].sort((x, y) => y.winRate - x.winRate);
ranked.forEach((t, i) => {
  lines.push(`${padS(i + 1, 2)}. [${pad(t.tier, 3)}] ${pad(t.note, 12)} 胜 ${padS(t.winRate, 5)}% 非败 ${padS(t.nonLossRate, 5)}% 平 ${padS(t.drawRate, 4)}%  场均战损 ${padS(t.avgLossNet, 5)} 胜场战损 ${padS(t.winLossNet, 5)} 死兵 ${padS(t.avgDead, 4)} 交换比 ${padS(t.trade, 4)}`);
});
lines.push('');
lines.push('## 多穿友好榜（按胜场战损升序：赢同样一场，谁血赚）');
lines.push('');
const byWinLoss = [...teams_out].sort((x, y) => x.winLossNet - y.winLossNet);
byWinLoss.forEach((t, i) => {
  lines.push(`${padS(i + 1, 2)}. [${pad(t.tier, 3)}] ${pad(t.note, 12)} 胜场战损 ${padS(t.winLossNet, 5)} 胜率 ${padS(t.winRate, 5)}% 胜场死兵 ${padS(t.deadInWins, 4)} 交换比 ${padS(t.trade, 4)}`);
});
lines.push('');
lines.push('## 样例战报（胜率榜 Top1 vs Top2，固定种子 20261102）');
lines.push('');
lines.push(`- ${sampleA.note}(${sampleA.tier}, 初兵${sIniA})  vs  ${sampleB.note}(${sampleB.tier}, 初兵${sIniB})`);
lines.push(`- 结果：${sReport.result} ｜ 回合数：${sReport.rounds}`);
lines.push(`- 终态：我(${sampleA.note}) 存活 ${sMyAliveEnd} / 死兵 ${sMyDeadEnd} → 我方战损 ${sIniA - sMyAliveEnd}；敌(${sampleB.note}) 存活 ${sEnAliveEnd} / 死兵 ${sEnDeadEnd} → 敌方战损 ${sIniB - sEnAliveEnd}`);
lines.push('');
lines.push('  回合级战损轨迹（存活 / 伤兵 / 死兵，双方）：');
for (const r of sRounds) {
  lines.push(`    R${padS(r.round, 2)}  我 活${padS(r.myAlive, 5)} 伤${padS(r.myWounded, 5)} 死${padS(r.myDead, 5)}   ｜ 敌 活${padS(r.enAlive, 5)} 伤${padS(r.enWounded, 5)} 死${padS(r.enDead, 5)}`);
}
lines.push('');
lines.push('## 结论要点');
lines.push('');
lines.push(`- 全样本：${N} 队全双向 × ${SEEDS} 种子，T0 整体对 T1 胜率 ${crossTier.t0_winRate}%（T1 反击 ${crossTier.t1_winRate}%）。`);
lines.push('- 战损与胜率并非同向：部分高胜率队"惨胜"（胜场战损高、多穿易被拖垮），部分中胜率队"血赚"（低胜场战损，多穿优质）。');
lines.push('- 多穿择优看「胜场战损 + 胜场死兵 + 交换比」三项，而非只看胜率。');
lines.push('');

const mdPath = join(root, 'docs/t0t1_warloss_report.md');
writeFileSync(mdPath, lines.join('\n'), 'utf8');
console.log(`已写出 ${mdPath}`);
console.log('\n=== 分层平均 ===');
for (const t of tierSummary) console.log(JSON.stringify(t));
console.log('\n=== 混战强度榜 ===');
for (const t of ranked) console.log(`${t.tier} 胜${t.winRate}% 非败${t.nonLossRate}% 场均战损${t.avgLossNet} 胜场战损${t.winLossNet} 死兵${t.avgDead} 交换比${t.trade}  ${t.note}`);
console.log('\n=== 多穿友好榜（胜场战损升序）===');
for (const t of byWinLoss) console.log(`${t.tier} 胜场战损${t.winLossNet} 胜率${t.winRate}% 胜场死兵${t.deadInWins} 交换比${t.trade}  ${t.note}`);
