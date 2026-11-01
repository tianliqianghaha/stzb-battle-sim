/**
 * T0 战法清单提取器（静态基底）
 * ───────────────────────────────────────────────────────────────────
 * 读取 8 支内置 T0 基准队，逐队逐英雄提取：
 *   主战法（hero.mainSkillId/Name）+ 携带的 2 个战法（slot.skillIds）
 * 并附每战法的名称/描述/品阶/目标类型，作为「精读战法」的机器可读基底。
 * 运行：npx tsx scripts/t0t1_skillman.mts
 * 产物：docs/t0t1_skills.json
 */
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const heroes: any[] = JSON.parse(readFileSync(join(root, 'web/data/heroes.json'), 'utf8'));
const skillDesc: Record<string, any> = JSON.parse(readFileSync(join(root, 'web/data/skill_desc.json'), 'utf8'));
const bench: any = JSON.parse(readFileSync(join(root, 'web/data/opponent_benchmark.json'), 'utf8'));

const byId: Record<string, any> = {};
const byName: Record<string, any> = {};
for (const h of heroes) { byId[h.id] = h; byName[h.name] = h; }
function findHero(heroId: string) { return byId[heroId] || byName[heroId] || byName[heroId?.replace(/^XP/, '')] || null; }

function sk(id: string) {
  const s = skillDesc[id];
  if (!s) return { id, name: id, desc: '(引擎无此战法描述)', quality: '', targetType: '' };
  return { id, name: s.name, desc: s.desc, desc1: s.desc1, quality: s.quality, targetType: s.targetType };
}

const POS = ['大营', '中军', '前锋'];
const out: any[] = [];
for (const e of bench.entries) {
  const team = { id: e.id, note: e.note, heroes: [] as any[] };
  e.cfg.slots.forEach((s: any, i: number) => {
    const hero = findHero(s.heroId);
    const main = hero ? sk(hero.mainSkillId) : { id: '', name: '(未知主战法)', desc: '', quality: '', targetType: '' };
    const carry = (s.skillIds || []).map((id: string) => sk(id));
    team.heroes.push({
      position: POS[i],
      heroId: s.heroId,
      heroName: hero ? hero.name : s.heroId,
      troopType: s.troopType,
      traits: s.traits || [],
      level: s.level,
      mainSkill: main,
      carrySkills: carry,
    });
  });
  out.push(team);
}
writeFileSync(join(root, 'docs/t0t1_skills.json'), JSON.stringify(out, null, 2), 'utf8');

// 控制台可读清单
for (const t of out) {
  console.log(`\n=== ${t.note} (${t.id}) ===`);
  for (const h of t.heroes) {
    console.log(`  [${h.position}] ${h.heroName}(${h.heroId}/${h.troopType}) 特性:${h.traits.join(',') || '-'}`);
    console.log(`    主战法: ${h.mainSkill.name}【${h.mainSkill.quality}】${h.mainSkill.desc}`);
    h.carrySkills.forEach((c: any, k: number) => console.log(`    携带${k + 1}: ${c.name}【${c.quality}】${c.desc}`));
  }
}
console.log('\n已写出 docs/t0t1_skills.json');
