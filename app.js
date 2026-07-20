/* Hydranten-Erfasser – PWA zum Eintragen, Bearbeiten & Prüfen von Wasserentnahmestellen
   in OpenStreetMap. OAuth2 (PKCE) im Browser. Funktionen:
   Auto-GPS + vorhandene laden · Nennweiten-Chips · "Heute geprüft" · Offline-Warteschlange. */
"use strict";

const CONFIG = {
  scopes:"read_prefs write_api", osmBase:"https://www.openstreetmap.org",
  apiBase:"https://api.openstreetmap.org/api/0.6", center:[51.700,14.41], zoom:12,
  minLoadZoom:15, createdBy:"Hydranten-Erfasser 1.2",
  pmxApi:"https://api.panoramax.xyz/api",
};
const REDIRECT_URI = location.origin + location.pathname;
document.getElementById("redir").textContent = REDIRECT_URI;
let CLIENT_ID = localStorage.getItem("wb_client_id") || "";
const today = () => new Date().toISOString().slice(0,10);

// ─── Kategorien ────────────────────────────────────────────────────────────
const CATS = [
  { id:"hyd_u", label:"Hydrant\nUnterflur", ic:"🔴", color:"#CC0000",
    tags:{ emergency:"fire_hydrant","fire_hydrant:type":"underground" }, fields:["diameter","note","check_date"] },
  { id:"hyd_p", label:"Hydrant\nÜberflur", ic:"🔴", color:"#CC0000",
    tags:{ emergency:"fire_hydrant","fire_hydrant:type":"pillar" }, fields:["diameter","note","check_date"] },
  { id:"hyd_w", label:"Wand-\nhydrant", ic:"🔴", color:"#CC0000",
    tags:{ emergency:"fire_hydrant","fire_hydrant:type":"wall" }, fields:["diameter","note","check_date"] },
  { id:"brunnen", label:"Lösch-\nbrunnen", ic:"🔷", color:"#1F4E8C",
    tags:{ emergency:"fire_hydrant","fire_hydrant:type":"pipe" }, fields:["note","check_date"] },
  { id:"tank", label:"Wasser-\nbehälter", ic:"🟩", color:"#009688",
    tags:{ emergency:"water_tank" }, fields:["volume","note","check_date"] },
  { id:"pond", label:"Lösch-\nteich", ic:"🟩", color:"#009688",
    tags:{ emergency:"fire_water_pond" }, fields:["note","check_date"] },
  { id:"suction", label:"Saug-\nstelle", ic:"🔻", color:"#00ACC1",
    tags:{ emergency:"suction_point" }, fields:["note","check_date"] },
  { id:"rescue", label:"Rettungs-\npunkt", ic:"🔺", color:"#FF8800",
    tags:{ highway:"emergency_access_point" }, fields:["ref","note"] },
];
const catById = id => CATS.find(c=>c.id===id);
const FIELDDEF = {
  diameter:   { label:"Nennweite (mm)", type:"chips", opts:["80","100","150","200"], tag:"fire_hydrant:diameter" },
  volume:     { label:"Volumen (m³)",   type:"number", tag:"water_tank:volume" },
  ref:        { label:"Rettungspunkt-Nr. (z.B. BB-1234)", type:"text", tag:"ref" },
  note:       { label:"Hinweis (frei)", type:"text", tag:"note" },
  check_date: { label:"Geprüft am",     type:"date", tag:"check_date" },
};
const CAT_KEYS=["emergency","fire_hydrant:type","highway"];
const FIELD_TAGS=["fire_hydrant:diameter","water_tank:volume","ref","note","check_date"];
function detectCatId(t){
  if(t.emergency==="fire_hydrant"){
    if(t["fire_hydrant:type"]==="pipe")return"brunnen"; if(t["fire_hydrant:type"]==="pillar")return"hyd_p";
    if(t["fire_hydrant:type"]==="wall")return"hyd_w"; return"hyd_u"; }
  if(t.emergency==="water_tank")return"tank"; if(t.emergency==="fire_water_pond")return"pond";
  if(t.emergency==="suction_point"||t.emergency==="water_point")return"suction";
  if(t.highway==="emergency_access_point")return"rescue"; return null;
}

// ─── Karte ──────────────────────────────────────────────────────────────────
const map=L.map("map",{zoomControl:true}).setView(CONFIG.center,CONFIG.zoom);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19,attribution:"© OpenStreetMap-Mitwirkende"}).addTo(map);
const layerExisting=L.layerGroup().addTo(map);
const layerNeu=L.layerGroup().addTo(map);
const layerQueue=L.layerGroup().addTo(map);

let posMarker=null, accCircle=null;
function locate(zoom){
  if(!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(p=>{
    const ll=[p.coords.latitude,p.coords.longitude];
    if(zoom) map.setView(ll,18);
    if(posMarker) posMarker.setLatLng(ll); else posMarker=L.circleMarker(ll,{radius:7,color:"#1565c0",fillColor:"#1565c0",fillOpacity:1}).addTo(map);
    if(accCircle) accCircle.setLatLng(ll).setRadius(p.coords.accuracy); else accCircle=L.circle(ll,{radius:p.coords.accuracy,color:"#1565c0",weight:1,fillOpacity:.08}).addTo(map);
  }, ()=>{ if(zoom) toast("Standort nicht ermittelbar"); }, {enableHighAccuracy:true,timeout:10000});
}
document.getElementById("gps").onclick=()=>locate(true);

// ─── Vorhandene Punkte laden ──────────────────────────────────────────────────
let loadTimer=null, lastBboxKey="";
function status(m){ const s=document.getElementById("status"); if(!m){s.style.display="none";return;} s.textContent=m; s.style.display="block"; }
map.on("moveend",()=>{ clearTimeout(loadTimer); loadTimer=setTimeout(loadExisting,500); });
function reloadExisting(){ lastBboxKey=""; loadExisting(); }
async function loadExisting(){
  if(map.getZoom()<CONFIG.minLoadZoom){ status("Zum Laden vorhandener Punkte näher heranzoomen"); layerExisting.clearLayers(); lastBboxKey=""; return; }
  const b=map.getBounds(); const key=[b.getSouth(),b.getWest(),b.getNorth(),b.getEast()].map(x=>x.toFixed(3)).join(",");
  if(key===lastBboxKey) return; lastBboxKey=key;
  const bbox=`${b.getSouth()},${b.getWest()},${b.getNorth()},${b.getEast()}`;
  const q=`[out:json][timeout:25];(node["emergency"](${bbox});node["highway"="emergency_access_point"](${bbox}););out body;`;
  status("Lade vorhandene Punkte …");
  try{
    const r=await fetch("https://overpass-api.de/api/interpreter",{method:"POST",body:new URLSearchParams({data:q})});
    const j=await r.json(); renderExisting(j.elements||[]); status("");
  }catch(e){ status("Overpass nicht erreichbar"); setTimeout(()=>status(""),2000); }
}
function renderExisting(els){
  layerExisting.clearLayers(); let n=0;
  els.forEach(el=>{
    if(el.type!=="node") return; const cid=detectCatId(el.tags||{}); if(!cid) return;
    const c=catById(cid);
    L.circleMarker([el.lat,el.lon],{radius:7,color:"#fff",weight:1.5,fillColor:c.color,fillOpacity:1})
      .on("click",()=>openEdit(el,cid)).addTo(layerExisting); n++;
  });
  if(!n){ status("Keine vorhandenen Punkte hier"); setTimeout(()=>status(""),1500); }
}

// ─── Sheet (neu / bearbeiten) ──────────────────────────────────────────────────
const sheet=document.getElementById("sheet"), catsEl=document.getElementById("cats"),
      fieldsEl=document.getElementById("fields"), posEl=document.getElementById("pos"),
      titleEl=document.getElementById("sheetTitle"), delBtn=document.getElementById("delete"),
      chkBtn=document.getElementById("checked");
let chosen=null, captureLatLng=null, mode="new", editEl=null;

CATS.forEach(c=>{
  const d=document.createElement("div"); d.className="cat"; d.dataset.id=c.id;
  d.innerHTML=`<span class="ic">${c.ic}</span>${c.label.replace(/\n/g,"<br>")}`;
  d.onclick=()=>selectCat(c); catsEl.appendChild(d);
});
function renderFields(c,vals){
  fieldsEl.innerHTML="";
  c.fields.forEach(fk=>{
    const f=FIELDDEF[fk], id="f_"+fk;
    const lab=document.createElement("label"); lab.textContent=f.label; fieldsEl.appendChild(lab);
    if(f.type==="chips"){
      const hid=document.createElement("input"); hid.type="hidden"; hid.id=id; hid.dataset.tag=f.tag;
      if(vals&&vals[f.tag]!=null) hid.value=vals[f.tag];
      const wrap=document.createElement("div"); wrap.className="chips";
      f.opts.forEach(o=>{
        const b=document.createElement("button"); b.type="button"; b.className="chip"+(hid.value===o?" act":""); b.textContent="DN "+o;
        b.onclick=()=>{ const on=hid.value===o; hid.value=on?"":o; wrap.querySelectorAll(".chip").forEach(x=>x.classList.remove("act")); if(!on)b.classList.add("act"); };
        wrap.appendChild(b);
      });
      fieldsEl.appendChild(hid); fieldsEl.appendChild(wrap);
    } else {
      const inp=document.createElement("input"); inp.type=f.type; inp.id=id; inp.dataset.tag=f.tag;
      if(vals&&vals[f.tag]!=null) inp.value=vals[f.tag]; else if(fk==="check_date") inp.value=today();
      fieldsEl.appendChild(inp);
    }
  });
}
function selectCat(c,vals){ chosen=c; document.querySelectorAll(".cat").forEach(x=>x.classList.toggle("act",x.dataset.id===c.id)); renderFields(c,vals); }
function collectFields(){ const o={}; fieldsEl.querySelectorAll("[data-tag]").forEach(i=>{ const v=(i.value||"").trim(); if(v)o[i.dataset.tag]=v; }); return o; }

document.getElementById("add").onclick=()=>{
  if(!CLIENT_ID && !token()){ login(); return; }
  mode="new"; editEl=null; chosen=null;
  titleEl.textContent="Neu erfassen"; delBtn.classList.add("hidden"); chkBtn.classList.add("hidden");
  document.getElementById("save").textContent="In OSM speichern";
  document.querySelectorAll(".cat").forEach(x=>x.classList.remove("act")); fieldsEl.innerHTML="";
  captureLatLng=map.getCenter();
  posEl.textContent=`Position: ${captureLatLng.lat.toFixed(6)}, ${captureLatLng.lng.toFixed(6)} (Fadenkreuz)`;
  document.getElementById("photoBox").classList.add("hidden");
  sheet.classList.add("open");
};
function openEdit(el,cid){
  mode="edit"; editEl=el; titleEl.textContent=`Bearbeiten · Knoten ${el.id}`;
  delBtn.classList.remove("hidden"); chkBtn.classList.remove("hidden");
  document.getElementById("save").textContent="Änderung speichern";
  selectCat(catById(cid)||CATS[0], el.tags||{});
  posEl.innerHTML=`Position: ${el.lat.toFixed(6)}, ${el.lon.toFixed(6)} · <a href="${CONFIG.osmBase}/node/${el.id}" target="_blank">auf OSM</a>`;
  renderPhotoBox(el.tags||{});
  sheet.classList.add("open");
}
document.getElementById("cancel").onclick=()=>sheet.classList.remove("open");

function buildTagsFrom(existing,cat,fields){
  const tags=Object.assign({},existing||{});
  CAT_KEYS.forEach(k=>delete tags[k]); Object.assign(tags,catById(cat).tags);
  FIELD_TAGS.forEach(k=>delete tags[k]); for(const k in fields) tags[k]=fields[k];
  return tags;
}

document.getElementById("save").onclick=async()=>{
  if(!chosen){ toast("Bitte eine Kategorie wählen"); return; }
  const fields=collectFields();
  const op = mode==="new"
    ? {t:"create",lat:captureLatLng.lat,lng:captureLatLng.lng,cat:chosen.id,fields}
    : {t:"update",id:editEl.id,cat:chosen.id,fields};
  const btn=document.getElementById("save"); btn.disabled=true; const lbl=btn.textContent; btn.textContent="…";
  const res=await commit([op], mode==="new"?"Gespeichert":"Geändert");
  btn.disabled=false; btn.textContent=lbl;
  if(res!==false) sheet.classList.remove("open");
};
delBtn.onclick=async()=>{
  if(!editEl) return; if(!confirm(`Knoten ${editEl.id} wirklich löschen?`)) return;
  const res=await commit([{t:"delete",id:editEl.id}],"Gelöscht");
  if(res!==false) sheet.classList.remove("open");
};
chkBtn.onclick=async()=>{
  if(!editEl) return; const f=collectFields(); f["check_date"]=today();
  const res=await commit([{t:"update",id:editEl.id,cat:chosen.id,fields:f}],"Prüfdatum aktualisiert");
  if(res!==false) sheet.classList.remove("open");
};

// ─── Foto (Panoramax) ──────────────────────────────────────────────────────────
// Fotos gibt es nur im Bearbeiten-Modus (der OSM-Knoten muss schon existieren).
// Der Foto-Bezug läuft ausschließlich über den OSM-Tag "panoramax" = <Bild-ID>.
function pmxToken(){ return localStorage.getItem("wb_pmx_token")||""; }
function thumbUrl(id){ return `${CONFIG.pmxApi}/pictures/${id}/thumb.jpg`; }

function renderPhotoBox(tags){
  const box=document.getElementById("photoBox"), thumb=document.getElementById("photoThumb"),
        add=document.getElementById("photoAdd"), rep=document.getElementById("photoReplace"),
        del=document.getElementById("photoDel"), hint=document.getElementById("photoHint");
  box.classList.remove("hidden"); hint.textContent="";
  const id=tags&&tags.panoramax;
  if(id){
    thumb.src=thumbUrl(id); thumb.classList.remove("hidden");
    add.classList.add("hidden"); rep.classList.remove("hidden"); del.classList.remove("hidden");
  } else {
    thumb.classList.add("hidden"); thumb.removeAttribute("src");
    add.classList.remove("hidden"); rep.classList.add("hidden"); del.classList.add("hidden");
  }
}

document.getElementById("photoAdd").onclick   = ()=>startPhotoUpload();
document.getElementById("photoReplace").onclick = ()=>startPhotoUpload();
document.getElementById("photoDel").onclick = async ()=>{
  if(!editEl) return;
  if(!confirm("Foto wirklich vom Hydranten entfernen?")) return;
  const hint=document.getElementById("photoHint"); hint.textContent="Entferne Foto-Verknüpfung …";
  try{
    await setPanoramaxTag(editEl.id, null);
    editEl.tags = Object.assign({},editEl.tags); delete editEl.tags.panoramax;
    renderPhotoBox(editEl.tags); toast("Foto entfernt ✓",4000);
  }catch(e){ hint.textContent=""; toast("Fehler beim Entfernen: "+e.message,6000); }
};

const pmxCam=document.getElementById("pmxCam");
function startPhotoUpload(){
  if(!editEl){ toast("Bitte zuerst den Punkt speichern, dann Foto hinzufügen"); return; }
  if(!pmxToken()){ document.getElementById("pmxSetup").style.display="block"; return; }
  pmxCam.click();
}
pmxCam.onchange=async()=>{
  const f=pmxCam.files&&pmxCam.files[0]; pmxCam.value=""; if(!f||!editEl) return;
  const hint=document.getElementById("photoHint");
  hint.textContent="Lade Foto hoch …";
  try{
    const picId=await uploadToPanoramax(f, editEl.lat, editEl.lon);
    hint.textContent="Verknüpfe mit Hydrant …";
    await setPanoramaxTag(editEl.id, picId);
    editEl.tags=Object.assign({},editEl.tags,{panoramax:picId});
    renderPhotoBox(editEl.tags);
    toast("Foto gespeichert ✓",5000);
  }catch(e){ hint.textContent=""; toast("Foto-Upload fehlgeschlagen: "+e.message,7000); }
};

async function pmxFetch(path,opts){
  const r=await fetch(CONFIG.pmxApi+path,Object.assign({},opts,{
    headers:Object.assign({"Authorization":"Bearer "+pmxToken()},(opts&&opts.headers)||{})
  }));
  if(!r.ok) throw new Error(`Panoramax ${r.status}: ${(await r.text()).slice(0,140)}`);
  return r;
}

// Best-effort: sucht rekursiv nach einer UUID unter Schlüsseln, die auf eine Bild-ID hindeuten.
// (Panoramax dokumentiert das genaue Antwortformat nicht öffentlich – daher robust statt starr.)
function findPictureId(obj){
  const uuidRe=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let found=null;
  (function walk(o){
    if(found||!o||typeof o!=="object") return;
    for(const k in o){
      const v=o[k];
      if(typeof v==="string" && uuidRe.test(v) && /pic|item/i.test(k)){ found=v; return; }
      if(typeof v==="string" && /rel/i.test(k) && v==="item" && o.href){
        const m=o.href.match(uuidRe); if(m){ found=m[0]; return; }
      }
      if(v && typeof v==="object") walk(v);
      if(found) return;
    }
  })(obj);
  return found;
}

async function uploadToPanoramax(file, lat, lon){
  // 1) Upload-Set anlegen
  const cs=await (await pmxFetch("/upload_sets",{method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({title:"Hydranten-Erfasser "+today(),estimated_nb_files:1})})).json();
  const setId=cs.id;
  // 2) Datei hochladen (Position/Zeit als Feld statt EXIF)
  const fd=new FormData();
  fd.append("file",file,"hydrant.jpg");
  fd.append("override_latitude",String(lat));
  fd.append("override_longitude",String(lon));
  fd.append("override_capture_time",new Date().toISOString());
  const upRes=await (await pmxFetch(`/upload_sets/${setId}/files`,{method:"POST",body:fd})).json();
  // 3) Set abschließen
  await pmxFetch(`/upload_sets/${setId}/complete`,{method:"POST"});
  // 4) Bild-ID ermitteln – ggf. etwas warten, da Verarbeitung asynchron läuft
  let picId=findPictureId(upRes);
  for(let i=0;i<8 && !picId;i++){
    await new Promise(r=>setTimeout(r,1500));
    const files=await (await pmxFetch(`/upload_sets/${setId}/files`)).json();
    picId=findPictureId(files);
  }
  if(!picId) throw new Error("Foto hochgeladen, aber Bild-ID nicht gefunden (bitte in Panoramax prüfen)");
  return picId;
}

// Setzt/entfernt NUR den panoramax-Tag, alle anderen Tags bleiben unverändert.
async function setPanoramaxTag(nodeId, picIdOrNull){
  const cur=await fetchNodeFull(nodeId);
  const tags=Object.assign({},cur.tags);
  if(picIdOrNull) tags.panoramax=picIdOrNull; else delete tags.panoramax;
  const cs=await createChangeset();
  const body=`<osm><node id="${nodeId}" version="${cur.version}" changeset="${cs}" lat="${cur.lat}" lon="${cur.lon}">${tagsXml(tags)}</node></osm>`;
  await apiFetch(`/node/${nodeId}`,"PUT",body);
  await apiFetch(`/changeset/${cs}/close`,"PUT","");
}

document.getElementById("pmxTokSave").onclick=()=>{
  const v=document.getElementById("pmxTok").value.trim();
  if(!v){ toast("Bitte Token eingeben"); return; }
  localStorage.setItem("wb_pmx_token",v);
  document.getElementById("pmxSetup").style.display="none";
  toast("Panoramax-Token gespeichert ✓");
  pmxCam.click();
};
document.getElementById("pmxTokCancel").onclick=()=>{ document.getElementById("pmxSetup").style.display="none"; };

// ─── OSM-Operationen ───────────────────────────────────────────────────────────
function esc(s){ return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;"); }
function tagsXml(t){ let s=""; for(const k in t) s+=`<tag k="${esc(k)}" v="${esc(t[k])}"/>`; return s; }
async function createChangeset(){
  const body=`<osm><changeset><tag k="created_by" v="${esc(CONFIG.createdBy)}"/><tag k="comment" v="Wasserentnahmestellen/Rettungspunkte (Hydranten-Erfasser)"/></changeset></osm>`;
  return (await apiFetch("/changeset/create","PUT",body)).text().then(t=>t.trim());
}
async function fetchNodeFull(id){
  const r=await fetch(`${CONFIG.apiBase}/node/${id}.json`); if(!r.ok) throw new Error("Knoten nicht ladbar ("+r.status+")");
  return (await r.json()).elements[0];
}
async function applyAll(ops){
  const cs=await createChangeset(); const ids=[];
  for(const op of ops){
    if(op.t==="create"){
      const tags=buildTagsFrom({},op.cat,op.fields);
      const body=`<osm><node changeset="${cs}" lat="${(+op.lat).toFixed(7)}" lon="${(+op.lng).toFixed(7)}">${tagsXml(tags)}</node></osm>`;
      ids.push((await (await apiFetch("/node/create","PUT",body)).text()).trim());
    } else if(op.t==="update"){
      const cur=await fetchNodeFull(op.id); const tags=buildTagsFrom(cur.tags,op.cat,op.fields);
      const body=`<osm><node id="${op.id}" version="${cur.version}" changeset="${cs}" lat="${cur.lat}" lon="${cur.lon}">${tagsXml(tags)}</node></osm>`;
      await apiFetch(`/node/${op.id}`,"PUT",body);
    } else if(op.t==="delete"){
      const cur=await fetchNodeFull(op.id);
      const body=`<osm><node id="${op.id}" version="${cur.version}" changeset="${cs}" lat="${cur.lat}" lon="${cur.lon}"/></osm>`;
      await apiFetch(`/node/${op.id}`,"DELETE",body);
    }
  }
  await apiFetch(`/changeset/${cs}/close`,"PUT","");
  return ids;
}
async function apiFetch(path,method,body){
  let r;
  try{ r=await fetch(CONFIG.apiBase+path,{method,headers:{"Authorization":"Bearer "+token(),"Content-Type":"text/xml"},body}); }
  catch(e){ const err=new Error("Netzwerkfehler"); err.__net=true; throw err; }
  if(r.status===401){ logout(); throw new Error("Nicht angemeldet – bitte neu anmelden"); }
  if(r.status===409){ throw new Error("Konflikt – Punkt wurde zwischenzeitlich geändert. Karte neu laden."); }
  if(!r.ok){ throw new Error(`OSM ${r.status}: ${(await r.text()).slice(0,120)}`); }
  return r;
}

// ─── Commit (online oder Offline-Warteschlange) ────────────────────────────────
function getQueue(){ try{ return JSON.parse(localStorage.getItem("wb_queue")||"[]"); }catch(_){ return []; } }
function setQueue(q){ localStorage.setItem("wb_queue",JSON.stringify(q)); badge(); renderQueue(); }
function enqueue(op){ const q=getQueue(); q.push(op); setQueue(q); }
function badge(){ const q=getQueue(), el=document.getElementById("sync");
  if(q.length){ el.classList.remove("hidden"); el.textContent="⏳ "+q.length; } else el.classList.add("hidden"); }
function renderQueue(){ layerQueue.clearLayers();
  getQueue().forEach(op=>{ if(op.t==="create") L.circleMarker([op.lat,op.lng],{radius:7,color:"#e8a800",weight:2,fillColor:"#ffd54f",fillOpacity:.9})
    .bindTooltip("⏳ noch nicht hochgeladen").addTo(layerQueue); }); }
document.getElementById("sync").onclick=trySync;
window.addEventListener("online",()=>{ if(getQueue().length) trySync(); });

async function commit(ops,label){
  if(!token()){ toast("Bitte zuerst anmelden"); login(); return false; }
  if(!navigator.onLine){ ops.forEach(enqueue); toast(`Offline – ${ops.length} gespeichert, lädt später hoch ⏳`,5000); return null; }
  try{
    const ids=await applyAll(ops); reloadExisting();
    const id=ids[0];
    if(id){ L.marker([+ops[0].lat,+ops[0].lng]).addTo(layerNeu).bindPopup(`✅ gespeichert<br><a href="${CONFIG.osmBase}/node/${id}" target="_blank">Knoten ${id}</a>`).openPopup();
            toast(`${label} ✓ <a href="${CONFIG.osmBase}/node/${id}" target="_blank">Knoten ${id}</a>`,6000); }
    else toast(`${label} ✓`,4000);
    return ids;
  }catch(e){
    if(e.__net){ ops.forEach(enqueue); toast("Netzproblem – offline gespeichert ⏳",5000); return null; }
    toast("Fehler: "+e.message,7000); return false;
  }
}
async function trySync(){
  const q=getQueue(); if(!q.length){ toast("Nichts zu senden"); return; }
  if(!navigator.onLine){ toast("Noch offline"); return; }
  if(!token()){ toast("Bitte anmelden"); login(); return; }
  const el=document.getElementById("sync"); el.textContent="⏳ …";
  try{ await applyAll(q); setQueue([]); reloadExisting(); toast(`${q.length} Einträge hochgeladen ✓`,5000); }
  catch(e){ badge(); toast(e.__net?"Noch offline – später erneut":"Sync-Fehler: "+e.message,6000); }
}

// ─── OAuth2 PKCE ──────────────────────────────────────────────────────────────
function token(){ return localStorage.getItem("wb_token"); }
function logout(){ localStorage.removeItem("wb_token"); localStorage.removeItem("wb_user"); refreshAuthUI(); }
function b64url(b){ return btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,""); }
async function sha256(s){ return crypto.subtle.digest("SHA-256",new TextEncoder().encode(s)); }
function randStr(n){ const a=new Uint8Array(n); crypto.getRandomValues(a); return Array.from(a,x=>("0"+(x&255).toString(16)).slice(-2)).join("").slice(0,n); }
async function login(){
  if(!CLIENT_ID){ document.getElementById("setup").style.display="block"; return; }
  const v=randStr(64); sessionStorage.setItem("wb_verifier",v);
  const ch=b64url(await sha256(v)); const url=new URL(CONFIG.osmBase+"/oauth2/authorize");
  url.search=new URLSearchParams({response_type:"code",client_id:CLIENT_ID,redirect_uri:REDIRECT_URI,scope:CONFIG.scopes,code_challenge:ch,code_challenge_method:"S256"}).toString();
  location.href=url.toString();
}
async function handleRedirect(){
  const p=new URLSearchParams(location.search);
  if(p.get("error")){ toast("Anmeldung abgelehnt: "+p.get("error")); history.replaceState({},"",REDIRECT_URI); return; }
  const code=p.get("code"); if(!code) return; const v=sessionStorage.getItem("wb_verifier"); history.replaceState({},"",REDIRECT_URI);
  try{
    const r=await fetch(CONFIG.osmBase+"/oauth2/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},
      body:new URLSearchParams({grant_type:"authorization_code",code,redirect_uri:REDIRECT_URI,client_id:CLIENT_ID,code_verifier:v})});
    if(!r.ok) throw new Error(await r.text());
    localStorage.setItem("wb_token",(await r.json()).access_token); await fetchUser(); toast("Angemeldet ✓");
    if(getQueue().length) trySync();
  }catch(e){ toast("Token-Fehler: "+String(e).slice(0,140),8000); }
  refreshAuthUI();
}
async function fetchUser(){ try{ const r=await fetch(CONFIG.apiBase+"/user/details.json",{headers:{"Authorization":"Bearer "+token()}});
  if(r.ok) localStorage.setItem("wb_user",(await r.json()).user.display_name); }catch(_){} }
function refreshAuthUI(){ const btn=document.getElementById("login"), who=document.getElementById("who");
  if(token()){ btn.textContent="Abmelden"; btn.onclick=logout; who.textContent=localStorage.getItem("wb_user")||"angemeldet"; }
  else{ btn.textContent="Anmelden"; btn.onclick=login; who.textContent=""; } }

document.getElementById("cidsave").onclick=()=>{
  const v=document.getElementById("cid").value.trim(); if(!v){ toast("Bitte Client ID eingeben"); return; }
  localStorage.setItem("wb_client_id",v); CLIENT_ID=v; document.getElementById("setup").style.display="none"; login();
};

// ─── Toast ──────────────────────────────────────────────────────────────────
let toastT=null;
function toast(html,ms=3500){ const t=document.getElementById("toast"); t.innerHTML=html; t.style.display="block"; clearTimeout(toastT); toastT=setTimeout(()=>t.style.display="none",ms); }

// ─── Start ──────────────────────────────────────────────────────────────────
(async function init(){
  refreshAuthUI(); badge(); renderQueue();
  await handleRedirect();
  if(token()&&!localStorage.getItem("wb_user")){ await fetchUser(); refreshAuthUI(); }
  locate(true);              // Auto-GPS beim Öffnen
  loadExisting();            // vorhandene Punkte laden
  if(navigator.onLine && token() && getQueue().length) trySync();
  if("serviceWorker" in navigator){ try{ await navigator.serviceWorker.register("sw.js"); }catch(_){} }
})();
