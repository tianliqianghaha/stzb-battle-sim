const fs = require('fs');
const d = JSON.parse(fs.readFileSync('docs/t0t1_deepread.json', 'utf8'));
const out = [];
for (let bi = 0; bi < d.battles.length; bi++) {
  const b = d.battles[bi];
  out.push('\n######## ' + (bi + 1) + '. ' + b.teamA.note + '【' + b.teamA.tier + '】 vs ' + b.teamB.note + '【' + b.teamB.tier + '】  seed=' + b.seed + ' 结果=' + b.result + ' 回合=' + b.rounds);
  out.push('  A 阵容: ' + b.teamA.portrait.map(p => p.hero + '(主' + p.main.name + '/携' + p.carry.map(c => c.name).join('·') + ')').join(' | '));
  out.push('  B 阵容: ' + b.teamB.portrait.map(p => p.hero + '(主' + p.main.name + '/携' + p.carry.map(c => c.name).join('·') + ')').join(' | '));
  for (const rd of b.roundsEvents) {
    if (rd.round === undefined) continue;
    const re = rd.events.find(e => e.t === 'round');
    if (re) out.push('  R' + re.r + ' 兵力 A=' + JSON.stringify(re.my) + ' B=' + JSON.stringify(re.en));
    for (const e of rd.events) {
      if (e.t === 'ctrl') out.push('    [控]R' + rd.round + ' ' + e.who + ' 被上 ' + e.status);
      else if ((e.t === 'dmg' || e.t === 'hit' || e.t === 'split' || e.t === 'dot') && e.dmg >= 1500) {
        let mod = '';
        if (e.mods) { const c = [...e.mods.caused, ...e.mods.taken].map(x => x.skill + '+' + (x.rate) + '%').concat(e.mods.reduce.map(x => x.skill + '-' + (x.rate) + '%')); if (c.length) mod = ' [' + c.join(',') + ']'; }
        out.push('    [伤]R' + rd.round + ' ' + e.src + '→' + e.tgt + ' ' + (e.dtype || '') + ' ' + (-Math.round(e.dmg)) + mod);
      }
      else if (e.t === 'heal' && e.amt >= 800) out.push('    [疗]R' + rd.round + ' ' + e.src + '→' + e.tgt + ' +' + Math.round(e.amt));
      else if (e.t === 'trigger') out.push('    [发]R' + rd.round + ' ' + e.who + ' ' + (e.ok ? '✓' : '✗') + ' ' + e.skill);
    }
  }
}
fs.writeFileSync('docs/_deepread_dump.txt', out.join('\n'), 'utf8');
console.log('written docs/_deepread_dump.txt lines=', out.length);
