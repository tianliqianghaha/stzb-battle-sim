/**
 * ① 小保底全池按"最适合位置"归类（用 position_lib 的阵位规律）
 * 规则：每将算 qBack/qMid/qFront，取最大者为其最适合位置；三档内按该位置质量分降序。
 * 运行：npx tsx scripts/xiaobaodi_position.mts
 * 产物：docs/小保底按位置归类.md（树状，无表）
 */
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { heroByName, makeSoloSlot, bestPosition, classify } from './position_lib.mts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const poolDoc: any = JSON.parse(readFileSync(join(root, 'docs/配将卡池.json'), 'utf8'));
const skDesc: Record<string, any> = JSON.parse(readFileSync(join(root, 'web/data/skill_desc.json'), 'utf8'));

const alias: Record<string, string> = { '大小乔': '小乔＆大乔', '关兴＆张苞': '关兴＆张苞' };
const norm = (n: string) => (alias[n] || n).replace(/＆/g, '&').replace(/\s/g, '');

// 抽取可用小保底池（引擎内 + 有主战法）
const xiao = poolDoc.pool.filter((r: any) => r.tier === '小保底');
const used: any[] = [], missing: any[] = [];
for (const r of xiao) {
  const nm = norm(r.name);
  const h = heroByName[nm] || heroByName['XP' + nm];
  if (!h || !h.mainSkillId) { missing.push({ name: r.name, faction: r.faction }); continue; }
  const s = makeSoloSlot(h.id);
  const bp = bestPosition(s);
  used.push({ ...s, bestPos: bp.pos, qBack: bp.qBack, qMid: bp.qMid, qFront: bp.qFront, q: bp.q, faction: r.faction });
}

// 三档归类 + 降序
const groups: Record<string, any[]> = { 大营: [], 中军: [], 前锋: [] };
for (const u of used) groups[u.bestPos].push(u);
for (const p of ['大营', '中军', '前锋']) groups[p].sort((a, b) => b.q - a.q);

// 报告（树状，无表）
let md = '';
md += '# 小保底卡池 · 全英雄按"最适合位置"归类\n\n';
md += '> 方法：用 `scripts/position_lib.mts` 的阵位规律（属性成长 + 攻击距离 + 主战法角色）。每将算 **大营质量 qBack / 中军质量 qMid / 前锋质量 qFront**（0–100），取最大者为其最适合位置；档内按该位置质量分降序。\n';
md += `> 卡池来源：docs/配将卡池.json(tier=小保底) ∩ 引擎 web/data/heroes.json（有主战法可 build）。可用 **${used.length} 将**（剔除 ${missing.length} 条不可用）。\n\n`;

md += '## 一、大营（胜负手位 · 后排主心骨）\n';
md += '> 优质画像：主属性成长高 + 攻击距离≥3 能覆盖敌阵 + 主战法是队内最高倍率胜负手（输出/控制/增伤）。\n';
for (const u of groups['大营']) {
  md += `\n- **${u.hero}**(${u.faction}/${u.troop}·${u.dtype})　适配度 ${u.qBack}/100　[大营${u.qBack}/中军${u.qMid}/前锋${u.qFront}]\n`;
  md += `  - 主战法：${u.main}　[${u.tags.join('/') || '—'}]\n`;
  md += `  - 距离 ${u.range}｜ATK${u.atk}(+${u.gAtk}) DEF${u.def}(+${u.gDef}) 谋${u.strat}(+${u.gStrat}) 速${u.spd}\n`;
  if (u.qMid >= u.qBack - 12) md += `  - ⚠ 双适（中军 ${u.qMid} 接近）：若队内有更强直伤核，可降中军衔接位。\n`;
}
md += '\n## 二、中军（衔接位 · 腰）\n';
md += '> 优质画像：功能纯粹（增伤/控制/续航/副输出其一拉满）+ 攻击距离≥2–3 稳定参与中距交火 + 能与大营/前锋联动。\n';
for (const u of groups['中军']) {
  md += `\n- **${u.hero}**(${u.faction}/${u.troop}·${u.dtype})　适配度 ${u.qMid}/100　[大营${u.qBack}/中军${u.qMid}/前锋${u.qFront}]\n`;
  md += `  - 主战法：${u.main}　[${u.tags.join('/') || '—'}]\n`;
  md += `  - 距离 ${u.range}｜ATK${u.atk}(+${u.gAtk}) DEF${u.def}(+${u.gDef}) 谋${u.strat}(+${u.gStrat}) 速${u.spd}\n`;
  if (u.qBack >= u.qMid - 12) md += `  - ⚠ 双适（大营 ${u.qBack} 接近）：缺核心时可顶大营。\n`;
}
md += '\n## 三、前锋（承伤位 · 前排盾+功能）\n';
md += '> 优质画像：防御成长高（标杆曹操2.95→满分）+ 主战法自带**自身**抗压（减伤/规避/援护/续航）+ 攻击距离≥2 能还手 + 带反击/控制惩罚对手。\n';
for (const u of groups['前锋']) {
  md += `\n- **${u.hero}**(${u.faction}/${u.troop}·${u.dtype})　适配度 ${u.qFront}/100　[大营${u.qBack}/中军${u.qMid}/前锋${u.qFront}]\n`;
  md += `  - 主战法：${u.main}　[${u.tags.join('/') || '—'}]\n`;
  md += `  - 距离 ${u.range}｜ATK${u.atk}(+${u.gAtk}) DEF${u.def}(+${u.gDef}) 谋${u.strat}(+${u.gStrat}) 速${u.spd}\n`;
  if (Math.max(u.qBack, u.qMid) >= u.qFront - 12) md += `  - ⚠ 双适（大营 ${u.qBack} / 中军 ${u.qMid} 接近）：依队友可升大营核或降中军。\n`;
}

md += '\n## 四、归类汇总（每档数量）\n';
md += `- 大营候选（输出/胜负手核）：${groups['大营'].length} 将\n`;
md += `- 中军候选（衔接/增益/控制）：${groups['中军'].length} 将\n`;
md += `- 前锋候选（肉/抗压）：${groups['前锋'].length} 将\n`;
if (missing.length) {
  md += `\n## 五、引擎不可用（已剔除）\n`;
  for (const m of missing) md += `- ${m.name}(${m.faction})\n`;
}

writeFileSync(join(root, 'docs/小保底按位置归类.md'), md, 'utf8');
console.log(`可用 ${used.length} 将；大营 ${groups['大营'].length} / 中军 ${groups['中军'].length} / 前锋 ${groups['前锋'].length}；剔除 ${missing.length}`);
console.log('已写出 docs/小保底按位置归类.md');
// 控制台速览
for (const p of ['大营', '中军', '前锋']) {
  console.log(`\n【${p}】降序:`);
  for (const u of groups[p]) console.log(`  ${u.q} ${u.hero}(${u.faction}) 距${u.range} [B${u.qBack}/M${u.qMid}/F${u.qFront}] ${u.tags.join('/') || '—'}`);
}
