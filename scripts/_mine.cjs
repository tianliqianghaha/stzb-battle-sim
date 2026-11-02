// 新规律挖掘脚本：基于全谱均值数据(17队画像 + 272有向配对)，系统化寻找除已知5条+始计之外的新规律
const fs = require('fs');
const j = JSON.parse(fs.readFileSync('docs/t0t1_fullsim.json', 'utf8'));
const teams = j.teams;
const pairs = j.pairs;
const heroes = JSON.parse(fs.readFileSync('web/data/heroes.json', 'utf8'));
const hmap = {}; for (const h of heroes) hmap[h.id] = h;

const dims = ['dmgDealt','dmgTaken','phys','strat','earlyBurstPct','heal','control','增伤活跃度','减伤活跃度'];

function pearson(xs, ys) {
  const n = xs.length; if (n < 3) return NaN;
  const mx = xs.reduce((a,b)=>a+b,0)/n, my = ys.reduce((a,b)=>a+b,0)/n;
  let num=0, dx=0, dy=0;
  for (let i=0;i<n;i++){ const a=xs[i]-mx, b=ys[i]-my; num+=a*b; dx+=a*a; dy+=b*b; }
  return num/Math.sqrt(dx*dy);
}

// 每队画像
const P = teams.map(t=>({id:t.id, note:t.note, tier:t.tier, ...t.profile}));
const win = P.map(p=>p.winRate);
const wr = {};
for (const p of P) wr[p.id] = p;

console.log('========== 1. 维度 vs 胜率 相关性(17队) ==========');
for (const d of dims) {
  const v = P.map(p=>p[d]);
  console.log(d.padEnd(14), 'r=', pearson(v, win).toFixed(3));
}

console.log('\n========== 2. 增伤活跃度 vs 胜率(排序, 找膝点) ==========');
const sorted = P.slice().sort((a,b)=>a['增伤活跃度']-b['增伤活跃度']);
for (const p of sorted) {
  console.log(('增伤'+p['增伤活跃度'].toFixed(2)).padEnd(9), ' 胜率'+String(p.winRate).padStart(6), ' '+p.tier+' '+p.note);
}

console.log('\n-------- 增伤区间分桶(膝点估计) --------');
const bins = [[0,0.2],[0.2,0.6],[0.6,1.2],[1.2,2.0],[2.0,3.0],[3.0,9]];
for (const [lo,hi] of bins) {
  const g = P.filter(p=>p['增伤活跃度']>=lo && p['增伤活跃度']<hi);
  if (g.length) console.log(`[${lo},${hi})  n=${g.length}  均胜率=${(g.reduce((a,p)=>a+p.winRate,0)/g.length).toFixed(1)}%  队: ${g.map(p=>p.note).join('/')}`);
}

console.log('\n========== 3. 减伤饱和: 减伤活跃度 vs 承伤 ==========');
console.log('r(减伤,承伤)=', pearson(P.map(p=>p['减伤活跃度']), P.map(p=>p.dmgTaken)).toFixed(3));
console.log('高减伤(>=2)队承伤 vs 低减伤(<1)队承伤:');
const hiR = P.filter(p=>p['减伤活跃度']>=2), loR = P.filter(p=>p['减伤活跃度']<1);
console.log('  高减伤组 n='+hiR.length+' 均承伤='+(hiR.reduce((a,p)=>a+p.dmgTaken,0)/hiR.length).toFixed(0)+' 均胜率='+(hiR.reduce((a,p)=>a+p.winRate,0)/hiR.length).toFixed(1)+'%');
console.log('  低减伤组 n='+loR.length+' 均承伤='+(loR.reduce((a,p)=>a+p.dmgTaken,0)/loR.length).toFixed(0)+' 均胜率='+(loR.reduce((a,p)=>a+p.winRate,0)/loR.length).toFixed(1)+'%');

console.log('\n========== 4. 配对决定性(增伤差 -> 是否一边倒) ==========');
// 每对有向: a=首队作攻方(其增伤=a.增伤), b=次队作攻方(其增伤=b.增伤)
const decis = [];
for (const k of Object.keys(pairs)) {
  const [ia, ib] = k.split('__');
  const a = pairs[k].a, b = pairs[k].b;
  // A(首队)公平胜率 = (a.win + (1-b.win))/2 ; 决定性 = 1 - 平均平局
  const drawAvg = (a.drawRate + b.drawRate)/2;
  const aWinFair = (a.winRate + (100 - b.winRate))/2;
  const gap = a['增伤活跃度'] - b['增伤活跃度']; // A引擎 - B引擎
  decis.push({k, drawAvg, aWinFair, gap, aDmg:a['增伤活跃度'], bDmg:b['增伤活跃度']});
}
console.log('r(增伤差 |gap|, 平局率)=', pearson(decis.map(d=>Math.abs(d.gap)), decis.map(d=>d.drawAvg)).toFixed(3));
console.log('r(增伤差 gap, A公平胜率)=', pearson(decis.map(d=>d.gap), decis.map(d=>d.aWinFair)).toFixed(3));
// 决定性分组
const dLow = decis.filter(d=>Math.abs(d.gap)<0.5), dHigh = decis.filter(d=>Math.abs(d.gap)>=2);
console.log(`增伤差<0.5 的对局 n=${dLow.length}  均平局=${(dLow.reduce((a,d)=>a+d.drawAvg,0)/dLow.length).toFixed(1)}%`);
console.log(`增伤差>=2 的对局 n=${dHigh.length}  均平局=${(dHigh.reduce((a,d)=>a+d.drawAvg,0)/dHigh.length).toFixed(1)}%`);

console.log('\n========== 5. 先手敏感度(攻方胜率 - 守方胜率) vs 爆发% ==========');
// 每队作为a(攻)的平均胜率 与 作为b(守,即对方攻)时自身的胜率
const byId = {};
for (const k of Object.keys(pairs)) {
  const [ia, ib] = k.split('__');
  (byId[ia] = byId[ia] || {atk:[], def:[]}).atk.push(pairs[k].a.winRate);
  (byId[ib] = byId[ib] || {atk:[], def:[]}).def.push(pairs[k].b.winRate);
}
const sens = [];
for (const p of P) {
  const b = byId[p.id];
  if (!b) continue;
  const atk = b.atk.reduce((a,v)=>a+v,0)/b.atk.length;
  const def = b.def.reduce((a,v)=>a+v,0)/b.def.length;
  const s = atk - def; // 先手增益
  sens.push({id:p.id, note:p.note, sens:s, burst:p.earlyBurstPct, win:p.winRate});
}
console.log('r(先手增益, 爆发%)=', pearson(sens.map(s=>s.sens), sens.map(s=>s.burst)).toFixed(3));
console.log('r(先手增益, 胜率)=', pearson(sens.map(s=>s.sens), sens.map(s=>s.win)).toFixed(3));
console.log('最高/最低先手增益:');
sens.slice().sort((a,b)=>b.sens-a.sens).slice(0,5).forEach(s=>console.log('  +'+s.sens.toFixed(1)+' 爆发'+s.burst+'% '+s.note));
sens.slice().sort((a,b)=>a.sens-b.sens).slice(0,5).forEach(s=>console.log('  '+s.sens.toFixed(1)+' 爆发'+s.burst+'% '+s.note));

console.log('\n========== 6. 兵种构成 ==========');
const bench = JSON.parse(fs.readFileSync('web/data/opponent_benchmark.json','utf8'));
const roster = JSON.parse(fs.readFileSync('docs/t0t1_roster.json','utf8'));
const allTeams = [];
for (const e of bench.entries) allTeams.push({id:e.id, slots:e.cfg.slots});
for (const e of roster.t1) allTeams.push({id:e.id, slots:e.slots});
for (const t of allTeams) {
  const tt = t.slots.map(s=>hmap[s.heroId] && hmap[s.heroId].troopType).filter(Boolean);
  const cnt = {}; tt.forEach(x=>cnt[x]=(cnt[x]||0)+1);
  const dom = Object.keys(cnt).sort((a,b)=>cnt[b]-cnt[a])[0];
  console.log(t.id.padEnd(34), '兵种='+JSON.stringify(cnt), '主='+dom);
}
