/**
 * 小保底武将 · 框架引导式配队优化器（顶级配将师 · 组合优化 v2）
 * ────────────────────────────────────────────────────────────────────
 * 方法论（用户指定，非穷举）：
 *   1) 观察 8 支 T0 真实配置 → 反推本质规律（三元结构 / 增伤链 / 减伤控制链 / 同阵营 / 先手 / 单一win-condition）
 *   2) 用规律把选择面从"C(45,3)×战法全组合"砍到"5 个单阵营 burst+control 流派 × 每槽角色候选"
 *   3) 战法按"链路功能"（增伤/法输出/物输出/减伤控续航）精选菜单，不再全组合穷举
 *   4) 按 E5 权威因子降序（战法→加点→站位→宝物→速度）做局部贪心 + 爬山
 *   5) 多策略探索：A 模板锚点 / B 引导式蒙特卡洛 / C 因子贪心+爬山 / D 稳健性复核
 * 目标：仅用"引擎内 + 网上共识"的小保底(45将)，配一队打 8 支 T0 平均胜率/非败率最高（胜率优先、平局降权）。
 * 运行：npx tsx scripts/optimize_xiaobaodi.mts
 *   预算环境变量：EXPLORE(默认14) FINE(默认40) FINAL(默认80) MC_PER_ARCH(默认30) HILL_ITERS(默认24) HILL_SEEDS(默认5)
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

// ───────────────── 名称 → 引擎 id ─────────────────
const skillByName: Record<string, string> = {};
for (const [id, s] of Object.entries(skillDesc)) skillByName[(s as any).name] = id;
const heroByName: Record<string, { id: string; troopType: string }> = {};
for (const h of heroesData) { heroByName[h.name] = { id: h.id, troopType: h.troopType }; heroByName['XP' + h.name] = { id: h.id, troopType: h.troopType }; }

// ───────────────── 小保底可用池（引擎内 + 共识，且可 build） ─────────────────
const xiao = poolDoc.pool.filter((r: any) => r.tier === '小保底');
const alias: Record<string, string> = { '大小乔': '小乔＆大乔' };
function findHero(name: string, faction: string) {
  const nm = alias[name] || name;
  const cand = heroesData.find((x: any) => (x.name === nm || x.name === 'XP' + nm) && x.faction === faction && Boolean(x.mainSkillId));
  return cand ? { id: cand.id, troopType: cand.troopType } : null;
}
const POOL: { id: string; name: string; faction: string; troop: string; role: string; mainSkillName: string }[] = [];
for (const r of xiao) {
  const c = findHero(r.name, r.faction); if (!c) continue;
  const rec = heroesData.find((x: any) => x.id === c.id);
  const atk = rec.baseAttack + rec.growthAttack * 49, stra = rec.baseStrategy + rec.growthStrategy * 49, def = rec.baseDefense + rec.growthDefense * 49;
  const role = stra >= atk && stra >= def ? 'mage' : atk >= def ? 'dd' : 'tank';
  POOL.push({ id: rec.id, name: rec.name, faction: rec.faction, troop: rec.troopType, role, mainSkillName: rec.mainSkillName });
}
const POOL_BY_NAME: Record<string, any> = {}; for (const h of POOL) POOL_BY_NAME[h.name] = h;

// ───────────────── 精选战法菜单（按"链路功能"，非全组合） ─────────────────
const FN_SKILLS: Record<string, string[]> = {
  'out-mage': ['三术奇谋', '深谋远虑', '十面埋伏', '河内世泽', '始计', '当阳桥', '妖术', '众谋不懈'],
  'out-dd': ['一骑当千', '击势', '先驱突击', '文伐', '全军突击', '长兵方阵', '钝兵挫锐', '威震逍遥', '百战无怯', '愈战愈勇'],
  'buff-ctrl': ['神兵天降', '大赏三军', '攻其不备', '久战熟谋', '反计之策', '浑水摸鱼', '磐阵善守', '避其锋芒', '无心恋战'],
  'tank': ['垒实迎击', '单骑救主', '战必断金', '磐阵善守', '避其锋芒', '无心恋战', '重整旗鼓', '桃园结义', '绝水遏敌', '反计之策'],
};
function sk(n: string): string { const id = skillByName[n]; if (!id) throw new Error('战法无映射: ' + n); return id; }
function skillIdPair(names: string[]): string[] { return names.map(sk); }

const TREASURE: Record<string, number> = { 骁锐: 1003, 天资: 1057, 机敏: 1072, 熟虑: 1087 };
const ROLE_TRE: Record<string, string> = { mage: '天资', dd: '骁锐', tank: '熟虑', 'buff-ctrl': '机敏' };
const ROLE_PTS: Record<string, any> = { mage: { strategy: 100 }, dd: { attack: 100 }, tank: { defense: 100 }, 'buff-ctrl': { strategy: 100 } };
const POS = ['大营', '中军', '前锋'] as const;
const MORALE = 120, LEVEL = 50, REDNESS = 5;

// ───────────────── 8 支 T0 真实对手（仅按 slots 构建，忠实 runBattle 契约） ─────────────────
function benchSlotToGen(s: any, i: number): any {
  const fp: any = {}; if (s.addAttack) fp.attack = s.addAttack; if (s.addDefense) fp.defense = s.addDefense; if (s.addStrategy) fp.strategy = s.addStrategy; if (s.addSpeed) fp.speed = s.addSpeed;
  return buildGeneral(s.heroId, s.skillIds, fp, POS[i], 0, s.level, s.morale ?? 120, s.secondaryTroop, s.traits, s.treasure ?? null, undefined);
}
const OPPONENTS: { label: string; team: any[] }[] = benchRaw.entries.map((e: any) => ({ label: e.note.replace('敌方·', ''), team: e.cfg.slots.map((s: any, i: number) => benchSlotToGen(s, i)) }));

// ───────────────── 框架引导的流派定义（选择性配对：单阵营 + 单一 win-condition） ─────────────────
interface SlotDef { role: string; fn: string; candidates: string[]; }
interface Arch { name: string; faction: string; winCondition: string; slots: SlotDef[]; }
const ARCHETYPES: Arch[] = [
  { name: '魏·神赏法刀', faction: '魏', winCondition: '法系爆发+控制', slots: [
    { role: 'mage', fn: 'out-mage', candidates: ['荀彧'] },
    { role: 'mage', fn: 'buff-ctrl', candidates: ['张春华'] },
    { role: 'tank', fn: 'tank', candidates: ['曹仁', '邓艾', 'XP王朗'] } ] },
  { name: '群·法系爆发', faction: '群', winCondition: '法系爆发', slots: [
    { role: 'mage', fn: 'out-mage', candidates: ['张角'] },
    { role: 'mage', fn: 'buff-ctrl', candidates: ['甄洛'] },
    { role: 'tank', fn: 'tank', candidates: ['兀突骨', '董白', '木鹿大王'] } ] },
  { name: '群·菜刀爆发', faction: '群', winCondition: '物理爆发', slots: [
    { role: 'dd', fn: 'out-dd', candidates: ['张郃', '庞德'] },
    { role: 'dd', fn: 'buff-ctrl', candidates: ['吕姬', '华雄'] },
    { role: 'tank', fn: 'tank', candidates: ['兀突骨', '董白'] } ] },
  { name: '吴·攻其菜刀', faction: '吴', winCondition: '物理爆发', slots: [
    { role: 'dd', fn: 'out-dd', candidates: ['甘宁', '太史慈'] },
    { role: 'dd', fn: 'buff-ctrl', candidates: ['凌统', '孙尚香'] },
    { role: 'tank', fn: 'tank', candidates: ['XP程普'] } ] },
  { name: '吴·法刀', faction: '吴', winCondition: '法系爆发+控制', slots: [
    { role: 'mage', fn: 'out-mage', candidates: ['周姬', '诸葛恪'] },
    { role: 'mage', fn: 'buff-ctrl', candidates: ['张昭', '小乔＆大乔'] },
    { role: 'tank', fn: 'tank', candidates: ['XP程普'] } ] },
];

// ───────────────── 候选队表示与构建 ─────────────────
interface Cand { arch: string; heroNames: string[]; skills: string[][]; pts: any[]; pos: string[]; treasure: string[]; }
function buildTeam(c: Cand): any[] {
  return c.heroNames.map((nm, i) => {
    const h = POOL_BY_NAME[nm];
    const [troop, traits] = troopTraits(h.troop);
    return buildGeneral(h.id, skillIdPair(c.skills[i]), c.pts[i], c.pos[i] as any, REDNESS, LEVEL, MORALE, troop, traits, { treasureId: TREASURE[c.treasure[i]], affix: { name: c.treasure[i], value: 15 } }, undefined);
  });
}
function troopTraits(troop: string): [string, string[]] {
  if (troop === 'cavalry') return ['轻骑兵', ['疾行', '出奇']];
  if (troop === 'archer') return ['长弓兵', ['地利', '迂回']];
  return ['重步兵', ['守备', '固阵']];
}
// 可复现 PRNG
function mulberry32(a: number) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rng = mulberry32(20261101);
const randInt = (n: number) => Math.floor(rng() * n);
function pick2(menu: string[]): [string, string] { const a = menu[randInt(menu.length)]; let b = menu[randInt(menu.length)]; let g = 0; while (b === a && g++ < 20) b = menu[randInt(menu.length)]; return [a, b]; }

// ───────────────── 评估（双向消除先手偏见；胜率优先、平局降权） ─────────────────
function evalTeam(team: any[], seeds: number, seedBase = 7) {
  let wins = 0, nonloss = 0, total = 0; const perOpp: number[] = []; const perOppW: number[] = [];
  for (let oi = 0; oi < OPPONENTS.length; oi++) {
    const opp = OPPONENTS[oi].team; let w = 0, nl = 0, t = 0, ww = 0;
    for (let g = 0; g < seeds; g++) {
      const dir = g < seeds / 2 ? 0 : 1;
      const my = dir === 0 ? team : opp, en = dir === 0 ? opp : team;
      const seed = (oi * 1009 + g * 131 + seedBase) & 0x7fffffff;
      const r = runBattle({ myTeam: my, enemyTeam: en, seed, maxRounds: 8 });
      t++; total++;
      if (dir === 0) { if (r.result === 'win') { wins++; w++; ww++; } if (r.result !== 'loss') { nonloss++; nl++; } }
      else { if (r.result === 'loss') { wins++; w++; ww++; } if (r.result !== 'win') { nonloss++; nl++; } }
    }
    perOpp.push(nl / t); perOppW.push(ww / t);
  }
  return { winRate: wins / total, nonlossRate: nonloss / total, perOpp, perOppW };
}
function score(e: any) { return e.winRate + 0.3 * (e.nonlossRate - e.winRate); }

function describe(c: Cand, e: any) {
  const arch = ARCHETYPES.find(a => a.name === c.arch);
  const roleLabel = (slotRole: string, fn: string) => fn === 'buff-ctrl' ? '控辅' : slotRole === 'tank' ? '承伤' : '输出';
  const lines = c.heroNames.map((nm, i) => {
    const h = POOL_BY_NAME[nm]; const sl = arch ? arch.slots[i] : null; const p = Object.entries(c.pts[i]).map(([k, v]) => k + '+' + v).join(',');
    return `  ${c.pos[i]} ${h.name}(${h.faction}/${sl ? roleLabel(sl.role, sl.fn) : h.role})[主:${h.mainSkillName}] 战法:${c.skills[i].join('+')} 宝:${c.treasure[i]} 点:${p}`;
  });
  return `胜率${(e.winRate * 100).toFixed(1)}% 非败${(e.nonlossRate * 100).toFixed(1)}% 评分${(score(e) * 100).toFixed(1)}%\n` + lines.join('\n') +
    `\n  对T0: ` + OPPONENTS.map((o, i) => o.label + ' ' + (e.perOppW[i] * 100).toFixed(0) + '%').join('  ');
}

// 由流派 + 角色候选 + 精选菜单 生成一支候选（框架引导，非全空间随机）
function candFromArch(a: Arch, heroPick: string[], skillMode: 'template' | 'random'): Cand {
  const skills: string[][] = a.slots.map((s, i) => skillMode === 'template' ? templateSkills(a, s, heroPick[i]) : pick2(FN_SKILLS[s.fn]));
  const pts = a.slots.map((s) => {
    if (s.fn === 'buff-ctrl' && skillMode === 'template') return { [s.role === 'mage' ? 'strategy' : 'attack']: 60, speed: 40 }; // 控辅抢先手：速度倾斜（按本槽角色主属性）
    return { ...ROLE_PTS[s.role] };
  });
  const treasure = a.slots.map((s) => ROLE_TRE[s.fn]);
  // 站位：输出放大营(0)、控辅中军(1)、承伤前锋(2)—— 规律①三元结构
  const pos = ['大营', '中军', '前锋'];
  return { arch: a.name, heroNames: heroPick, skills, pts, pos, treasure };
}
// 模板战法（按链路常识手工锚定最优组合）
function templateSkills(a: Arch, s: SlotDef, hero: string): [string, string] {
  if (s.fn === 'out-mage') return ['三术奇谋', '深谋远虑'];
  if (s.fn === 'out-dd') return ['一骑当千', '击势'];
  if (s.fn === 'buff-ctrl') return (a.faction === '群' && hero === '甄洛') ? ['神兵天降', '大赏三军'] : ['神兵天降', '大赏三军'];
  if (s.fn === 'tank') return ['垒实迎击', '战必断金'];
  return pick2(FN_SKILLS[s.fn]);
}
// 流派内角色候选的笛卡尔积（选择面已极小）
function heroCombos(a: Arch): string[][] {
  let combos: string[][] = [[]];
  for (const s of a.slots) combos = combos.flatMap(c => s.candidates.map(h => [...c, h]));
  return combos;
}

// ───────────────── 主流程 ─────────────────
const EXPLORE = +(process.env.EXPLORE || 12);
const FINE = +(process.env.FINE || 40);
const FINAL = +(process.env.FINAL || 200);
const MC_PER_ARCH = +(process.env.MC_PER_ARCH || 40);
const HILL_ITERS = +(process.env.HILL_ITERS || 6);
const HILL_SEEDS = +(process.env.HILL_SEEDS || 3);

const t0 = Date.now();
console.log('═'.repeat(72));
console.log(`小保底框架引导配队器 v2：可用池 ${POOL.length} 将 | 对手 ${OPPONENTS.length} 支T0 | 流派 ${ARCHETYPES.length}`);
console.log(`预算：EXPLORE=${EXPLORE} FINE=${FINE} FINAL=${FINAL} MC_PER_ARCH=${MC_PER_ARCH} HILL=${HILL_ITERS}×${HILL_SEEDS}`);
console.log('═'.repeat(72));
console.log('\n【框架·池确认】引擎内+共识小保底 45 将，按阵营/角色：');
const byFacRole: Record<string, string> = {};
for (const h of POOL) byFacRole[h.faction + h.role] = (byFacRole[h.faction + h.role] || '') + h.name + ' ';
for (const f of ['魏', '群', '吴', '汉', '蜀', '晋']) for (const r of ['mage', 'dd', 'tank']) if (byFacRole[f + r]) console.log(`  ${f}/${r}: ${byFacRole[f + r]}`);
console.log('\n【框架·5 流派（单阵营 + 单一 win-condition）】');
for (const a of ARCHETYPES) console.log(`  ${a.name} [${a.winCondition}] 大营:${a.slots[0].candidates.join('/')} 中军:${a.slots[1].candidates.join('/')} 前锋:${a.slots[2].candidates.join('/')}`);

// ── 策略 A：模板锚点（每流派按常识锚定 1 队，FINE 评估） ──
console.log('\n【策略A 模板锚点】');
const A_results: { arch: string; c: Cand; e: any }[] = [];
for (const a of ARCHETYPES) {
  for (const combo of heroCombos(a)) {
    const c = candFromArch(a, combo, 'template');
    const e = evalTeam(buildTeam(c), FINE);
    A_results.push({ arch: a.name, c, e });
  }
}
A_results.sort((x, y) => score(y.e) - score(x.e));
console.log(`  模板共 ${A_results.length} 队，Top5（评分=胜率+0.3×非败差）：`);
A_results.slice(0, 5).forEach((r, i) => console.log(`   #${i + 1} [${r.arch}] ${describe(r.c, r.e)}`));

// ── 策略 B：引导式蒙特卡洛（在"流派×角色候选×精选菜单"内抽样，非全空间） ──
console.log('\n【策略B 引导式蒙特卡洛】');
const seen = new Set<string>();
const B_results: { arch: string; c: Cand; e: any }[] = [];
for (const a of ARCHETYPES) {
  const combos = heroCombos(a);
  for (let s = 0; s < MC_PER_ARCH; s++) {
    const combo = combos[randInt(combos.length)];
    const c = candFromArch(a, combo, 'random');
    const k = c.heroNames.join(',') + '|' + c.skills.map(p => p.join('+')).join('|') + '|' + c.treasure.join('');
    if (seen.has(k)) continue; seen.add(k);
    const e = evalTeam(buildTeam(c), EXPLORE);
    B_results.push({ arch: a.name, c, e });
  }
}
B_results.sort((x, y) => score(y.e) - score(x.e));
console.log(`  抽样 ${B_results.length} 队，Top5：`);
B_results.slice(0, 5).forEach((r, i) => console.log(`   #${i + 1} [${r.arch}] ${describe(r.c, r.e)}`));
const B_top: Cand[] = [...A_results, ...B_results].sort((x, y) => score(y.e) - score(x.e)).slice(0, HILL_SEEDS).map(r => r.c);

// 按"链路功能"精选的战法对（引导式，非 menu² 穷举）
const CURATED_PAIRS: Record<string, [string, string][]> = {
  'out-mage': [['三术奇谋', '深谋远虑'], ['十面埋伏', '河内世泽'], ['始计', '当阳桥']],
  'out-dd': [['一骑当千', '击势'], ['先驱突击', '文伐'], ['长兵方阵', '威震逍遥']],
  'buff-ctrl': [['神兵天降', '大赏三军'], ['反计之策', '浑水摸鱼'], ['攻其不备', '久战熟谋']],
  'tank': [['垒实迎击', '战必断金'], ['磐阵善守', '避其锋芒'], ['单骑救主', '重整旗鼓']],
};

// ── 策略 C：因子贪心 + 局部爬山（按 E5 降序：战法→加点→站位；宝物/速度收尾精修） ──
console.log('\n【策略C 因子贪心+局部爬山（E5 降序，战法用精选对，不穷举）】');
const cands: { src: string; c: Cand; e: any }[] = [];
// 单步改进：战法(精选3对)×加点(2)×站位(2)，均用 EXPLORE 种子
function stepImprove(base: Cand, baseE: any): { c: Cand; e: any } {
  let best = JSON.parse(JSON.stringify(base)); let bestE = baseE;
  const arch0 = ARCHETYPES.find(a => a.name === best.arch)!;
  // 1) 战法（最大杠杆33.5%）：每槽仅测 3 组"链路功能精选对"（引导，非全组合）
  for (let slot = 0; slot < 3; slot++) {
    const pairs = CURATED_PAIRS[arch0.slots[slot].fn];
    for (const pr of pairs) { const nc = JSON.parse(JSON.stringify(best)); nc.skills[slot] = pr; const ne = evalTeam(buildTeam(nc), EXPLORE); if (score(ne) > score(bestE) + 1e-9) { best = nc; bestE = ne; } }
  }
  // 2) 加点（12.9%）：每槽在 角色默认 / 速度倾斜 间选优（速度倾斜仅控辅/输出适用）
  const ptOpts: Record<string, any[]> = {
    mage: [{ strategy: 100 }, { strategy: 60, speed: 40 }],
    dd: [{ attack: 100 }, { attack: 60, speed: 40 }],
    tank: [{ defense: 100 }, { defense: 70, speed: 30 }],
  };
  for (let slot = 0; slot < 3; slot++) {
    const role = ARCHETYPES.find(a => a.name === best.arch)!.slots[slot].role;
    for (const p of ptOpts[role]) { const nc = JSON.parse(JSON.stringify(best)); nc.pts[slot] = p; const ne = evalTeam(buildTeam(nc), EXPLORE); if (score(ne) > score(bestE) + 1e-9) { best = nc; bestE = ne; } }
  }
  // 3) 站位（8.7%）：仅验证"输出↔控辅"是否优于固定；承伤必须留前锋
  for (const perm of [['大营', '中军', '前锋'], ['中军', '大营', '前锋']]) {
    const nc = JSON.parse(JSON.stringify(best)); nc.pos = perm; const ne = evalTeam(buildTeam(nc), EXPLORE); if (score(ne) > score(bestE) + 1e-9) { best = nc; bestE = ne; }
  }
  return { c: best, e: bestE };
}
// 收尾精修：宝物(4词条×3槽) + 速度(控辅槽0/40/60)，仅在爬山收敛后做一次
function polish(base: Cand, baseE: any): { c: Cand; e: any } {
  let best = JSON.parse(JSON.stringify(base)); let bestE = baseE;
  const archP = ARCHETYPES.find(a => a.name === best.arch)!;
  const affs = ['骁锐', '天资', '机敏', '熟虑'];
  for (let slot = 0; slot < 3; slot++) for (const af of affs) { const nc = JSON.parse(JSON.stringify(best)); nc.treasure[slot] = af; const ne = evalTeam(buildTeam(nc), EXPLORE); if (score(ne) > score(bestE) + 1e-9) { best = nc; bestE = ne; } }
  const slot = 1; const role = archP.slots[slot].role;
  for (const sp of [0, 40, 60]) { const nc = JSON.parse(JSON.stringify(best)); const rest = 100 - sp; nc.pts[slot] = sp > 0 ? { [role === 'mage' ? 'strategy' : 'attack']: rest, speed: sp } : ROLE_PTS[role]; const ne = evalTeam(buildTeam(nc), EXPLORE); if (score(ne) > score(bestE) + 1e-9) { best = nc; bestE = ne; } }
  return { c: best, e: bestE };
}
for (let s = 0; s < B_top.length; s++) {
  let cur = B_top[s]; let curE = evalTeam(buildTeam(cur), EXPLORE);
  for (let it = 0; it < HILL_ITERS; it++) {
    const imp = stepImprove(cur, curE);
    if (score(imp.e) > score(curE) + 1e-9) { cur = imp.c; curE = imp.e; } else break; // 无改进则提前停止
  }
  const pol = polish(cur, curE); cur = pol.c; curE = evalTeam(buildTeam(cur), EXPLORE);
  cands.push({ src: 'C爬山#' + s, c: cur, e: curE });
  console.log(`   Seed${s + 1} 终态: ${describe(cur, curE)}`);
}

// ── 汇总当前最优，做 FINAL 精细 ──
const allSoFar = [...A_results.map(r => ({ src: 'A', c: r.c, e: r.e })), ...B_results.map(r => ({ src: 'B', c: r.c, e: r.e })), ...cands];
allSoFar.sort((x, y) => score(y.e) - score(x.e));
const finalCand = allSoFar[0].c;
const finalE = evalTeam(buildTeam(finalCand), FINAL);
console.log('\n【当前全局最优 · FINAL 精细】');
console.log(describe(finalCand, finalE));

// ── 策略 D：稳健性复核（多种子块 × 多次，报告波动与分对手胜率） ──
console.log('\n【策略D 稳健性复核（4 种子块 × 各 40 场）】');
const blocks: any[] = [];
for (let bseed = 0; bseed < 4; bseed++) {
  const e = evalTeam(buildTeam(finalCand), 40, 7000 + bseed * 1000);
  blocks.push(e);
}
const avgWin = blocks.reduce((s, e) => s + e.winRate, 0) / blocks.length;
const avgNL = blocks.reduce((s, e) => s + e.nonlossRate, 0) / blocks.length;
const varWin = Math.sqrt(blocks.reduce((s, e) => s + (e.winRate - avgWin) ** 2, 0) / blocks.length);
console.log(`  平均胜率 ${(avgWin * 100).toFixed(1)}% (σ=${(varWin * 100).toFixed(1)})  平均非败 ${(avgNL * 100).toFixed(1)}%`);

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log('\n' + '═'.repeat(72));
console.log(`总耗时 ${elapsed}s`);
console.log('═'.repeat(72));

// ───────────────── 落盘结果 ─────────────────
const out = {
  meta: {
    method: '框架引导（非穷举）：观察8支T0→反推规律→5单阵营bust+control流派×角色候选×链路精选战法菜单，按E5因子降序贪心+爬山',
    poolSize: POOL.length, opponents: OPPONENTS.map(o => o.label),
    scoreDef: 'winRate + 0.3*(nonlossRate - winRate)（胜率优先、平局降权）',
    note: '引擎内相对对比；我方50级5红顶配 vs 基准T0(白板~43级)。runBattle 不吃 cfg.enemy/manual/rounds。',
    elapsedSec: +elapsed,
  },
  best: { arch: finalCand.arch, heroes: finalCand.heroNames, skills: finalCand.skills, pts: finalCand.pts, pos: finalCand.pos, treasure: finalCand.treasure, eval: finalE, blocks: blocks.map(b => ({ winRate: b.winRate, nonlossRate: b.nonlossRate })) },
  topCandidates: allSoFar.slice(0, 10).map(r => ({ src: r.src, arch: r.c.arch, heroes: r.c.heroNames, skills: r.c.skills, winRate: r.e.winRate, nonlossRate: r.e.nonlossRate, score: score(r.e), perOppW: r.e.perOppW })),
};
const outPath = join(root, 'docs/小保底最优队.json');
writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');
console.log('\n已写出:', outPath);
console.log('\n★ 最终推荐一队（小保底）：');
console.log(describe(finalCand, finalE));
