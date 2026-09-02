/* JAYASONA PREDIKSI V3.2
   UI tetap V3.1.x. Mesin prediksi memakai pertandingan Completed yang ada di data.json.
   Model: weighted recent form + home/away split + league baseline + Poisson score model.
*/
const VERSION = "3.2.1";
const state = {
  data: {matches:[]},
  filter: "all",
  search: "",
  favorites: new Set(JSON.parse(localStorage.getItem("jayasona_favorites") || "[]")),
  logoCache: JSON.parse(localStorage.getItem("jayasona_logo_cache") || "{}"),
  predictionCache: new Map()
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

// ===== V3.2.1 INDIVIDUAL PREDICTION ENGINE =====
// Hanya memakai data pertandingan yang benar-benar selesai.
// Per pertandingan: 10 laga terakhir masing-masing tim + H2H terbaru.
// Tidak memakai angka prediksi baku yang sama untuk semua pertandingan.
function sortRecent(matches){
  return [...matches].sort((a,b)=>new Date(a.kickoff)-new Date(b.kickoff));
}
function historicalFor(team, league){
  const k=teamKey(team), l=String(league||"");
  return sortRecent(completedMatches().filter(m=>teamKey(m.home)===k || teamKey(m.away)===k)
    .filter(m=>!l || String(m.league||"")===l));
}
function teamHistory10(team){
  const k=teamKey(team);
  return sortRecent(completedMatches().filter(m=>teamKey(m.home)===k || teamKey(m.away)===k)).slice(-10);
}
function venueHistory10(team, venue){
  const k=teamKey(team);
  return sortRecent(completedMatches().filter(m=>{
    const isHome=teamKey(m.home)===k, isAway=teamKey(m.away)===k;
    return venue==='home' ? isHome : isAway;
  })).slice(-10);
}
function h2hHistory10(homeTeam, awayTeam){
  const h=teamKey(homeTeam), a=teamKey(awayTeam);
  return sortRecent(completedMatches().filter(m=>{
    const mh=teamKey(m.home), ma=teamKey(m.away);
    return (mh===h && ma===a) || (mh===a && ma===h);
  })).slice(-10);
}
function weightedMean(values){
  if(!values.length) return 0;
  let num=0, den=0;
  values.forEach((v,i)=>{ const w=Math.pow(0.82, values.length-1-i); num+=v*w; den+=w; });
  return den ? num/den : 0;
}
function matchSampleStats(games, team){
  const k=teamKey(team);
  const rows=games.map(m=>{
    const isHome=teamKey(m.home)===k;
    const gf=Number(m.ft[isHome?0:1]||0), ga=Number(m.ft[isHome?1:0]||0);
    return {gf,ga,points:gf>ga?3:gf===ga?1:0,over:gf+ga>2.5?1:0};
  });
  const avg=(key, fallback)=>rows.length?weightedMean(rows.map(x=>x[key])):fallback;
  return {
    n:rows.length,
    gf:avg('gf',1.2), ga:avg('ga',1.2),
    points:avg('points',1), over:avg('over',.5),
    wins:rows.filter(x=>x.points===3).length,
    draws:rows.filter(x=>x.points===1).length,
    losses:rows.filter(x=>x.points===0).length
  };
}
function teamStats(team, league){
  const recent=teamHistory10(team);
  const home=venueHistory10(team,'home');
  const away=venueHistory10(team,'away');
  const base=leagueStats(league);
  const all=matchSampleStats(recent,team);
  const hs=matchSampleStats(home,team);
  const as=matchSampleStats(away,team);
  const fallbackHome=base.homeGoals||1.35, fallbackAway=base.awayGoals||1.05;
  return {
    n:recent.length,
    gf:all.gf, ga:all.ga, points:all.points, over:all.over,
    homeN:hs.n, awayN:as.n,
    homeGf:hs.n?hs.gf:fallbackHome, homeGa:hs.n?hs.ga:fallbackAway,
    awayGf:as.n?as.gf:fallbackAway, awayGa:as.n?as.ga:fallbackHome,
    last:recent.slice(-5).map(m=>{
      const k=teamKey(team), isHome=teamKey(m.home)===k;
      const gf=Number(m.ft[isHome?0:1]||0), ga=Number(m.ft[isHome?1:0]||0);
      return gf>ga?'W':gf===ga?'D':'L';
    })
  };
}

const leagueCache=new Map();
function leagueStats(league){
  const key=String(league||""); if(leagueCache.has(key)) return leagueCache.get(key);
  const ms=completedMatches().filter(m=>String(m.league||"")===key);
  let hg=[],ag=[],tot=[];
  ms.forEach(m=>{ const h=Number(m.ft[0]||0),a=Number(m.ft[1]||0);hg.push(h);ag.push(a);tot.push(h+a); });
  const g=(arr,f)=>arr.length?weightedMean(arr):f;
  const s={homeGoals:g(hg,1.35),awayGoals:g(ag,1.05),teamGoals:g(hg.concat(ag),1.20),overRate:g(tot.map(x=>x>2.5?1:0),.50),n:ms.length};
  leagueCache.set(key,s); return s;
}

function poissonMass(k,lambda){
  if(k<0) return 0;
  let p=Math.exp(-lambda);
  for(let i=1;i<=k;i++) p*=lambda/i;
  return p;
}
function estimate(m){
  const cacheKey=String(m.id||"")+"|"+String(m.kickoff||"")+"|"+String(m.ft||"")+"|v321i";
  if(state.predictionCache.has(cacheKey)) return state.predictionCache.get(cacheKey);

  const league=leagueStats(m.league);
  const H=teamStats(m.home,m.league), A=teamStats(m.away,m.league);
  const h2h=h2hHistory10(m.home,m.away);
  const h2hHome=matchSampleStats(h2h,m.home);
  const h2hAway=matchSampleStats(h2h,m.away);

  // V3.2.1: individual model. Recent 10 matches are primary; venue split and H2H
  // are separate signals. No fixed 44/27/29 or 50/50 prediction is used.
  const recencyWeight=(n)=>n>=10?1:0.55+0.045*n;
  const hRecentW=recencyWeight(H.n), aRecentW=recencyWeight(A.n);
  const hVenueW=H.homeN?Math.min(0.24,0.08+H.homeN*0.016):0;
  const aVenueW=A.awayN?Math.min(0.24,0.08+A.awayN*0.016):0;

  const leagueH=league.homeGoals||1.35, leagueA=league.awayGoals||1.05;
  const hRecentAttack=H.n?H.gf:leagueH;
  const hRecentDefense=H.n?H.ga:leagueA;
  const aRecentAttack=A.n?A.gf:leagueA;
  const aRecentDefense=A.n?A.ga:leagueH;

  // Venue performance pulls the expected goals toward the team's own home/away record.
  let hAttack=hRecentAttack*(1-hVenueW)+(H.homeN?H.homeGf:leagueH)*hVenueW;
  let hDefense=hRecentDefense*(1-hVenueW)+(H.homeN?H.homeGa:leagueA)*hVenueW;
  let aAttack=aRecentAttack*(1-aVenueW)+(A.awayN?A.awayGf:leagueA)*aVenueW;
  let aDefense=aRecentDefense*(1-aVenueW)+(A.awayN?A.awayGa:leagueH)*aVenueW;

  // Blend attack/defence using both teams' actual recent numbers.
  let lambdaH=0.56*hAttack+0.44*aDefense;
  let lambdaA=0.56*aAttack+0.44*hDefense;

  // League shrinkage only for missing team history, never as a fixed prediction.
  if(!H.n) lambdaH=0.72*lambdaH+0.28*leagueH;
  else if(H.n<10) lambdaH=0.88*lambdaH+0.12*leagueH;
  if(!A.n) lambdaA=0.72*lambdaA+0.28*leagueA;
  else if(A.n<10) lambdaA=0.88*lambdaA+0.12*leagueA;

  // Form points and goal difference from the last 10 produce an individual adjustment.
  const hForm=(H.points-1.0)*0.075 + (H.gf-H.ga)*0.025;
  const aForm=(A.points-1.0)*0.075 + (A.gf-A.ga)*0.025;
  lambdaH*=clamp(1+hForm*hRecentW,.82,1.20);
  lambdaA*=clamp(1+aForm*aRecentW,.82,1.20);

  // H2H: use only meetings between these exact two clubs, weighted to recent meetings.
  if(h2h.length){
    const h2hW=Math.min(0.24,0.06+h2h.length*0.018);
    const h2hHG=h2hHome.gf, h2hAG=h2hAway.gf;
    const h2hLambdaH=(h2hHG+h2hAG)/2;
    const h2hLambdaA=(h2hAG+h2hHG)/2;
    lambdaH=(1-h2hW)*lambdaH+h2hW*Math.max(0.25,h2hLambdaH);
    lambdaA=(1-h2hW)*lambdaA+h2hW*Math.max(0.20,h2hLambdaA);

    // H2H result edge adds a small directional correction.
    const hPts=h2hHome.points, aPts=h2hAway.points;
    const edge=clamp((hPts-aPts)*0.035,-0.10,0.10);
    lambdaH*=1+edge; lambdaA*=1-edge;
  }

  lambdaH=clamp(lambdaH,.20,4.20);
  lambdaA=clamp(lambdaA,.20,4.20);

  let home=0,draw=0,away=0,over=0,best={p:-1,h:0,a:0};
  for(let h=0;h<=8;h++) for(let a=0;a<=8;a++){
    const p=poissonMass(h,lambdaH)*poissonMass(a,lambdaA);
    if(h>a) home+=p; else if(h===a) draw+=p; else away+=p;
    if(h+a>=3) over+=p;
    if(p>best.p) best={p,h,a};
  }
  const total=home+draw+away;
  home/=total; draw/=total; away/=total;

  const overPct=clamp(over*100,5,95), underPct=100-overPct;
  const htH=lambdaH*.44, htA=lambdaA*.44;
  let bestHT={p:-1,h:0,a:0};
  for(let h=0;h<=5;h++) for(let a=0;a<=5;a++){
    const p=poissonMass(h,htH)*poissonMass(a,htA);
    if(p>bestHT.p) bestHT={p,h,a};
  }

  // Confidence reflects how much actual evidence exists, including H2H.
  const evidence=Math.min(H.n,10)+Math.min(A.n,10)+Math.min(h2h.length,10);
  const confidence=Math.round(clamp(38+evidence*1.55+(H.homeN?3:0)+(A.awayN?3:0),38,92));

  const result={
    home:Math.round(home*100),draw:Math.round(draw*100),away:Math.round(away*100),
    over:Math.round(overPct),under:Math.round(underPct),score:`${best.h}-${best.a}`,
    htft:`${bestHT.h}-${bestHT.a} / ${best.h}-${best.a}`,
    lambdaH,lambdaA,samplesH:H.n,samplesA:A.n,h2hSamples:h2h.length,
    formH:H.last.join(''),formA:A.last.join(''),confidence
  };
  state.predictionCache.set(cacheKey,result);
  return result;
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
    // Completed matches remain in data.json as archive/history, but are never shown in the main app.
    if(isCompleted(m)) return false;
    if(state.filter==="live"&&!isLive(m)) return false;
    if(state.filter==="upcoming"&&isLive(m)) return false;
    if(state.filter==="favorite"&&!state.favorites.has(m.id)) return false;
    return true;
  });
}
function renderQuick(){
  const all=[]; for(const m of matchesForDisplay()){for(const t of [m.home,m.away]) if(t&&!all.includes(t)) all.push(t); if(all.length>=10) break;}
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
  document.querySelectorAll("[data-detail]").forEach(b=>b.onclick=()=>{const m=state.data.matches.find(x=>String(x.id)===String(b.dataset.detail));if(!m)return;const p=estimate(m);alert(`${m.home} vs ${m.away}\n\nLiga: ${m.league||"-"}\nKickoff: ${m.kickoff||"-"}\nStatus: ${m.status||"-"}\nHT: ${arrScore(m.ht)}\nFT: ${arrScore(m.ft)}\n\nPREDIKSI V3.2.1 (10 LAGA + H2H)\nHome ${p.home}% · Draw ${p.draw}% · Away ${p.away}%\nOver 2.5 ${p.over}% · Under 2.5 ${p.under}%\nSkor model: ${p.score}\nHT/FT model: ${p.htft}\nSampel ${m.home}: ${p.samplesH} pertandingan\nSampel ${m.away}: ${p.samplesA} pertandingan\nH2H: ${p.h2hSamples} pertandingan\nConfidence: ${p.confidence}%`);});
}
async function load(){
  try{
    const r=await fetch("data.json?ts="+Date.now(),{cache:"no-store"});if(!r.ok)throw new Error("HTTP "+r.status);
    state.data=await r.json();normalizeMatches();leagueCache.clear();state.predictionCache.clear();renderQuick();render();
    const teams=[...new Set(matchesForDisplay().flatMap(m=>[m.home,m.away]).filter(Boolean))];
    // Parallel lookup so logos appear much faster; fallback initials are always visible.
    // Load logos without re-rendering the entire page for every single request.
    const results=await Promise.all(teams.map(t=>fetchLogo(t)));
    if(results.some(Boolean)) render();
  }catch(e){$("matchList").innerHTML='<div class="empty">Gagal memuat data.json. Pastikan file data.json tetap ada di repository.</div>';}
}

document.querySelectorAll(".filter").forEach(b=>b.onclick=()=>{document.querySelectorAll(".filter").forEach(x=>x.classList.remove("active"));b.classList.add("active");state.filter=b.dataset.filter;render();});
$("search").addEventListener("input",e=>{state.search=e.target.value;render();});
$("searchToggle").onclick=()=>{$("searchWrap").scrollIntoView({behavior:"smooth",block:"center"});$("search").focus();};
$("menuToggle").onclick=()=>toast("JAYASONA PREDIKSI V"+VERSION);
document.querySelectorAll(".bottom-item").forEach(b=>b.onclick=()=>{const v=b.dataset.bottom;if(v==="favorite"){state.filter="favorite";document.querySelectorAll(".filter").forEach(x=>x.classList.toggle("active",x.dataset.filter==="favorite"));render();}else if(v==="live"){state.filter="live";document.querySelectorAll(".filter").forEach(x=>x.classList.toggle("active",x.dataset.filter==="live"));render();}else if(v==="home"){state.filter="all";document.querySelectorAll(".filter").forEach(x=>x.classList.toggle("active",x.dataset.filter==="all"));render();}else toast("Menu JAYASONA PREDIKSI");document.querySelectorAll(".bottom-item").forEach(x=>x.classList.toggle("active",x===b));});
load();
