/**
 * ② 小保底 · 自由组 3 队（跨队尽量不重复）打 8 支 T0 · 全规律重模拟
 * ────────────────────────────────────────────────────────────────────
 * 用全部已发现规律组队：
 *   N1 物理输出驱动胜率 → 物理爆发核优先；法系核须配高增伤链
 *   N2 增伤膝点(>0.2) → 每队必带增伤链(神兵大赏/攻其不备/大赏三军)
 *   N3 减伤饱和 → 减伤只用于"非败"，不强堆
 *   N4 增伤差决定胶着 → 增伤链要压过 T0 常见增伤
 *   N5 先手与爆发正相关 → 爆发/控制队抢速度(加点倾斜)
 *   红度放大 → 顶配 50级5红；阵位规律 → 大营核/中军衔接/前锋肉；兵种克制±0.3；链路协同；同阵营加成；8回合上限→爆发+控制
 * 评估：双向消先手；score = winRate + 0.3*(nonloss-win)（胜率优先、平局降权）
 * 选队：候选全量评估 → 贪心选 3 队（跨队英雄重复≤1，最好0）→ FINAL=200 种子×8T0×2 方向重模拟
 * 运行：npx tsx scripts/xiaobaodi_3teams.mts   （FINE/FINAL/FAIR 可用环境变量调）
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
const poolDoc: any = JSON.parse(readFileSync(join(root, 'docs/配将卡池.json'), 'utf8'));
const benchRaw: any = JSON.parse(readFileSync(join(root, 'web/data/opponent_benchmark.json'), 'utf8'));

const skillByName: Record<string, string> = {};
for (const [id, s] of Object.entries(skillDesc)) skillByName[(s as any).name] = id;
function sk(n: string): string { const id = skillByName[n]; if (!id) throw new Error('战法无映射: ' + n); return id; }
function skillIdPair(names: string[]): string[] { return names.map(sk); }

// ── 小保底可用池 ──
const xiao = poolDoc.pool.filter((r: any) => r.tier === '小保底');
const alias: Record<string, string> = { '大小乔': '小乔＆大乔', '关兴＆张苞': '关兴＆张苞' };
const norm = (n: string) => (alias[n] || n).replace(/＆/g, '&').replace(/\s/g, '');
const heroByName: Record<string, { id: string; troopType: string }> = {};
for (const h of heroesData) { heroByName[h.name] = { id: h.id, troopType: h.troopType }; heroByName['XP' + h.name] = { id: h.id, troopType: h.troopType }; }
function findHero(name: string, faction: string) { const nm = norm(name); const c = heroByName[nm] || heroByName['XP' + nm]; return c ? c.id : null; }

// ── T0 对手（仅按 slots 构建，忠实 runBattle 契约）──
function troopTraits(troop: string): [string, string[]] {
  if (troop === 'cavalry') return ['轻骑兵', ['疾行', '出奇']];
  if (troop === 'archer') return ['长弓兵', ['地利', '迂回']];
  return ['重步兵', ['守备', '固阵']];
}
function benchSlotToGen(s: any, i: number): any {
  const fp: any = {}; if (s.addAttack) fp.attack = s.addAttack; if (s.addDefense) fp.defense = s.addDefense; if (s.addStrategy) fp.strategy = s.addStrategy; if (s.addSpeed) fp.speed = s.addSpeed;
  return buildGeneral(s.heroId, s.skillIds, fp, ['大营', '中军', '前锋'][i] as any, 0, s.level, s.morale ?? 120, s.secondaryTroop, s.traits, s.treasure ?? null, undefined);
}
const POS = ['大营', '中军', '前锋'] as const;
const OPPONENTS: { label: string; team: any[] }[] = benchRaw.entries.map((e: any) => ({ label: e.note.replace('敌方·', ''), team: e.cfg.slots.map((s: any, i: number) => benchSlotToGen(s, i)) }));

// ── 宝物 / 加点 / 位置（按"阵位规律 + N5 先手"定）──
const TREASURE: Record<string, number> = { 骁锐: 1003, 天资: 1057, 机敏: 1072, 熟虑: 1087 };
const LEVEL = 50, REDNESS = 5, MORALE = 120;
// 槽位角色 → 宝物 + 加点（dd/mage 主属性；tank 防御+少量速度；buff 控制抢先手）
function slotEquip(role: string): { tre: string; pts: any } {
  if (role === 'dd') return { tre: '骁锐', pts: { attack: 60, speed: 40 } };
  if (role === 'mage') return { tre: '天资', pts: { strategy: 100 } };
  if (role === 'tank') return { tre: '熟虑', pts: { defense: 70, speed: 30 } };
  return { tre: '机敏', pts: { strategy: 60, speed: 40 } }; // buff/control
}

// ── 候选模板队（跨阵营，单阵营同阵营加成；每队含增伤链+减伤控制链+续航；按阵位规律排位）──
interface Tpl { arch: string; faction: string; heroes: [string, string, string]; roles: [string, string, string]; skills: [[string, string], [string, string], [string, string]]; }
// roles: 大营 / 中军 / 前锋 各自的职能(dd/mage/tank/buff)
const TEMPLATES: Tpl[] = [
  // 群·菜刀爆发（先验最优流派）
  { arch: '群·菜刀A', faction: '群', heroes: ['庞德', '华雄', '兀突骨'], roles: ['dd', 'buff', 'tank'], skills: [['一骑当千', '击势'], ['攻其不备', '反计之策'], ['垒实迎击', '战必断金']] },
  { arch: '群·菜刀B', faction: '群', heroes: ['张郃', '华雄', '董白'], roles: ['dd', 'buff', 'tank'], skills: [['一骑当千', '击势'], ['攻其不备', '久战熟谋'], ['避其锋芒', '战必断金']] },
  { arch: '群·菜刀C', faction: '群', heroes: ['庞德', '吕姬', '董卓'], roles: ['dd', 'buff', 'tank'], skills: [['一骑当千', '击势'], ['攻其不备', '浑水摸鱼'], ['垒实迎击', '战必断金']] },
  // 群·法系爆发
  { arch: '群·法A', faction: '群', heroes: ['张角', '甄洛', '兀突骨'], roles: ['mage', 'buff', 'tank'], skills: [['三术奇谋', '深谋远虑'], ['神兵天降', '大赏三军'], ['垒实迎击', '战必断金']] },
  { arch: '群·法B', faction: '群', heroes: ['贾诩', '甄洛', '董卓'], roles: ['mage', 'buff', 'tank'], skills: [['三术奇谋', '深谋远虑'], ['神兵天降', '大赏三军'], ['垒实迎击', '战必断金']] },
  { arch: '群·法C', faction: '群', heroes: ['李儒', '甄洛', '董白'], roles: ['mage', 'buff', 'tank'], skills: [['十面埋伏', '河内世泽'], ['神兵天降', '大赏三军'], ['磐阵善守', '避其锋芒']] },
  // 魏·神赏法刀
  { arch: '魏·法刀A', faction: '魏', heroes: ['荀彧', '张春华', '曹仁'], roles: ['mage', 'buff', 'tank'], skills: [['三术奇谋', '深谋远虑'], ['神兵天降', '大赏三军'], ['垒实迎击', '战必断金']] },
  { arch: '魏·法刀B', faction: '魏', heroes: ['荀彧', '张春华', '邓艾'], roles: ['mage', 'buff', 'tank'], skills: [['始计', '当阳桥'], ['反计之策', '浑水摸鱼'], ['垒实迎击', '战必断金']] },
  // 吴·攻其菜刀
  { arch: '吴·菜刀A', faction: '吴', heroes: ['甘宁', '凌统', 'XP程普'], roles: ['dd', 'buff', 'tank'], skills: [['一骑当千', '击势'], ['攻其不备', '浑水摸鱼'], ['垒实迎击', '战必断金']] },
  { arch: '吴·菜刀B', faction: '吴', heroes: ['太史慈', '凌统', 'XP程普'], roles: ['dd', 'buff', 'tank'], skills: [['一骑当千', '击势'], ['攻其不备', '反计之策'], ['避其锋芒', '单骑救主']] },
  // 吴·法刀
  { arch: '吴·法刀A', faction: '吴', heroes: ['周姬', '张昭', 'XP程普'], roles: ['mage', 'buff', 'tank'], skills: [['三术奇谋', '深谋远虑'], ['神兵天降', '大赏三军'], ['垒实迎击', '战必断金']] },
  { arch: '吴·法刀B', faction: '吴', heroes: ['诸葛恪', '小乔＆大乔', 'XP程普'], roles: ['mage', 'buff', 'tank'], skills: [['十面埋伏', '河内世泽'], ['神兵天降', '大赏三军'], ['磐阵善守', '避其锋芒']] },
  // 汉·法系
  { arch: '汉·法A', faction: '汉', heroes: ['灵帝', '蔡文姬', '卢植'], roles: ['mage', 'buff', 'tank'], skills: [['三术奇谋', '深谋远虑'], ['神兵天降', '大赏三军'], ['垒实迎击', '战必断金']] },
  // 汉·菜刀
  { arch: '汉·菜刀A', faction: '汉', heroes: ['朱儁', '何太后', '卢植'], roles: ['dd', 'buff', 'tank'], skills: [['一骑当千', '击势'], ['攻其不备', '浑水摸鱼'], ['垒实迎击', '战必断金']] },
  // 蜀·菜刀（池内蜀将少，沙摩柯核）
  { arch: '蜀·菜刀A', faction: '蜀', heroes: ['沙摩柯', '姜维', '张姬'], roles: ['dd', 'buff', 'tank'], skills: [['一骑当千', '击势'], ['神兵天降', '大赏三军'], ['垒实迎击', '战必断金']] },
];

// ── 构建候选队 ──
interface Cand { arch: string; faction: string; heroNames: string[]; heroIds: string[]; skills: string[][]; pts: any[]; pos: string[]; treasure: string[]; troops: string[]; traits: string[][]; }
function buildCand(t: Tpl): Cand | null {
  const heroIds: string[] = []; const troops: string[] = []; const traits: string[][] = [];
  for (const nm of t.heroes) {
    const fid = findHero(nm, t.faction); if (!fid) return null;
    const h = heroesData.find((x: any) => x.id === fid)!;
    heroIds.push(fid); const [tr, trt] = troopTraits(h.troopType); troops.push(tr); traits.push(trt);
  }
  const pos = ['大营', '中军', '前锋'];
  const pts: any[] = []; const treasure: string[] = [];
  for (let i = 0; i < 3; i++) { const e = slotEquip(t.roles[i]); pts.push(e.pts); treasure.push(e.tre); }
  return { arch: t.arch, faction: t.faction, heroNames: t.heroes, heroIds, roles: t.roles, skills: t.skills.map(p => skillIdPair(p)), pts, pos, treasure, troops, traits };
}
function buildTeam(c: Cand): any[] {
  return c.heroIds.map((id, i) => buildGeneral(id, c.skills[i], c.pts[i], c.pos[i] as any, REDNESS, LEVEL, MORALE, c.troops[i], c.traits[i], { treasureId: TREASURE[c.treasure[i]], affix: { name: c.treasure[i], value: 15 } }, undefined));
}

// ── 评估（双向消先手）──
function evalTeam(team: any[], seeds: number, seedBase = 7) {
  let wins = 0, nonloss = 0, total = 0; const perOppW: number[] = []; const perOppNL: number[] = [];
  for (let oi = 0; oi < OPPONENTS.length; oi++) {
    const opp = OPPONENTS[oi].team; let w = 0, nl = 0, t = 0;
    for (let g = 0; g < seeds; g++) {
      const dir = g < seeds / 2 ? 0 : 1;
      const my = dir === 0 ? team : opp, en = dir === 0 ? opp : team;
      const seed = (oi * 1009 + g * 131 + seedBase) & 0x7fffffff;
      const r = runBattle({ myTeam: my, enemyTeam: en, seed, maxRounds: 8 });
      t++; total++;
      if (dir === 0) { if (r.result === 'win') { wins++; w++; } if (r.result !== 'loss') { nonloss++; nl++; } }
      else { if (r.result === 'loss') { wins++; w++; } if (r.result !== 'win') { nonloss++; nl++; } }
    }
    perOppW.push(w / t); perOppNL.push(nl / t);
  }
  return { winRate: wins / total, nonlossRate: nonloss / total, perOppW, perOppNL };
}
function score(e: any) { return e.winRate + 0.3 * (e.nonlossRate - e.winRate); }

function describe(c: Cand, e: any) {
  const lines = c.heroNames.map((nm, i) => `  ${c.pos[i]} ${nm}(${c.faction}/${c.roles ? '' : ''}${t_roletag(c.roles[i])}) 战法:${c.skills[i].map(sk2name).join('+')} 宝:${c.treasure[i]} 点:${Object.entries(c.pts[i]).map(([k, v]) => k + '+' + v).join(',')}`);
  return `评分${(score(e) * 100).toFixed(1)}% 胜率${(e.winRate * 100).toFixed(1)}% 非败${(e.nonlossRate * 100).toFixed(1)}%\n` + lines.join('\n') + `\n  对T0: ` + OPPONENTS.map((o, i) => o.label + ' ' + (e.perOppW[i] * 100).toFixed(0) + '%').join('  ');
}
function t_roletag(r: string) { return { dd: '物理核', mage: '法系核', tank: '肉盾', buff: '衔接/控' }[r] || r; }
function sk2name(id: string) { const v = skillDesc[id]; return v ? v.name : id; }

// ── 主流程 ──
const FINE = +(process.env.FINE || 60);
const FINAL = +(process.env.FINAL || 200);
const FAIR = +(process.env.FAIR || 40);
const t0 = Date.now();
const candidates: { c: Cand; e: any }[] = [];
console.log('═'.repeat(72));
console.log(`小保底 3 队筛选器：模板 ${TEMPLATES.length} 队 | 对手 ${OPPONENTS.length} 支T0 | FINE=${FINE} FINAL=${FINAL} FAIR=${FAIR}`);
console.log('═'.repeat(72));
for (const t of TEMPLATES) {
  const c = buildCand(t); if (!c) { console.log('  跳过(引擎无将):', t.arch); continue; }
  const e = evalTeam(buildTeam(c), FINE);
  candidates.push({ c, e });
  console.log(`  [${t.arch}] ${describe(c, e)}`);
}
candidates.sort((a, b) => score(b.e) - score(a.e));
console.log(`\n【候选排名 Top${Math.min(8, candidates.length)}（FINE=${FINE}）】`);
candidates.slice(0, 8).forEach((r, i) => console.log(`  #${i + 1} ${r.c.arch} 评分${(score(r.e) * 100).toFixed(1)}% 胜率${(r.e.winRate * 100).toFixed(1)}%`));

// ── FINAL 重模拟 topK 候选（200 种子 × 8T0 × 2 方向），用于稳健的组合搜索 ──
function overlap(a: string[], b: string[]) { const s = new Set(a); return b.filter(x => s.has(x)).length; }
function totalRepeats(sel: { c: Cand }[]) {
  const all: string[] = []; for (const s of sel) for (const h of s.c.heroNames) all.push(h);
  const seen = new Set<string>(); let rep = 0; for (const h of all) { if (seen.has(h)) rep++; else seen.add(h); } return rep;
}
const TOPK = Math.min(10, candidates.length);
const topK = candidates.slice(0, TOPK);
console.log(`\n【FINAL 重模拟 top${TOPK} 候选 × 200 种子】`);
for (const cand of topK) (cand as any).finalE = evalTeam(buildTeam(cand.c), FINAL);
topK.sort((a, b) => score((b as any).finalE) - score((a as any).finalE));
topK.slice(0, 8).forEach((r, i) => console.log(`  #${i + 1} ${r.c.arch} FINAL评分${(score((r as any).finalE) * 100).toFixed(1)}% 胜率${((r as any).finalE.winRate * 100).toFixed(1)}%`));

// ── 组合搜索选 3 队（两两重叠≤1，优先 0 重复，按 FINAL 总分最大化、平局比最小分）──
let bestCombo: { c: Cand; e: any }[][] | null = null; let bestObj = -1e9;
const m = topK.length;
for (let i = 0; i < m; i++) for (let j = i + 1; j < m; j++) for (let k = j + 1; k < m; k++) {
  const trio = [topK[i], topK[j], topK[k]];
  if (overlap(trio[0].c.heroNames, trio[1].c.heroNames) > 1) continue;
  if (overlap(trio[0].c.heroNames, trio[2].c.heroNames) > 1) continue;
  if (overlap(trio[1].c.heroNames, trio[2].c.heroNames) > 1) continue;
  const sum = trio.reduce((s, x) => s + score((x as any).finalE), 0);
  const rep = totalRepeats(trio);
  const minS = Math.min(score((trio[0] as any).finalE), score((trio[1] as any).finalE), score((trio[2] as any).finalE));
  const obj = sum - rep * 15 + minS * 0.01;   // 总分主导；重复重罚；平局比最小分
  if (obj > bestObj) { bestObj = obj; bestCombo = trio; }
}
if (!bestCombo) { console.log('!! 未找到满足约束的 3 队组合'); process.exit(1); }
const selected = [...bestCombo].sort((a, b) => score((b as any).finalE) - score((a as any).finalE));
const usedHeroes: string[] = []; for (const h of selected) for (const x of h.c.heroNames) usedHeroes.push(x);
console.log(`\n【组合搜索结果】选 3 队（跨队累计英雄 ${usedHeroes.length} 人，重复 ${totalRepeats(selected)} 人）`);
for (let k = 0; k < selected.length; k++) console.log(`  候选位 ${k + 1} ${selected[k].c.arch} FINAL评分${(score((selected[k] as any).finalE) * 100).toFixed(1)}%`);

// ── 入选 3 队 FINAL 详情 ──
console.log('\n' + '═'.repeat(72));
console.log('【入选 3 队 FINAL 详情 · 200 种子】');
const finalRes: any[] = [];
for (let i = 0; i < selected.length; i++) {
  const fe = (selected[i] as any).finalE;
  finalRes.push({ arch: selected[i].c.arch, c: selected[i].c, e: fe });
  console.log(`\n  队${i + 1} ${selected[i].c.arch} ${describe(selected[i].c, fe)}`);
}
finalRes.sort((a, b) => score(b.e) - score(a.e));

// ── 公平性对照（同配置 43级0红，战法/站位/宝物不变）──
console.log('\n【公平性对照 · 43级0红 同投资 vs T0基准】');
function buildTeamFair(c: Cand): any[] {
  return c.heroIds.map((id, i) => buildGeneral(id, c.skills[i], { attack: 0, defense: 0, strategy: 0, speed: 0 }, c.pos[i] as any, 0, 43, MORALE, c.troops[i], c.traits[i], { treasureId: TREASURE[c.treasure[i]], affix: { name: c.treasure[i], value: 15 } }, undefined));
}
const fairRes: any[] = [];
for (const fr of finalRes) {
  const e = evalTeam(buildTeamFair(fr.c), FAIR);
  fairRes.push({ arch: fr.arch, e });
  console.log(`  ${fr.arch} 公平胜率${(e.winRate * 100).toFixed(1)}% 非败${(e.nonlossRate * 100).toFixed(1)}%`);
}

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log('\n' + '═'.repeat(72));
console.log(`总耗时 ${elapsed}s`);

// ── 落盘 ──
const out = {
  meta: { method: '全规律自由组队：跨阵营单阵营burst+control模板×增伤链+减伤控制链+续航，双向消先手，胜率+0.3×平局评分；FINE筛选top10→FINAL=200实测→0重复优先的组合搜索选3队(跨队≤1重复)；', poolSize: 45, opponents: OPPONENTS.map(o => o.label), scoreDef: 'winRate + 0.3*(nonlossRate - winRate)', investment: '顶配我方50级5红 vs T0基准(引擎默认~43级0红白板)', elapsedSec: +elapsed },
  topCandidates: candidates.slice(0, 12).map(r => ({ arch: r.c.arch, heroes: r.c.heroNames, skills: r.c.skills.map(p => p.map(sk2name)), winRate: r.e.winRate, nonlossRate: r.e.nonlossRate, score: score(r.e) })),
  selectedFinal: finalRes.map((fr, i) => ({ rank: i + 1, arch: fr.arch, heroes: fr.c.heroNames, roles: fr.c.roles, skills: fr.c.skills.map(p => p.map(sk2name)), pts: fr.c.pts, treasure: fr.c.treasure, pos: fr.c.pos, eval: fr.e, fair: fairRes[i].e })),
};
writeFileSync(join(root, 'docs/小保底组队3队.json'), JSON.stringify(out, null, 2), 'utf8');
console.log('\n已写出 docs/小保底组队3队.json');
console.log('\n★ 最终 3 队（按战力降序）：');
finalRes.forEach((fr, i) => console.log(`  队${i + 1} ${fr.arch} 评分${(score(fr.e) * 100).toFixed(1)}% 胜率${(fr.e.winRate * 100).toFixed(1)}%`));
