const fs = require('fs');
const r = JSON.parse(fs.readFileSync('docs/t0t1_redness.json','utf8'));
const fs2 = JSON.parse(fs.readFileSync('docs/t0t1_fullsim.json','utf8'));
// 修 bothRed_spread
const bvals = r.rows.map(x=>x.bothRedWin);
r.spread.bothRed_spread = +(Math.max(...bvals)-Math.min(...bvals)).toFixed(1);
// 额外统计供报告
function pearson(xs,ys){const n=xs.length;const mx=xs.reduce((a,b)=>a+b,0)/n,my=ys.reduce((a,b)=>a+b,0)/n;let nu=0,dx=0,dy=0;for(let i=0;i<n;i++){const a=xs[i]-mx,b=ys[i]-my;nu+=a*b;dx+=a*a;dy+=b*b;}return nu/Math.sqrt(dx*dy);}
const rows = r.rows;
const d1 = rows.map(x=>x.delta1);
const eng = rows.map(x=>x['增伤0red']);
const base = rows.map(x=>x.base0red);
console.log('Δ1 vs 增伤0red  r=', pearson(d1,eng).toFixed(3));
console.log('Δ1 vs base0red  r=', pearson(d1,base).toFixed(3));
const eng0 = rows.filter(x=>x['增伤0red']===0);
const engPos = rows.filter(x=>x['增伤0red']>0);
console.log('增伤=0 队 Δ1 均值=', (eng0.reduce((a,x)=>a+x.delta1,0)/eng0.length).toFixed(2), '队:', eng0.map(x=>x.note).join('/'));
console.log('增伤>0 队 Δ1 均值=', (engPos.reduce((a,x)=>a+x.delta1,0)/engPos.length).toFixed(2));
console.log('全员满红极差=', r.spread.bothRed_spread, ' baseline极差=', r.spread.base0red_spread);
console.log('全员满红后 增伤0队仍垫底:', eng0.map(x=>x.note+'='+x.bothRedWin+'%').join(', '));
fs.writeFileSync('docs/t0t1_redness.json', JSON.stringify(r,null,2),'utf8');
console.log('已修复 docs/t0t1_redness.json bothRed_spread');
