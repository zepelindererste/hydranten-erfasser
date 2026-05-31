/* Hydranten-Erfasser – PWA zum Eintragen UND Bearbeiten von Wasserentnahmestellen
   in OpenStreetMap. OAuth2 (PKCE, öffentlicher Client – kein Secret) im Browser. */

"use strict";

// ─── Konfiguration ────────────────────────────────────────────────────────────
const CONFIG = {
  scopes:   "read_prefs write_api",
  osmBase:  "https://www.openstreetmap.org",
  apiBase:  "https://api.openstreetmap.org/api/0.6",
  center:   [51.700, 14.41],   // Neuhausen/Spree
  zoom:     12,
  minLoadZoom: 15,             // ab hier vorhandene Punkte laden
  createdBy:"Hydranten-Erfasser 1.0",
};
const REDIRECT_URI = location.origin + location.pathname;
document.getElementById("redir").textContent = REDIRECT_URI;
let CLIENT_ID = localStorage.getItem("wb_client_id") || "";

// ─── Kategorien (Tags exakt wie unsere Karte sie auswertet) ─────────────────────
const CATS = [
  { id:"hyd_u", label:"Hydrant\nUnterflur", ic:"🔴", color:"#CC0000",
    tags:{ emergency:"fire_hydrant", "fire_hydrant:type":"underground" }, fields:["diameter","note","check_date"] },
  { id:"hyd_p", label:"Hydrant\nÜberflur", ic:"🔴", color:"#CC0000",
    tags:{ emergency:"fire_hydrant", "fire_hydrant:type":"pillar" }, fields:["diameter","note","check_date"] },
  { id:"hyd_w", label:"Wand-\nhydrant", ic:"🔴", color:"#CC0000",
    tags:{ emergency:"fire_hydrant", "fire_hydrant:type":"wall" }, fields:["diameter","note","check_date"] },
  { id:"brunnen", label:"Lösch-\nbrunnen", ic:"🔷", color:"#1F4E8C",
    tags:{ emergency:"fire_hydrant", "fire_hydrant:type":"pipe" }, fields:["note","check_date"] },
  { id:"tank", label:"Wasser-\nbehälter", ic:"🟩", color:"#009688",
    tags:{ emergency:"water_tank" }, fields:["volume","note","check_date"] },
  { id:"pond", label:"Lösch-\nteich", ic:"🟩", color:"#009688",
    tags:{ emergency:"fire_water_pond" }, fields:["note","check_date"] },
  { id:"suction", label:"Saug-\nstelle", ic:"🔻", color:"#6BA6C2",
    tags:{ emergency:"suction_point" }, fields:["note","check_date"] },
  { id:"rescue", label:"Rettungs-\npunkt", ic:"🔺", color:"#FF8800",
    tags:{ highway:"emergency_access_point" }, fields:["ref","note"] },
];
const catById = id => CATS.find(c=>c.id===id);

const FIELDDEF = {
  diameter:   { label:"Nennweite (mm)", type:"select", opts:["","80","100","150","200"], tag:"fire_hydrant:diameter" },
  volume:     { label:"Volumen (m³)",   type:"number", tag:"water_tank:volume" },
  ref:        { label:"Rettungspunkt-Nr. (z.B. BB-1234)", type:"text", tag:"ref" },
  note:       { label:"Hinweis (frei)", type:"text", tag:"note" },
  check_date: { label:"Geprüft am",     type:"date", tag:"check_date" },
};
// Tags, die von Kategorie bzw. Feldern verwaltet werden (beim Bearbeiten zurückgesetzt)
const CAT_KEYS   = ["emergency","fire_hydrant:type","highway"];
const FIELD_TAGS = ["fire_hydrant:diameter","water_tank:volume","ref","note","check_date"];

// Kategorie eines vorhandenen OSM-Objekts erkennen
function detectCatId(t){
  if(t.emergency==="fire_hydrant"){
    if(t["fire_hydrant:type"]==="pipe")   return "brunnen";
    if(t["fire_hydrant:type"]==="pillar") return "hyd_p";
    if(t["fire_hydrant:type"]==="wall")   return "hyd_w";
    return "hyd_u";
  }
  if(t.emergency==="water_tank")        return "tank";
  if(t.emergency==="fire_water_pond")   return "pond";
  if(t.emergency==="suction_point" || t.emergency==="water_point") return "suction";
  if(t.highway==="emergency_access_point") return "rescue";
  return null;   // andere emergency-Typen (Sirene, Defi …) ignorieren
}

// ─── Karte ──────────────────────────────────────────────────────────────────
const map = L.map("map", { zoomControl:true }).setView(CONFIG.center, CONFIG.zoom);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom:19, attribution:"© OpenStreetMap-Mitwirkende"
}).addTo(map);
const layerExisting = L.layerGroup().addTo(map);  // vorhandene OSM-Punkte
const layerNeu      = L.layerGroup().addTo(map);  // gerade selbst erfasste

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

// ─── Vorhandene Punkte laden ──────────────────────────────────────────────────
let loadTimer=null, lastBboxKey="";
function status(msg){ const s=document.getElementById("status"); if(!msg){s.style.display="none";return;} s.textContent=msg; s.style.display="block"; }

map.on("moveend", ()=>{ clearTimeout(loadTimer); loadTimer=setTimeout(loadExisting, 500); });

async function loadExisting(){
  if(map.getZoom() < CONFIG.minLoadZoom){ status("Zum Laden vorhandener Punkte näher heranzoomen"); layerExisting.clearLayers(); lastBboxKey=""; return; }
  const b=map.getBounds();
  const key=[b.getSouth(),b.getWest(),b.getNorth(),b.getEast()].map(x=>x.toFixed(3)).join(",");
  if(key===lastBboxKey) return;  // gleiche Ansicht – nichts tun
  lastBboxKey=key;
  const bbox=`${b.getSouth()},${b.getWest()},${b.getNorth()},${b.getEast()}`;
  const q=`[out:json][timeout:25];(node["emergency"](${bbox});node["highway"="emergency_access_point"](${bbox}););out body;`;
  status("Lade vorhandene Punkte …");
  try{
    const r=await fetch("https://overpass-api.de/api/interpreter",{ method:"POST", body:new URLSearchParams({data:q}) });
    const j=await r.json();
    renderExisting(j.elements||[]);
    status("");
  }catch(e){ status("Overpass nicht erreichbar"); setTimeout(()=>status(""),2000); }
}

function renderExisting(els){
  layerExisting.clearLayers();
  let n=0;
  els.forEach(el=>{
    if(el.type!=="node") return;
    const cid=detectCatId(el.tags||{});
    if(!cid) return;   // nur unsere Kategorien
    const c=catById(cid);
    const m=L.circleMarker([el.lat,el.lon],{ radius:7, color:"#fff", weight:1.5, fillColor:c.color, fillOpacity:1 });
    m.on("click", ()=>openEdit(el, cid));
    m.addTo(layerExisting); n++;
  });
  status(n? "" : "Keine vorhandenen Punkte hier");
  if(!n) setTimeout(()=>status(""),1500);
}

// ─── Erfassungs-/Bearbeitungs-Sheet ────────────────────────────────────────────
const sheet=document.getElementById("sheet"), catsEl=document.getElementById("cats"),
      fieldsEl=document.getElementById("fields"), posEl=document.getElementById("pos"),
      titleEl=document.getElementById("sheetTitle"), delBtn=document.getElementById("delete");
let chosen=null, captureLatLng=null, mode="new", editEl=null;

CATS.forEach(c=>{
  const d=document.createElement("div"); d.className="cat"; d.dataset.id=c.id;
  d.innerHTML=`<span class="ic">${c.ic}</span>${c.label.replace(/\n/g,"<br>")}`;
  d.onclick=()=>{ chosen=c; document.querySelectorAll(".cat").forEach(x=>x.classList.remove("act")); d.classList.add("act"); renderFields(c); };
  catsEl.appendChild(d);
});

function renderFields(c, vals){
  fieldsEl.innerHTML="";
  c.fields.forEach(fk=>{
    const f=FIELDDEF[fk]; const id="f_"+fk;
    const lab=document.createElement("label"); lab.textContent=f.label; lab.htmlFor=id;
    let inp;
    if(f.type==="select"){ inp=document.createElement("select"); f.opts.forEach(o=>{const op=document.createElement("option");op.value=o;op.textContent=o||"– keine Angabe –";inp.appendChild(op);}); }
    else { inp=document.createElement("input"); inp.type=f.type; }
    inp.id=id; inp.dataset.tag=f.tag;
    if(vals && vals[f.tag]!=null) inp.value=vals[f.tag];
    else if(fk==="check_date") inp.value=new Date().toISOString().slice(0,10);
    fieldsEl.appendChild(lab); fieldsEl.appendChild(inp);
  });
}
function selectCat(c, vals){
  chosen=c;
  document.querySelectorAll(".cat").forEach(x=>x.classList.toggle("act", x.dataset.id===c.id));
  renderFields(c, vals);
}
function fieldInputs(){ return [...fieldsEl.querySelectorAll("[data-tag]")]; }

// Neu erfassen (Fadenkreuz)
document.getElementById("add").onclick=()=>{
  if(!token()){ toast("Bitte zuerst anmelden"); return; }
  mode="new"; editEl=null; chosen=null;
  titleEl.textContent="Neu erfassen"; delBtn.classList.add("hidden");
  document.getElementById("save").textContent="In OSM speichern";
  document.querySelectorAll(".cat").forEach(x=>x.classList.remove("act")); fieldsEl.innerHTML="";
  captureLatLng=map.getCenter();
  posEl.textContent=`Position: ${captureLatLng.lat.toFixed(6)}, ${captureLatLng.lng.toFixed(6)} (Fadenkreuz)`;
  sheet.classList.add("open");
};

// Vorhandenen Punkt bearbeiten
function openEdit(el, cid){
  if(!token()){ toast("Zum Bearbeiten bitte anmelden"); return; }
  mode="edit"; editEl=el;
  titleEl.textContent=`Bearbeiten · Knoten ${el.id}`;
  delBtn.classList.remove("hidden");
  document.getElementById("save").textContent="Änderung speichern";
  const c=catById(cid)||CATS[0];
  selectCat(c, el.tags||{});
  posEl.innerHTML=`Position: ${el.lat.toFixed(6)}, ${el.lon.toFixed(6)} · <a href="${CONFIG.osmBase}/node/${el.id}" target="_blank">auf OSM</a>`;
  sheet.classList.add("open");
}

document.getElementById("cancel").onclick=()=>sheet.classList.remove("open");

// Tags zusammenbauen (für neu UND bearbeiten; fremde Tags bleiben erhalten)
function buildTags(existing){
  const tags=Object.assign({}, existing||{});
  CAT_KEYS.forEach(k=>delete tags[k]);
  Object.assign(tags, chosen.tags);
  FIELD_TAGS.forEach(k=>delete tags[k]);
  fieldInputs().forEach(inp=>{ const v=(inp.value||"").trim(); if(v) tags[inp.dataset.tag]=v; });
  return tags;
}

document.getElementById("save").onclick=async()=>{
  if(!chosen){ toast("Bitte eine Kategorie wählen"); return; }
  const btn=document.getElementById("save"); btn.disabled=true; const label=btn.textContent; btn.textContent="Lade hoch …";
  try{
    if(mode==="new"){
      const tags=buildTags({});
      const id=await uploadNode(captureLatLng.lat, captureLatLng.lng, tags);
      L.marker([captureLatLng.lat, captureLatLng.lng]).addTo(layerNeu)
        .bindPopup(`✅ ${chosen.label.replace(/\n/g," ")}<br><a href="${CONFIG.osmBase}/node/${id}" target="_blank">Knoten ${id}</a>`).openPopup();
      toast(`Gespeichert ✓ <a href="${CONFIG.osmBase}/node/${id}" target="_blank">Knoten ${id}</a>`, 6000);
    } else {
      const ver=await updateNode(editEl.id);
      toast(`Geändert ✓ <a href="${CONFIG.osmBase}/node/${editEl.id}" target="_blank">Knoten ${editEl.id}</a> (v${ver})`, 6000);
    }
    sheet.classList.remove("open");
    document.getElementById("finish").classList.remove("hidden");
    lastBboxKey=""; loadExisting();   // Ansicht aktualisieren
  }catch(e){ toast("Fehler: "+e.message, 7000); }
  finally{ btn.disabled=false; btn.textContent=label; }
};

delBtn.onclick=async()=>{
  if(!editEl) return;
  if(!confirm(`Knoten ${editEl.id} wirklich aus OpenStreetMap löschen?`)) return;
  delBtn.disabled=true;
  try{
    await deleteNode(editEl.id);
    toast(`Gelöscht ✓ (Knoten ${editEl.id})`, 5000);
    sheet.classList.remove("open");
    document.getElementById("finish").classList.remove("hidden");
    lastBboxKey=""; loadExisting();
  }catch(e){ toast("Löschen fehlgeschlagen: "+e.message, 7000); }
  finally{ delBtn.disabled=false; }
};

// ─── OSM-Upload / -Änderung ─────────────────────────────────────────────────
let currentChangeset=null;
function esc(s){ return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;"); }

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
function tagsToXml(tags){ let s=""; for(const k in tags) s+=`<tag k="${esc(k)}" v="${esc(tags[k])}"/>`; return s; }

async function uploadNode(lat,lon,tags){
  const cs=await ensureChangeset();
  const body=`<osm><node changeset="${cs}" lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}">${tagsToXml(tags)}</node></osm>`;
  const r=await apiFetch("/node/create","PUT",body);
  return (await r.text()).trim();
}

// aktuelle Version + volle Tags frisch holen (gegen Konflikte)
async function fetchNodeFull(id){
  const r=await fetch(`${CONFIG.apiBase}/node/${id}.json`);
  if(!r.ok) throw new Error("Knoten nicht ladbar ("+r.status+")");
  return (await r.json()).elements[0];
}
async function updateNode(id){
  const cur=await fetchNodeFull(id);
  const tags=buildTags(cur.tags);            // fremde Tags bleiben erhalten
  const cs=await ensureChangeset();
  const body=`<osm><node id="${id}" version="${cur.version}" changeset="${cs}" lat="${cur.lat}" lon="${cur.lon}">${tagsToXml(tags)}</node></osm>`;
  const r=await apiFetch(`/node/${id}`,"PUT",body);
  return (await r.text()).trim();
}
async function deleteNode(id){
  const cur=await fetchNodeFull(id);
  const cs=await ensureChangeset();
  const body=`<osm><node id="${id}" version="${cur.version}" changeset="${cs}" lat="${cur.lat}" lon="${cur.lon}"/></osm>`;
  await apiFetch(`/node/${id}`,"DELETE",body);
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
  if(r.status===409){ throw new Error("Konflikt – jemand hat den Punkt zwischenzeitlich geändert. Karte neu laden."); }
  if(!r.ok){ throw new Error(`OSM ${r.status}: ${(await r.text()).slice(0,140)}`); }
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
  const verifier=randStr(64); sessionStorage.setItem("wb_verifier",verifier);
  const challenge=b64url(await sha256(verifier));
  const url=new URL(CONFIG.osmBase+"/oauth2/authorize");
  url.search=new URLSearchParams({ response_type:"code", client_id:CLIENT_ID, redirect_uri:REDIRECT_URI,
    scope:CONFIG.scopes, code_challenge:challenge, code_challenge_method:"S256" }).toString();
  location.href=url.toString();
}
async function handleRedirect(){
  const p=new URLSearchParams(location.search);
  if(p.get("error")){ toast("Anmeldung abgelehnt: "+p.get("error")); history.replaceState({},"",REDIRECT_URI); return; }
  const code=p.get("code"); if(!code) return;
  const verifier=sessionStorage.getItem("wb_verifier");
  history.replaceState({},"",REDIRECT_URI);
  try{
    const r=await fetch(CONFIG.osmBase+"/oauth2/token",{ method:"POST",
      headers:{ "Content-Type":"application/x-www-form-urlencoded" },
      body:new URLSearchParams({ grant_type:"authorization_code", code, redirect_uri:REDIRECT_URI, client_id:CLIENT_ID, code_verifier:verifier }) });
    if(!r.ok) throw new Error(await r.text());
    localStorage.setItem("wb_token",(await r.json()).access_token);
    await fetchUser(); toast("Angemeldet ✓");
  }catch(e){ toast("Token-Fehler: "+String(e).slice(0,140), 8000); }
  refreshAuthUI();
}
async function fetchUser(){
  try{ const r=await fetch(CONFIG.apiBase+"/user/details.json",{ headers:{ "Authorization":"Bearer "+token() } });
    if(r.ok) localStorage.setItem("wb_user",(await r.json()).user.display_name); }catch(_){}
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
  document.getElementById("setup").style.display="none"; login();
};

// ─── Toast ──────────────────────────────────────────────────────────────────
let toastT=null;
function toast(html, ms=3500){ const t=document.getElementById("toast"); t.innerHTML=html; t.style.display="block";
  clearTimeout(toastT); toastT=setTimeout(()=>t.style.display="none", ms); }

// ─── Start ──────────────────────────────────────────────────────────────────
(async function init(){
  refreshAuthUI();
  await handleRedirect();
  if(token() && !localStorage.getItem("wb_user")){ await fetchUser(); refreshAuthUI(); }
  loadExisting();
  if("serviceWorker" in navigator){ try{ await navigator.serviceWorker.register("sw.js"); }catch(_){} }
})();
