/* JAYASONA PREDIKSI V3.2
   UI tetap V3.1.x. Mesin prediksi memakai pertandingan Completed yang ada di data.json.
   Model: weighted recent form + home/away split + league baseline + Poisson score model.
*/
const VERSION = "3.2";
const state = {
  data: {matches:[]},
  filter: "all",
  search: "",
  favorites: new Set(JSON.parse(localStorage.getItem("jayasona_favorites") || "[]")),
  logoCache: JSON.parse(localStorage.getItem("jayasona_logo_cache") || "{}")
};

const $ = id => document.getElementById(id);
const esc = v => String(v ?? "").replace(/[&<>"']/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[s]));
const arrScore = v => Array.isArray(v) ? v.join(" - ") : (v === null || v === undefined || v === "" ? "—" : String(v));
const isCompleted = m => String(m.status||"").toLowerCase() === "completed" || Array.isArray(m.ft);
const isLive = m => /running|live/i.test(String(m.status||""));
const teamKey = s => String(s||"").trim().toLowerCase().replace(/\s+/g," ");
const clamp = (x,a,b) => Math.max(a,Math.min(b,x));

function saveFav(){ localStorage.setItem("jayasona_favorites", JSON.stringify([...state.favorites])); }
function toast(msg){ const t=$("toast"); t.textContent=msg; t.classList.add("show"); clearTimeout(window.__toast); window.__toast=setTimeout(()=>t.classList.remove("show"),1800); }

function normalizeMatches(){
  state.data.matches = (state.data.matches || []).map(m => {
    const ht = Array.isArray(m.ht) ? m.ht : (m.ht_home!==undefined && m.ht_away!==undefined && m.ht_home!=="" && m.ht_away!=="" ? [Number(m.ht_home),Number(m.ht_away)] : null);
    const ft = Array.isArray(m.ft) ? m.ft : (m.final_home!==undefined && m.final_away!==undefined && m.final_home!=="" && m.final_away!=="" ? [Number(m.final_home),Number(m.final_away)] : null);
    return {...m, ht, ft};
  });
}

function completedMatches(){ return state.data.matches.filter(m=>isCompleted(m) && Array.isArray(m.ft) && m.ft.length>=2); }
function historicalFor(team, league){
  const k=teamKey(team), l=String(league||"");
  return completedMatches().filter(m=>teamKey(m.home)===k || teamKey(m.away)===k)
    .filter(m=>!l || String(m.league||"")===l)
    .sort((a,b)=>new Date(a.kickoff)-new Date(b.kickoff));
}
function leagueMatches(league){
  const l=String(league||"");
  return completedMatches().filter(m=>String(m.league||"")===l);
}
function weightedMean(values){
  if(!values.length) return 0;
  let num=0, den=0;
  values.forEach((v,i)=>{ const w=Math.pow(0.84, values.length-1-i); num+=v*w; den+=w; });
  return den ? num/den : 0;
}
function teamStats(team, league){
  const all=historicalFor(team,league);
  const recent=all.slice(-12);
  const home=recent.filter(m=>teamKey(m.home)===teamKey(team));
  const away=recent.filter(m=>teamKey(m.away)===teamKey(team));
  const extract=(games, side)=>games.map(m=>{
    const h=teamKey(m.home)===teamKey(team);
    const gf=Number(m.ft[h?0:1]||0), ga=Number(m.ft[h?1:0]||0);
    return {gf,ga,points:gf>ga?3:gf===ga?1:0,over:gf+ga>2.5?1:0};
  });
  const x=extract(recent);
  const hx=extract(home), ax=extract(away);
  const base=leagueStats(league);
  const avg=(arr,key, fallback)=>arr.length?weightedMean(arr.map(z=>z[key])):fallback;
  return {
    n:recent.length,
    gf:avg(x,"gf",base.teamGoals),
    ga:avg(x,"ga",base.teamGoals),
    homeGf:avg(hx,"gf",base.homeGoals), homeGa:avg(hx,"ga",base.awayGoals),
    awayGf:avg(ax,"gf",base.awayGoals), awayGa:avg(ax,"ga",base.homeGoals),
    points:avg(x,"points",1.25), over:avg(x,"over",base.overRate),
    last: recent.slice(-5).map(z=>{const h=teamKey(z.home)===teamKey(team);const gf=Number(z.ft[h?0:1]||0),ga=Number(z.ft[h?1:0]||0);return gf>ga?"W":gf===ga?"D":"L";})
  };
}

const leagueCache=new Map();
function leagueStats(league){
  const key=String(league||""); if(leagueCache.has(key)) return leagueCache.get(key);
  const ms=leagueMatches(key);
  let hg=[],ag=[],tot=[];
  ms.forEach(m=>{ const h=Number(m.ft[0]||0),a=Number(m.ft[1]||0);hg.push(h);ag.push(a);tot.push(h+a); });
  const g=(arr,f)=>arr.length?weightedMean(arr):f;
  const s={homeGoals:g(hg,1.35),awayGoals:g(ag,1.05),teamGoals:g(hg.concat(ag),1.20),overRate:g(tot.map(x=>x>2.5?1:0),0.50),n:ms.length};
  leagueCache.set(key,s); return s;
}

function poisson(k,lambda){
  let p=Math.exp(-lambda), term=p;
  for(let i=1;i<=k;i++){ term*=lambda/i; p+=term; }
  return term;
}
function scoreProb(h,a){
  let ph=poisson(h,a); // replaced below; kept separate for readability
  return ph;
}
function poissonMass(k,lambda){
  if(k<0) return 0;
  let p=Math.exp(-lambda);
  for(let i=1;i<=k;i++) p*=lambda/i;
  return p;
}

function estimate(m){
  const league=leagueStats(m.league);
  const H=teamStats(m.home,m.league), A=teamStats(m.away,m.league);
  const nH=Math.min(H.n,12), nA=Math.min(A.n,12);
  const shrinkH=nH/(nH+4), shrinkA=nA/(nA+4);

  // Strength relative to the same league baseline. More recent matches have more weight.
  const hAttackRaw=H.homeGf/Math.max(.25,league.homeGoals);
  const hDefenseRaw=H.homeGa/Math.max(.25,league.awayGoals);
  const aAttackRaw=A.awayGf/Math.max(.25,league.awayGoals);
  const aDefenseRaw=A.awayGa/Math.max(.25,league.homeGoals);
  const hAttack=1+(hAttackRaw-1)*shrinkH;
  const hDefense=1+(hDefenseRaw-1)*shrinkH;
  const aAttack=1+(aAttackRaw-1)*shrinkA;
  const aDefense=1+(aDefenseRaw-1)*shrinkA;

  let lambdaH=league.homeGoals*hAttack*aDefense;
  let lambdaA=league.awayGoals*aAttack*hDefense;
  lambdaH=clamp(lambdaH,.20,4.20); lambdaA=clamp(lambdaA,.20,4.20);

  // Small form adjustment so two teams with similar scoring still separate naturally.
  const formH=(H.points-1.25)*0.10, formA=(A.points-1.25)*0.10;
  lambdaH=clamp(lambdaH*(1+formH),.20,4.20);
  lambdaA=clamp(lambdaA*(1+formA),.20,4.20);

  let home=0,draw=0,away=0,over=0;
  let best={p:-1,h:0,a:0};
  for(let h=0;h<=7;h++) for(let a=0;a<=7;a++){
    const p=poissonMass(h,lambdaH)*poissonMass(a,lambdaA);
    if(h>a) home+=p; else if(h===a) draw+=p; else away+=p;
    if(h+a>=3) over+=p;
    if(p>best.p) best={p,h,a};
  }
  const total=home+draw+away;
  home/=total; draw/=total; away/=total;
  const overPct=clamp(over*100,5,95);
  const underPct=100-overPct;

  // Half-time expectation and most likely HT score; FT is the most likely score.
  const htH=lambdaH*.46, htA=lambdaA*.46;
  let bestHT={p:-1,h:0,a:0};
  for(let h=0;h<=5;h++) for(let a=0;a<=5;a++){
    const p=poissonMass(h,htH)*poissonMass(a,htA);
    if(p>bestHT.p) bestHT={p,h,a};
  }
  const htft=`${bestHT.h}-${bestHT.a} / ${best.h}-${best.a}`;
  return {
    home:Math.round(home*100), draw:Math.round(draw*100), away:Math.round(away*100),
    over:Math.round(overPct), under:Math.round(underPct), score:`${best.h}-${best.a}`,
    htft, lambdaH, lambdaA, samplesH:H.n, samplesA:A.n, formH:H.last.join(""), formA:A.last.join("")
  };
}

function initials(name){ return String(name||"").split(/\s+/).filter(Boolean).slice(0,2).map(x=>x[0]).join("").toUpperCase()||"?"; }
function teamLogoUrl(team){ return state.logoCache[String(team||"").trim()]||""; }

const LOGO_ALIASES={
  "red bull salzburg":"FC Red Bull Salzburg",
  "rapid wien":"SK Rapid",
  "west bromwich albion":"West Bromwich Albion F.C.",
  "charlton athletic":"Charlton Athletic F.C.",
  "queens park rangers":"Queens Park Rangers F.C.",
  "cardiff city":"Cardiff City F.C.",
  "millwall":"Millwall F.C.",
  "wrexham":"Wrexham A.F.C.",
  "barnsley":"Barnsley F.C.",
  "blackpool":"Blackpool F.C.",
  "manchester city":"Manchester City F.C.",
  "lazio":"S.S. Lazio",
  "liverpool":"Liverpool F.C.",
  "everton":"Everton F.C."
};
async function fetchLogo(team){
  const key=String(team||"").trim(); if(!key) return "";
  if(state.logoCache[key]) return state.logoCache[key];
  const q=LOGO_ALIASES[teamKey(key)]||key;
  const urls=[
    `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(q)}`,
    `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(q+" football club crest")}&gsrnamespace=6&gsrlimit=5&prop=imageinfo&iiprop=url&format=json&origin=*`,
    `https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(q+" football club")}&gsrnamespace=0&gsrlimit=5&prop=pageimages&piprop=thumbnail&pithumbsize=180&format=json&origin=*`
  ];
  for(const url of urls){
    try{
      const r=await fetch(url,{cache:"no-store",mode:"cors"}); if(!r.ok) continue;
      const j=await r.json();
      let src=j.thumbnail?.source||j.originalimage?.source||"";
      if(!src && j.query?.pages){
        for(const p of Object.values(j.query.pages)) src=src||p.imageinfo?.[0]?.url||p.thumbnail?.source||"";
      }
      if(src){ state.logoCache[key]=src; localStorage.setItem("jayasona_logo_cache",JSON.stringify(state.logoCache)); return src; }
    }catch(e){}
  }
  return "";
}
function logoHtml(team){
  const src=teamLogoUrl(team);
  return `<div class="logo">${src?`<img src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer">`:`<span class="logo-fallback">${esc(initials(team))}</span>`}</div>`;
}
function statusInfo(m){ if(isLive(m)) return {text:"● LIVE",cls:"live"}; if(isCompleted(m)) return {text:"SELESAI",cls:"done"}; return {text:"MENDATANG",cls:"upcoming"}; }
function timeOnly(k){ const s=String(k||""); const x=s.match(/(\d{1,2}:\d{2}\s*(?:AM|PM))/i); return x?x[1].toUpperCase():s; }
function matchesForDisplay(){
  const q=state.search.toLowerCase().trim();
  return state.data.matches.filter(m=>{
    const hay=`${m.home||""} ${m.away||""} ${m.league||""}`.toLowerCase();
    if(q&&!hay.includes(q)) return false;
    if(state.filter==="live"&&!isLive(m)) return false;
    if(state.filter==="upcoming"&&(isLive(m)||isCompleted(m))) return false;
    if(state.filter==="favorite"&&!state.favorites.has(m.id)) return false;
    return true;
  });
}
function renderQuick(){
  const all=[]; for(const m of state.data.matches){for(const t of [m.home,m.away]) if(t&&!all.includes(t)) all.push(t); if(all.length>=10) break;}
  $("quickClubs").innerHTML=all.slice(0,8).map(t=>`<button class="quick" data-club="${esc(t)}">⚽ ${esc(t)}</button>`).join("");
  document.querySelectorAll(".quick").forEach(b=>b.onclick=()=>{$("search").value=b.dataset.club;state.search=b.dataset.club;render();});
}
function card(m){
  const s=statusInfo(m), pred=estimate(m), fav=state.favorites.has(m.id), future=!isCompleted(m);
  const score=m.ft?arrScore(m.ft):"— - —";
  const ht=m.ht?arrScore(m.ht):(future?pred.htft.split(" / ")[0]:"—");
  return `<article class="match-card">
    <div class="card-top"><span>${esc(timeOnly(m.kickoff))}</span><span class="status ${s.cls}">${s.text}</span></div>
    <div class="teams">
      <div class="team">${logoHtml(m.home)}<div class="team-name">${esc(m.home)}</div></div>
      <div class="scorebox"><div class="score">${esc(score)}</div><div class="period">${isLive(m)||future?"15 MIN":"FT"}</div></div>
      <div class="team">${logoHtml(m.away)}<div class="team-name">${esc(m.away)}</div></div>
    </div>
    <div class="metrics">
      <div class="metric"><span class="label">HOME</span><span class="value">${future?pred.home+"%":"—"}</span></div>
      <div class="metric"><span class="label">DRAW</span><span class="value">${future?pred.draw+"%":"—"}</span></div>
      <div class="metric"><span class="label">AWAY</span><span class="value">${future?pred.away+"%":"—"}</span></div>
      <div class="metric"><span class="label">OVER 2.5</span><span class="value">${future?pred.over+"%":pred.over+"%"}</span></div>
      <div class="metric"><span class="label">UNDER 2.5</span><span class="value">${pred.under}%</span></div>
      <div class="metric"><span class="label">HT / FT</span><span class="value">${esc(ht)}</span></div>
    </div>
    <div class="actions"><button class="action favorite ${fav?"active":""}" data-fav="${esc(m.id)}">${fav?"★ Favorit":"☆ Favorit"}</button><button class="action detail" data-detail="${esc(m.id)}">Detail pertandingan</button></div>
  </article>`;
}
function render(){
  const ms=matchesForDisplay(), groups={};
  for(const m of ms)(groups[m.league||"SABA CLUB FRIENDLY · PES 21"]||=[]).push(m);
  let html=""; for(const [league,arr] of Object.entries(groups)){html+=`<div class="league-head"><span>⚽ ${esc(league)}</span><span class="league-count">${arr.length} pertandingan</span></div>`;html+=arr.map(card).join("");}
  $("matchList").innerHTML=html; $("empty").classList.toggle("hidden",!!ms.length); bindCards();
}
function bindCards(){
  document.querySelectorAll("[data-fav]").forEach(b=>b.onclick=()=>{const id=b.dataset.fav;if(state.favorites.has(id))state.favorites.delete(id);else state.favorites.add(id);saveFav();render();toast(state.favorites.has(id)?"Ditambahkan ke Favorit":"Dihapus dari Favorit");});
  document.querySelectorAll("[data-detail]").forEach(b=>b.onclick=()=>{const m=state.data.matches.find(x=>String(x.id)===String(b.dataset.detail));if(!m)return;const p=estimate(m);alert(`${m.home} vs ${m.away}\n\nLiga: ${m.league||"-"}\nKickoff: ${m.kickoff||"-"}\nStatus: ${m.status||"-"}\nHT: ${arrScore(m.ht)}\nFT: ${arrScore(m.ft)}\n\nPREDIKSI V3.2 (historis)\nHome ${p.home}% · Draw ${p.draw}% · Away ${p.away}%\nOver 2.5 ${p.over}% · Under 2.5 ${p.under}%\nSkor model: ${p.score}\nHT/FT model: ${p.htft}\nSampel ${m.home}: ${p.samplesH} pertandingan\nSampel ${m.away}: ${p.samplesA} pertandingan`);});
}
async function load(){
  try{
    const r=await fetch("data.json?ts="+Date.now(),{cache:"no-store"});if(!r.ok)throw new Error("HTTP "+r.status);
    state.data=await r.json();normalizeMatches();leagueCache.clear();renderQuick();render();
    const teams=[...new Set(matchesForDisplay().flatMap(m=>[m.home,m.away]).filter(Boolean))];
    // Parallel lookup so logos appear much faster; fallback initials are always visible.
    await Promise.all(teams.map(t=>fetchLogo(t).then(src=>{if(src)render();})));
  }catch(e){$("matchList").innerHTML='<div class="empty">Gagal memuat data.json. Pastikan file data.json tetap ada di repository.</div>';}
}

document.querySelectorAll(".filter").forEach(b=>b.onclick=()=>{document.querySelectorAll(".filter").forEach(x=>x.classList.remove("active"));b.classList.add("active");state.filter=b.dataset.filter;render();});
$("search").addEventListener("input",e=>{state.search=e.target.value;render();});
$("searchToggle").onclick=()=>{$("searchWrap").scrollIntoView({behavior:"smooth",block:"center"});$("search").focus();};
$("menuToggle").onclick=()=>toast("JAYASONA PREDIKSI V"+VERSION);
document.querySelectorAll(".bottom-item").forEach(b=>b.onclick=()=>{const v=b.dataset.bottom;if(v==="favorite"){state.filter="favorite";document.querySelectorAll(".filter").forEach(x=>x.classList.toggle("active",x.dataset.filter==="favorite"));render();}else if(v==="live"){state.filter="live";document.querySelectorAll(".filter").forEach(x=>x.classList.toggle("active",x.dataset.filter==="live"));render();}else if(v==="home"){state.filter="all";document.querySelectorAll(".filter").forEach(x=>x.classList.toggle("active",x.dataset.filter==="all"));render();}else toast("Menu JAYASONA PREDIKSI");document.querySelectorAll(".bottom-item").forEach(x=>x.classList.toggle("active",x===b));});
load();
