(() => {
  'use strict';

  const APP_VERSION = '2.0.0';
  const STORAGE_KEY = 'hako.app.v2';
  const LEGACY_KEYS = ['hako.app.v1'];
  const DB_NAME = 'hako-media-v1';
  const DB_STORE = 'media';
  const VIEW_LIMIT = 160;
  const SEARCH_LIMIT = 80;

  const $app = document.getElementById('app');
  const $modal = document.getElementById('modal-root');
  const $toast = document.getElementById('toast');

  const uid = (p='id') => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`;
  const nowISO = () => new Date().toISOString();
  const esc = (v='') => String(v).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const clamp = (n,min,max) => Math.max(min, Math.min(max, Number(n)||0));
  const fmtDate = (v) => v ? new Date(`${v}T12:00:00`).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}) : 'Not set';
  const fmtShortDate = (v) => v ? new Date(`${v}T12:00:00`).toLocaleDateString(undefined,{month:'short',day:'numeric'}) : '';
  const normalize = (v='') => String(v).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
  const todayISO = () => new Date().toISOString().slice(0,10);
  const addDays = (date, days) => { const d=new Date(`${date}T12:00:00`); d.setDate(d.getDate()+days); return d.toISOString().slice(0,10); };
  const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;

  const DEFAULT = {
    schemaVersion: 2,
    hasOnboarded: false,
    profile: { name: '' },
    project: {
      id: uid('move'), name:'My Move', moveDate:'', from:'', to:'', currency:'PHP', units:'cm',
      moveType:'Home move', householdSize:1, homeType:'', budget:0, createdAt:nowISO()
    },
    rooms: [], boxes: [], items: [], tasks: [], expenses: [], supplies: [],
    utilities: [], addressChanges: [], documents: [], contacts: [], packingSessions: [],
    activity: [], recentSearches: [],
    settings: { accent:'pink', haptics:true, reduceEffects:false, compact:false },
    meta: { boxSeq:0, lastBackup:'' },
    ui: {
      tab:'home', tool:null, roomFilter:null, boxFilter:'all', taskFilter:'all', findQuery:'',
      declutterFilter:'all', packRoomFilter:'all', reportRoomFilter:'all'
    }
  };

  let state = loadState();
  let derived = {};
  let deferredInstallPrompt = null;
  let saveTimer = null;
  let toastTimer = null;
  let activeStream = null;
  let scannerLoopId = 0;
  let packingTimer = { endAt:0, startedAt:0, duration:0, interval:null };
  const mediaURLCache = new Map();
  let mediaDBPromise = null;
  let moneyFormatter = null;
  let moneyFormatterCurrency = '';

  function cloneDefault(){ return structuredClone(DEFAULT); }

  function loadState(){
    let raw = null;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch(_) {}
    if(!raw){
      for(const key of LEGACY_KEYS){
        try { raw = localStorage.getItem(key); } catch(_) {}
        if(raw) break;
      }
    }
    if(!raw) return cloneDefault();
    try { return migrateState(JSON.parse(raw)); }
    catch(_) { return cloneDefault(); }
  }

  function migrateState(data){
    const out = {
      ...cloneDefault(), ...data,
      profile:{...DEFAULT.profile,...(data.profile||{})},
      project:{...DEFAULT.project,...(data.project||{})},
      settings:{...DEFAULT.settings,...(data.settings||{})},
      meta:{...DEFAULT.meta,...(data.meta||{})},
      ui:{...DEFAULT.ui,...(data.ui||{})}
    };
    for(const k of ['rooms','boxes','items','tasks','expenses','supplies','utilities','addressChanges','documents','contacts','packingSessions','activity','recentSearches']){
      if(!Array.isArray(out[k])) out[k]=[];
    }
    let seq = Number(out.meta.boxSeq)||0;
    out.boxes.forEach((b,idx)=>{
      seq = Math.max(seq, idx+1);
      b.status ||= 'empty';
      b.type ||= 'Box';
      b.capacity = clamp(b.capacity||0,0,100);
      b.weight = Number(b.weight)||0;
      b.priority ||= b.openFirst ? 'first' : 'normal';
      b.vehicle ||= '';
      b.loadOrder = Number(b.loadOrder)||0;
      b.missing = !!b.missing;
      b.damaged = !!b.damaged;
      b.code ||= makeStableCode(out, b.roomId, idx+1);
    });
    out.meta.boxSeq = Math.max(seq, out.boxes.length);
    out.items.forEach(i=>{
      i.quantity = Math.max(1, Number(i.quantity)||1);
      i.status ||= i.boxId ? 'packed' : 'loose';
      i.decision ||= '';
      i.destinationRoomId ||= '';
      i.condition ||= '';
      i.brand ||= '';
      i.model ||= '';
      i.serial ||= '';
      i.doNotPack = !!i.doNotPack;
      i.sentimental = !!i.sentimental;
      i.saleStatus ||= '';
      i.soldPrice = Number(i.soldPrice)||0;
      i.donationOrg ||= '';
      i.partsFor ||= '';
      i.reassemblyNotes ||= '';
      if(i.photo && !i.photoRef) i.legacyPhoto = i.photo;
      delete i.photo;
    });
    out.tasks.forEach(t=>{ t.priority ||= 'normal'; t.templateKey ||= ''; });
    out.schemaVersion = 2;
    return out;
  }

  function makeStableCode(s, roomId, seq){
    const room = (s.rooms||[]).find(r=>r.id===roomId);
    const prefix = normalize(room?.name||'Hako').replace(/\s+/g,'').slice(0,5).toUpperCase() || 'HAKO';
    return `${prefix}-${String(seq).padStart(3,'0')}`;
  }

  function nextBoxCode(roomId){
    state.meta.boxSeq = (Number(state.meta.boxSeq)||0)+1;
    let code = makeStableCode(state,roomId,state.meta.boxSeq);
    while(state.boxes.some(b=>b.code===code)){
      state.meta.boxSeq++;
      code = makeStableCode(state,roomId,state.meta.boxSeq);
    }
    return code;
  }

  function saveState(immediate=true){
    clearTimeout(saveTimer);
    const run = () => {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
      catch(_) { toast('Hako could not save. Export a backup and remove older photos or browser data.'); }
    };
    if(immediate) run(); else saveTimer=setTimeout(run,220);
  }

  function commit(message, opts={}){
    if(message){
      state.activity.unshift({id:uid('act'),text:message,at:nowISO()});
      state.activity = state.activity.slice(0,80);
    }
    saveState(true);
    if(opts.render!==false) render();
  }

  function toast(msg){
    $toast.textContent = msg;
    $toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(()=>$toast.classList.remove('show'),2200);
  }

  function haptic(){
    if(!state.settings.haptics) return;
    try { navigator.vibrate?.(10); } catch(_) {}
  }

  function money(n){
    const currency = state.project.currency || 'PHP';
    try {
      if(!moneyFormatter || moneyFormatterCurrency!==currency){
        moneyFormatter = new Intl.NumberFormat(undefined,{style:'currency',currency,maximumFractionDigits:0});
        moneyFormatterCurrency = currency;
      }
      return moneyFormatter.format(Number(n)||0);
    } catch(_) { return `${currency} ${Math.round(Number(n)||0).toLocaleString()}`; }
  }

  function openMediaDB(){
    if(mediaDBPromise) return mediaDBPromise;
    mediaDBPromise = new Promise((resolve,reject)=>{
      if(!('indexedDB' in window)){ reject(new Error('IndexedDB unavailable')); return; }
      const req = indexedDB.open(DB_NAME,1);
      req.onupgradeneeded = () => {
        const db=req.result;
        if(!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE,{keyPath:'id'});
      };
      req.onsuccess=()=>resolve(req.result);
      req.onerror=()=>reject(req.error||new Error('Media database unavailable'));
    });
    return mediaDBPromise;
  }

  async function mediaPut(blob,id=uid('media')){
    const db=await openMediaDB();
    await new Promise((resolve,reject)=>{
      const tx=db.transaction(DB_STORE,'readwrite');
      tx.objectStore(DB_STORE).put({id,blob,updatedAt:nowISO()});
      tx.oncomplete=resolve; tx.onerror=()=>reject(tx.error);
    });
    if(mediaURLCache.has(id)){ URL.revokeObjectURL(mediaURLCache.get(id)); mediaURLCache.delete(id); }
    return id;
  }

  async function mediaGet(id){
    if(!id) return null;
    const db=await openMediaDB();
    return await new Promise((resolve,reject)=>{
      const tx=db.transaction(DB_STORE,'readonly');
      const req=tx.objectStore(DB_STORE).get(id);
      req.onsuccess=()=>resolve(req.result?.blob||null); req.onerror=()=>reject(req.error);
    });
  }

  async function mediaDelete(id){
    if(!id) return;
    try{
      const db=await openMediaDB();
      await new Promise((resolve,reject)=>{
        const tx=db.transaction(DB_STORE,'readwrite');
        tx.objectStore(DB_STORE).delete(id);
        tx.oncomplete=resolve; tx.onerror=()=>reject(tx.error);
      });
    }catch(_){}
    if(mediaURLCache.has(id)){ URL.revokeObjectURL(mediaURLCache.get(id)); mediaURLCache.delete(id); }
  }

  async function mediaURL(id){
    if(!id) return '';
    if(mediaURLCache.has(id)) return mediaURLCache.get(id);
    try{
      const blob=await mediaGet(id); if(!blob) return '';
      const url=URL.createObjectURL(blob); mediaURLCache.set(id,url); return url;
    }catch(_){ return ''; }
  }

  async function hydrateMedia(root=document){
    const nodes=[...root.querySelectorAll('img[data-media]')];
    await Promise.all(nodes.map(async img=>{
      const id=img.dataset.media;
      if(!id || img.dataset.hydrated==='1') return;
      const url=await mediaURL(id);
      if(url){ img.src=url; img.dataset.hydrated='1'; }
    }));
  }

  async function compressPhoto(file){
    if(!file) return null;
    const maxDim = 720;
    let bitmap = null, width=0, height=0, source=null, cleanup=()=>{};
    try{
      if('createImageBitmap' in window){
        bitmap=await createImageBitmap(file,{imageOrientation:'from-image'});
        width=bitmap.width; height=bitmap.height; source=bitmap; cleanup=()=>bitmap.close?.();
      } else {
        const url=URL.createObjectURL(file);
        const img=await new Promise((resolve,reject)=>{const im=new Image();im.onload=()=>resolve(im);im.onerror=reject;im.src=url;});
        width=img.naturalWidth; height=img.naturalHeight; source=img; cleanup=()=>URL.revokeObjectURL(url);
      }
      const scale=Math.min(1,maxDim/Math.max(width,height));
      const canvas=document.createElement('canvas');
      canvas.width=Math.max(1,Math.round(width*scale)); canvas.height=Math.max(1,Math.round(height*scale));
      const ctx=canvas.getContext('2d',{alpha:false});
      ctx.drawImage(source,0,0,canvas.width,canvas.height);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/webp',0.66));
      cleanup();
      return blob || file;
    }catch(err){ cleanup(); throw err; }
  }

  async function migrateLegacyPhotos(){
    const legacy=state.items.filter(i=>i.legacyPhoto && !i.photoRef);
    if(!legacy.length) return;
    let changed=false;
    for(const item of legacy){
      try{
        const blob=await (await fetch(item.legacyPhoto)).blob();
        item.photoRef=await mediaPut(blob);
        delete item.legacyPhoto;
        changed=true;
      }catch(_){}
    }
    if(changed) saveState(true);
  }

  function rebuildDerived(){
    const roomsById=new Map(state.rooms.map(r=>[r.id,r]));
    const boxesById=new Map(state.boxes.map(b=>[b.id,b]));
    const itemsById=new Map(state.items.map(i=>[i.id,i]));
    const itemsByBox=new Map(), boxesByRoom=new Map(), itemsByRoom=new Map();
    for(const b of state.boxes){ if(!boxesByRoom.has(b.roomId)) boxesByRoom.set(b.roomId,[]); boxesByRoom.get(b.roomId).push(b); }
    for(const i of state.items){
      if(!itemsByBox.has(i.boxId)) itemsByBox.set(i.boxId,[]); itemsByBox.get(i.boxId).push(i);
      if(!itemsByRoom.has(i.roomId)) itemsByRoom.set(i.roomId,[]); itemsByRoom.get(i.roomId).push(i);
    }
    const searchIndex=[];
    for(const i of state.items){
      const b=boxesById.get(i.boxId), r=roomsById.get(i.roomId), dr=roomsById.get(i.destinationRoomId);
      searchIndex.push({type:'item',id:i.id,title:i.name||'Untitled item',emoji:i.essential?'⭐':'🔎',sub:`${b?b.code+' · '+b.name:'Loose'} · ${r?.name||'No room'}`,search:normalize([i.name,i.category,i.tags,i.notes,i.brand,i.model,i.serial,i.partsFor,i.reassemblyNotes,b?.name,b?.code,r?.name,dr?.name].join(' '))});
    }
    for(const b of state.boxes){
      const r=roomsById.get(b.roomId);
      searchIndex.push({type:'box',id:b.id,title:`${b.code} · ${b.name||'Untitled box'}`,emoji:'📦',sub:`${r?.name||'No room'} · ${(itemsByBox.get(b.id)||[]).length} items`,search:normalize([b.code,b.name,b.notes,b.type,b.vehicle,r?.name].join(' '))});
    }
    for(const r of state.rooms){
      searchIndex.push({type:'room',id:r.id,title:r.name,emoji:r.emoji||'🏠',sub:`${(itemsByRoom.get(r.id)||[]).length} items · ${(boxesByRoom.get(r.id)||[]).length} boxes`,search:normalize([r.name,r.destination,r.notes].join(' '))});
    }
    derived={roomsById,boxesById,itemsById,itemsByBox,boxesByRoom,itemsByRoom,searchIndex};
  }

  function roomById(id){ return derived.roomsById?.get(id); }
  function boxById(id){ return derived.boxesById?.get(id); }
  function itemById(id){ return derived.itemsById?.get(id); }
  function itemsInBox(id){ return derived.itemsByBox?.get(id)||[]; }
  function boxesInRoom(id){ return derived.boxesByRoom?.get(id)||[]; }
  function itemsInRoom(id){ return derived.itemsByRoom?.get(id)||[]; }

  function taskDone(){ return state.tasks.reduce((n,t)=>n+(t.done?1:0),0); }
  function daysLeft(){
    if(!state.project.moveDate) return null;
    const target=new Date(`${state.project.moveDate}T23:59:59`);
    return Math.ceil((target-new Date())/86400000);
  }
  function packPercent(){
    const packable=state.items.filter(i=>i.decision!=='trash'&&i.decision!=='donate'&&i.decision!=='sell'&&!i.doNotPack);
    const itemPct=packable.length ? packable.filter(i=>['packed','loaded','unloaded','unpacked'].includes(i.status)).length/packable.length : 0;
    const boxPct=state.boxes.length ? state.boxes.filter(b=>['sealed','loaded','unloaded','unpacked'].includes(b.status)).length/state.boxes.length : 0;
    if(!packable.length && !state.boxes.length) return 0;
    if(!packable.length) return Math.round(boxPct*100);
    if(!state.boxes.length) return Math.round(itemPct*100);
    return Math.round((itemPct*.65+boxPct*.35)*100);
  }
  function declutterPercent(){ return state.items.length ? Math.round(state.items.filter(i=>i.decision).length/state.items.length*100) : 0; }
  function unpackPercent(){
    const boxes=state.boxes.filter(b=>['sealed','loaded','unloaded','unpacked'].includes(b.status));
    return boxes.length ? Math.round(boxes.filter(b=>b.status==='unpacked').length/boxes.length*100) : 0;
  }
  function readiness(){
    const setup=(state.project.moveDate?25:0)+(state.rooms.length?25:0)+(state.boxes.length?25:0)+(state.items.length?25:0);
    const tasks=state.tasks.length?taskDone()/state.tasks.length*100:0;
    return clamp(Math.round(packPercent()*.45+declutterPercent()*.15+tasks*.20+setup*.20),0,100);
  }
  function journeyPhase(){
    const d=daysLeft(), packed=packPercent(), unpacked=unpackPercent();
    if(unpacked>=90 && state.boxes.length) return 5;
    if(d!==null && d<=0 && packed>=50) return 3;
    if(state.boxes.some(b=>['loaded','unloaded'].includes(b.status))) return 3;
    if(state.boxes.some(b=>b.status==='unpacked')) return 4;
    if(packed>=20 || state.boxes.some(b=>b.status==='packing'||b.status==='sealed')) return 2;
    if(state.items.length && declutterPercent()<80) return 1;
    return 0;
  }
  function statusLabel(s){ return ({empty:'Empty',packing:'Packing',sealed:'Sealed',loaded:'Loaded',unloaded:'Unloaded',unpacked:'Unpacked',loose:'Loose',packed:'Packed'}[s]||s||'Not set'); }
  function priorityLabel(p){ return ({first:'Open first',high:'High',normal:'Normal',low:'Low'}[p]||'Normal'); }
  function overdueTasks(){ const today=todayISO(); return state.tasks.filter(t=>!t.done&&t.due&&t.due<today); }
  function soldProceeds(){ return state.items.reduce((n,i)=>n+(i.saleStatus==='sold'?(Number(i.soldPrice)||0):0),0); }
  function expenseTotal(){ return state.expenses.reduce((n,e)=>n+(Number(e.amount)||0),0); }

  function applyLaunchParamsOnce(){
    const params=new URLSearchParams(location.search);
    const tab=params.get('tab'), tool=params.get('tool'), action=params.get('action');
    if(tab&&['home','rooms','boxes','find','more'].includes(tab)) state.ui.tab=tab;
    if(tool) state.ui.tool=tool;
    try { history.replaceState({},'',location.pathname+location.hash); } catch(_) {}
    return action;
  }
  const launchAction=applyLaunchParamsOnce();

  // App-like interaction: disable pinch and accidental double-tap zoom while preserving normal one-finger scrolling.
  document.addEventListener('gesturestart',e=>e.preventDefault(),{passive:false});
  document.addEventListener('gesturechange',e=>e.preventDefault(),{passive:false});
  document.addEventListener('gestureend',e=>e.preventDefault(),{passive:false});
  document.addEventListener('touchmove',e=>{if(e.touches?.length>1)e.preventDefault();},{passive:false});
  let lastTouchEnd=0;
  document.addEventListener('touchend',e=>{
    const now=Date.now();
    if(now-lastTouchEnd<300&&!e.target.closest('input,textarea,select,[contenteditable=true]')) e.preventDefault();
    lastTouchEnd=now;
  },{passive:false});
  document.addEventListener('dblclick',e=>{if(!e.target.closest('input,textarea,select,[contenteditable=true]'))e.preventDefault();},{passive:false});

  window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredInstallPrompt=e;render();});
  window.addEventListener('appinstalled',()=>{deferredInstallPrompt=null;toast('Hako added to your home screen 💗');render();});
  window.addEventListener('pagehide',()=>{stopScanner(); saveState(true);});
  window.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='hidden') saveState(true); });
  if('serviceWorker' in navigator) window.addEventListener('load',()=>navigator.serviceWorker.register('./service-worker.js').catch(()=>{}));

  function render(){
    rebuildDerived();
    document.documentElement.dataset.accent=state.settings.accent||'pink';
    document.documentElement.classList.toggle('reduce-effects',!!state.settings.reduceEffects);
    document.documentElement.classList.toggle('compact-mode',!!state.settings.compact);
    if(!state.hasOnboarded){ renderOnboarding(); return; }
    $app.innerHTML=`<main class="screen">${topbar()}<section class="content" id="content">${view()}</section>${nav()}</main>`;
    requestAnimationFrame(()=>hydrateMedia($app));
  }

  function topbar(){
    const toolTitle={tasks:'Checklist',declutter:'Declutter','pack-mode':'Pack Mode','move-day':'Move Day',unpacking:'Unpacking',essentials:'Essentials',expenses:'Budget & Expenses',supplies:'Packing Supplies',utilities:'Utilities','address-change':'Address Change',documents:'Documents',contacts:'Contacts','fit-check':'Will It Fit?',reports:'Reports',backup:'Backup & Export',settings:'Settings',about:'About Hako'}[state.ui.tool];
    const titles={home:'Hako',rooms:'Rooms',boxes:'Boxes',find:'Find My Stuff',more:'More'};
    if(state.ui.tool) return `<header class="topbar"><button class="icon-btn" data-action="back-tool" aria-label="Back">‹</button><h1>${esc(toolTitle||'Hako')}</h1><button class="icon-btn" data-action="quick-add" aria-label="Quick add">＋</button></header>`;
    return `<header class="topbar"><button class="icon-btn" data-action="open-project" aria-label="Move settings">☰</button><h1>${esc(titles[state.ui.tab]||'Hako')}</h1><button class="icon-btn" data-action="quick-add" aria-label="Quick add">＋</button></header>`;
  }

  function nav(){
    const tabs=[['home','⌂','Home'],['rooms','▦','Rooms'],['boxes','▣','Boxes'],['find','⌕','Find'],['more','♡','More']];
    return `<nav class="nav" aria-label="Main navigation">${tabs.map(([id,icon,label])=>`<button class="nav-btn ${state.ui.tab===id&&!state.ui.tool?'active':''}" data-tab="${id}"><span class="nicon">${icon}</span><span>${label}</span></button>`).join('')}</nav>`;
  }

  function view(){
    if(state.ui.tool) return renderTool(state.ui.tool);
    return ({home:homeView,rooms:roomsView,boxes:boxesView,find:findView,more:moreView}[state.ui.tab]||homeView)();
  }

  function renderOnboarding(){
    $app.innerHTML=`<section class="onboarding">
      <div class="brand"><img src="icons/icon-192.png" alt="Hako pink box icon"><h1>Hako</h1><p>Moving & Decluttering</p></div>
      <div class="about-box"><strong>Hako (箱)</strong> means “box” in Japanese. Moving often starts with putting everything into boxes, but Hako is really about what comes next—sorting what stays, finding where everything belongs, and making a new space feel like home.</div>
      <div class="feature-chips"><span class="pill">📦 Boxes & QR</span><span class="pill">🏠 Rooms</span><span class="pill">🔎 Smart Find</span><span class="pill">✓ Checklists</span><span class="pill">🚚 Move Day</span><span class="pill">📴 Offline</span></div>
      <div class="onboarding-actions"><button class="primary-btn wide" data-action="start-setup">Set up my move</button><button class="soft-btn wide" data-action="skip-setup">Explore the empty app</button></div>
      <p class="tiny center-text">No account required. Core move data stays on this device unless you export it.</p>
    </section>`;
  }

  function journeyHTML(){
    const labels=[['Plan','✦'],['Declutter','♻'],['Pack','📦'],['Move','🚚'],['Unpack','🏠'],['Home','♡']];
    const phase=journeyPhase();
    return `<div class="journey">${labels.map(([label,icon],idx)=>`<div class="journey-step ${idx<phase?'done':idx===phase?'active':''}"><span>${idx<phase?'✓':icon}</span><small>${label}</small></div>`).join('')}</div>`;
  }

  function homeAlerts(){
    const alerts=[];
    const overdue=overdueTasks().length;
    const heavy=state.boxes.filter(b=>Number(b.weight)>=20).length;
    const missing=state.boxes.filter(b=>b.missing).length;
    const undecided=state.items.filter(i=>!i.decision).length;
    const doNotPack=state.items.filter(i=>i.doNotPack).length;
    if(overdue) alerts.push(`${overdue} overdue task${overdue===1?'':'s'}`);
    if(missing) alerts.push(`${missing} box${missing===1?' is':'es are'} marked missing`);
    if(heavy) alerts.push(`${heavy} heavy box${heavy===1?'':'es'} to handle carefully`);
    if(undecided&&state.items.length>5) alerts.push(`${undecided} item${undecided===1?'':'s'} still need a keep/sell/donate/trash decision`);
    if(doNotPack) alerts.push(`${doNotPack} do-not-pack item${doNotPack===1?'':'s'} should stay with you`);
    return alerts;
  }

  function homeView(){
    const d=daysLeft(), p=packPercent(), r=readiness(), alerts=homeAlerts();
    const keep=state.items.filter(i=>i.decision==='keep').length;
    const sell=state.items.filter(i=>i.decision==='sell').length;
    const donate=state.items.filter(i=>i.decision==='donate').length;
    const trash=state.items.filter(i=>i.decision==='trash').length;
    const essentials=state.items.filter(i=>i.essential).length;
    const openFirst=state.boxes.filter(b=>b.openFirst||b.priority==='first').length;
    const openTasks=state.tasks.filter(t=>!t.done).slice().sort((a,b)=>(a.due||'9999').localeCompare(b.due||'9999')).slice(0,4);
    return `
      <div class="hero"><div class="eyebrow">${d===null?'Your move hub':d<0?'Move date passed':d===0?'Moving day!':`${d} day${d===1?'':'s'} to go`}</div><h2>${state.profile.name?`Hi, ${esc(state.profile.name)}!`:'Everything in its place.'}</h2><p>${esc(state.project.name||'My Move')}${state.project.from||state.project.to?` · ${esc(state.project.from||'Current home')} → ${esc(state.project.to||'New home')}`:''}</p>${journeyHTML()}</div>
      ${deferredInstallPrompt&&!isStandalone()?`<div class="section"><div class="install-banner"><img src="icons/icon-96.png" alt=""><div class="copy"><h4>Install Hako</h4><p>Open it full-screen like a phone app.</p></div><button class="soft-btn small-btn" data-action="install">Install</button></div></div>`:''}
      ${alerts.length?`<div class="section"><div class="alert-card"><strong>Needs attention</strong>${alerts.slice(0,4).map(a=>`<span>• ${esc(a)}</span>`).join('')}</div></div>`:''}
      <div class="section"><div class="card dashboard-progress"><div class="progress-ring" style="--p:${p}"><strong>${p}%</strong><small>Packed</small></div><div class="copy"><h3>${r}% move-ready</h3><p>${state.items.length} items · ${state.boxes.length} boxes · ${state.rooms.length} rooms · ${state.tasks.filter(t=>!t.done).length} open tasks</p><div class="progress" style="margin-top:10px"><span style="width:${r}%"></span></div></div></div></div>
      <div class="section"><div class="section-head"><h2 class="section-title">Quick actions</h2></div><div class="quick-grid">
        <button class="quick-card" data-tool="pack-mode"><span class="emoji">⚡</span><span>Quick pack</span></button>
        <button class="quick-card" data-action="add-box"><span class="emoji">📦</span><span>Add box</span></button>
        <button class="quick-card" data-action="open-scan"><span class="emoji">▦</span><span>Scan box</span></button>
        <button class="quick-card" data-action="go-find"><span class="emoji">⌕</span><span>Find stuff</span></button>
      </div></div>
      <div class="section"><div class="grid-4 compact-stats"><button data-tool="essentials"><span>${essentials}</span><small>Essentials</small></button><button data-tool="declutter"><span>${keep}</span><small>Keep</small></button><button data-tool="declutter"><span>${donate}</span><small>Donate</small></button><button data-tool="declutter"><span>${sell}</span><small>Sell</small></button></div></div>
      <div class="section"><div class="grid-2"><div class="card stat"><span class="label">Open-first boxes</span><span class="value">${openFirst}</span></div><div class="card stat"><span class="label">Tasks done</span><span class="value">${taskDone()}/${state.tasks.length}</span></div></div></div>
      <div class="section"><div class="section-head"><h2 class="section-title">Declutter snapshot</h2><button class="soft-btn small-btn" data-tool="declutter">Open</button></div><div class="grid-4 decision-grid"><button data-tool="declutter">Keep<br><b>${keep}</b></button><button data-tool="declutter">Donate<br><b>${donate}</b></button><button data-tool="declutter">Sell<br><b>${sell}</b></button><button data-tool="declutter">Trash<br><b>${trash}</b></button></div></div>
      <div class="section"><div class="section-head"><h2 class="section-title">Next tasks</h2><button class="soft-btn small-btn" data-tool="tasks">View all</button></div>${openTasks.length?`<div class="list-card">${openTasks.map(taskRow).join('')}</div>`:empty('📝','No tasks yet','Generate the moving checklist or add a task so nothing gets forgotten.','Open checklist','open-tasks')}</div>
      ${state.activity.length?`<div class="section"><div class="section-head"><h2 class="section-title">Recent activity</h2></div><div class="list-card">${state.activity.slice(0,4).map(a=>`<div class="row"><div class="row-icon">•</div><div class="row-main"><div class="row-title">${esc(a.text)}</div><div class="row-sub">${new Date(a.at).toLocaleString()}</div></div></div>`).join('')}</div></div>`:''}`;
  }

  function roomPackedPercent(roomId){
    const items=itemsInRoom(roomId).filter(i=>i.decision!=='trash'&&i.decision!=='donate'&&i.decision!=='sell'&&!i.doNotPack);
    return items.length?Math.round(items.filter(i=>['packed','loaded','unloaded','unpacked'].includes(i.status)).length/items.length*100):0;
  }

  function roomsView(){
    const rooms=state.rooms.slice(0,VIEW_LIMIT);
    return `<div class="section-head"><div><h2 class="section-title">Your rooms</h2><div class="tiny">Organize where things are now and where they should go next.</div></div><button class="primary-btn small-btn" data-action="add-room">＋ Room</button></div>
      ${state.rooms.length?`<div class="grid-2">${rooms.map(r=>{
        const boxes=boxesInRoom(r.id), items=itemsInRoom(r.id), packed=roomPackedPercent(r.id);
        const setup=r.setupStatus||'not-started';
        return `<article class="card room-card perf-item"><div class="card-top"><div><h3>${esc(r.name)}</h3><p>${items.length} items · ${boxes.length} boxes</p></div><div class="room-emoji">${esc(r.emoji||'🏠')}</div></div><div class="progress" style="margin-top:13px"><span style="width:${packed}%"></span></div><div class="tiny" style="margin-top:6px">${packed}% packed${r.destination?` · → ${esc(r.destination)}`:''}</div><div class="tag-row"><span class="pill gray">Setup: ${setup==='done'?'Done':setup==='in-progress'?'In progress':'Not started'}</span>${r.priority==='high'?'<span class="pill warn">Priority room</span>':''}</div><div class="mini-actions"><button class="primary-btn small-btn" data-action="room-detail" data-id="${r.id}">Open</button><button class="soft-btn small-btn" data-action="filter-room" data-id="${r.id}">Boxes</button><button class="soft-btn small-btn" data-action="edit-room" data-id="${r.id}">Edit</button></div></article>`;
      }).join('')}</div>${state.rooms.length>VIEW_LIMIT?`<p class="tiny center-text">Showing first ${VIEW_LIMIT} rooms for smoother scrolling.</p>`:''}`:empty('🏠','No rooms yet','Add rooms such as Bedroom, Kitchen, Office, Storage or any custom space.','Add your first room','add-room')}`;
  }

  function boxFilterMatch(b,filter){
    if(filter==='all') return true;
    if(filter==='open-first') return b.openFirst||b.priority==='first';
    if(filter==='heavy') return Number(b.weight)>=20;
    if(filter==='missing') return !!b.missing;
    if(filter==='damaged') return !!b.damaged;
    return b.status===filter;
  }

  function boxesView(){
    const filter=state.ui.boxFilter||'all';
    let boxes=state.boxes.filter(b=>(!state.ui.roomFilter||b.roomId===state.ui.roomFilter)&&boxFilterMatch(b,filter));
    boxes=boxes.slice().sort((a,b)=>(Number(b.openFirst||b.priority==='first')-Number(a.openFirst||a.priority==='first'))||((a.loadOrder||9999)-(b.loadOrder||9999))||a.code.localeCompare(b.code));
    const room=roomById(state.ui.roomFilter);
    return `<div class="section-head"><div><h2 class="section-title">${room?esc(room.name)+' boxes':'Boxes & containers'}</h2><div class="tiny">Stable box codes, packing status, capacity, weight and move-day tracking.</div></div><button class="primary-btn small-btn" data-action="add-box">＋ Box</button></div>
      <div class="toolbar-row">${room?`<button class="soft-btn small-btn" data-action="clear-room-filter">← All rooms</button>`:'<span></span>'}<button class="soft-btn small-btn" data-action="open-scan">▦ Scan / enter code</button></div>
      <div class="segmented" style="margin-bottom:12px">${['all','open-first','packing','sealed','loaded','unloaded','unpacked','heavy','missing','damaged'].map(s=>`<button class="${filter===s?'active':''}" data-box-filter="${s}">${({'all':'All','open-first':'Open first','heavy':'Heavy','missing':'Missing','damaged':'Damaged'}[s]||statusLabel(s))}</button>`).join('')}</div>
      ${boxes.length?`<div class="stack">${boxes.slice(0,VIEW_LIMIT).map(b=>{
        const r=roomById(b.roomId), count=itemsInBox(b.id).length;
        const flags=[b.openFirst||b.priority==='first'?'OPEN FIRST':'',b.fragile?'FRAGILE':'',b.missing?'MISSING':'',b.damaged?'DAMAGED':''].filter(Boolean);
        return `<article class="card box-card perf-item"><div class="card-top"><div><div class="eyebrow">${esc(b.code)}</div><h3>${esc(b.name||'Untitled box')}</h3><p>${esc(r?.name||'No room')} · ${count} item${count===1?'':'s'}${b.vehicle?` · ${esc(b.vehicle)}`:''}</p></div><span class="pill ${b.status==='sealed'?'good':b.status==='loaded'?'warn':'gray'}">${statusLabel(b.status)}</span></div><div class="box-meter"><span><b>${clamp(b.capacity,0,100)}%</b> full</span><div class="progress"><span style="width:${clamp(b.capacity,0,100)}%"></span></div><span>${b.weight?`${Number(b.weight).toFixed(1)} ${state.project.units==='in'||state.project.units==='ft'?'lb':'kg'}`:'No weight'}</span></div>${flags.length?`<div class="tag-row">${flags.map(f=>`<span class="pill ${f==='MISSING'||f==='DAMAGED'?'warn':'gray'}">${f}</span>`).join('')}</div>`:''}${b.notes?`<p style="margin-top:10px">${esc(b.notes)}</p>`:''}<div class="mini-actions"><button class="primary-btn small-btn" data-action="box-detail" data-id="${b.id}">Open</button><button class="soft-btn small-btn" data-action="box-label" data-id="${b.id}">Label</button><button class="soft-btn small-btn" data-action="edit-box" data-id="${b.id}">Edit</button></div></article>`;
      }).join('')}</div>${boxes.length>VIEW_LIMIT?`<p class="tiny center-text">Showing first ${VIEW_LIMIT} matching boxes for smoother scrolling.</p>`:''}`:empty('📦','No boxes here','Create a box, bag, bin, suitcase or crate and assign it to a room.','Add a box','add-box')}`;
  }

  const SEARCH_SYNONYMS={
    charger:['cable','cord','adapter','usb'], cable:['charger','cord','wire'], clothes:['clothing','shirt','dress','pants'],
    medicine:['medication','meds','prescription'], documents:['passport','papers','records'], kitchen:['cooking','cookware'],
    shoes:['sneakers','heels','boots','slippers']
  };

  function performSearch(raw){
    const q=normalize(raw); if(!q) return [];
    const baseTokens=q.split(/\s+/).filter(Boolean);
    const tokenGroups=baseTokens.map(t=>[t,...(SEARCH_SYNONYMS[t]||[])]);
    return derived.searchIndex.map(entry=>{
      let score=0;
      for(const group of tokenGroups){
        const hits=group.filter(t=>entry.search.includes(t));
        if(!hits.length) return null;
        score += hits.reduce((s,t)=>s+(entry.search.startsWith(t)?5:2),0);
      }
      const title=normalize(entry.title);
      if(title===q) score+=12; else if(title.startsWith(q)) score+=6;
      return {...entry,score};
    }).filter(Boolean).sort((a,b)=>b.score-a.score||a.title.localeCompare(b.title)).slice(0,SEARCH_LIMIT);
  }

  function findResultsHTML(raw){
    const q=(raw||'').trim();
    if(!q) return empty('🔎','Where did I pack it?','Search item names, box codes, rooms, categories, tags, serial numbers, brands and notes. Try “passport”, “charger” or “KITCH-003”.');
    const results=performSearch(q);
    return results.length?`<div class="list-card">${results.map(x=>`<button class="row result-row" data-result-type="${x.type}" data-id="${x.id}"><div class="row-icon">${x.emoji}</div><div class="row-main"><div class="row-title">${esc(x.title)}</div><div class="row-sub">${esc(x.sub)}</div></div><span>›</span></button>`).join('')}</div>`:empty('🕵️','Nothing found','Try fewer words, a room name, category, item name, tag or box code.');
  }

  function findView(){
    return `<div class="searchbar"><span>⌕</span><input id="find-input" type="search" autocomplete="off" inputmode="search" enterkeyhint="search" placeholder="Search item, box code, room, category…" value="${esc(state.ui.findQuery||'')}"><button class="icon-btn mini-icon" data-action="voice-search" aria-label="Voice search">◉</button><button class="icon-btn mini-icon" data-action="open-scan" aria-label="Scan box">▦</button></div>
      ${state.recentSearches.length?`<div class="section"><div class="section-head"><h2 class="section-title">Recent</h2><button class="soft-btn small-btn" data-action="clear-searches">Clear</button></div><div class="segmented">${state.recentSearches.map(x=>`<button data-recent-search="${esc(x)}">${esc(x)}</button>`).join('')}</div></div>`:''}
      <div class="section"><div class="section-head"><h2 class="section-title">Find anything</h2><span class="tiny">Fast local search</span></div><div id="find-results">${findResultsHTML(state.ui.findQuery)}</div></div>`;
  }

  function moreView(){
    const tools=[
      ['tasks','✓','Checklist','Auto timeline, due dates and moving tasks'],
      ['declutter','♻','Declutter','Keep, sell, donate or trash'],
      ['pack-mode','⚡','Pack Mode','Focus timer, loose items and open boxes'],
      ['move-day','🚚','Move Day','Load, unload, missing and damaged boxes'],
      ['unpacking','🏡','Unpacking','Open-first and room setup progress'],
      ['essentials','⭐','Essentials','First-night and do-not-pack items'],
      ['expenses','₱','Budget','Budget, expenses and selling proceeds'],
      ['supplies','▧','Supplies','Boxes, tape and packing materials'],
      ['utilities','⚡','Utilities','Disconnect old and connect new services'],
      ['address-change','✉','Address Change','Track who still needs your new address'],
      ['documents','▤','Documents','Permits, contracts and references'],
      ['contacts','☏','Contacts','Movers, building admin and helpers'],
      ['fit-check','↔','Will It Fit?','Quick doorway and furniture size check'],
      ['reports','◫','Reports','Move readiness and inventory summaries'],
      ['backup','⇩','Backup & Export','Save or restore Hako data'],
      ['settings','⚙','Settings','Move details and preferences'],
      ['about','♡','About Hako','Meaning, privacy and What’s New']
    ];
    return `<div class="hero"><div class="eyebrow">Hako tools</div><h2>A tiny moving command center.</h2><p>The home screen stays simple; the deeper tools live here when you need them.</p></div><div class="section tool-grid">${tools.map(t=>`<button class="tool-card perf-item" data-tool="${t[0]}"><span class="tool-icon">${t[1]}</span><h3>${t[2]}</h3><p>${t[3]}</p></button>`).join('')}</div>`;
  }

  function renderTool(tool){
    if(tool==='tasks') return tasksView();
    if(tool==='declutter') return declutterView();
    if(tool==='pack-mode') return packModeView();
    if(tool==='move-day') return moveDayView();
    if(tool==='unpacking') return unpackingView();
    if(tool==='essentials') return essentialsView();
    if(tool==='expenses') return expensesView();
    if(tool==='supplies') return suppliesView();
    if(tool==='utilities') return utilitiesView();
    if(tool==='address-change') return addressChangeView();
    if(tool==='documents') return documentsView();
    if(tool==='contacts') return contactsView();
    if(tool==='fit-check') return fitCheckView();
    if(tool==='reports') return reportsView();
    if(tool==='backup') return backupView();
    if(tool==='settings') return settingsView();
    if(tool==='about') return aboutView();
    return moreView();
  }

  function taskRow(t){
    const overdue=!t.done&&t.due&&t.due<todayISO();
    return `<div class="row ${overdue?'row-alert':''}"><button class="check ${t.done?'done':''}" data-action="toggle-task" data-id="${t.id}" aria-label="Toggle task">${t.done?'✓':''}</button><div class="row-main"><div class="row-title" style="${t.done?'text-decoration:line-through;opacity:.55':''}">${esc(t.title)}</div><div class="row-sub">${overdue?'Overdue · ':''}${t.due?`Due ${fmtDate(t.due)}`:'No due date'}${t.category?` · ${esc(t.category)}`:''}${t.priority==='high'?' · High priority':''}</div></div><button class="icon-btn mini-icon" data-action="edit-task" data-id="${t.id}" aria-label="Edit task">⋯</button></div>`;
  }

  function tasksView(){
    const f=state.ui.taskFilter||'all';
    let tasks=state.tasks.slice();
    if(f==='open') tasks=tasks.filter(t=>!t.done);
    if(f==='done') tasks=tasks.filter(t=>t.done);
    if(f==='overdue') tasks=tasks.filter(t=>!t.done&&t.due&&t.due<todayISO());
    tasks.sort((a,b)=>(Number(a.done)-Number(b.done))||((a.due||'9999').localeCompare(b.due||'9999'))||((a.priority==='high'?-1:0)-(b.priority==='high'?-1:0)));
    return `<div class="section-head"><div><h2 class="section-title">Moving checklist</h2><div class="tiny">Plan before, during and after the move.</div></div><button class="primary-btn small-btn" data-action="add-task">＋ Task</button></div>
      <div class="action-strip"><button class="soft-btn" data-action="generate-checklist">✦ Generate move timeline</button></div>
      <div class="segmented" style="margin-bottom:12px">${['all','open','overdue','done'].map(x=>`<button class="${f===x?'active':''}" data-task-filter="${x}">${x[0].toUpperCase()+x.slice(1)}</button>`).join('')}</div>
      ${tasks.length?`<div class="list-card">${tasks.slice(0,VIEW_LIMIT).map(taskRow).join('')}</div>${tasks.length>VIEW_LIMIT?`<p class="tiny center-text">Showing first ${VIEW_LIMIT} tasks.</p>`:''}`:empty('✅','Checklist is clear','Generate a timeline or add tasks like book movers, change address, pack essentials or return keys.','Generate checklist','generate-checklist')}`;
  }

  function declutterView(){
    const f=state.ui.declutterFilter||'all';
    const decisions=['keep','donate','sell','trash'];
    const counts=Object.fromEntries(decisions.map(d=>[d,state.items.filter(i=>i.decision===d).length]));
    const undecided=state.items.filter(i=>!i.decision).length;
    let items=state.items.slice();
    if(f==='undecided') items=items.filter(i=>!i.decision); else if(f!=='all') items=items.filter(i=>i.decision===f);
    const sellValue=state.items.filter(i=>i.decision==='sell').reduce((n,i)=>n+(Number(i.value)||0),0);
    return `<div class="grid-3"><div class="card stat"><span class="label">Undecided</span><span class="value">${undecided}</span></div><div class="card stat"><span class="label">Sell estimate</span><span class="value small-value">${money(sellValue)}</span></div><div class="card stat"><span class="label">Sold</span><span class="value small-value">${money(soldProceeds())}</span></div></div>
      <div class="section"><div class="segmented">${['all','undecided','keep','donate','sell','trash'].map(x=>`<button class="${f===x?'active':''}" data-declutter-filter="${x}">${x==='all'?'All':x[0].toUpperCase()+x.slice(1)} ${x==='undecided'?undecided:(counts[x]??'')}</button>`).join('')}</div></div>
      <div class="section"><div class="section-head"><h2 class="section-title">Sort your things</h2><button class="primary-btn small-btn" data-action="add-item">＋ Item</button></div>${items.length?`<div class="stack">${items.slice(0,100).map(i=>`<div class="card perf-item"><div class="item-line">${itemThumb(i)}<div class="row-main"><div class="row-title">${esc(i.name)}</div><div class="row-sub">${esc(roomById(i.roomId)?.name||'No room')}${i.boxId?' · '+esc(boxById(i.boxId)?.code||'Box'):''}${i.value?` · ${money(i.value)}`:''}</div></div><button class="icon-btn mini-icon" data-action="edit-item" data-id="${i.id}">⋯</button></div><div class="decision-grid" style="margin-top:12px">${decisions.map(d=>`<button class="${i.decision===d?'active':''}" data-action="decide" data-id="${i.id}" data-value="${d}">${d[0].toUpperCase()+d.slice(1)}</button>`).join('')}</div>${i.decision==='sell'?`<div class="tiny" style="margin-top:8px">${i.saleStatus?`Status: ${esc(i.saleStatus)}`:'Add sale status/price in item details.'}</div>`:''}${i.decision==='donate'&&i.donationOrg?`<div class="tiny" style="margin-top:8px">Donate to ${esc(i.donationOrg)}</div>`:''}</div>`).join('')}</div>${items.length>100?'<p class="tiny center-text">Showing first 100 items for smoother decluttering. Use filters to narrow the list.</p>':''}`:empty('♻️','Nothing to sort here','Add items first, then decide what stays, gets donated, sold or let go.','Add an item','add-item')}</div>`;
  }

  function packModeView(){
    const roomFilter=state.ui.packRoomFilter||'all';
    const rooms=state.rooms;
    let loose=state.items.filter(i=>!i.boxId&&!i.doNotPack&&i.decision!=='trash'&&i.decision!=='donate'&&i.decision!=='sell');
    if(roomFilter!=='all') loose=loose.filter(i=>i.roomId===roomFilter);
    const openBoxes=state.boxes.filter(b=>['empty','packing'].includes(b.status) && (!roomFilter||roomFilter==='all'||b.roomId===roomFilter));
    const todaySessions=state.packingSessions.filter(s=>String(s.endedAt||'').slice(0,10)===todayISO());
    const minutes=todaySessions.reduce((n,s)=>n+(Number(s.minutes)||0),0);
    return `<div class="hero"><div class="eyebrow">Focused packing</div><h2>Pack without the menu hopping.</h2><p>Use quick-add, a focus timer and your loose-item queue. Photos are stored separately so the app stays lighter.</p></div>
      <div class="section"><div class="timer-card"><div><span class="label">Packing focus</span><strong id="packing-timer-display">${packingTimer.endAt?formatTimerRemaining():'Ready'}</strong><small>${minutes} min logged today</small></div><div class="timer-buttons"><button class="soft-btn small-btn" data-action="start-pack-timer" data-value="15">15m</button><button class="soft-btn small-btn" data-action="start-pack-timer" data-value="30">30m</button><button class="soft-btn small-btn" data-action="start-pack-timer" data-value="60">60m</button>${packingTimer.endAt?'<button class="danger-btn small-btn" data-action="stop-pack-timer">Stop</button>':''}</div></div></div>
      <div class="section"><div class="segmented"><button class="${roomFilter==='all'?'active':''}" data-pack-room="all">All rooms</button>${rooms.map(r=>`<button class="${roomFilter===r.id?'active':''}" data-pack-room="${r.id}">${esc(r.emoji||'🏠')} ${esc(r.name)}</button>`).join('')}</div></div>
      <div class="section"><div class="grid-2"><button class="primary-btn" data-action="quick-pack-add">＋ Add & keep packing</button><button class="soft-btn" data-action="add-box">＋ Open a box</button></div></div>
      <div class="section"><div class="section-head"><h2 class="section-title">Open boxes (${openBoxes.length})</h2><button class="soft-btn small-btn" data-action="go-boxes">All boxes</button></div>${openBoxes.length?`<div class="h-scroll">${openBoxes.slice(0,20).map(b=>`<button class="mini-box" data-action="box-detail" data-id="${b.id}"><b>${esc(b.code)}</b><span>${esc(b.name)}</span><small>${clamp(b.capacity,0,100)}% full · ${itemsInBox(b.id).length} items</small></button>`).join('')}</div>`:empty('📦','No open boxes','Create a box and set it to Empty or Packing.','Add box','add-box')}</div>
      <div class="section"><div class="section-head"><h2 class="section-title">Loose items (${loose.length})</h2></div>${loose.length?`<div class="list-card">${loose.slice(0,80).map(i=>`<div class="row"><div class="row-icon">${i.essential?'⭐':'•'}</div><div class="row-main"><div class="row-title">${esc(i.name)}</div><div class="row-sub">${esc(roomById(i.roomId)?.name||'No room')} · ${esc(i.category||'Uncategorized')}</div></div><button class="soft-btn small-btn" data-action="edit-item" data-id="${i.id}">Pack</button></div>`).join('')}</div>`:empty('🎀','No loose items in this view','Everything here is packed, sorted out, or marked do-not-pack.')}</div>`;
  }

  function moveDayView(){
    const loaded=state.boxes.filter(b=>['loaded','unloaded','unpacked'].includes(b.status)).length;
    const unloaded=state.boxes.filter(b=>['unloaded','unpacked'].includes(b.status)).length;
    const missing=state.boxes.filter(b=>b.missing).length;
    const damaged=state.boxes.filter(b=>b.damaged).length;
    const boxes=state.boxes.slice().sort((a,b)=>(a.loadOrder||9999)-(b.loadOrder||9999)||a.code.localeCompare(b.code));
    return `<div class="hero"><div class="eyebrow">Move Day Mode</div><h2>${loaded}/${state.boxes.length} loaded · ${unloaded} unloaded</h2><p>Fast one-handed controls for checking boxes onto the vehicle and into the new home.</p></div>
      <div class="section"><div class="grid-4 compact-stats"><button data-box-filter="loaded"><span>${loaded}</span><small>Loaded</small></button><button data-box-filter="unloaded"><span>${unloaded}</span><small>Unloaded</small></button><button data-box-filter="missing"><span>${missing}</span><small>Missing</small></button><button data-box-filter="damaged"><span>${damaged}</span><small>Damaged</small></button></div></div>
      <div class="section"><button class="primary-btn wide big-action" data-action="open-scan">▦ SCAN / ENTER BOX CODE</button></div>
      <div class="section">${boxes.length?`<div class="stack">${boxes.slice(0,VIEW_LIMIT).map(b=>`<div class="card perf-item ${b.missing?'danger-card':''}"><div class="card-top"><div><div class="eyebrow">${esc(b.code)}</div><h3 style="margin:0">${esc(b.name)}</h3><p class="tiny">${esc(roomById(b.roomId)?.name||'No room')} · ${statusLabel(b.status)}${b.vehicle?` · ${esc(b.vehicle)}`:''}${b.loadOrder?` · Load #${b.loadOrder}`:''}</p></div><span class="badge">${itemsInBox(b.id).length}</span></div><div class="move-day-actions"><button class="${['loaded','unloaded','unpacked'].includes(b.status)?'primary-btn':'soft-btn'}" data-action="set-box-status" data-id="${b.id}" data-value="loaded">✓ Loaded</button><button class="${['unloaded','unpacked'].includes(b.status)?'primary-btn':'soft-btn'}" data-action="set-box-status" data-id="${b.id}" data-value="unloaded">⌂ Unloaded</button><button class="${b.missing?'danger-btn':'soft-btn'}" data-action="toggle-missing" data-id="${b.id}">? Missing</button><button class="${b.damaged?'danger-btn':'soft-btn'}" data-action="toggle-damaged" data-id="${b.id}">! Damage</button></div></div>`).join('')}</div>`:empty('🚚','No boxes to move','Add and pack boxes first. Hako will turn them into a move-day loading list.','Add a box','add-box')}</div>`;
  }

  function unpackingView(){
    const boxes=state.boxes.filter(b=>['sealed','loaded','unloaded','unpacked'].includes(b.status)).slice().sort((a,b)=>(Number(b.openFirst||b.priority==='first')-Number(a.openFirst||a.priority==='first'))||a.code.localeCompare(b.code));
    const done=boxes.filter(b=>b.status==='unpacked').length;
    const roomDone=state.rooms.filter(r=>r.setupStatus==='done').length;
    return `<div class="card dashboard-progress"><div class="progress-ring" style="--p:${boxes.length?Math.round(done/boxes.length*100):0}"><strong>${done}/${boxes.length}</strong><small>Unpacked</small></div><div class="copy"><h3>Settle in room by room</h3><p>${roomDone}/${state.rooms.length} rooms marked set up. Open-first boxes appear first.</p></div></div>
      <div class="section">${boxes.length?`<div class="stack">${boxes.slice(0,VIEW_LIMIT).map(b=>`<div class="card perf-item"><div class="card-top"><div><div class="eyebrow">${esc(b.code)}</div><h3 style="margin:0">${esc(b.name)}</h3><p class="tiny">→ ${esc(roomById(b.roomId)?.destination||roomById(b.roomId)?.name||'Destination room')}</p></div><div class="tag-row">${b.openFirst||b.priority==='first'?'<span class="pill warn">OPEN FIRST</span>':''}<span class="pill ${b.status==='unpacked'?'good':'gray'}">${statusLabel(b.status)}</span></div></div><button class="${b.status==='unpacked'?'soft-btn':'primary-btn'} wide" style="margin-top:12px" data-action="set-box-status" data-id="${b.id}" data-value="${b.status==='unpacked'?'unloaded':'unpacked'}">${b.status==='unpacked'?'Mark not finished':'Mark unpacked'}</button></div>`).join('')}</div>`:empty('🏡','Nothing ready to unpack','Seal boxes during packing, then they will appear here.','View boxes','go-boxes')}</div>
      ${state.rooms.length?`<div class="section"><div class="section-head"><h2 class="section-title">Room setup</h2></div><div class="list-card">${state.rooms.map(r=>`<div class="row"><div class="row-icon">${esc(r.emoji||'🏠')}</div><div class="row-main"><div class="row-title">${esc(r.destination||r.name)}</div><div class="row-sub">${roomPackedPercent(r.id)}% packed · Setup ${r.setupStatus==='done'?'done':r.setupStatus==='in-progress'?'in progress':'not started'}</div></div><button class="soft-btn small-btn" data-action="cycle-room-setup" data-id="${r.id}">${r.setupStatus==='done'?'Done ✓':r.setupStatus==='in-progress'?'Finish':'Start'}</button></div>`).join('')}</div></div>`:''}`;
  }

  function essentialsView(){
    const firstNight=state.items.filter(i=>i.essential);
    const doNotPack=state.items.filter(i=>i.doNotPack);
    const openFirst=state.boxes.filter(b=>b.openFirst||b.priority==='first');
    return `<div class="hero"><div class="eyebrow">First night & keep-with-you</div><h2>Don’t bury the things you need first.</h2><p>Mark passports, medication, chargers, toiletries, keys and comfort items as essential or do-not-pack.</p></div>
      <div class="section"><div class="grid-3"><div class="card stat"><span class="label">Essentials</span><span class="value">${firstNight.length}</span></div><div class="card stat"><span class="label">Do not pack</span><span class="value">${doNotPack.length}</span></div><div class="card stat"><span class="label">Open first</span><span class="value">${openFirst.length}</span></div></div></div>
      <div class="section"><div class="section-head"><h2 class="section-title">Essential items</h2><button class="primary-btn small-btn" data-action="add-item">＋ Item</button></div>${firstNight.length?`<div class="list-card">${firstNight.map(i=>itemRow(i)).join('')}</div>`:empty('⭐','No essentials marked','Edit an item and turn on Essential / First Night.')}</div>
      <div class="section"><div class="section-head"><h2 class="section-title">Keep with you</h2></div>${doNotPack.length?`<div class="list-card">${doNotPack.map(i=>itemRow(i)).join('')}</div>`:empty('👜','Nothing marked do-not-pack','Use this for passports, keys, medication, phone chargers and valuables you should carry yourself.')}</div>`;
  }

  function expensesView(){
    const total=expenseTotal(), budget=Number(state.project.budget)||0, proceeds=soldProceeds(), net=Math.max(0,total-proceeds);
    const cats={}; state.expenses.forEach(e=>cats[e.category||'Other']=(cats[e.category||'Other']||0)+(Number(e.amount)||0));
    const pct=budget?clamp(Math.round(total/budget*100),0,100):0;
    return `<div class="grid-2"><div class="card stat"><span class="label">Total spent</span><span class="value small-value">${money(total)}</span></div><div class="card stat"><span class="label">Budget</span><span class="value small-value">${budget?money(budget):'Not set'}</span></div><div class="card stat"><span class="label">Sold proceeds</span><span class="value small-value">${money(proceeds)}</span></div><div class="card stat"><span class="label">Net move cost</span><span class="value small-value">${money(net)}</span></div></div>
      ${budget?`<div class="section"><div class="card"><div class="card-top"><div><div class="row-title">Budget used</div><div class="row-sub">${pct}% · ${money(Math.max(0,budget-total))} remaining</div></div><span class="pill ${total>budget?'warn':'good'}">${total>budget?'Over budget':'On track'}</span></div><div class="progress" style="margin-top:12px"><span style="width:${pct}%"></span></div></div></div>`:''}
      <div class="section"><button class="primary-btn wide" data-action="add-expense">＋ Add expense</button></div>
      ${Object.keys(cats).length?`<div class="section"><div class="section-head"><h2 class="section-title">By category</h2></div><div class="list-card">${Object.entries(cats).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`<div class="row"><div class="row-icon">₱</div><div class="row-main"><div class="row-title">${esc(k)}</div><div class="row-sub">${money(v)}</div></div></div>`).join('')}</div></div>`:''}
      <div class="section"><div class="section-head"><h2 class="section-title">Expenses</h2></div>${state.expenses.length?`<div class="list-card">${state.expenses.slice().reverse().slice(0,VIEW_LIMIT).map(e=>`<div class="row"><div class="row-icon">🧾</div><div class="row-main"><div class="row-title">${esc(e.title)}</div><div class="row-sub">${esc(e.category||'Other')} · ${money(e.amount)}</div></div><button class="icon-btn mini-icon" data-action="delete-expense" data-id="${e.id}">×</button></div>`).join('')}</div>`:empty('💸','No moving expenses yet','Track movers, supplies, storage, cleaning, travel, deposits and unexpected costs.')}</div>`;
  }

  function suppliesView(){
    const total=state.supplies.reduce((n,s)=>n+(Number(s.cost)||0),0), bought=state.supplies.filter(s=>s.bought).length;
    return `<div class="grid-2"><div class="card stat"><span class="label">Bought</span><span class="value">${bought}/${state.supplies.length}</span></div><div class="card stat"><span class="label">Estimated supplies</span><span class="value small-value">${money(total)}</span></div></div><div class="section-head section"><div><h2 class="section-title">Packing supplies</h2><div class="tiny">Track what you have and what you still need.</div></div><button class="primary-btn small-btn" data-action="add-supply">＋ Supply</button></div>${state.supplies.length?`<div class="list-card">${state.supplies.map(s=>`<div class="row"><button class="check ${s.bought?'done':''}" data-action="toggle-supply" data-id="${s.id}">${s.bought?'✓':''}</button><div class="row-main"><div class="row-title">${esc(s.name)}</div><div class="row-sub">Need ${esc(s.qty||'1')} ${s.unit?esc(s.unit):''}${s.cost?` · ${money(s.cost)}`:''}</div></div><button class="icon-btn mini-icon" data-action="delete-supply" data-id="${s.id}">×</button></div>`).join('')}</div>`:empty('📦','Supply list is empty','Add boxes, tape, markers, labels, bubble wrap, paper or anything else you need.','Add supply','add-supply')}`;
  }

  function utilitiesView(){
    return `<div class="hero"><div class="eyebrow">Old home → new home</div><h2>Utilities without the sticky-note chaos.</h2><p>Track disconnection, activation dates, providers and confirmation numbers.</p></div>
      <div class="section"><div class="grid-2"><button class="primary-btn" data-action="add-utility">＋ Add utility</button><button class="soft-btn" data-action="generate-utilities">✦ Add common utilities</button></div></div>
      <div class="section">${state.utilities.length?`<div class="stack">${state.utilities.map(u=>`<div class="card perf-item"><div class="card-top"><div><h3 style="margin:0">${esc(u.service)}</h3><p class="tiny">${esc(u.provider||'No provider')}</p></div><span class="pill ${u.newStatus==='connected'?'good':'gray'}">${u.newStatus==='connected'?'New connected':'New pending'}</span></div><div class="utility-grid"><span><b>Old home</b><small>${u.oldStatus==='disconnected'?'Disconnected':'Pending'}${u.disconnectDate?` · ${fmtShortDate(u.disconnectDate)}`:''}</small></span><span><b>New home</b><small>${u.newStatus==='connected'?'Connected':'Pending'}${u.connectDate?` · ${fmtShortDate(u.connectDate)}`:''}</small></span></div>${u.confirmation?`<div class="tiny">Confirmation: ${esc(u.confirmation)}</div>`:''}<div class="mini-actions"><button class="soft-btn small-btn" data-action="edit-utility" data-id="${u.id}">Edit</button><button class="danger-btn small-btn" data-action="delete-utility" data-id="${u.id}">Delete</button></div></div>`).join('')}</div>`:empty('⚡','No utilities tracked','Add electricity, water, internet, gas, trash or building services.','Add common utilities','generate-utilities')}</div>`;
  }

  function addressChangeView(){
    const done=state.addressChanges.filter(a=>a.status==='confirmed').length;
    return `<div class="card dashboard-progress"><div class="progress-ring" style="--p:${state.addressChanges.length?Math.round(done/state.addressChanges.length*100):0}"><strong>${done}/${state.addressChanges.length}</strong><small>Updated</small></div><div class="copy"><h3>Address change center</h3><p>Track every organization that still has your old address.</p></div></div>
      <div class="section"><div class="grid-2"><button class="primary-btn" data-action="add-address-change">＋ Add</button><button class="soft-btn" data-action="generate-address-list">✦ Starter list</button></div></div>
      <div class="section">${state.addressChanges.length?`<div class="list-card">${state.addressChanges.slice().sort((a,b)=>(a.status==='confirmed')-(b.status==='confirmed')||a.label.localeCompare(b.label)).map(a=>`<div class="row"><button class="check ${a.status==='confirmed'?'done':''}" data-action="cycle-address-status" data-id="${a.id}">${a.status==='confirmed'?'✓':''}</button><div class="row-main"><div class="row-title">${esc(a.label)}</div><div class="row-sub">${esc(a.category||'Other')} · ${a.status==='confirmed'?'Confirmed':a.status==='requested'?'Requested':'Not started'}${a.notes?` · ${esc(a.notes)}`:''}</div></div><button class="icon-btn mini-icon" data-action="edit-address-change" data-id="${a.id}">⋯</button></div>`).join('')}</div>`:empty('✉','No address updates yet','Generate a starter list for banks, employer, insurance, subscriptions, government and more.','Generate starter list','generate-address-list')}</div>`;
  }

  function documentsView(){
    return `<div class="about-box"><strong>Lightweight document register</strong><br>Hako tracks names, reference numbers and notes without storing huge PDF files in the app, which helps keep it fast and stable.</div><div class="section"><button class="primary-btn wide" data-action="add-document">＋ Add document / reference</button></div><div class="section">${state.documents.length?`<div class="list-card">${state.documents.map(d=>`<div class="row"><div class="row-icon">▤</div><div class="row-main"><div class="row-title">${esc(d.title)}</div><div class="row-sub">${esc(d.category||'Other')}${d.reference?` · ${esc(d.reference)}`:''}${d.due?` · ${fmtDate(d.due)}`:''}</div></div><button class="icon-btn mini-icon" data-action="edit-document" data-id="${d.id}">⋯</button></div>`).join('')}</div>`:empty('▤','No moving documents yet','Track mover contracts, permits, elevator bookings, insurance, utility confirmations and lease references.','Add document','add-document')}</div>`;
  }

  function contactsView(){
    return `<div class="section-head"><div><h2 class="section-title">Moving contacts</h2><div class="tiny">Movers, building admin, helpers, cleaners and emergency contacts.</div></div><button class="primary-btn small-btn" data-action="add-contact">＋ Contact</button></div>${state.contacts.length?`<div class="list-card">${state.contacts.map(c=>`<div class="row"><div class="row-icon">☏</div><div class="row-main"><div class="row-title">${esc(c.name)}</div><div class="row-sub">${esc(c.role||'Contact')}${c.phone?` · ${esc(c.phone)}`:''}</div></div>${c.phone?`<a class="soft-btn small-btn link-btn" href="tel:${esc(c.phone)}">Call</a>`:''}<button class="icon-btn mini-icon" data-action="edit-contact" data-id="${c.id}">⋯</button></div>`).join('')}</div>`:empty('☏','No moving contacts yet','Save the people you may need quickly on move day.','Add contact','add-contact')}`;
  }

  function fitCheckView(){
    return `<div class="hero"><div class="eyebrow">Quick estimate</div><h2>Will it fit?</h2><p>Compare the item’s two largest face dimensions with an opening. This is a planning aid, not a guarantee—angles, depth, handles and stair turns still matter.</p></div><div class="section"><form class="form card" id="fit-form"><div class="grid-3"><div class="field"><label>Item width</label><input type="number" step="0.1" min="0" name="iw" required></div><div class="field"><label>Item height</label><input type="number" step="0.1" min="0" name="ih" required></div><div class="field"><label>Item depth</label><input type="number" step="0.1" min="0" name="id" required></div></div><div class="grid-2"><div class="field"><label>Opening width</label><input type="number" step="0.1" min="0" name="ow" required></div><div class="field"><label>Opening height</label><input type="number" step="0.1" min="0" name="oh" required></div></div><button class="primary-btn wide" type="submit">Check fit</button></form><div id="fit-result"></div></div>`;
  }

  function reportsView(){
    const p=packPercent(), d=declutterPercent(), u=unpackPercent(), r=readiness();
    const fragile=state.items.filter(i=>i.fragile).length, essential=state.items.filter(i=>i.essential).length, totalValue=state.items.reduce((n,i)=>n+(Number(i.value)||0),0);
    const decisions={keep:0,donate:0,sell:0,trash:0,undecided:0}; state.items.forEach(i=>decisions[i.decision||'undecided']++);
    return `<div class="hero"><div class="eyebrow">Move report</div><h2>${r}% ready</h2><p>A lightweight snapshot generated entirely from your local Hako data.</p>${journeyHTML()}</div>
      <div class="section"><div class="grid-4 compact-stats"><div><span>${p}%</span><small>Packed</small></div><div><span>${d}%</span><small>Sorted</small></div><div><span>${u}%</span><small>Unpacked</small></div><div><span>${overdueTasks().length}</span><small>Overdue</small></div></div></div>
      <div class="section"><div class="grid-2"><div class="card stat"><span class="label">Inventory value</span><span class="value small-value">${money(totalValue)}</span></div><div class="card stat"><span class="label">Move spend</span><span class="value small-value">${money(expenseTotal())}</span></div><div class="card stat"><span class="label">Fragile items</span><span class="value">${fragile}</span></div><div class="card stat"><span class="label">Essentials</span><span class="value">${essential}</span></div></div></div>
      <div class="section"><div class="section-head"><h2 class="section-title">Declutter breakdown</h2></div><div class="grid-4 compact-stats"><div><span>${decisions.keep}</span><small>Keep</small></div><div><span>${decisions.donate}</span><small>Donate</small></div><div><span>${decisions.sell}</span><small>Sell</small></div><div><span>${decisions.trash}</span><small>Trash</small></div></div></div>
      ${state.rooms.length?`<div class="section"><div class="section-head"><h2 class="section-title">Room progress</h2></div><div class="list-card">${state.rooms.map(rm=>`<div class="row"><div class="row-icon">${esc(rm.emoji||'🏠')}</div><div class="row-main"><div class="row-title">${esc(rm.name)}</div><div class="row-sub">${itemsInRoom(rm.id).length} items · ${boxesInRoom(rm.id).length} boxes</div><div class="progress slim-progress"><span style="width:${roomPackedPercent(rm.id)}%"></span></div></div><b>${roomPackedPercent(rm.id)}%</b></div>`).join('')}</div></div>`:''}
      <div class="section grid-2"><button class="soft-btn" data-action="copy-summary">Copy summary</button><button class="primary-btn" data-action="export-csv">Export inventory CSV</button></div>`;
  }

  function backupView(){
    return `<div class="about-box"><strong>Local-first backup</strong><br>Core data is stored in this browser. Item photos are kept in IndexedDB instead of the main app record so adding photos causes far less lag. Export a backup before changing phones or clearing browser data.</div><div class="section stack"><button class="primary-btn wide" data-action="export-json">⇩ Export full Hako backup</button><button class="soft-btn wide" data-action="export-csv">⇩ Export item inventory (.csv)</button><button class="soft-btn wide" data-action="import-json">⇧ Restore from backup</button><input id="import-file" type="file" accept="application/json,.json" hidden></div><div class="section"><div class="card"><div class="row-title">Included</div><div class="row-sub wrap-text">Move setup, rooms, boxes, items, compressed item photos, declutter data, tasks, budget, supplies, utilities, address changes, documents, contacts, sessions, activity and settings.</div></div></div>`;
  }

  function settingsView(){
    return `<div class="stack">
      <button class="card text-left" data-action="open-project"><div class="row-title">Move setup</div><div class="row-sub">${esc(state.project.name)} · ${fmtDate(state.project.moveDate)}</div></button>
      <div class="card"><div class="row-title">Signature look</div><div class="row-sub wrap-text" style="margin:6px 0 12px">Hako uses light pink as its signature app color.</div><span class="pill">💗 Light Pink</span></div>
      <label class="setting-row card"><div><div class="row-title">Haptics</div><div class="row-sub">Tiny tap feedback when supported</div></div><input type="checkbox" data-setting="haptics" ${state.settings.haptics?'checked':''}></label>
      <label class="setting-row card"><div><div class="row-title">Reduced visual effects</div><div class="row-sub">Flatter shadows for older or slower phones</div></div><input type="checkbox" data-setting="reduceEffects" ${state.settings.reduceEffects?'checked':''}></label>
      <label class="setting-row card"><div><div class="row-title">Compact mode</div><div class="row-sub">Fit more information on screen</div></div><input type="checkbox" data-setting="compact" ${state.settings.compact?'checked':''}></label>
      <div class="card"><div class="row-title">Units & currency</div><div class="row-sub">${esc(state.project.units)} · ${esc(state.project.currency)}</div></div>
      <div class="card"><div class="row-title">Install on iPhone</div><div class="row-sub wrap-text">In Safari: Share → Add to Home Screen. Hako then launches in standalone app mode.</div></div>
      <button class="danger-btn wide" data-action="reset-app">Erase all Hako data</button>
    </div>`;
  }

  function aboutView(){
    return `<div class="brand about-brand"><img src="icons/icon-192.png" alt="Hako icon"><h1>Hako</h1><p>Version ${APP_VERSION}</p></div><div class="about-box"><strong>Hako (箱)</strong> means “box” in Japanese. Moving often starts with putting everything into boxes, but Hako is really about what comes next—sorting what stays, finding where everything belongs, and making a new space feel like home.</div><div class="section"><div class="section-head"><h2 class="section-title">What’s New · ${APP_VERSION}</h2></div><div class="list-card"><div class="row"><div class="row-icon">⚡</div><div class="row-main"><div class="row-title">Mega feature + stability build</div><div class="row-sub wrap-text">Stable box codes, faster search, IndexedDB photos, Quick Pack, focus timer, enhanced box metadata, Move Day flags, first-night essentials, utilities, address changes, document register, contacts, budget reports, fit checker, generated checklists and more.</div></div></div><div class="row"><div class="row-icon">🛠</div><div class="row-main"><div class="row-title">Performance fixes</div><div class="row-sub wrap-text">Search no longer re-renders the entire app on every keystroke, long lists are capped, visual blur effects were reduced, route shortcuts no longer trap navigation, and task sorting no longer mutates saved order.</div></div></div></div></div><div class="section"><div class="card"><div class="row-title">Privacy</div><div class="row-sub wrap-text">No account is required. This build does not send your inventory to a Hako server. Exported backups are files you control.</div></div></div>`;
  }

  function empty(icon,title,text,buttonText,action){ return `<div class="empty"><div class="big">${icon}</div><h3>${title}</h3><p>${text}</p>${buttonText?`<button class="primary-btn" data-action="${action}">${buttonText}</button>`:''}</div>`; }

  function itemThumb(i){
    if(i.photoRef) return `<img class="item-thumb" data-media="${esc(i.photoRef)}" alt="" loading="lazy" decoding="async">`;
    if(i.legacyPhoto) return `<img class="item-thumb" src="${i.legacyPhoto}" alt="" loading="lazy" decoding="async">`;
    return `<span class="item-thumb placeholder">${i.essential?'⭐':'•'}</span>`;
  }
  function itemRow(i){
    const b=boxById(i.boxId),r=roomById(i.roomId);
    return `<button class="row result-row" data-action="edit-item" data-id="${i.id}">${itemThumb(i)}<div class="row-main"><div class="row-title">${esc(i.name)}</div><div class="row-sub">${b?`${esc(b.code)} · ${esc(b.name)}`:'Loose'} · ${esc(r?.name||'No room')}</div></div><span>›</span></button>`;
  }

  function openSheet(title,body,opts={}){
    stopScanner();
    $modal.innerHTML=`<div class="sheet-backdrop" data-action="close-modal"><section class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}" data-sheet><div class="sheet-handle"></div><div class="sheet-head"><h2>${esc(title)}</h2><button class="icon-btn" data-action="close-modal" aria-label="Close">×</button></div>${body}</section></div>`;
    requestAnimationFrame(()=>{
      hydrateMedia($modal);
      if(opts.focus!==false){ const el=$modal.querySelector('input:not([type=hidden]):not([readonly]),select,textarea'); setTimeout(()=>el?.focus(),40); }
    });
  }
  function closeModal(){ stopScanner(); $modal.innerHTML=''; }

  function openSetup(first=false){
    const p=state.project;
    openSheet(first?'Set up your move':'Move setup',`<form class="form" id="project-form">
      <div class="field"><label>Your name (optional)</label><input name="name" maxlength="40" value="${esc(state.profile.name)}" placeholder="Your name"></div>
      <div class="grid-2"><div class="field"><label>Move name</label><input name="projectName" maxlength="60" value="${esc(p.name)}" placeholder="New Apartment"></div><div class="field"><label>Move type</label><select name="moveType">${['Home move','Decluttering only','Storage / organization','Room reset'].map(x=>`<option ${p.moveType===x?'selected':''}>${x}</option>`).join('')}</select></div></div>
      <div class="grid-2"><div class="field"><label>Move date</label><input type="date" name="moveDate" value="${esc(p.moveDate)}"></div><div class="field"><label>Household size</label><input type="number" min="1" max="30" name="householdSize" value="${Number(p.householdSize)||1}"></div></div>
      <div class="field"><label>Home type</label><select name="homeType"><option value="">Not set</option>${['Condo','Apartment','House','Dorm / room','Office','Other'].map(x=>`<option ${p.homeType===x?'selected':''}>${x}</option>`).join('')}</select></div>
      <div class="grid-2"><div class="field"><label>Moving from</label><input name="from" maxlength="100" value="${esc(p.from)}" placeholder="Current home"></div><div class="field"><label>Moving to</label><input name="to" maxlength="100" value="${esc(p.to)}" placeholder="New home"></div></div>
      <div class="grid-3"><div class="field"><label>Currency</label><select name="currency">${['PHP','JPY','USD','EUR','GBP','SGD','HKD','AUD','CAD'].map(x=>`<option ${p.currency===x?'selected':''}>${x}</option>`).join('')}</select></div><div class="field"><label>Measurements</label><select name="units">${['cm','m','in','ft'].map(x=>`<option ${p.units===x?'selected':''}>${x}</option>`).join('')}</select></div><div class="field"><label>Moving budget</label><input type="number" min="0" step="0.01" name="budget" value="${Number(p.budget)||''}" placeholder="0"></div></div>
      <div class="form-actions"><button type="button" class="soft-btn" data-action="close-modal">Cancel</button><button class="primary-btn" type="submit">Save move</button></div>
    </form>`,{focus:!first});
  }

  function openRoomForm(id){
    const r=state.rooms.find(x=>x.id===id)||{name:'',emoji:'🏠',destination:'',notes:'',priority:'normal',setupStatus:'not-started'};
    openSheet(id?'Edit room':'Add room',`<form class="form" id="room-form" data-id="${id||''}">
      <div class="grid-2"><div class="field"><label>Room name</label><input required name="name" maxlength="50" value="${esc(r.name)}" placeholder="Bedroom"></div><div class="field"><label>Emoji</label><input name="emoji" maxlength="8" value="${esc(r.emoji||'🏠')}"></div></div>
      <div class="field"><label>Destination room / area</label><input name="destination" maxlength="60" value="${esc(r.destination||'')}" placeholder="New Home · Bedroom"></div>
      <div class="grid-2"><div class="field"><label>Priority</label><select name="priority">${['normal','high','low'].map(x=>`<option value="${x}" ${r.priority===x?'selected':''}>${x[0].toUpperCase()+x.slice(1)}</option>`).join('')}</select></div><div class="field"><label>Setup status</label><select name="setupStatus">${[['not-started','Not started'],['in-progress','In progress'],['done','Done']].map(([v,l])=>`<option value="${v}" ${r.setupStatus===v?'selected':''}>${l}</option>`).join('')}</select></div></div>
      <div class="field"><label>Notes / setup ideas</label><textarea name="notes" maxlength="500" placeholder="Furniture placement, cleaning, repairs, install notes…">${esc(r.notes||'')}</textarea></div>
      <div class="form-actions">${id?`<button type="button" class="danger-btn" data-action="delete-room" data-id="${id}">Delete</button>`:`<button type="button" class="soft-btn" data-action="close-modal">Cancel</button>`}<button class="primary-btn" type="submit">Save room</button></div>
    </form>`);
  }

  function openRoomDetail(id){
    const r=roomById(id); if(!r)return;
    const boxes=boxesInRoom(id), items=itemsInRoom(id), packed=roomPackedPercent(id);
    openSheet(r.name,`<div class="stack"><div class="card"><div class="card-top"><div><div class="eyebrow">Room progress</div><h3 style="margin:0">${packed}% packed</h3><p class="tiny">${items.length} items · ${boxes.length} boxes${r.destination?` · → ${esc(r.destination)}`:''}</p></div><div class="room-emoji">${esc(r.emoji||'🏠')}</div></div><div class="progress" style="margin-top:12px"><span style="width:${packed}%"></span></div>${r.notes?`<p class="wrap-text">${esc(r.notes)}</p>`:''}</div>
      <div class="grid-2"><button class="primary-btn" data-action="filter-room" data-id="${id}">View boxes</button><button class="soft-btn" data-action="edit-room" data-id="${id}">Edit room</button></div>
      <div class="section-head"><h3 class="section-title">Items (${items.length})</h3><button class="soft-btn small-btn" data-action="add-item">＋ Item</button></div>${items.length?`<div class="list-card">${items.slice(0,50).map(itemRow).join('')}</div>`:empty('•','No items in this room','Add items and assign them to this room.')}
    </div>`,{focus:false});
  }

  function openBoxForm(id){
    const b=state.boxes.find(x=>x.id===id)||{name:'',roomId:'',type:'Box',status:'empty',notes:'',fragile:false,openFirst:false,capacity:0,weight:0,priority:'normal',vehicle:'',loadOrder:0,missing:false,damaged:false,code:''};
    openSheet(id?'Edit box':'Add box',`<form class="form" id="box-form" data-id="${id||''}">
      ${id?`<div class="field"><label>Stable box code</label><input readonly value="${esc(b.code)}"><div class="tiny">This code stays the same even if the box moves rooms.</div></div>`:''}
      <div class="field"><label>Box name</label><input required name="name" maxlength="70" value="${esc(b.name)}" placeholder="Kitchen essentials"></div>
      <div class="grid-2"><div class="field"><label>Room</label><select name="roomId"><option value="">No room</option>${state.rooms.map(r=>`<option value="${r.id}" ${b.roomId===r.id?'selected':''}>${esc(r.name)}</option>`).join('')}</select></div><div class="field"><label>Container type</label><select name="type">${['Box','Bin','Bag','Suitcase','Crate','Parts bag','Other'].map(x=>`<option ${b.type===x?'selected':''}>${x}</option>`).join('')}</select></div></div>
      <div class="grid-2"><div class="field"><label>Status</label><select name="status">${['empty','packing','sealed','loaded','unloaded','unpacked'].map(x=>`<option value="${x}" ${b.status===x?'selected':''}>${statusLabel(x)}</option>`).join('')}</select></div><div class="field"><label>Priority</label><select name="priority">${[['normal','Normal'],['first','Open first'],['high','High'],['low','Low']].map(([v,l])=>`<option value="${v}" ${b.priority===v?'selected':''}>${l}</option>`).join('')}</select></div></div>
      <div class="grid-2"><div class="field"><label>Capacity %</label><input type="number" min="0" max="100" step="5" name="capacity" value="${clamp(b.capacity,0,100)}"></div><div class="field"><label>Approx. weight (${state.project.units==='in'||state.project.units==='ft'?'lb':'kg'})</label><input type="number" min="0" step="0.1" name="weight" value="${Number(b.weight)||''}"></div></div>
      <div class="grid-2"><div class="field"><label>Vehicle / trip</label><input name="vehicle" maxlength="40" value="${esc(b.vehicle||'')}" placeholder="Truck 1"></div><div class="field"><label>Load order</label><input type="number" min="0" step="1" name="loadOrder" value="${Number(b.loadOrder)||''}" placeholder="1"></div></div>
      <div class="field"><label>Notes</label><textarea name="notes" maxlength="600" placeholder="Plates, mugs, charger…">${esc(b.notes||'')}</textarea></div>
      <div class="grid-2"><label class="check-card"><input type="checkbox" name="fragile" ${b.fragile?'checked':''}> Fragile</label><label class="check-card"><input type="checkbox" name="openFirst" ${b.openFirst?'checked':''}> Open first</label><label class="check-card"><input type="checkbox" name="missing" ${b.missing?'checked':''}> Missing</label><label class="check-card"><input type="checkbox" name="damaged" ${b.damaged?'checked':''}> Damaged</label></div>
      <div class="form-actions">${id?`<button type="button" class="danger-btn" data-action="delete-box" data-id="${id}">Delete</button>`:`<button type="button" class="soft-btn" data-action="close-modal">Cancel</button>`}<button class="primary-btn" type="submit">Save box</button></div>
    </form>`);
  }

  function openItemForm(id,opts={}){
    const forcedBoxId=opts.boxId||'';
    const i=state.items.find(x=>x.id===id)||{name:'',quantity:1,category:'',roomId:'',destinationRoomId:'',boxId:forcedBoxId,status:forcedBoxId?'packed':'loose',decision:'',tags:'',notes:'',fragile:false,essential:false,doNotPack:false,sentimental:false,value:'',photoRef:'',condition:'',brand:'',model:'',serial:'',width:'',height:'',depth:'',saleStatus:'',soldPrice:'',donationOrg:'',partsFor:'',reassemblyNotes:''};
    const preview=i.photoRef?`<img class="photo-preview" data-media="${esc(i.photoRef)}" alt="Item photo">`:i.legacyPhoto?`<img class="photo-preview" src="${i.legacyPhoto}" alt="Item photo">`:'';
    openSheet(id?'Edit item':opts.continuous?'Quick Pack · Add item':'Add item',`<form class="form" id="item-form" data-id="${id||''}" data-continuous="${opts.continuous?'1':'0'}">
      <div class="grid-2"><div class="field"><label>Item name</label><input required name="name" maxlength="90" value="${esc(i.name)}" placeholder="Blender"></div><div class="field"><label>Quantity</label><input type="number" min="1" max="999" step="1" name="quantity" value="${Number(i.quantity)||1}"></div></div>
      <div class="grid-2"><div class="field"><label>Category</label><input name="category" maxlength="50" value="${esc(i.category||'')}" placeholder="Kitchen"></div><div class="field"><label>Decision</label><select name="decision"><option value="">Undecided</option>${['keep','donate','sell','trash'].map(x=>`<option value="${x}" ${i.decision===x?'selected':''}>${x[0].toUpperCase()+x.slice(1)}</option>`).join('')}</select></div></div>
      <div class="grid-2"><div class="field"><label>Current room</label><select name="roomId"><option value="">No room</option>${state.rooms.map(r=>`<option value="${r.id}" ${i.roomId===r.id?'selected':''}>${esc(r.name)}</option>`).join('')}</select></div><div class="field"><label>Destination room</label><select name="destinationRoomId"><option value="">Same / not set</option>${state.rooms.map(r=>`<option value="${r.id}" ${i.destinationRoomId===r.id?'selected':''}>${esc(r.destination||r.name)}</option>`).join('')}</select></div></div>
      <div class="field"><label>Packed in</label><select name="boxId"><option value="">Loose / no box</option>${state.boxes.map(b=>`<option value="${b.id}" ${i.boxId===b.id?'selected':''}>${esc(b.code)} · ${esc(b.name)}</option>`).join('')}</select></div>
      <div class="grid-2"><div class="field"><label>Condition</label><select name="condition"><option value="">Not set</option>${['New','Excellent','Good','Fair','Poor','Needs repair'].map(x=>`<option ${i.condition===x?'selected':''}>${x}</option>`).join('')}</select></div><div class="field"><label>Estimated value</label><input type="number" min="0" step="0.01" name="value" value="${esc(i.value||'')}"></div></div>
      <div class="field"><label>Tags</label><input name="tags" maxlength="160" value="${esc(i.tags||'')}" placeholder="winter, documents, favorite"></div>
      <div class="field"><label>Photo</label>${preview}<input type="file" id="item-photo" accept="image/*" capture="environment"><div class="tiny">Photos are compressed and stored separately for smoother performance.</div></div>
      <div class="field"><label>Notes</label><textarea name="notes" maxlength="700">${esc(i.notes||'')}</textarea></div>
      <div class="grid-2"><label class="check-card"><input type="checkbox" name="fragile" ${i.fragile?'checked':''}> Fragile</label><label class="check-card"><input type="checkbox" name="essential" ${i.essential?'checked':''}> Essential / first night</label><label class="check-card"><input type="checkbox" name="doNotPack" ${i.doNotPack?'checked':''}> Do not pack</label><label class="check-card"><input type="checkbox" name="sentimental" ${i.sentimental?'checked':''}> Memory / sentimental</label></div>
      <details class="details-card"><summary>More details</summary><div class="form details-body">
        <div class="grid-3"><div class="field"><label>Brand</label><input name="brand" maxlength="50" value="${esc(i.brand||'')}"></div><div class="field"><label>Model</label><input name="model" maxlength="50" value="${esc(i.model||'')}"></div><div class="field"><label>Serial no.</label><input name="serial" maxlength="70" value="${esc(i.serial||'')}"></div></div>
        <div class="grid-3"><div class="field"><label>Width</label><input type="number" min="0" step="0.1" name="width" value="${esc(i.width||'')}"></div><div class="field"><label>Height</label><input type="number" min="0" step="0.1" name="height" value="${esc(i.height||'')}"></div><div class="field"><label>Depth</label><input type="number" min="0" step="0.1" name="depth" value="${esc(i.depth||'')}"></div></div>
        <div class="field"><label>Parts belong to</label><input name="partsFor" maxlength="90" value="${esc(i.partsFor||'')}" placeholder="IKEA bed / TV stand"></div>
        <div class="field"><label>Reassembly / cable notes</label><textarea name="reassemblyNotes" maxlength="700" placeholder="Which cable goes where, screw bag location, assembly reminder…">${esc(i.reassemblyNotes||'')}</textarea></div>
        <div class="grid-2"><div class="field"><label>Sale status</label><select name="saleStatus"><option value="">Not tracked</option>${['planned','listed','reserved','sold'].map(x=>`<option value="${x}" ${i.saleStatus===x?'selected':''}>${x[0].toUpperCase()+x.slice(1)}</option>`).join('')}</select></div><div class="field"><label>Sold price</label><input type="number" min="0" step="0.01" name="soldPrice" value="${Number(i.soldPrice)||''}"></div></div>
        <div class="field"><label>Donation destination</label><input name="donationOrg" maxlength="100" value="${esc(i.donationOrg||'')}" placeholder="Charity / friend / donation center"></div>
      </div></details>
      <div class="form-actions">${id?`<button type="button" class="danger-btn" data-action="delete-item" data-id="${id}">Delete</button>`:`<button type="button" class="soft-btn" data-action="close-modal">Cancel</button>`}<button class="primary-btn" type="submit">${opts.continuous&&!id?'Save & add another':'Save item'}</button></div>
    </form>`,{focus:true});
  }

  function openTaskForm(id){
    const t=state.tasks.find(x=>x.id===id)||{title:'',due:'',category:'Packing',notes:'',done:false,priority:'normal'};
    openSheet(id?'Edit task':'Add task',`<form class="form" id="task-form" data-id="${id||''}"><div class="field"><label>Task</label><input required name="title" maxlength="110" value="${esc(t.title)}" placeholder="Book moving truck"></div><div class="grid-3"><div class="field"><label>Due date</label><input type="date" name="due" value="${esc(t.due||'')}"></div><div class="field"><label>Category</label><select name="category">${['Plan & Notify','Declutter','Packing','Move Day','After Move','Admin','Other'].map(x=>`<option ${t.category===x?'selected':''}>${x}</option>`).join('')}</select></div><div class="field"><label>Priority</label><select name="priority">${['normal','high','low'].map(x=>`<option value="${x}" ${t.priority===x?'selected':''}>${x[0].toUpperCase()+x.slice(1)}</option>`).join('')}</select></div></div><div class="field"><label>Notes</label><textarea name="notes" maxlength="500">${esc(t.notes||'')}</textarea></div><label class="check-card"><input type="checkbox" name="done" ${t.done?'checked':''}> Completed</label><div class="form-actions">${id?`<button type="button" class="danger-btn" data-action="delete-task" data-id="${id}">Delete</button>`:`<button type="button" class="soft-btn" data-action="close-modal">Cancel</button>`}<button class="primary-btn" type="submit">Save task</button></div></form>`);
  }

  function openExpenseForm(){
    openSheet('Add expense',`<form class="form" id="expense-form"><div class="field"><label>Expense</label><input required name="title" maxlength="90" placeholder="Moving truck"></div><div class="grid-2"><div class="field"><label>Amount</label><input required type="number" min="0" step="0.01" name="amount" placeholder="0"></div><div class="field"><label>Category</label><select name="category">${['Movers','Packing Supplies','Storage','Cleaning','Travel','Deposits','Utilities','Furniture','Repairs','Food','Other'].map(x=>`<option>${x}</option>`).join('')}</select></div></div><div class="field"><label>Notes</label><textarea name="notes" maxlength="400"></textarea></div><div class="form-actions"><button type="button" class="soft-btn" data-action="close-modal">Cancel</button><button class="primary-btn" type="submit">Save expense</button></div></form>`);
  }

  function openSupplyForm(){
    openSheet('Add packing supply',`<form class="form" id="supply-form"><div class="field"><label>Supply</label><input required name="name" maxlength="80" placeholder="Packing tape"></div><div class="grid-2"><div class="field"><label>Quantity needed</label><input name="qty" type="number" min="0" step="1" value="1"></div><div class="field"><label>Unit</label><input name="unit" maxlength="20" placeholder="rolls"></div></div><div class="field"><label>Estimated cost</label><input name="cost" type="number" min="0" step="0.01"></div><div class="form-actions"><button type="button" class="soft-btn" data-action="close-modal">Cancel</button><button class="primary-btn" type="submit">Save supply</button></div></form>`);
  }

  function openUtilityForm(id){
    const u=state.utilities.find(x=>x.id===id)||{service:'',provider:'',oldStatus:'pending',newStatus:'pending',disconnectDate:'',connectDate:'',confirmation:'',notes:''};
    openSheet(id?'Edit utility':'Add utility',`<form class="form" id="utility-form" data-id="${id||''}"><div class="grid-2"><div class="field"><label>Service</label><input required name="service" maxlength="60" value="${esc(u.service)}" placeholder="Internet"></div><div class="field"><label>Provider</label><input name="provider" maxlength="80" value="${esc(u.provider||'')}"></div></div><div class="grid-2"><div class="field"><label>Old home status</label><select name="oldStatus"><option value="pending" ${u.oldStatus!=='disconnected'?'selected':''}>Pending</option><option value="disconnected" ${u.oldStatus==='disconnected'?'selected':''}>Disconnected</option></select></div><div class="field"><label>New home status</label><select name="newStatus"><option value="pending" ${u.newStatus!=='connected'?'selected':''}>Pending</option><option value="connected" ${u.newStatus==='connected'?'selected':''}>Connected</option></select></div></div><div class="grid-2"><div class="field"><label>Disconnect date</label><input type="date" name="disconnectDate" value="${esc(u.disconnectDate||'')}"></div><div class="field"><label>Connect date</label><input type="date" name="connectDate" value="${esc(u.connectDate||'')}"></div></div><div class="field"><label>Confirmation / account reference</label><input name="confirmation" maxlength="100" value="${esc(u.confirmation||'')}"></div><div class="field"><label>Notes</label><textarea name="notes" maxlength="500">${esc(u.notes||'')}</textarea></div><div class="form-actions">${id?`<button type="button" class="danger-btn" data-action="delete-utility" data-id="${id}">Delete</button>`:`<button type="button" class="soft-btn" data-action="close-modal">Cancel</button>`}<button class="primary-btn" type="submit">Save utility</button></div></form>`);
  }

  function openAddressForm(id){
    const a=state.addressChanges.find(x=>x.id===id)||{label:'',category:'Bank / Finance',status:'not-started',notes:''};
    openSheet(id?'Edit address update':'Add address update',`<form class="form" id="address-form" data-id="${id||''}"><div class="field"><label>Organization / person</label><input required name="label" maxlength="90" value="${esc(a.label)}" placeholder="BPI / Employer / Insurance"></div><div class="grid-2"><div class="field"><label>Category</label><select name="category">${['Bank / Finance','Employer','Government','Insurance','Utilities','Shopping / Delivery','Subscriptions','School','Healthcare','Friends / Family','Other'].map(x=>`<option ${a.category===x?'selected':''}>${x}</option>`).join('')}</select></div><div class="field"><label>Status</label><select name="status">${[['not-started','Not started'],['requested','Requested'],['confirmed','Confirmed']].map(([v,l])=>`<option value="${v}" ${a.status===v?'selected':''}>${l}</option>`).join('')}</select></div></div><div class="field"><label>Notes</label><textarea name="notes" maxlength="400">${esc(a.notes||'')}</textarea></div><div class="form-actions">${id?`<button type="button" class="danger-btn" data-action="delete-address-change" data-id="${id}">Delete</button>`:`<button type="button" class="soft-btn" data-action="close-modal">Cancel</button>`}<button class="primary-btn" type="submit">Save</button></div></form>`);
  }

  function openDocumentForm(id){
    const d=state.documents.find(x=>x.id===id)||{title:'',category:'Moving contract',reference:'',due:'',notes:''};
    openSheet(id?'Edit document':'Add document / reference',`<form class="form" id="document-form" data-id="${id||''}"><div class="field"><label>Title</label><input required name="title" maxlength="100" value="${esc(d.title)}" placeholder="Condo move-in permit"></div><div class="grid-2"><div class="field"><label>Category</label><select name="category">${['Moving contract','Permit / building','Lease / property','Insurance','Utility confirmation','Receipt reference','School / medical','Other'].map(x=>`<option ${d.category===x?'selected':''}>${x}</option>`).join('')}</select></div><div class="field"><label>Due / expiry date</label><input type="date" name="due" value="${esc(d.due||'')}"></div></div><div class="field"><label>Reference number / link note</label><input name="reference" maxlength="160" value="${esc(d.reference||'')}"></div><div class="field"><label>Notes</label><textarea name="notes" maxlength="600">${esc(d.notes||'')}</textarea></div><div class="form-actions">${id?`<button type="button" class="danger-btn" data-action="delete-document" data-id="${id}">Delete</button>`:`<button type="button" class="soft-btn" data-action="close-modal">Cancel</button>`}<button class="primary-btn" type="submit">Save</button></div></form>`);
  }

  function openContactForm(id){
    const c=state.contacts.find(x=>x.id===id)||{name:'',role:'',phone:'',email:'',notes:''};
    openSheet(id?'Edit contact':'Add contact',`<form class="form" id="contact-form" data-id="${id||''}"><div class="field"><label>Name / company</label><input required name="name" maxlength="90" value="${esc(c.name)}" placeholder="Moving company"></div><div class="field"><label>Role</label><input name="role" maxlength="70" value="${esc(c.role||'')}" placeholder="Mover / building admin / cleaner"></div><div class="grid-2"><div class="field"><label>Phone</label><input name="phone" inputmode="tel" maxlength="40" value="${esc(c.phone||'')}"></div><div class="field"><label>Email</label><input type="email" name="email" maxlength="100" value="${esc(c.email||'')}"></div></div><div class="field"><label>Notes</label><textarea name="notes" maxlength="500">${esc(c.notes||'')}</textarea></div><div class="form-actions">${id?`<button type="button" class="danger-btn" data-action="delete-contact" data-id="${id}">Delete</button>`:`<button type="button" class="soft-btn" data-action="close-modal">Cancel</button>`}<button class="primary-btn" type="submit">Save</button></div></form>`);
  }

  function openBoxDetail(id){
    const b=boxById(id); if(!b)return;
    const r=roomById(b.roomId), items=itemsInBox(id);
    openSheet(`${b.code} · ${b.name}`,`<div class="stack"><div class="card"><div class="card-top"><div><span class="pill">${statusLabel(b.status)}</span><h3 style="margin:10px 0 4px">${esc(r?.name||'No room')}</h3><p class="tiny">${esc(b.type||'Box')}${b.fragile?' · Fragile':''}${b.openFirst||b.priority==='first'?' · Open first':''}${b.vehicle?` · ${esc(b.vehicle)}`:''}</p></div><button class="soft-btn small-btn" data-action="box-label" data-id="${b.id}">Label</button></div><div class="box-meter detail-meter"><span><b>${clamp(b.capacity,0,100)}%</b> full</span><div class="progress"><span style="width:${clamp(b.capacity,0,100)}%"></span></div><span>${b.weight?`${Number(b.weight).toFixed(1)} ${state.project.units==='in'||state.project.units==='ft'?'lb':'kg'}`:'No weight'}</span></div>${b.notes?`<p class="wrap-text">${esc(b.notes)}</p>`:''}<div class="tag-row">${b.missing?'<span class="pill warn">MISSING</span>':''}${b.damaged?'<span class="pill warn">DAMAGED</span>':''}<span class="pill gray">${priorityLabel(b.priority)}</span></div></div>
      <div class="grid-3"><button class="soft-btn" data-action="set-box-status" data-id="${id}" data-value="packing">Packing</button><button class="soft-btn" data-action="set-box-status" data-id="${id}" data-value="sealed">Seal</button><button class="soft-btn" data-action="set-box-status" data-id="${id}" data-value="loaded">Load</button></div>
      <div class="section-head"><h3 class="section-title">Contents (${items.length})</h3><button class="primary-btn small-btn" data-action="add-item-to-box" data-id="${b.id}">＋ Item</button></div>${items.length?`<div class="list-card">${items.slice(0,100).map(itemRow).join('')}</div>`:empty('📭','Box is empty','Add items as you pack them.')}
      <div class="grid-2"><button class="soft-btn" data-action="edit-box" data-id="${b.id}">Edit box</button><button class="primary-btn" data-action="share-box" data-id="${b.id}">Share box</button></div></div>`,{focus:false});
  }

  function openLabel(id){
    const b=boxById(id); if(!b)return;
    const r=roomById(b.roomId),code=b.code;
    openSheet('Box label',`<div class="label-preview"><div class="label-code">${esc(code)}</div><div class="qr"><canvas id="qr-canvas" width="172" height="172"></canvas></div><div class="label-room">${esc(b.name)}</div><div class="label-meta">${esc(r?.name||'No room')} · ${itemsInBox(id).length} items${b.fragile?' · FRAGILE':''}${b.openFirst||b.priority==='first'?' · OPEN FIRST':''}</div></div><div class="section grid-2"><button class="soft-btn" data-action="copy-box-code" data-id="${id}">Copy code</button><button class="primary-btn" data-action="print-label">Print label</button></div><div class="print-only"><div class="label-preview"><div class="label-code">${esc(code)}</div><div class="qr"><canvas id="qr-print" width="172" height="172"></canvas></div><div class="label-room">${esc(b.name)}</div><div class="label-meta">${esc(r?.name||'No room')} · ${itemsInBox(id).length} items${b.fragile?' · FRAGILE':''}${b.openFirst||b.priority==='first'?' · OPEN FIRST':''}</div></div></div>`,{focus:false});
    setTimeout(()=>{drawQR(code,document.getElementById('qr-canvas'));drawQR(code,document.getElementById('qr-print'));},30);
  }

  function openScanSheet(){
    const cameraSupported='BarcodeDetector' in window && !!navigator.mediaDevices?.getUserMedia;
    openSheet('Find box by code',`<form class="form" id="scan-code-form"><div class="field"><label>Box code</label><input required name="code" autocomplete="off" autocapitalize="characters" placeholder="KITCH-003"></div><button class="primary-btn wide" type="submit">Open box</button></form><div class="divider"><span>or</span></div>${cameraSupported?`<button class="soft-btn wide" data-action="start-camera-scan">▦ Scan QR with camera</button><div id="scanner-area" class="scanner-area" hidden><video id="scanner-video" playsinline muted></video><div class="scanner-frame"></div><p class="tiny center-text">Point the camera at a Hako box label.</p></div>`:`<div class="about-box compact-about">Camera QR scanning is not supported by this browser. Enter the printed box code instead—this fallback works offline on every supported device.</div>`}`,{focus:true});
  }

  function findBoxByCode(raw){
    const code=String(raw||'').trim().toUpperCase().replace(/^HAKO:\/\/BOX\//,'');
    return state.boxes.find(b=>String(b.code||'').toUpperCase()===code) || state.boxes.find(b=>normalize(b.code)===normalize(code));
  }

  async function startCameraScan(){
    if(!('BarcodeDetector' in window) || !navigator.mediaDevices?.getUserMedia){ toast('Camera QR scanning is not supported here.'); return; }
    const area=document.getElementById('scanner-area'), video=document.getElementById('scanner-video');
    if(!area||!video)return;
    try{
      stopScanner();
      activeStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false});
      video.srcObject=activeStream; area.hidden=false; await video.play();
      const detector=new BarcodeDetector({formats:['qr_code']}); let last=0;
      const loop=async(ts)=>{
        if(!activeStream)return;
        if(ts-last>260){ last=ts; try{ const codes=await detector.detect(video); if(codes?.[0]?.rawValue){ const val=codes[0].rawValue; stopScanner(); const b=findBoxByCode(val); if(b){ closeModal(); setTimeout(()=>openBoxDetail(b.id),30); haptic(); } else toast(`No Hako box found for ${val}`); return; } }catch(_){} }
        scannerLoopId=requestAnimationFrame(loop);
      };
      scannerLoopId=requestAnimationFrame(loop);
    }catch(_){ stopScanner(); toast('Camera access was not available. Enter the box code instead.'); }
  }

  function stopScanner(){
    if(scannerLoopId){ cancelAnimationFrame(scannerLoopId); scannerLoopId=0; }
    if(activeStream){ activeStream.getTracks().forEach(t=>t.stop()); activeStream=null; }
    const video=document.getElementById('scanner-video'); if(video) video.srcObject=null;
  }

  function download(name,content,type='application/octet-stream'){
    const blob=content instanceof Blob?content:new Blob([content],{type});
    const url=URL.createObjectURL(blob),a=document.createElement('a');
    a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1800);
  }
  function csvCell(v){const s=String(v??'');return /[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s;}
  function blobToDataURL(blob){ return new Promise((resolve,reject)=>{const fr=new FileReader();fr.onload=()=>resolve(fr.result);fr.onerror=reject;fr.readAsDataURL(blob);}); }
  async function dataURLToBlob(data){ return await (await fetch(data)).blob(); }

  async function exportBackup(){
    toast('Preparing backup…');
    const media={};
    const refs=[...new Set(state.items.map(i=>i.photoRef).filter(Boolean))];
    for(const ref of refs){ try{ const blob=await mediaGet(ref); if(blob) media[ref]=await blobToDataURL(blob); }catch(_){} }
    const payload={format:'hako-backup',appVersion:APP_VERSION,exportedAt:nowISO(),state:structuredClone(state),media};
    state.meta.lastBackup=nowISO(); saveState(true);
    download(`hako-backup-${todayISO()}.json`,JSON.stringify(payload,null,2),'application/json');
    toast('Full backup exported');
  }

  async function restoreBackup(data){
    let incoming=data?.format==='hako-backup'?data.state:data;
    if(!incoming?.project||!Array.isArray(incoming.rooms)||!Array.isArray(incoming.boxes)||!Array.isArray(incoming.items)) throw new Error('Invalid backup');
    incoming=migrateState(incoming); incoming.hasOnboarded=true; incoming.ui={...DEFAULT.ui,...incoming.ui,tool:'backup'};
    const media=data?.media||{};
    for(const [id,url] of Object.entries(media)){ try{ await mediaPut(await dataURLToBlob(url),id); }catch(_){} }
    state=incoming; saveState(true); render(); toast('Backup restored');
  }

  async function clearAllMedia(){
    try{
      const db=await openMediaDB();
      await new Promise((resolve,reject)=>{const tx=db.transaction(DB_STORE,'readwrite');tx.objectStore(DB_STORE).clear();tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});
      for(const url of mediaURLCache.values()) URL.revokeObjectURL(url); mediaURLCache.clear();
    }catch(_){}
  }

  function exportCSV(){
    rebuildDerived();
    const head=['Item','Quantity','Category','Decision','Current Room','Destination Room','Box Code','Box','Status','Fragile','Essential','Do Not Pack','Condition','Brand','Model','Serial','Value','Sale Status','Sold Price','Donation Destination','Tags','Notes','Parts For','Reassembly Notes'];
    const rows=state.items.map(i=>{const b=boxById(i.boxId),r=roomById(i.roomId),dr=roomById(i.destinationRoomId);return [i.name,i.quantity,i.category,i.decision,r?.name||'',dr?.name||'',b?.code||'',b?.name||'',i.status,i.fragile?'Yes':'No',i.essential?'Yes':'No',i.doNotPack?'Yes':'No',i.condition,i.brand,i.model,i.serial,i.value,i.saleStatus,i.soldPrice,i.donationOrg,i.tags,i.notes,i.partsFor,i.reassemblyNotes];});
    download(`hako-inventory-${todayISO()}.csv`,[head,...rows].map(r=>r.map(csvCell).join(',')).join('\n'),'text/csv');
  }

  function moveSummaryText(){
    const d=daysLeft();
    return `Hako — ${state.project.name}\nMove date: ${state.project.moveDate?fmtDate(state.project.moveDate):'Not set'}${d!==null?` (${d>=0?d+' days left':Math.abs(d)+' days ago'})`:''}\nMove readiness: ${readiness()}%\nPacked: ${packPercent()}%\nDecluttered: ${declutterPercent()}%\nUnpacked: ${unpackPercent()}%\nRooms: ${state.rooms.length}\nBoxes: ${state.boxes.length}\nItems: ${state.items.length}\nOpen tasks: ${state.tasks.filter(t=>!t.done).length}\nOverdue tasks: ${overdueTasks().length}\nMoving spend: ${money(expenseTotal())}\nSelling proceeds: ${money(soldProceeds())}`;
  }

  function generateChecklist(){
    const templates=[
      ['confirm-plan','Confirm move date, budget and moving plan',-30,'Plan & Notify','high'],
      ['book-movers','Book movers / vehicle / transport',-28,'Plan & Notify','high'],
      ['declutter','Declutter room by room',-21,'Declutter','normal'],
      ['supplies','Buy packing supplies and labels',-18,'Packing','normal'],
      ['nonessential','Start packing non-essential items',-14,'Packing','normal'],
      ['address','Start address changes',-10,'Admin','normal'],
      ['utilities','Confirm utility disconnection / activation',-7,'Admin','high'],
      ['documents','Check permits, elevator/loading bay and moving documents',-7,'Admin','high'],
      ['essentials','Prepare first-night essentials and do-not-pack bag',-3,'Packing','high'],
      ['confirm-movers','Reconfirm movers, access, parking and contacts',-2,'Plan & Notify','high'],
      ['final-food','Finish fridge / food / cleaning plan',-1,'Packing','normal'],
      ['final-photos','Take final home, meter and condition photos',0,'Move Day','normal'],
      ['load-scan','Load and check every labeled box',0,'Move Day','high'],
      ['unload-scan','Unload and check for missing / damaged boxes',0,'Move Day','high'],
      ['keys','Return / collect keys and access cards',0,'Move Day','high'],
      ['unpack-first','Unpack first-night essentials',0,'After Move','high'],
      ['boxes-after','Reuse, donate or recycle empty boxes',3,'After Move','low'],
      ['address-finish','Finish remaining address changes',5,'After Move','normal'],
      ['room-setup','Finish high-priority room setup',7,'After Move','normal']
    ];
    const existing=new Set(state.tasks.map(t=>t.templateKey).filter(Boolean)); let added=0;
    for(const [key,title,offset,category,priority] of templates){
      if(existing.has(key)) continue;
      state.tasks.push({id:uid('task'),title,due:state.project.moveDate?addDays(state.project.moveDate,offset):'',category,priority,notes:'',done:false,templateKey:key}); added++;
    }
    commit(`Added ${added} moving checklist task${added===1?'':'s'}`);
    toast(added?`Added ${added} checklist tasks`:'Starter checklist is already added');
  }

  function generateUtilities(){
    const common=['Electricity','Water','Internet','Gas','Trash / Building services'];
    const existing=new Set(state.utilities.map(u=>normalize(u.service))); let added=0;
    common.forEach(service=>{if(!existing.has(normalize(service))){state.utilities.push({id:uid('util'),service,provider:'',oldStatus:'pending',newStatus:'pending',disconnectDate:'',connectDate:'',confirmation:'',notes:''});added++;}});
    commit(`Added ${added} utility tracker${added===1?'':'s'}`); toast(added?`Added ${added} common utilities`:'Common utilities are already listed');
  }

  function generateAddressList(){
    const common=[
      ['Employer','Employer'],['Primary bank','Bank / Finance'],['Credit cards / loans','Bank / Finance'],['Insurance','Insurance'],['Government records / IDs','Government'],['Electricity / water','Utilities'],['Internet / mobile','Utilities'],['Online shopping addresses','Shopping / Delivery'],['Subscriptions / deliveries','Subscriptions'],['School / childcare','School'],['Doctor / dentist / pharmacy','Healthcare'],['Friends & family','Friends / Family']
    ];
    const existing=new Set(state.addressChanges.map(a=>normalize(a.label))); let added=0;
    common.forEach(([label,category])=>{if(!existing.has(normalize(label))){state.addressChanges.push({id:uid('addr'),label,category,status:'not-started',notes:''});added++;}});
    commit(`Added ${added} address-change item${added===1?'':'s'}`); toast(added?`Added ${added} address reminders`:'Starter address list is already added');
  }

  function formatTimerRemaining(){
    if(!packingTimer.endAt)return 'Ready';
    const ms=Math.max(0,packingTimer.endAt-Date.now()),secs=Math.ceil(ms/1000),m=Math.floor(secs/60),s=secs%60;
    return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }
  function updatePackingTimerDisplay(){
    const el=document.getElementById('packing-timer-display'); if(el)el.textContent=formatTimerRemaining();
    if(packingTimer.endAt&&Date.now()>=packingTimer.endAt) finishPackingTimer(true);
  }
  function startPackingTimer(minutes){
    finishPackingTimer(false,false);
    packingTimer={endAt:Date.now()+minutes*60000,startedAt:Date.now(),duration:minutes,interval:setInterval(updatePackingTimerDisplay,1000)};
    updatePackingTimerDisplay(); toast(`${minutes}-minute packing focus started`); haptic();
  }
  function finishPackingTimer(completed=false,log=true){
    if(!packingTimer.startedAt){ clearInterval(packingTimer.interval); packingTimer={endAt:0,startedAt:0,duration:0,interval:null}; return; }
    const elapsed=Math.max(1,Math.round((Date.now()-packingTimer.startedAt)/60000));
    clearInterval(packingTimer.interval);
    if(log){state.packingSessions.push({id:uid('session'),minutes:Math.min(packingTimer.duration||elapsed,elapsed),startedAt:new Date(packingTimer.startedAt).toISOString(),endedAt:nowISO(),completed});saveState(true);}
    packingTimer={endAt:0,startedAt:0,duration:0,interval:null};
    if(completed){toast('Packing focus complete 🎀');haptic();}
    if(state.ui.tool==='pack-mode') render();
  }

  // Dependency-free QR generator for short Hako box codes (QR Version 1-L).
  function qrMatrix(text){
    const bytes=[...new TextEncoder().encode(text)].slice(0,17);
    const bits=[]; const push=(val,n)=>{for(let i=n-1;i>=0;i--)bits.push((val>>>i)&1);};
    push(0b0100,4); push(bytes.length,8); bytes.forEach(b=>push(b,8));
    const cap=19*8; for(let i=0;i<Math.min(4,cap-bits.length);i++)bits.push(0); while(bits.length%8)bits.push(0);
    const data=[]; for(let i=0;i<bits.length;i+=8){let b=0;for(let j=0;j<8;j++)b=(b<<1)|(bits[i+j]||0);data.push(b);} let pad=0; while(data.length<19)data.push(pad++%2?0x11:0xec);
    const gfExp=new Array(512),gfLog=new Array(256); let x=1; for(let i=0;i<255;i++){gfExp[i]=x;gfLog[x]=i;x<<=1;if(x&0x100)x^=0x11d;} for(let i=255;i<512;i++)gfExp[i]=gfExp[i-255];
    const mul=(a,b)=>a&&b?gfExp[gfLog[a]+gfLog[b]]:0;
    let gen=[1]; for(let i=0;i<7;i++){const next=new Array(gen.length+1).fill(0);for(let j=0;j<gen.length;j++){next[j]^=gen[j];next[j+1]^=mul(gen[j],gfExp[i]);}gen=next;}
    const ecc=new Array(7).fill(0); data.forEach(v=>{const factor=v^ecc[0];ecc.shift();ecc.push(0);for(let j=0;j<7;j++)ecc[j]^=mul(gen[j+1],factor);});
    const code=data.concat(ecc),stream=[]; const pushTo=(arr,val,n)=>{for(let i=n-1;i>=0;i--)arr.push((val>>>i)&1);}; code.forEach(b=>pushTo(stream,b,8));
    const size=21,m=Array.from({length:size},()=>Array(size).fill(false)),fn=Array.from({length:size},()=>Array(size).fill(false));
    function setf(xx,yy,v){if(xx>=0&&yy>=0&&xx<size&&yy<size){m[yy][xx]=!!v;fn[yy][xx]=true;}}
    for(let i=0;i<size;i++){setf(6,i,i%2===0);setf(i,6,i%2===0);}
    [[3,3],[size-4,3],[3,size-4]].forEach(([cx,cy])=>{for(let dy=-4;dy<=4;dy++)for(let dx=-4;dx<=4;dx++){const dist=Math.max(Math.abs(dx),Math.abs(dy));setf(cx+dx,cy+dy,dist!==2&&dist!==4);}});
    function formatBits(mask){let data5=(1<<3)|mask,rem=data5;for(let i=0;i<10;i++)rem=(rem<<1)^(((rem>>>9)&1)?0x537:0);let bits15=((data5<<10)|rem)^0x5412;const gb=i=>(bits15>>>i)&1;for(let i=0;i<=5;i++)setf(8,i,gb(i));setf(8,7,gb(6));setf(8,8,gb(7));setf(7,8,gb(8));for(let i=9;i<15;i++)setf(14-i,8,gb(i));for(let i=0;i<8;i++)setf(size-1-i,8,gb(i));for(let i=8;i<15;i++)setf(8,size-15+i,gb(i));setf(8,size-8,true);}
    formatBits(0); let k=0,up=true; for(let right=size-1;right>=1;right-=2){if(right===6)right=5;for(let vert=0;vert<size;vert++){const y=up?size-1-vert:vert;for(let j=0;j<2;j++){const xx=right-j;if(!fn[y][xx]){let bit=k<stream.length?stream[k]:0;k++;if((xx+y)%2===0)bit^=1;m[y][xx]=!!bit;}}}up=!up;} formatBits(0); return m;
  }
  function drawQR(text,canvas){
    if(!canvas)return;const mat=qrMatrix(text),ctx=canvas.getContext('2d'),quiet=4,total=mat.length+quiet*2,scale=canvas.width/total;ctx.imageSmoothingEnabled=false;ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.fillStyle='#221820';for(let y=0;y<mat.length;y++)for(let x=0;x<mat.length;x++)if(mat[y][x])ctx.fillRect(Math.floor((x+quiet)*scale),Math.floor((y+quiet)*scale),Math.ceil(scale),Math.ceil(scale));
  }

  function updateFindResults(){
    const host=document.getElementById('find-results'); if(host)host.innerHTML=findResultsHTML(state.ui.findQuery);
  }
  function recordSearch(q){
    q=String(q||'').trim(); if(!q)return;
    state.recentSearches=[q,...state.recentSearches.filter(x=>normalize(x)!==normalize(q))].slice(0,8); saveState(false);
  }

  document.addEventListener('input',e=>{
    if(e.target.id==='find-input'){
      state.ui.findQuery=e.target.value;
      saveState(false);
      updateFindResults();
    }
  });

  document.addEventListener('change',e=>{
    const setting=e.target.dataset.setting;
    if(setting){ state.settings[setting]=!!e.target.checked; commit(`Updated ${setting} setting`); return; }
    if(e.target.id==='import-file'){
      const file=e.target.files?.[0]; if(!file)return;
      const fr=new FileReader();
      fr.onload=async()=>{try{await restoreBackup(JSON.parse(fr.result));}catch(_){toast('That file is not a valid Hako backup.');}};
      fr.readAsText(file);
    }
  });

  document.addEventListener('submit',async e=>{
    e.preventDefault();
    const f=e.target,fd=new FormData(f);

    if(f.id==='project-form'){
      state.profile.name=String(fd.get('name')||'').trim();
      Object.assign(state.project,{projectName:undefined,name:String(fd.get('projectName')||'My Move').trim()||'My Move',moveType:fd.get('moveType')||'Home move',moveDate:fd.get('moveDate')||'',householdSize:Math.max(1,Number(fd.get('householdSize'))||1),homeType:fd.get('homeType')||'',from:String(fd.get('from')||'').trim(),to:String(fd.get('to')||'').trim(),currency:fd.get('currency')||'PHP',units:fd.get('units')||'cm',budget:Number(fd.get('budget')||0)});
      delete state.project.projectName;
      closeModal(); commit('Updated move setup'); return;
    }

    if(f.id==='room-form'){
      const id=f.dataset.id;
      const obj={id:id||uid('room'),name:String(fd.get('name')).trim(),emoji:String(fd.get('emoji')||'🏠').trim()||'🏠',destination:String(fd.get('destination')||'').trim(),priority:fd.get('priority')||'normal',setupStatus:fd.get('setupStatus')||'not-started',notes:String(fd.get('notes')||'').trim()};
      if(id) Object.assign(state.rooms.find(x=>x.id===id),obj); else state.rooms.push(obj);
      closeModal(); commit(`${id?'Updated':'Added'} room “${obj.name}”`); return;
    }

    if(f.id==='box-form'){
      const id=f.dataset.id,roomId=fd.get('roomId')||'';
      const obj={id:id||uid('box'),code:id?(state.boxes.find(x=>x.id===id)?.code||nextBoxCode(roomId)):nextBoxCode(roomId),name:String(fd.get('name')).trim(),roomId,type:fd.get('type')||'Box',status:fd.get('status')||'empty',capacity:clamp(fd.get('capacity'),0,100),weight:Math.max(0,Number(fd.get('weight'))||0),priority:fd.get('priority')||'normal',vehicle:String(fd.get('vehicle')||'').trim(),loadOrder:Math.max(0,Number(fd.get('loadOrder'))||0),notes:String(fd.get('notes')||'').trim(),fragile:fd.get('fragile')==='on',openFirst:fd.get('openFirst')==='on',missing:fd.get('missing')==='on',damaged:fd.get('damaged')==='on'};
      if(obj.openFirst&&obj.priority==='normal')obj.priority='first';
      if(id) Object.assign(state.boxes.find(x=>x.id===id),obj); else state.boxes.push(obj);
      if(['loaded','unloaded','unpacked'].includes(obj.status)) state.items.filter(i=>i.boxId===obj.id).forEach(i=>i.status=obj.status==='unpacked'?'unpacked':obj.status);
      closeModal(); commit(`${id?'Updated':'Added'} box ${obj.code}`); return;
    }

    if(f.id==='item-form'){
      const id=f.dataset.id,old=id?state.items.find(x=>x.id===id):null;
      let photoRef=old?.photoRef||'';
      const file=document.getElementById('item-photo')?.files?.[0];
      if(file){
        try{
          toast('Optimizing photo…');
          const blob=await compressPhoto(file),newRef=await mediaPut(blob);
          if(photoRef)mediaDelete(photoRef); photoRef=newRef;
        }catch(_){toast('Could not process that photo. The item will still save.');}
      }
      let boxId=fd.get('boxId')||'',roomId=fd.get('roomId')||'';
      const doNotPack=fd.get('doNotPack')==='on';
      if(doNotPack) boxId='';
      if(boxId&&!roomId){ const b=state.boxes.find(x=>x.id===boxId); if(b)roomId=b.roomId||''; }
      const obj={id:id||uid('item'),name:String(fd.get('name')).trim(),quantity:Math.max(1,Number(fd.get('quantity'))||1),category:String(fd.get('category')||'').trim(),roomId,destinationRoomId:fd.get('destinationRoomId')||'',boxId,status:boxId?'packed':'loose',decision:fd.get('decision')||'',tags:String(fd.get('tags')||'').trim(),value:Number(fd.get('value')||0)||'',notes:String(fd.get('notes')||'').trim(),fragile:fd.get('fragile')==='on',essential:fd.get('essential')==='on',doNotPack,sentimental:fd.get('sentimental')==='on',photoRef,condition:fd.get('condition')||'',brand:String(fd.get('brand')||'').trim(),model:String(fd.get('model')||'').trim(),serial:String(fd.get('serial')||'').trim(),width:Number(fd.get('width')||0)||'',height:Number(fd.get('height')||0)||'',depth:Number(fd.get('depth')||0)||'',partsFor:String(fd.get('partsFor')||'').trim(),reassemblyNotes:String(fd.get('reassemblyNotes')||'').trim(),saleStatus:fd.get('saleStatus')||'',soldPrice:Number(fd.get('soldPrice')||0)||0,donationOrg:String(fd.get('donationOrg')||'').trim()};
      if(old)Object.assign(old,obj);else state.items.push(obj);
      if(boxId){ const b=state.boxes.find(x=>x.id===boxId); if(b&&b.status==='empty')b.status='packing'; }
      const continuous=f.dataset.continuous==='1'&&!id;
      closeModal(); commit(`${id?'Updated':'Added'} item “${obj.name}”`);
      if(continuous)setTimeout(()=>openItemForm('',{continuous:true,boxId}),35);
      return;
    }

    if(f.id==='task-form'){
      const id=f.dataset.id,obj={id:id||uid('task'),title:String(fd.get('title')).trim(),due:fd.get('due')||'',category:fd.get('category')||'Other',priority:fd.get('priority')||'normal',notes:String(fd.get('notes')||'').trim(),done:fd.get('done')==='on',templateKey:id?(state.tasks.find(x=>x.id===id)?.templateKey||''):''};
      if(id)Object.assign(state.tasks.find(x=>x.id===id),obj);else state.tasks.push(obj);
      closeModal();commit(`${id?'Updated':'Added'} task “${obj.title}”`);return;
    }

    if(f.id==='expense-form'){
      const obj={id:uid('exp'),title:String(fd.get('title')).trim(),amount:Number(fd.get('amount')||0),category:fd.get('category')||'Other',notes:String(fd.get('notes')||'').trim(),at:nowISO()};
      state.expenses.push(obj);closeModal();commit(`Added expense “${obj.title}”`);return;
    }

    if(f.id==='supply-form'){
      const obj={id:uid('sup'),name:String(fd.get('name')).trim(),qty:Number(fd.get('qty')||1),unit:String(fd.get('unit')||'').trim(),cost:Number(fd.get('cost')||0),bought:false};
      state.supplies.push(obj);closeModal();commit(`Added supply “${obj.name}”`);return;
    }

    if(f.id==='utility-form'){
      const id=f.dataset.id,obj={id:id||uid('util'),service:String(fd.get('service')).trim(),provider:String(fd.get('provider')||'').trim(),oldStatus:fd.get('oldStatus')||'pending',newStatus:fd.get('newStatus')||'pending',disconnectDate:fd.get('disconnectDate')||'',connectDate:fd.get('connectDate')||'',confirmation:String(fd.get('confirmation')||'').trim(),notes:String(fd.get('notes')||'').trim()};
      if(id)Object.assign(state.utilities.find(x=>x.id===id),obj);else state.utilities.push(obj);closeModal();commit(`${id?'Updated':'Added'} utility “${obj.service}”`);return;
    }

    if(f.id==='address-form'){
      const id=f.dataset.id,obj={id:id||uid('addr'),label:String(fd.get('label')).trim(),category:fd.get('category')||'Other',status:fd.get('status')||'not-started',notes:String(fd.get('notes')||'').trim()};
      if(id)Object.assign(state.addressChanges.find(x=>x.id===id),obj);else state.addressChanges.push(obj);closeModal();commit(`${id?'Updated':'Added'} address reminder “${obj.label}”`);return;
    }

    if(f.id==='document-form'){
      const id=f.dataset.id,obj={id:id||uid('doc'),title:String(fd.get('title')).trim(),category:fd.get('category')||'Other',reference:String(fd.get('reference')||'').trim(),due:fd.get('due')||'',notes:String(fd.get('notes')||'').trim()};
      if(id)Object.assign(state.documents.find(x=>x.id===id),obj);else state.documents.push(obj);closeModal();commit(`${id?'Updated':'Added'} document “${obj.title}”`);return;
    }

    if(f.id==='contact-form'){
      const id=f.dataset.id,obj={id:id||uid('contact'),name:String(fd.get('name')).trim(),role:String(fd.get('role')||'').trim(),phone:String(fd.get('phone')||'').trim(),email:String(fd.get('email')||'').trim(),notes:String(fd.get('notes')||'').trim()};
      if(id)Object.assign(state.contacts.find(x=>x.id===id),obj);else state.contacts.push(obj);closeModal();commit(`${id?'Updated':'Added'} contact “${obj.name}”`);return;
    }

    if(f.id==='scan-code-form'){
      const b=findBoxByCode(fd.get('code'));
      if(!b){toast('No Hako box found with that code.');return;}
      closeModal();recordSearch(b.code);setTimeout(()=>openBoxDetail(b.id),25);return;
    }

    if(f.id==='fit-form'){
      const iw=Number(fd.get('iw')),ih=Number(fd.get('ih')),idp=Number(fd.get('id')),ow=Number(fd.get('ow')),oh=Number(fd.get('oh'));
      const dims=[iw,ih,idp].filter(n=>n>0),pairs=[[dims[0],dims[1]],[dims[0],dims[2]],[dims[1],dims[2]]];
      const fits=pairs.some(([a,b])=>(a<=ow&&b<=oh)||(b<=ow&&a<=oh));
      const host=document.getElementById('fit-result');
      if(host)host.innerHTML=`<div class="card fit-result ${fits?'fit-good':'fit-warn'}"><h3>${fits?'Likely fits ✓':'May not fit'}</h3><p>${fits?'At least one face orientation fits within the opening dimensions. Still check depth, handles, stair turns and required rotation.':'None of the item face-dimension pairs fit inside the opening as entered. Measure again and consider removable legs/doors or another route.'}</p></div>`;
      return;
    }
  });

  document.addEventListener('click',async e=>{
    const tab=e.target.closest('[data-tab]');
    if(tab){state.ui.tab=tab.dataset.tab;state.ui.tool=null;state.ui.roomFilter=null;saveState(true);render();haptic();return;}

    const tool=e.target.closest('[data-tool]');
    if(tool){state.ui.tool=tool.dataset.tool;saveState(true);render();haptic();return;}

    const boxFilter=e.target.closest('[data-box-filter]');
    if(boxFilter){
      state.ui.boxFilter=boxFilter.dataset.boxFilter;
      if(state.ui.tool==='move-day'){state.ui.tool=null;state.ui.tab='boxes';}
      saveState(true);render();return;
    }
    const taskFilter=e.target.closest('[data-task-filter]');
    if(taskFilter){state.ui.taskFilter=taskFilter.dataset.taskFilter;saveState(false);render();return;}
    const declutterFilter=e.target.closest('[data-declutter-filter]');
    if(declutterFilter){state.ui.declutterFilter=declutterFilter.dataset.declutterFilter;saveState(false);render();return;}
    const packRoom=e.target.closest('[data-pack-room]');
    if(packRoom){state.ui.packRoomFilter=packRoom.dataset.packRoom;saveState(false);render();return;}
    const recent=e.target.closest('[data-recent-search]');
    if(recent){state.ui.findQuery=recent.dataset.recentSearch;const input=document.getElementById('find-input');if(input)input.value=state.ui.findQuery;saveState(false);updateFindResults();return;}
    const result=e.target.closest('[data-result-type]');
    if(result){
      recordSearch(state.ui.findQuery);
      if(result.dataset.resultType==='box')openBoxDetail(result.dataset.id);
      else if(result.dataset.resultType==='item')openItemForm(result.dataset.id);
      else if(result.dataset.resultType==='room')openRoomDetail(result.dataset.id);
      return;
    }

    const act=e.target.closest('[data-action]'); if(!act)return;
    const a=act.dataset.action,id=act.dataset.id,val=act.dataset.value;

    if(a==='close-modal'){
      if(!e.target.closest('[data-sheet]')||act.closest('.sheet-head,.form-actions'))closeModal();
      return;
    }
    if(a==='start-setup'){state.hasOnboarded=true;saveState(true);render();setTimeout(()=>openSetup(true),25);return;}
    if(a==='skip-setup'){state.hasOnboarded=true;commit('Started Hako');return;}
    if(a==='back-tool'){state.ui.tool=null;saveState(true);render();return;}
    if(a==='open-project'){openSetup(false);return;}
    if(a==='quick-add'){
      openSheet('Quick add',`<div class="tool-grid"><button class="tool-card" data-action="quick-pack-add"><span class="tool-icon">⚡</span><h3>Quick Pack</h3><p>Add multiple items continuously</p></button><button class="tool-card" data-action="add-box"><span class="tool-icon">📦</span><h3>Box</h3><p>Create a container</p></button><button class="tool-card" data-action="add-room"><span class="tool-icon">🏠</span><h3>Room</h3><p>Add a space</p></button><button class="tool-card" data-action="add-task"><span class="tool-icon">✓</span><h3>Task</h3><p>Add a checklist item</p></button><button class="tool-card" data-action="open-scan"><span class="tool-icon">▦</span><h3>Scan</h3><p>Find a labeled box</p></button><button class="tool-card" data-action="add-expense"><span class="tool-icon">₱</span><h3>Expense</h3><p>Track a moving cost</p></button></div>`,{focus:false});return;
    }
    if(a==='open-tasks'){state.ui.tool='tasks';saveState(true);render();return;}

    if(a==='add-room'){openRoomForm();return;}
    if(a==='edit-room'){openRoomForm(id);return;}
    if(a==='room-detail'){openRoomDetail(id);return;}
    if(a==='delete-room'){
      if(confirm('Delete this room? Boxes and items stay but become unassigned.')){
        state.boxes.forEach(b=>{if(b.roomId===id)b.roomId='';});
        state.items.forEach(i=>{if(i.roomId===id)i.roomId='';if(i.destinationRoomId===id)i.destinationRoomId='';});
        state.rooms=state.rooms.filter(r=>r.id!==id);closeModal();commit('Deleted room');
      }return;
    }
    if(a==='filter-room'){state.ui.roomFilter=id;state.ui.tab='boxes';state.ui.tool=null;saveState(true);closeModal();render();return;}
    if(a==='clear-room-filter'){state.ui.roomFilter=null;saveState(true);render();return;}
    if(a==='cycle-room-setup'){
      const r=state.rooms.find(x=>x.id===id); if(r){r.setupStatus=r.setupStatus==='done'?'not-started':r.setupStatus==='in-progress'?'done':'in-progress';commit(`Updated ${r.name} setup`);}return;
    }

    if(a==='add-box'){openBoxForm();return;}
    if(a==='edit-box'){openBoxForm(id);return;}
    if(a==='delete-box'){
      if(confirm('Delete this box? Items inside will become loose items.')){
        state.items.forEach(i=>{if(i.boxId===id){i.boxId='';i.status='loose';}});state.boxes=state.boxes.filter(b=>b.id!==id);closeModal();commit('Deleted box');
      }return;
    }
    if(a==='box-detail'){openBoxDetail(id);return;}
    if(a==='box-label'){openLabel(id);return;}
    if(a==='set-box-status'){
      const b=state.boxes.find(x=>x.id===id); if(!b)return;
      b.status=val;
      const field={sealed:'sealedAt',loaded:'loadedAt',unloaded:'unloadedAt',unpacked:'unpackedAt'}[val];if(field)b[field]=nowISO();
      if(val==='loaded')b.missing=false;
      state.items.filter(i=>i.boxId===id).forEach(i=>i.status=val==='unpacked'?'unpacked':val==='unloaded'?'unloaded':val==='loaded'?'loaded':'packed');
      commit(`${b.code} marked ${statusLabel(val).toLowerCase()}`);return;
    }
    if(a==='toggle-missing'){const b=state.boxes.find(x=>x.id===id);if(b){b.missing=!b.missing;commit(`${b.code} ${b.missing?'marked missing':'found'}`);}return;}
    if(a==='toggle-damaged'){const b=state.boxes.find(x=>x.id===id);if(b){b.damaged=!b.damaged;commit(`${b.code} damage flag ${b.damaged?'added':'cleared'}`);}return;}

    if(a==='add-item'){openItemForm('');return;}
    if(a==='quick-pack-add'){openItemForm('',{continuous:true});return;}
    if(a==='add-item-to-box'){openItemForm('',{boxId:id,continuous:true});return;}
    if(a==='edit-item'){openItemForm(id);return;}
    if(a==='delete-item'){
      if(confirm('Delete this item?')){const item=state.items.find(i=>i.id===id);if(item?.photoRef)mediaDelete(item.photoRef);state.items=state.items.filter(i=>i.id!==id);closeModal();commit('Deleted item');}return;
    }
    if(a==='decide'){const i=state.items.find(x=>x.id===id);if(i){i.decision=val;commit(`Marked “${i.name}” as ${val}`);}return;}

    if(a==='add-task'){openTaskForm();return;}
    if(a==='edit-task'){openTaskForm(id);return;}
    if(a==='toggle-task'){const t=state.tasks.find(x=>x.id===id);if(t){t.done=!t.done;commit(`${t.done?'Completed':'Reopened'} task “${t.title}”`);}return;}
    if(a==='delete-task'){if(confirm('Delete this task?')){state.tasks=state.tasks.filter(t=>t.id!==id);closeModal();commit('Deleted task');}return;}
    if(a==='generate-checklist'){generateChecklist();return;}

    if(a==='add-expense'){openExpenseForm();return;}
    if(a==='delete-expense'){state.expenses=state.expenses.filter(x=>x.id!==id);commit('Deleted expense');return;}
    if(a==='add-supply'){openSupplyForm();return;}
    if(a==='toggle-supply'){const s=state.supplies.find(x=>x.id===id);if(s){s.bought=!s.bought;commit(`${s.bought?'Bought':'Reopened'} supply “${s.name}”`);}return;}
    if(a==='delete-supply'){state.supplies=state.supplies.filter(x=>x.id!==id);commit('Deleted supply');return;}

    if(a==='add-utility'){openUtilityForm();return;}
    if(a==='edit-utility'){openUtilityForm(id);return;}
    if(a==='delete-utility'){state.utilities=state.utilities.filter(x=>x.id!==id);closeModal();commit('Deleted utility');return;}
    if(a==='generate-utilities'){generateUtilities();return;}

    if(a==='add-address-change'){openAddressForm();return;}
    if(a==='edit-address-change'){openAddressForm(id);return;}
    if(a==='delete-address-change'){state.addressChanges=state.addressChanges.filter(x=>x.id!==id);closeModal();commit('Deleted address reminder');return;}
    if(a==='cycle-address-status'){const x=state.addressChanges.find(y=>y.id===id);if(x){x.status=x.status==='not-started'?'requested':x.status==='requested'?'confirmed':'not-started';commit(`Updated ${x.label}`);}return;}
    if(a==='generate-address-list'){generateAddressList();return;}

    if(a==='add-document'){openDocumentForm();return;}
    if(a==='edit-document'){openDocumentForm(id);return;}
    if(a==='delete-document'){state.documents=state.documents.filter(x=>x.id!==id);closeModal();commit('Deleted document record');return;}
    if(a==='add-contact'){openContactForm();return;}
    if(a==='edit-contact'){openContactForm(id);return;}
    if(a==='delete-contact'){state.contacts=state.contacts.filter(x=>x.id!==id);closeModal();commit('Deleted contact');return;}

    if(a==='go-find'){state.ui.tab='find';state.ui.tool=null;saveState(true);render();return;}
    if(a==='go-boxes'){state.ui.tab='boxes';state.ui.tool=null;saveState(true);render();return;}
    if(a==='clear-searches'){state.recentSearches=[];saveState(true);render();return;}
    if(a==='open-scan'){openScanSheet();return;}
    if(a==='start-camera-scan'){startCameraScan();return;}
    if(a==='voice-search'){startVoiceSearch();return;}

    if(a==='copy-box-code'){const b=state.boxes.find(x=>x.id===id);if(b){try{await navigator.clipboard.writeText(b.code);toast('Box code copied');}catch(_){toast(b.code);}}return;}
    if(a==='print-label'){window.print();return;}
    if(a==='share-box'){
      rebuildDerived(); const b=boxById(id);if(!b)return;
      const lines=itemsInBox(id).map(i=>`• ${i.name}${i.quantity>1?` ×${i.quantity}`:''}`).join('\n');
      const text=`${b.code} — ${b.name}\nRoom: ${roomById(b.roomId)?.name||'Unassigned'}\nStatus: ${statusLabel(b.status)}\n${lines}`;
      try{if(navigator.share)await navigator.share({title:`Hako ${b.code}`,text});else{await navigator.clipboard.writeText(text);toast('Box summary copied');}}catch(_){}return;
    }

    if(a==='export-json'){await exportBackup();return;}
    if(a==='export-csv'){exportCSV();return;}
    if(a==='import-json'){document.getElementById('import-file')?.click();return;}
    if(a==='copy-summary'){try{await navigator.clipboard.writeText(moveSummaryText());toast('Move summary copied');}catch(_){toast('Could not access clipboard.');}return;}

    if(a==='start-pack-timer'){startPackingTimer(Number(val)||15);return;}
    if(a==='stop-pack-timer'){finishPackingTimer(false,true);toast('Packing focus stopped');return;}

    if(a==='install'&&deferredInstallPrompt){deferredInstallPrompt.prompt();await deferredInstallPrompt.userChoice;deferredInstallPrompt=null;render();return;}
    if(a==='reset-app'){
      if(confirm('Erase every Hako room, box, item, photo, task, expense and setting from this device? This cannot be undone.')){
        for(const k of [STORAGE_KEY,...LEGACY_KEYS]){try{localStorage.removeItem(k);}catch(_){}}
        await clearAllMedia(); state=cloneDefault(); closeModal(); render();
      }return;
    }
  });

  function startVoiceSearch(){
    const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
    if(!SR){toast('Voice search is not supported on this browser.');return;}
    const rec=new SR();rec.lang=navigator.language||'en-US';rec.interimResults=false;rec.maxAlternatives=1;
    rec.onresult=e=>{state.ui.findQuery=e.results[0][0].transcript;const input=document.getElementById('find-input');if(input)input.value=state.ui.findQuery;saveState(false);updateFindResults();};
    rec.onerror=()=>toast('Could not hear that. Try typing instead.');rec.start();
  }

  saveState(true);
  render();
  migrateLegacyPhotos().then(()=>{rebuildDerived();hydrateMedia($app);});
  if(launchAction==='add-box'&&state.hasOnboarded)setTimeout(()=>openBoxForm(),40);
})();
