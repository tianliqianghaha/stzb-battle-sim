import { buildGeneral } from '../web/heroes';
import { runBattle } from '../src/engine/combat';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const heroesData:any[] = JSON.parse(readFileSync(join(root,'web/data/heroes.json'),'utf8'));
const skillDesc:any = JSON.parse(readFileSync(join(root,'web/data/skill_desc.json'),'utf8'));
const benchRaw:any = JSON.parse(readFileSync(join(root,'web/data/opponent_benchmark.json'),'utf8'));
const byName:Record<string,string>={}; for(const [id,s] of Object.entries(skillDesc)) byName[(s as any).name]=id;
const heroName:Record<string,string>={}; for(const h of heroesData){heroName[h.name]=h.id;heroName['XP'+h.name]=h.id;}
function troopTraits(t:string):[string,string[]]{if(t==='cavalry')return['轻骑兵',['疾行','出奇']];if(t==='archer')return['长弓兵',['地利','迂回']];return['重步兵',['守备','固阵']];}
function mkHero(name:string,skills:string[],pts:any,pos:any,tre:string,lv:number,red:number){
  const rec=heroesData.find((x:any)=>x.name===name||x.name==='XP'+name)!;
  const [tr,ts]=troopTraits(rec.troopType);
  return buildGeneral(rec.id, skills.map(s=>byName[s]), pts, pos, red, lv, 120, tr, ts, {treasureId:{骁锐:1003,天资:1057,机敏:1072,熟虑:1087}[tre], affix:{name:tre,value:15}}, undefined);
}
function benchSlot(s:any,i:number){const fp:any={};if(s.addAttack)fp.attack=s.addAttack;if(s.addDefense)fp.defense=s.addDefense;if(s.addStrategy)fp.strategy=s.addStrategy;if(s.addSpeed)fp.speed=s.addSpeed;return buildGeneral(s.heroId,s.skillIds,fp,['大营','中军','前锋'][i],0,s.level,s.morale??120,s.secondaryTroop,s.traits,s.treasure??null,undefined);}
const opp=benchRaw.entries.map((e:any)=>e.cfg.slots.map((s:any,i:number)=>benchSlot(s,i)));
const finalTeam=[
  mkHero('庞德',['一骑当千','击势'],{attack:60,speed:40},'大营','天资',50,5),
  mkHero('华雄',['攻其不备','反计之策'],{attack:100},'中军','机敏',50,5),
  mkHero('兀突骨',['垒实迎击','战必断金'],{defense:70,speed:30},'前锋','熟虑',50,5),
];
function evalT(team:any[],seeds:number){let w=0,nl=0,t=0;const pw:number[]=[];for(let oi=0;oi<opp.length;oi++){let ww=0,nll=0,tt=0;for(let g=0;g<seeds;g++){const dir=g<seeds/2?0:1;const my=dir===0?team:opp[oi];const en=dir===0?opp[oi]:team;const r=runBattle({myTeam:my,enemyTeam:en,seed:(oi*1009+g*131+7)&0x7fffffff,maxRounds:8});tt++; if(dir===0){if(r.result==='win'){w++;ww++;}if(r.result!=='loss'){nl++;nll++;}}else{if(r.result==='loss'){w++;ww++;}if(r.result!=='win'){nl++;nll++;}}}pw.push(ww/tt);t+=tt;}return{win:w/t, nl:nl/t, pw};}
console.log('── 顶配(50级5红) vs T0基准(43级白板) ──');
let e=evalT(finalTeam,200);console.log(`胜率${(e.win*100).toFixed(1)}% 非败${(e.nl*100).toFixed(1)}% 对T0: `+e.pw.map(v=>v.toFixed(2)).join(' '));
console.log('── 同条件(43级0红) vs T0基准(43级白板) ──');
const fair=[ mkHero('庞德',['一骑当千','击势'],{attack:60,speed:40},'大营','天资',43,0), mkHero('华雄',['攻其不备','反计之策'],{attack:100},'中军','机敏',43,0), mkHero('兀突骨',['垒实迎击','战必断金'],{defense:70,speed:30},'前锋','熟虑',43,0)];
let e2=evalT(fair,200);console.log(`胜率${(e2.win*100).toFixed(1)}% 非败${(e2.nl*100).toFixed(1)}% 对T0: `+e2.pw.map(v=>v.toFixed(2)).join(' '));
