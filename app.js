const state = {
  data: {matches:[]},
  filter: "all",
  search: "",
  favorites: new Set(JSON.parse(localStorage.getItem("jayasona_favorites") || "[]")),
  logoCache: JSON.parse(localStorage.getItem("jayasona_logo_cache") || "{}")
};

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[s]));
const arrScore = (v) => Array.isArray(v) ? v.join(" - ") : (v === null || v === undefined || v === "" ? "—" : String(v));
const isCompleted = m => String(m.status||"").toLowerCase() === "completed" || Array.isArray(m.ft);
const isLive = m => /running|live/i.test(String(m.status||""));
const kickoffDate = m => {
  const d = new Date(String(m.kickoff || "").replace("Sep ", "Sep "));
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
};
const initials = name => String(name||"").split(/\s+/).filter(Boolean).slice(0,2).map(x=>x[0]).join("").toUpperCase() || "?";

function saveFav(){
  localStorage.setItem("jayasona_favorites", JSON.stringify([...state.favorites]));
}
function toast(msg){
  const t=$("toast"); t.textContent=msg; t.classList.add("show");
  clearTimeout(window.__toast); window.__toast=setTimeout(()=>t.classList.remove("show"),1800);
}
function normalizeMatches(){
  state.data.matches = (state.data.matches || []).map(m => {
    // Supports both the current V3.1.1 array format and the older sync format.
    const ht = Array.isArray(m.ht) ? m.ht : (
      m.ht_home !== undefined && m.ht_away !== undefined && m.ht_home !== "" && m.ht_away !== ""
        ? [Number(m.ht_home),Number(m.ht_away)] : null);
    const ft = Array.isArray(m.ft) ? m.ft : (
      m.final_home !== undefined && m.final_away !== undefined && m.final_home !== "" && m.final_away !== ""
        ? [Number(m.final_home),Number(m.final_away)] : null);
    return {...m, ht, ft};
  });
}
function historicalFor(team){
  return state.data.matches.filter(m => isCompleted(m) && (m.home===team || m.away===team) && Array.isArray(m.ft));
}
function estimate(m){
  // Lightweight, deterministic estimate using completed matches already in data.json.
  // It does not claim to be bookmaker odds or guaranteed outcomes.
  const h = historicalFor(m.home), a = historicalFor(m.away);
  const rate = (games, team) => {
    if(!games.length) return {p:1,d:1,g:1,over:0.5};
    let pts=0, gf=0, ga=0, over=0;
    for(const x of games.slice(-30)){
      const home=x.home===team, gf0=Number(x.ft?.[home?0:1]||0), ga0=Number(x.ft?.[home?1:0]||0);
      gf+=gf0; ga+=ga0; pts += gf0>ga0?3:(gf0===ga0?1:0); over += gf0+ga0>2.5?1:0;
    }
    const n=Math.min(games.length,30);
    return {p:pts/n,d:1-(pts/(3*n)),g:(gf/n+1)/(ga/n+1),over:over/n};
  };
  const H=rate(h,m.home), A=rate(a,m.away);
  let hp=H.g/(H.g+A.g+0.9), ap=A.g/(H.g+A.g+0.9);
  let dp=Math.max(.12, 1-hp-ap);
  const total=hp+dp+ap; hp/=total; dp/=total; ap/=total;
  const over=Math.max(.05,Math.min(.95,(H.over+A.over)/2));
  return {home:Math.round(hp*100),draw:Math.round(dp*100),away:Math.round(ap*100),over:Math.round(over*100),under:Math.round((1-over)*100)};
}
function teamLogoUrl(team){
  const key=String(team||"").trim();
  if(!key) return "";
  if(state.logoCache[key]) return state.logoCache[key];
  return "";
}
async function fetchLogo(team){
  const key=String(team||"").trim();
  if(!key || state.logoCache[key]) return state.logoCache[key] || "";

  // Try Wikimedia's page summary first: it is stable and usually returns the
  // club crest/logo as the page image. Then fall back to the MediaWiki search.
  const candidates = [
    `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(key)}`,
    `https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(key+" football club crest")}&gsrnamespace=0&gsrlimit=3&prop=pageimages&piprop=thumbnail&pithumbsize=160&format=json&origin=*`
  ];

  for(const url of candidates){
    try{
      const r=await fetch(url,{cache:"force-cache",mode:"cors"});
      if(!r.ok) continue;
      const j=await r.json();
      const src = j.thumbnail?.source || j.originalimage?.source ||
        (j.query?.pages ? Object.values(j.query.pages).map(x=>x.thumbnail?.source).find(Boolean) : "") || "";
      if(src){
        state.logoCache[key]=src;
        localStorage.setItem("jayasona_logo_cache",JSON.stringify(state.logoCache));
        return src;
      }
    }catch(e){}
  }
  return "";
}
function logoHtml(team){
  const src=teamLogoUrl(team);
  return `<div class="logo">${src ? `<img src="${esc(src)}" alt="" loading="lazy">` : `<span class="logo-fallback">${esc(initials(team))}</span>`}</div>`;
}
function statusInfo(m){
  if(isLive(m)) return {text:"● LIVE",cls:"live"};
  if(isCompleted(m)) return {text:"SELESAI",cls:"done"};
  return {text:"MENDATANG",cls:"upcoming"};
}
function timeOnly(k){
  const s=String(k||"");
  const x=s.match(/(\d{1,2}:\d{2}\s*(?:AM|PM))/i);
  return x ? x[1].toUpperCase() : s;
}
function matchesForDisplay(){
  const q=state.search.toLowerCase().trim();
  return state.data.matches.filter(m=>{
    const hay=`${m.home||""} ${m.away||""} ${m.league||""}`.toLowerCase();
    if(q && !hay.includes(q)) return false;
    if(state.filter==="live" && !isLive(m)) return false;
    if(state.filter==="upcoming" && (isLive(m)||isCompleted(m))) return false;
    if(state.filter==="favorite" && !state.favorites.has(m.id)) return false;
    return true;
  });
}
function renderQuick(){
  const all=[];
  for(const m of state.data.matches){
    for(const t of [m.home,m.away]) if(t && !all.includes(t)) all.push(t);
    if(all.length>=10) break;
  }
  $("quickClubs").innerHTML=all.slice(0,8).map(t=>`<button class="quick" data-club="${esc(t)}">⚽ ${esc(t)}</button>`).join("");
  document.querySelectorAll(".quick").forEach(b=>b.onclick=()=>{ $("search").value=b.dataset.club; state.search=b.dataset.club; render(); });
}
function card(m){
  const s=statusInfo(m), pred=estimate(m), fav=state.favorites.has(m.id);
  const future=!isCompleted(m);
  const score = m.ft ? arrScore(m.ft) : "— - —";
  const ht = m.ht ? arrScore(m.ht) : "—";
  return `<article class="match-card">
    <div class="card-top"><span>${esc(timeOnly(m.kickoff))}</span><span class="status ${s.cls}">${s.text}</span></div>
    <div class="teams">
      <div class="team">${logoHtml(m.home)}<div class="team-name">${esc(m.home)}</div></div>
      <div class="scorebox"><div class="score">${esc(score)}</div><div class="period">${isLive(m)||future ? "15 MIN" : "FT"}</div></div>
      <div class="team">${logoHtml(m.away)}<div class="team-name">${esc(m.away)}</div></div>
    </div>
    <div class="metrics">
      <div class="metric"><span class="label">HOME</span><span class="value">${future ? pred.home+"%" : "—"}</span></div>
      <div class="metric"><span class="label">DRAW</span><span class="value">${future ? pred.draw+"%" : "—"}</span></div>
      <div class="metric"><span class="label">AWAY</span><span class="value">${future ? pred.away+"%" : "—"}</span></div>
      <div class="metric"><span class="label">OVER 2.5</span><span class="value">${pred.over}%</span></div>
      <div class="metric"><span class="label">UNDER 2.5</span><span class="value">${pred.under}%</span></div>
      <div class="metric"><span class="label">HT / FT</span><span class="value">${esc(ht)}</span></div>
    </div>
    <div class="actions">
      <button class="action favorite ${fav?"active":""}" data-fav="${esc(m.id)}">${fav?"★ Favorit":"☆ Favorit"}</button>
      <button class="action detail" data-detail="${esc(m.id)}">Detail pertandingan</button>
    </div>
  </article>`;
}
function render(){
  const ms=matchesForDisplay();
  const groups={};
  for(const m of ms) (groups[m.league||"SABA CLUB FRIENDLY · PES 21"] ||= []).push(m);
  let html="";
  for(const [league,arr] of Object.entries(groups)){
    html+=`<div class="league-head"><span>⚽ ${esc(league)}</span><span class="league-count">${arr.length} pertandingan</span></div>`;
    html+=arr.map(card).join("");
  }
  $("matchList").innerHTML=html;
  $("empty").classList.toggle("hidden",!!ms.length);
  bindCards();
}
function bindCards(){
  document.querySelectorAll("[data-fav]").forEach(b=>b.onclick=()=>{
    const id=b.dataset.fav;
    if(state.favorites.has(id)) state.favorites.delete(id); else state.favorites.add(id);
    saveFav(); render(); toast(state.favorites.has(id)?"Ditambahkan ke Favorit":"Dihapus dari Favorit");
  });
  document.querySelectorAll("[data-detail]").forEach(b=>b.onclick=()=>{
    const m=state.data.matches.find(x=>String(x.id)===String(b.dataset.detail));
    if(!m) return;
    const p=estimate(m);
    alert(`${m.home} vs ${m.away}\n\nLiga: ${m.league||"-"}\nKickoff: ${m.kickoff||"-"}\nStatus: ${m.status||"-"}\nHT: ${arrScore(m.ht)}\nFT: ${arrScore(m.ft)}\n\nEstimasi Home ${p.home}% · Draw ${p.draw}% · Away ${p.away}%\nOver 2.5 ${p.over}% · Under 2.5 ${p.under}%`);
  });
}
async function load(){
  try{
    const r=await fetch("data.json?ts="+Date.now(),{cache:"no-store"});
    if(!r.ok) throw new Error("HTTP "+r.status);
    state.data=await r.json(); normalizeMatches(); renderQuick(); render();
    // Load logos for the teams currently displayed, not only the first 20
    // records. This fixes league sections farther down the page (e.g.
    // Millwall, Wrexham, West Bromwich Albion, Charlton Athletic).
    const loadVisibleLogos = async () => {
      const teams=[...new Set(matchesForDisplay().flatMap(m=>[m.home,m.away]).filter(Boolean))];
      for(const t of teams){
        const src=await fetchLogo(t);
        if(src) render();
      }
    };
    loadVisibleLogos();
  }catch(e){
    $("matchList").innerHTML='<div class="empty">Gagal memuat data.json. Pastikan file data.json tetap ada di repository.</div>';
  }
}
document.querySelectorAll(".filter").forEach(b=>b.onclick=()=>{
  document.querySelectorAll(".filter").forEach(x=>x.classList.remove("active"));
  b.classList.add("active"); state.filter=b.dataset.filter; render();
});
$("search").addEventListener("input",e=>{state.search=e.target.value;render()});
$("searchToggle").onclick=()=>{ $("searchWrap").scrollIntoView({behavior:"smooth",block:"center"}); $("search").focus(); };
$("menuToggle").onclick=()=>toast("Menu JAYASONA PREDIKSI");
document.querySelectorAll(".bottom-item").forEach(b=>b.onclick=()=>{
  const v=b.dataset.bottom;
  if(v==="favorite"){state.filter="favorite";document.querySelectorAll(".filter").forEach(x=>x.classList.toggle("active",x.dataset.filter==="favorite"));render();}
  else if(v==="live"){state.filter="live";document.querySelectorAll(".filter").forEach(x=>x.classList.toggle("active",x.dataset.filter==="live"));render();}
  else if(v==="home"){state.filter="all";document.querySelectorAll(".filter").forEach(x=>x.classList.toggle("active",x.dataset.filter==="all"));render();}
  else toast("Menu JAYASONA PREDIKSI");
  document.querySelectorAll(".bottom-item").forEach(x=>x.classList.toggle("active",x===b));
});
load();
