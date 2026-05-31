/* Hydranten-Erfasser – PWA zum Eintragen von Wasserentnahmestellen in OpenStreetMap.
   OAuth2 (PKCE, öffentlicher Client – kein Secret) direkt im Browser. */

"use strict";

// ─── Konfiguration ────────────────────────────────────────────────────────────
const CONFIG = {
  scopes:   "read_prefs write_api",
  osmBase:  "https://www.openstreetmap.org",
  apiBase:  "https://api.openstreetmap.org/api/0.6",
  center:   [51.700, 14.41],   // Neuhausen/Spree
  zoom:     12,
  createdBy:"Hydranten-Erfasser 1.0",
};
// Redirect-URI = genau diese Seite (ohne Query/Hash)
const REDIRECT_URI = location.origin + location.pathname;
document.getElementById("redir").textContent = REDIRECT_URI;

// Client ID kommt aus localStorage (vom Einrichtungs-Schritt)
let CLIENT_ID = localStorage.getItem("wb_client_id") || "";

// ─── Kategorien (Tags exakt wie unsere Karte sie auswertet) ─────────────────────
const CATS = [
  { id:"hyd_u", label:"Hydrant\nUnterflur", ic:"🔴",
    tags:{ emergency:"fire_hydrant", "fire_hydrant:type":"underground" }, fields:["diameter","note","check_date"] },
  { id:"hyd_p", label:"Hydrant\nÜberflur", ic:"🔴",
    tags:{ emergency:"fire_hydrant", "fire_hydrant:type":"pillar" }, fields:["diameter","note","check_date"] },
  { id:"hyd_w", label:"Wand-\nhydrant", ic:"🔴",
    tags:{ emergency:"fire_hydrant", "fire_hydrant:type":"wall" }, fields:["diameter","note","check_date"] },
  { id:"brunnen", label:"Lösch-\nbrunnen", ic:"🔷",
    tags:{ emergency:"fire_hydrant", "fire_hydrant:type":"pipe" }, fields:["note","check_date"] },
  { id:"tank", label:"Wasser-\nbehälter", ic:"🟩",
    tags:{ emergency:"water_tank" }, fields:["volume","note","check_date"] },
  { id:"pond", label:"Lösch-\nteich", ic:"🟩",
    tags:{ emergency:"fire_water_pond" }, fields:["note","check_date"] },
  { id:"suction", label:"Saug-\nstelle", ic:"🔻",
    tags:{ emergency:"suction_point" }, fields:["note","check_date"] },
  { id:"rescue", label:"Rettungs-\npunkt", ic:"🔺",
    tags:{ highway:"emergency_access_point" }, fields:["ref","note"] },
];

const FIELDDEF = {
  diameter:   { label:"Nennweite (mm)", type:"select", opts:["","80","100","150","200"], tag:"fire_hydrant:diameter" },
  volume:     { label:"Volumen (m³)",   type:"number", tag:"water_tank:volume" },
  ref:        { label:"Rettungspunkt-Nr. (z.B. BB-1234)", type:"text", tag:"ref" },
  note:       { label:"Hinweis (frei)", type:"text", tag:"note" },
  check_date: { label:"Geprüft am",     type:"date", tag:"check_date" },
};

// ─── Karte ──────────────────────────────────────────────────────────────────
const map = L.map("map", { zoomControl:true }).setView(CONFIG.center, CONFIG.zoom);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom:19, attribution:"© OpenStreetMap-Mitwirkende"
}).addTo(map);
const layerNeu = L.layerGroup().addTo(map);   // selbst erfasste Punkte

// GPS
let posMarker=null, accCircle=null;
document.getElementById("gps").onclick = () => {
  if(!navigator.geolocation){ toast("Kein GPS verfügbar"); return; }
  navigator.geolocation.getCurrentPosition(p=>{
    const ll=[p.coords.latitude,p.coords.longitude];
    map.setView(ll, 18);
    if(posMarker) posMarker.setLatLng(ll); else posMarker=L.circleMarker(ll,{radius:7,color:"#1565c0",fillColor:"#1565c0",fillOpacity:1}).addTo(map);
    if(accCircle) accCircle.setLatLng(ll).setRadius(p.coords.accuracy); else accCircle=L.circle(ll,{radius:p.coords.accuracy,color:"#1565c0",weight:1,fillOpacity:.08}).addTo(map);
  }, ()=>toast("Standort nicht ermittelbar"), { enableHighAccuracy:true, timeout:10000 });
};

// ─── Erfassungs-Sheet ─────────────────────────────────────────────────────────
const sheet=document.getElementById("sheet"), catsEl=document.getElementById("cats"),
      fieldsEl=document.getElementById("fields"), posEl=document.getElementById("pos");
let chosen=null, captureLatLng=null;

CATS.forEach(c=>{
  const d=document.createElement("div"); d.className="cat"; d.dataset.id=c.id;
  d.innerHTML=`<span class="ic">${c.ic}</span>${c.label.replace(/\n/g,"<br>")}`;
  d.onclick=()=>{ chosen=c; document.querySelectorAll(".cat").forEach(x=>x.classList.remove("act")); d.classList.add("act"); renderFields(c); };
  catsEl.appendChild(d);
});

function renderFields(c){
  fieldsEl.innerHTML="";
  c.fields.forEach(fk=>{
    const f=FIELDDEF[fk]; const id="f_"+fk;
    const lab=document.createElement("label"); lab.textContent=f.label; lab.htmlFor=id;
    let inp;
    if(f.type==="select"){ inp=document.createElement("select"); f.opts.forEach(o=>{const op=document.createElement("option");op.value=o;op.textContent=o||"– keine Angabe –";inp.appendChild(op);}); }
    else { inp=document.createElement("input"); inp.type=f.type; }
    inp.id=id; inp.dataset.tag=f.tag;
    if(fk==="check_date") inp.value=new Date().toISOString().slice(0,10);
    fieldsEl.appendChild(lab); fieldsEl.appendChild(inp);
  });
}

document.getElementById("add").onclick=()=>{
  if(!token()){ toast("Bitte zuerst anmelden"); return; }
  captureLatLng=map.getCenter();
  chosen=null; document.querySelectorAll(".cat").forEach(x=>x.classList.remove("act")); fieldsEl.innerHTML="";
  posEl.textContent=`Position: ${captureLatLng.lat.toFixed(6)}, ${captureLatLng.lng.toFixed(6)}  (Fadenkreuz)`;
  sheet.classList.add("open");
};
document.getElementById("cancel").onclick=()=>sheet.classList.remove("open");

document.getElementById("save").onclick=async()=>{
  if(!chosen){ toast("Bitte eine Kategorie wählen"); return; }
  const tags=Object.assign({}, chosen.tags);
  fieldsEl.querySelectorAll("[data-tag]").forEach(inp=>{ const v=(inp.value||"").trim(); if(v) tags[inp.dataset.tag]=v; });
  const btn=document.getElementById("save"); btn.disabled=true; btn.textContent="Lade hoch…";
  try{
    const id=await uploadNode(captureLatLng.lat, captureLatLng.lng, tags);
    L.marker([captureLatLng.lat, captureLatLng.lng]).addTo(layerNeu)
      .bindPopup(`✅ ${chosen.label.replace(/\n/g," ")}<br><a href="${CONFIG.osmBase}/node/${id}" target="_blank">Knoten ${id}</a>`).openPopup();
    sheet.classList.remove("open");
    toast(`Gespeichert ✓ <a href="${CONFIG.osmBase}/node/${id}" target="_blank">Knoten ${id} ansehen</a>`, 6000);
    document.getElementById("finish").classList.remove("hidden");
  }catch(e){ toast("Fehler: "+e.message, 7000); }
  finally{ btn.disabled=false; btn.textContent="In OSM speichern"; }
};

// ─── OSM-Upload (Changeset offen halten, am Ende schließen) ─────────────────────
let currentChangeset=null;

// XML-Sonderzeichen in Tag-Werten maskieren
function esc(s){
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;")
                  .replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;");
}

async function ensureChangeset(){
  if(currentChangeset) return currentChangeset;
  const body=`<osm><changeset>
    <tag k="created_by" v="${esc(CONFIG.createdBy)}"/>
    <tag k="comment" v="Wasserentnahmestellen/Rettungspunkte (Hydranten-Erfasser)"/>
  </changeset></osm>`;
  const r=await apiFetch("/changeset/create","PUT",body);
  currentChangeset=(await r.text()).trim();
  return currentChangeset;
}

async function uploadNode(lat,lon,tags){
  const cs=await ensureChangeset();
  let tagXml=""; for(const k in tags) tagXml+=`<tag k="${esc(k)}" v="${esc(tags[k])}"/>`;
  const body=`<osm><node changeset="${cs}" lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}">${tagXml}</node></osm>`;
  const r=await apiFetch("/node/create","PUT",body);
  return (await r.text()).trim();
}

document.getElementById("finish").onclick=async()=>{
  if(!currentChangeset){ document.getElementById("finish").classList.add("hidden"); return; }
  try{ await apiFetch(`/changeset/${currentChangeset}/close`,"PUT",""); toast("Änderungssatz abgeschlossen ✓"); }
  catch(e){ toast("Konnte Änderungssatz nicht schließen: "+e.message); }
  currentChangeset=null; document.getElementById("finish").classList.add("hidden");
};

async function apiFetch(path,method,body){
  const r=await fetch(CONFIG.apiBase+path,{ method,
    headers:{ "Authorization":"Bearer "+token(), "Content-Type":"text/xml" }, body });
  if(r.status===401){ logout(); throw new Error("Nicht mehr angemeldet – bitte neu anmelden"); }
  if(!r.ok){ throw new Error(`OSM ${r.status}: ${(await r.text()).slice(0,120)}`); }
  return r;
}

// ─── OAuth2 PKCE ──────────────────────────────────────────────────────────────
function token(){ return localStorage.getItem("wb_token"); }
function logout(){ localStorage.removeItem("wb_token"); localStorage.removeItem("wb_user"); refreshAuthUI(); }

function b64url(buf){ return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,""); }
async function sha256(s){ return crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)); }
function randStr(n){ const a=new Uint8Array(n); crypto.getRandomValues(a); return Array.from(a,x=>("0"+(x&255).toString(16)).slice(-2)).join("").slice(0,n); }

async function login(){
  if(!CLIENT_ID){ document.getElementById("setup").style.display="block"; return; }
  const verifier=randStr(64);
  sessionStorage.setItem("wb_verifier",verifier);
  const challenge=b64url(await sha256(verifier));
  const url=new URL(CONFIG.osmBase+"/oauth2/authorize");
  url.search=new URLSearchParams({
    response_type:"code", client_id:CLIENT_ID, redirect_uri:REDIRECT_URI,
    scope:CONFIG.scopes, code_challenge:challenge, code_challenge_method:"S256"
  }).toString();
  location.href=url.toString();
}

async function handleRedirect(){
  const p=new URLSearchParams(location.search);
  if(p.get("error")){ toast("Anmeldung abgelehnt: "+p.get("error")); history.replaceState({},"",REDIRECT_URI); return; }
  const code=p.get("code"); if(!code) return;
  const verifier=sessionStorage.getItem("wb_verifier");
  history.replaceState({},"",REDIRECT_URI);   // Code aus URL entfernen
  try{
    const r=await fetch(CONFIG.osmBase+"/oauth2/token",{ method:"POST",
      headers:{ "Content-Type":"application/x-www-form-urlencoded" },
      body:new URLSearchParams({ grant_type:"authorization_code", code, redirect_uri:REDIRECT_URI, client_id:CLIENT_ID, code_verifier:verifier }) });
    if(!r.ok) throw new Error(await r.text());
    const j=await r.json();
    localStorage.setItem("wb_token", j.access_token);
    await fetchUser();
    toast("Angemeldet ✓");
  }catch(e){ toast("Token-Fehler: "+String(e).slice(0,140), 8000); }
  refreshAuthUI();
}

async function fetchUser(){
  try{
    const r=await fetch(CONFIG.apiBase+"/user/details.json",{ headers:{ "Authorization":"Bearer "+token() } });
    if(r.ok){ const j=await r.json(); localStorage.setItem("wb_user", j.user.display_name); }
  }catch(_){}
}

function refreshAuthUI(){
  const btn=document.getElementById("login"), who=document.getElementById("who");
  if(token()){ btn.textContent="Abmelden"; btn.onclick=logout; who.textContent=localStorage.getItem("wb_user")||"angemeldet"; }
  else{ btn.textContent="Anmelden"; btn.onclick=login; who.textContent=""; }
}

// ─── Einrichtung (Client ID) ───────────────────────────────────────────────────
document.getElementById("cidsave").onclick=()=>{
  const v=document.getElementById("cid").value.trim();
  if(!v){ toast("Bitte Client ID eingeben"); return; }
  localStorage.setItem("wb_client_id", v); CLIENT_ID=v;
  document.getElementById("setup").style.display="none";
  login();
};

// ─── Toast ──────────────────────────────────────────────────────────────────
let toastT=null;
function toast(html, ms=3500){ const t=document.getElementById("toast"); t.innerHTML=html; t.style.display="block";
  clearTimeout(toastT); toastT=setTimeout(()=>t.style.display="none", ms); }

// ─── Start ──────────────────────────────────────────────────────────────────
(async function init(){
  refreshAuthUI();
  await handleRedirect();
  if(token() && !localStorage.getItem("wb_user")) { await fetchUser(); refreshAuthUI(); }
  if("serviceWorker" in navigator){ try{ await navigator.serviceWorker.register("sw.js"); }catch(_){} }
})();
