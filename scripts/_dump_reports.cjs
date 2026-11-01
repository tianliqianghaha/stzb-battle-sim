const fs = require('fs');
const d = JSON.parse(fs.readFileSync('docs/t0t1_reports.json', 'utf8'));
const m = d.matchups;
const out = [];
for (let i = 0; i < m.length; i++) {
  const M = m[i];
  out.push('\n######## ' + (i + 1) + '. ' + M.key + ' (' + M.law + ') ########');
  out.push('方向:' + M.direction + ' seed=' + M.selectedSeed + ' 结果=' + M.result + ' 结束回合=' + M.rounds.length);
  out.push('A(' + M.teamA.tier + ')' + M.teamA.note + ' 伤害' + M.statsA.dmgDealt + '/承伤' + M.statsA.dmgTaken + '/物理' + M.statsA.physDealt + '/谋略' + M.statsA.stratDealt + '/爆发' + M.statsA.earlyBurstPct + '%/增伤' + M.statsA.增伤活跃度 + '/减伤' + M.statsA.减伤活跃度 + '/控制' + M.statsA.control + '/续航' + M.statsA.heal);
  out.push('B(' + M.teamB.tier + ')' + M.teamB.note + ' 伤害' + M.statsB.dmgDealt + '/承伤' + M.statsB.dmgTaken + '/物理' + M.statsB.physDealt + '/谋略' + M.statsB.stratDealt + '/爆发' + M.statsB.earlyBurstPct + '%/增伤' + M.statsB.增伤活跃度 + '/减伤' + M.statsB.减伤活跃度 + '/控制' + M.statsB.control + '/续航' + M.statsB.heal);
  for (const rd of M.rounds) {
    if (rd.round === undefined) continue;
    const re = rd.events.find(e => e.t === 'round');
    if (re) out.push('  R' + re.r + ' 兵力 A=' + JSON.stringify(re.my) + ' B=' + JSON.stringify(re.en));
    for (const e of rd.events) {
      if (e.t === 'ctrl') out.push('    [控]R' + rd.round + ' ' + e.who + ' 被上 ' + e.status);
      else if ((e.t === 'dmg' || e.t === 'hit' || e.t === 'split' || e.t === 'dot') && e.dmg >= 1500) {
        let mod = '';
        if (e.mods) { const c = [...e.mods.caused, ...e.mods.taken].map(x => x.skill + '+' + (x.rate) + '%').concat(e.mods.reduce.map(x => x.skill + '-' + (x.rate) + '%')); if (c.length) mod = ' [' + c.join(',') + ']'; }
        out.push('    [伤]R' + rd.round + ' ' + e.src + '→' + e.tgt + ' ' + (e.dtype || '') + ' ' + (-Math.round(e.dmg)) + mod);
      } else if (e.t === 'heal' && e.amt >= 800) out.push('    [疗]R' + rd.round + ' ' + e.src + '→' + e.tgt + ' +' + Math.round(e.amt));
      else if (e.t === 'trigger') out.push('    [发]R' + rd.round + ' ' + e.who + ' ' + (e.ok ? 'OK' : 'X') + ' ' + e.skill);
    }
  }
}
fs.writeFileSync('docs/_tl_dump.txt', out.join('\n'), 'utf8');
console.log('written /tmp/tl.txt lines=' + out.length);
