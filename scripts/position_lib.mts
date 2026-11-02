/**
 * position_lib.mts —— 阵位规律的独立可复用库（无副作用，纯函数 + 数据加载）
 * 供 scripts/position_rule.mts（17队回判）、scripts/xiaobaodi_position.mts（①全池归类）、
 *     scripts/xiaobaodi_3teams.mts（②组队）共用。
 * 规律来源：从"属性成长 + 攻击距离 + 主战法角色"反推大营/中军/前锋（相对律 + 三位置优质画像）。
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

export const heroesData: any[] = JSON.parse(readFileSync(join(root, 'web/data/heroes.json'), 'utf8'));
export const skDesc: Record<string, any> = JSON.parse(readFileSync(join(root, 'web/data/skill_desc.json'), 'utf8'));

export const heroById: Record<string, any> = {};
export const heroByName: Record<string, any> = {};
for (const h of heroesData) { heroById[h.id] = h; heroByName[h.name] = h; heroByName['XP' + h.name] = h; }

export const POS = ['大营', '中军', '前锋'] as const;

// ── 主战法角色分类（关键词，透明可复核）──
export function classify(descRaw: string) {
  const d = (descRaw || '').replace(/\s/g, '');
  const tags: string[] = [];
  if (/减伤|降低.{0,6}(伤害|受到|攻击|防御|谋略|速度)|受到的伤害|下降\d|援护|免疫接下来受到的|受到伤害前.{0,8}防御/.test(d)) tags.push('减伤');
  if (/进入规避状态|获得规避|规避状态|免疫接下来受到的/.test(d)) tags.push('规避');
  if (/恢复|急救|治疗|休整|兵力恢复|恢复率|恢复一定兵力/.test(d)) tags.push('续航');
  if (/反击|受到攻击.{0,14}发动|受到.{0,6}伤害.{0,10}(反|发动)/.test(d)) tags.push('反击');
  if (/混乱|暴走|怯战|怯步|犹豫|挑衅|妖术|计穷|疲弱|无法.{0,4}普通攻击|无法.{0,4}主动战法/.test(d)) tags.push('控制');
  if (/增伤|伤害提高|造成的伤害提高|攻击伤害提升|攻击时的伤害提高|伤害提升|受伤.{0,4}提高|受到.{0,4}伤害.{0,4}提高|额外提高|攻击提高|谋略提高/.test(d)) tags.push('增伤');
  if (/提升.{0,6}(防御|速度|属性|攻击|谋略)|提高.{0,6}(防御|速度|属性|攻击|谋略)|攻击距离\+|分兵|士气提升/.test(d)) tags.push('增益');
  if (/移除|清除|解除|祛除/.test(d)) tags.push('净化');
  if (/前[一二三1-3]回合|首回合|前2回合|前3回合|立即|第1回合|战斗开始后前/.test(d)) tags.push('爆发');
  if (/伤害率\s*\d|策略攻击|猛烈攻击|强力策略攻击|发动一次攻击|发动攻击|对敌军.{0,10}发动.{0,10}攻击|普攻后.{0,10}再次发动攻击|普通攻击后.{0,10}再次发动|猛攻/.test(d)) tags.push('输出');
  let dtype = '混合/指挥';
  if (/策略攻击|谋略|智力/.test(d) && !/攻击属性|物理|兵刃/.test(d)) dtype = '谋略';
  else if (/攻击|兵刃|物理|普攻|普通攻击/.test(d)) dtype = '物理';
  const selfDur = /自身受到|自身进行攻击时的伤害|援护|免疫接下来受到的/.test(d);
  const teamDur = /我军全体|友军/.test(d);
  return { tags, dtype, selfDur, teamDur };
}

export function stat40(base: number, growth: number, free = 0) { return Math.round(base + 39 * growth) + free; }

export interface Slot {
  pos: string; hero: string; id: string; troop: string; range: number;
  atk: number; def: number; strat: number; spd: number;
  gAtk: number; gDef: number; gStrat: number; gSpd: number;
  out40: number; main: string; dtype: string; tags: string[]; selfDur: boolean; teamDur: boolean; desc: string; faction: string;
}

// 构建"孤立"槽位（用于池内单将判定，无队友上下文，标准 40 级、无自由点）
export function makeSoloSlot(heroId: string, free: any = {}): Slot {
  const h = heroById[heroId];
  const atk = stat40(h.baseAttack, h.growthAttack, free.attack || 0);
  const def = stat40(h.baseDefense, h.growthDefense, free.defense || 0);
  const strat = stat40(h.baseStrategy, h.growthStrategy, free.strategy || 0);
  const spd = stat40(h.baseSpeed, h.growthSpeed, free.speed || 0);
  const mainDesc = (skDesc[h.mainSkillId] && (skDesc[h.mainSkillId].desc || skDesc[h.mainSkillId].desc1)) || h.skillDesc;
  const cl = classify(mainDesc);
  return {
    pos: '', hero: h.name, id: h.id, troop: h.troopType, range: h.attackRange,
    atk, def, strat, spd, gAtk: h.growthAttack, gDef: h.growthDefense, gStrat: h.growthStrategy, gSpd: h.growthSpeed,
    out40: Math.max(atk, strat), main: h.mainSkillName, dtype: cl.dtype, tags: cl.tags, selfDur: cl.selfDur, teamDur: cl.teamDur,
    desc: (mainDesc || '').slice(0, 60), faction: h.faction,
  };
}

// ── 三位置"优质"打分（0–100，单将孤立口径：三函数衡量不同维度）──
// 大营 = 真·主伤害核（必须自带输出标签，否则重罚；主属性成长 + 攻击距离覆盖）
export function qualityBack(s: Slot): number {
  let q = 0;
  const mg = Math.max(s.gAtk, s.gStrat);
  q += Math.min(50, mg * 22);
  q += Math.min(12, (s.out40 / 320) * 12);
  if (s.tags.includes('输出')) q += 16; else q -= 22;   // 必须是真伤害源
  if (s.dtype === '物理' || s.dtype === '谋略') q += 4;
  if (s.range >= 3) q += 12; else if (s.range === 2) q += 4; else q -= 12;
  return Math.round(Math.max(0, Math.min(100, q)));
}
// 中军 = 衔接/放大位（增益/减伤/续航/控制/规避/增伤 纯度；纯伤害核轻扣分）
export function qualityMid(s: Slot): number {
  let q = 0;
  const sup = ['增伤', '增益', '减伤', '续航', '控制', '规避'].filter(t => s.tags.includes(t));
  if (sup.length) q += 12;
  q += Math.min(48, sup.length * 18);
  if (sup.length >= 2) q += 10;
  if (s.tags.includes('输出')) q -= 8;
  if (s.range >= 3) q += 12; else if (s.range === 2) q += 6; else q -= 8;
  q += Math.min(14, (Math.max(s.gAtk, s.gStrat) / 2.3) * 14 * 0.4);
  return Math.round(Math.max(0, Math.min(100, q)));
}
// 前锋 = 承伤/抗压位（防御成长主导 + 自身抗压按防御成长是否达标给部分加分；脆皮输出不进前锋）
export function qualityFront(s: Slot): number {
  let q = 0;
  q += Math.min(50, s.gDef * 24);
  if (s.selfDur) q += (s.gDef >= 1.6 ? 12 : 6);
  if (s.range <= 2) q += 10;
  if (s.range === 1) q += 8;
  if (s.tags.includes('反击')) q += 6;
  if (s.tags.includes('续航')) q += 4;
  if (s.tags.includes('输出') && !s.selfDur) q -= 12;
  return Math.round(Math.max(0, Math.min(100, q)));
}

// 判定单将最适合位置（argmax 三质量分；距1 按引擎必前锋硬锁）
export function bestPosition(s: Slot): { pos: string; q: number; qBack: number; qMid: number; qFront: number } {
  const qBack = qualityBack(s), qMid = qualityMid(s), qFront = qualityFront(s);
  if (s.range === 1) return { pos: '前锋', q: qFront, qBack, qMid, qFront };
  const arr = [['大营', qBack], ['中军', qMid], ['前锋', qFront]] as [string, number][];
  arr.sort((a, b) => b[1] - a[1]);
  return { pos: arr[0][0], q: arr[0][1], qBack, qMid, qFront };
}
