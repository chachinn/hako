(() => {
  'use strict';

  const APP_VERSION = '1.0.0';
  const STORAGE_KEY = 'hako.app.v1';
  const $app = document.getElementById('app');
  const $modal = document.getElementById('modal-root');
  const $toast = document.getElementById('toast');

  const uid = (p='id') => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,7)}`;
  const nowISO = () => new Date().toISOString();
  const esc = (v='') => String(v).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const fmtDate = (v) => v ? new Date(`${v}T12:00:00`).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}) : 'Not set';
  const clamp = (n,min,max) => Math.max(min,Math.min(max,n));
  const money = n => new Intl.NumberFormat(undefined,{style:'currency',currency:state.project.currency||'PHP',maximumFractionDigits:0}).format(Number(n)||0);

  const DEFAULT = {
    version: 1,
    hasOnboarded: false,
    profile: { name: '' },
    project: { id: uid('move'), name:'My Move', moveDate:'', from:'', to:'', currency:'PHP', units:'cm', createdAt:nowISO() },
    rooms: [],
    boxes: [],
    items: [],
    tasks: [],
    expenses: [],
    supplies: [],
    activity: [],
    recentSearches: [],
    settings: { accent:'pink' },
    ui: { tab:'home', tool:null, roomFilter:null, boxFilter:'all', taskFilter:'all', findQuery:'' }
  };

  let state = load();
  let deferredInstallPrompt = null;

  function load(){
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if(!raw) return structuredClone(DEFAULT);
      const data = JSON.parse(raw);
      return {
        ...structuredClone(DEFAULT), ...data,
        profile:{...DEFAULT.profile,...data.profile},
        project:{...DEFAULT.project,...data.project},
        settings:{...DEFAULT.settings,...data.settings},
        ui:{...DEFAULT.ui,...data.ui}
      };
    } catch(e){ return structuredClone(DEFAULT); }
  }
  function save(){
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch(e){ toast('Storage is full. Export a backup and remove large photos.'); }
  }
  function commit(message){
    if(message){ state.activity.unshift({id:uid('act'),text:message,at:nowISO()}); state.activity=state.activity.slice(0,40); }
    save(); render();
  }
  function toast(msg){
    $toast.textContent = msg; $toast.classList.add('show'); clearTimeout(toast.t); toast.t=setTimeout(()=>$toast.classList.remove('show'),2200);
  }
  function haptic(){ try { navigator.vibrate?.(12); } catch(_){} }

  // iOS-like interaction: prevent pinch zoom and double-tap zoom while keeping form controls usable.
  document.addEventListener('gesturestart', e => e.preventDefault(), {passive:false});
  document.addEventListener('gesturechange', e => e.preventDefault(), {passive:false});
  document.addEventListener('gestureend', e => e.preventDefault(), {passive:false});
  document.addEventListener('touchmove', e => { if(e.touches && e.touches.length > 1) e.preventDefault(); }, {passive:false});
  let lastTouchEnd = 0;
  document.addEventListener('touchend', e => {
    const now = Date.now();
    if(now-lastTouchEnd <= 300 && !['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)) e.preventDefault();
    lastTouchEnd = now;
  }, {passive:false});
  document.addEventListener('dblclick', e => { if(!['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)) e.preventDefault(); }, {passive:false});

  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstallPrompt = e; render(); });
  window.addEventListener('appinstalled', () => { deferredInstallPrompt=null; toast('Hako added to your home screen 💗'); render(); });

  if('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('./service-worker.js').catch(()=>{}));

  function daysLeft(){
    if(!state.project.moveDate) return null;
    const target = new Date(`${state.project.moveDate}T23:59:59`);
    return Math.ceil((target - new Date()) / 86400000);
  }
  function roomById(id){ return state.rooms.find(r=>r.id===id); }
  function boxById(id){ return state.boxes.find(b=>b.id===id); }
  function itemById(id){ return state.items.find(i=>i.id===id); }
  function itemsInBox(id){ return state.items.filter(i=>i.boxId===id); }
  function boxesInRoom(id){ return state.boxes.filter(b=>b.roomId===id); }
  function itemsInRoom(id){ return state.items.filter(i=>i.roomId===id); }
  function taskDone(){ return state.tasks.filter(t=>t.done).length; }
  function packPercent(){
    if(!state.items.length && !state.boxes.length) return 0;
    const packedItems = state.items.filter(i=>['packed','loaded','unloaded','unpacked'].includes(i.status)).length;
    const itemPart = state.items.length ? packedItems/state.items.length : 1;
    const sealedBoxes = state.boxes.filter(b=>['sealed','loaded','unloaded','unpacked'].includes(b.status)).length;
    const boxPart = state.boxes.length ? sealedBoxes/state.boxes.length : 1;
    return Math.round(((itemPart+boxPart)/2)*100);
  }
  function readiness(){
    const p = packPercent();
    const tasks = state.tasks.length ? taskDone()/state.tasks.length*100 : 0;
    const setup = (state.project.moveDate?25:0)+(state.rooms.length?25:0)+(state.boxes.length?25:0)+(state.items.length?25:0);
    return Math.round(p*.55 + tasks*.25 + setup*.20);
  }
  function statusLabel(s){ return ({empty:'Empty',packing:'Packing',sealed:'Sealed',loaded:'Loaded',unloaded:'Unloaded',unpacked:'Unpacked',loose:'Loose',packed:'Packed'}[s]||s||'Not set'); }
  function boxCode(b){
    const room=(roomById(b.roomId)?.name||'BOX').replace(/[^A-Za-z0-9]/g,'').slice(0,4).toUpperCase() || 'BOX';
    const idx = Math.max(1, state.boxes.findIndex(x=>x.id===b.id)+1);
    return `${room}-${String(idx).padStart(3,'0')}`;
  }

  function render(){
    document.documentElement.dataset.accent=state.settings.accent||'pink';
    if(!state.hasOnboarded){ renderOnboarding(); return; }
    const params = new URLSearchParams(location.search);
    if(params.get('tab') && ['home','rooms','boxes','find','more'].includes(params.get('tab'))) state.ui.tab=params.get('tab');
    if(params.get('tool')) state.ui.tool=params.get('tool');

    $app.innerHTML = `
      <main class="screen">
        ${topbar()}
        <section class="content" id="content">${view()}</section>
        ${nav()}
      </main>`;
    if(state.ui.tool) setTimeout(()=>document.getElementById('content')?.scrollTo(0,0),0);
    const action=params.get('action');
    if(action==='add-box'){ history.replaceState({},'',location.pathname); setTimeout(()=>openBoxForm(),10); }
  }

  function topbar(){
    const toolTitle = ({tasks:'Checklist',declutter:'Declutter','move-day':'Move Day',unpacking:'Unpacking',expenses:'Expenses',supplies:'Packing Supplies',backup:'Backup & Export',settings:'Settings',about:'About Hako'}[state.ui.tool]);
    const titles={home:'Hako',rooms:'Rooms',boxes:'Boxes',find:'Find My Stuff',more:'More'};
    if(state.ui.tool) return `<header class="topbar"><button class="icon-btn" data-action="back-tool" aria-label="Back">‹</button><h1>${esc(toolTitle||'Hako')}</h1><span></span></header>`;
    return `<header class="topbar"><button class="icon-btn" data-action="open-project" aria-label="Move settings">☰</button><h1>${titles[state.ui.tab]}</h1><button class="icon-btn" data-action="quick-add" aria-label="Quick add">＋</button></header>`;
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
      <div class="feature-chips"><span class="pill">📦 Boxes</span><span class="pill">🏠 Rooms</span><span class="pill">🔎 Smart Find</span><span class="pill">✓ Checklists</span><span class="pill">📴 Offline</span><span class="pill">💗 Local-first</span></div>
      <div class="onboarding-actions"><button class="primary-btn wide" data-action="start-setup">Set up my move</button><button class="soft-btn wide" data-action="skip-setup">Explore the empty app</button></div>
      <p class="tiny" style="text-align:center;margin-top:14px">No account required. Your move data stays on this device unless you export it.</p>
    </section>`;
  }

  function homeView(){
    const d=daysLeft(); const p=packPercent(); const r=readiness();
    const keep=state.items.filter(i=>i.decision==='keep').length, sell=state.items.filter(i=>i.decision==='sell').length, donate=state.items.filter(i=>i.decision==='donate').length, trash=state.items.filter(i=>i.decision==='trash').length;
    const openTasks=state.tasks.filter(t=>!t.done).sort((a,b)=>(a.due||'9999').localeCompare(b.due||'9999')).slice(0,4);
    return `
      <div class="hero"><div class="eyebrow">${d===null?'Your move hub':d<0?'Move date passed':d===0?'Moving day!':`${d} day${d===1?'':'s'} to go`}</div><h2>${state.profile.name?`Hi, ${esc(state.profile.name)}!`:'Everything in its place.'}</h2><p>${esc(state.project.name||'My Move')}${state.project.from||state.project.to?` · ${esc(state.project.from||'Current home')} → ${esc(state.project.to||'New home')}`:''}</p></div>
      ${deferredInstallPrompt?`<div class="section"><div class="install-banner"><img src="icons/icon-96.png" alt=""><div class="copy"><h4>Install Hako</h4><p>Open it full-screen like a phone app.</p></div><button class="soft-btn small-btn" data-action="install">Install</button></div></div>`:''}
      <div class="section"><div class="card dashboard-progress"><div class="progress-ring" style="--p:${p}"><strong>${p}%</strong><small>Packed</small></div><div class="copy"><h3>${r}% move-ready</h3><p>${state.items.length} items · ${state.boxes.length} boxes · ${state.rooms.length} rooms · ${state.tasks.filter(t=>!t.done).length} open tasks</p><div class="progress" style="margin-top:10px"><span style="width:${r}%"></span></div></div></div></div>
      <div class="section"><div class="section-head"><h2 class="section-title">Quick actions</h2></div><div class="quick-grid">
        <button class="quick-card" data-action="add-item"><span class="emoji">＋</span><span>Add item</span></button>
        <button class="quick-card" data-action="add-box"><span class="emoji">📦</span><span>Add box</span></button>
        <button class="quick-card" data-action="add-task"><span class="emoji">✓</span><span>Add task</span></button>
        <button class="quick-card" data-action="go-find"><span class="emoji">⌕</span><span>Find stuff</span></button>
      </div></div>
      <div class="section"><div class="grid-2">
        <div class="card stat"><span class="label">Boxes sealed</span><span class="value">${state.boxes.filter(b=>['sealed','loaded','unloaded','unpacked'].includes(b.status)).length}/${state.boxes.length}</span></div>
        <div class="card stat"><span class="label">Tasks done</span><span class="value">${taskDone()}/${state.tasks.length}</span></div>
      </div></div>
      <div class="section"><div class="section-head"><h2 class="section-title">Declutter snapshot</h2><button class="soft-btn small-btn" data-tool="declutter">Open</button></div><div class="grid-4 decision-grid"><button>Keep<br><b>${keep}</b></button><button>Donate<br><b>${donate}</b></button><button>Sell<br><b>${sell}</b></button><button>Trash<br><b>${trash}</b></button></div></div>
      <div class="section"><div class="section-head"><h2 class="section-title">Next tasks</h2><button class="soft-btn small-btn" data-tool="tasks">View all</button></div>${openTasks.length?`<div class="list-card">${openTasks.map(taskRow).join('')}</div>`:empty('📝','No tasks yet','Add a moving task, due date, or reminder so nothing gets forgotten.','Add a task','add-task')}</div>
      ${state.activity.length?`<div class="section"><div class="section-head"><h2 class="section-title">Recent activity</h2></div><div class="list-card">${state.activity.slice(0,4).map(a=>`<div class="row"><div class="row-icon">•</div><div class="row-main"><div class="row-title">${esc(a.text)}</div><div class="row-sub">${new Date(a.at).toLocaleString()}</div></div></div>`).join('')}</div></div>`:''}`;
  }

  function roomsView(){
    const rooms=state.rooms;
    return `<div class="section-head"><div><h2 class="section-title">Your rooms</h2><div class="tiny">Organize the current home and where things should go next.</div></div><button class="primary-btn small-btn" data-action="add-room">＋ Room</button></div>
      ${rooms.length?`<div class="grid-2">${rooms.map(r=>{
        const boxes=boxesInRoom(r.id), items=itemsInRoom(r.id), packed=items.length?Math.round(items.filter(i=>['packed','loaded','unloaded','unpacked'].includes(i.status)).length/items.length*100):0;
        return `<article class="card room-card"><div class="card-top"><div><h3>${esc(r.name)}</h3><p>${items.length} items · ${boxes.length} boxes</p></div><div class="room-emoji">${esc(r.emoji||'🏠')}</div></div><div class="progress" style="margin-top:13px"><span style="width:${packed}%"></span></div><div class="tiny" style="margin-top:6px">${packed}% packed${r.destination?` · → ${esc(r.destination)}`:''}</div><div class="mini-actions"><button class="soft-btn small-btn" data-action="filter-room" data-id="${r.id}">View stuff</button><button class="soft-btn small-btn" data-action="edit-room" data-id="${r.id}">Edit</button></div></article>`;
      }).join('')}</div>`:empty('🏠','No rooms yet','Add rooms such as Bedroom, Kitchen, Office, Storage or any custom space.','Add your first room','add-room')}`;
  }

  function boxesView(){
    const filter=state.ui.boxFilter||'all'; let boxes=state.boxes;
    if(state.ui.roomFilter) boxes=boxes.filter(b=>b.roomId===state.ui.roomFilter);
    if(filter!=='all') boxes=boxes.filter(b=>b.status===filter);
    const room=roomById(state.ui.roomFilter);
    return `<div class="section-head"><div><h2 class="section-title">${room?esc(room.name)+' boxes':'Boxes & containers'}</h2><div class="tiny">Track what is packed, loaded and unpacked.</div></div><button class="primary-btn small-btn" data-action="add-box">＋ Box</button></div>
      ${room?`<button class="soft-btn small-btn" data-action="clear-room-filter" style="margin-bottom:10px">← All rooms</button>`:''}
      <div class="segmented" style="margin-bottom:12px">${['all','empty','packing','sealed','loaded','unloaded','unpacked'].map(s=>`<button class="${filter===s?'active':''}" data-box-filter="${s}">${s==='all'?'All':statusLabel(s)}</button>`).join('')}</div>
      ${boxes.length?`<div class="stack">${boxes.map(b=>{
        const r=roomById(b.roomId), count=itemsInBox(b.id).length;
        return `<article class="card box-card"><div class="card-top"><div><div class="eyebrow">${boxCode(b)}</div><h3>${esc(b.name||'Untitled box')}</h3><p>${esc(r?.name||'No room')} · ${count} item${count===1?'':'s'}</p></div><span class="pill ${b.status==='sealed'?'good':b.status==='loaded'?'warn':'gray'}">${statusLabel(b.status)}</span></div>${b.notes?`<p style="margin-top:10px">${esc(b.notes)}</p>`:''}<div class="mini-actions"><button class="primary-btn small-btn" data-action="box-detail" data-id="${b.id}">Open</button><button class="soft-btn small-btn" data-action="box-label" data-id="${b.id}">Label</button><button class="soft-btn small-btn" data-action="edit-box" data-id="${b.id}">Edit</button></div></article>`;
      }).join('')}</div>`:empty('📦','No boxes here','Create a box, bag, bin, suitcase or crate and assign it to a room.','Add a box','add-box')}`;
  }

  function findView(){
    const q=(state.ui.findQuery||'').trim().toLowerCase();
    let results=[];
    if(q){
      state.items.forEach(i=>{const b=boxById(i.boxId),r=roomById(i.roomId); const hay=[i.name,i.category,i.tags,i.notes,b?.name,b?boxCode(b):'',r?.name].join(' ').toLowerCase(); if(hay.includes(q)) results.push({type:'item',id:i.id,title:i.name,sub:`${b?boxCode(b)+' · '+b.name:'Loose'} · ${r?.name||'No room'}`,emoji:'🔎'});});
      state.boxes.forEach(b=>{const r=roomById(b.roomId); const hay=[b.name,boxCode(b),b.notes,r?.name].join(' ').toLowerCase(); if(hay.includes(q)) results.push({type:'box',id:b.id,title:`${boxCode(b)} · ${b.name}`,sub:`${r?.name||'No room'} · ${itemsInBox(b.id).length} items`,emoji:'📦'});});
      state.rooms.forEach(r=>{if(r.name.toLowerCase().includes(q)) results.push({type:'room',id:r.id,title:r.name,sub:`${itemsInRoom(r.id).length} items · ${boxesInRoom(r.id).length} boxes`,emoji:r.emoji||'🏠'});});
    }
    return `<div class="searchbar"><span>⌕</span><input id="find-input" type="search" autocomplete="off" inputmode="search" placeholder="Search item, box code, room, category…" value="${esc(state.ui.findQuery||'')}"><button class="icon-btn" style="width:36px;height:36px" data-action="voice-search" aria-label="Voice search">◉</button></div>
      ${state.recentSearches.length?`<div class="section"><div class="section-head"><h2 class="section-title">Recent</h2><button class="soft-btn small-btn" data-action="clear-searches">Clear</button></div><div class="segmented">${state.recentSearches.map(x=>`<button data-recent-search="${esc(x)}">${esc(x)}</button>`).join('')}</div></div>`:''}
      <div class="section"><div class="section-head"><h2 class="section-title">${q?`${results.length} result${results.length===1?'':'s'}`:'Find anything'}</h2></div>${q?(results.length?`<div class="list-card">${results.slice(0,60).map(x=>`<button class="row" style="width:100%;border-left:0;border-right:0;border-top:0;background:white;text-align:left" data-result-type="${x.type}" data-id="${x.id}"><div class="row-icon">${x.emoji}</div><div class="row-main"><div class="row-title">${esc(x.title)}</div><div class="row-sub">${esc(x.sub)}</div></div><span>›</span></button>`).join('')}</div>`:empty('🕵️','Nothing found','Try a box code, item name, room, category, tag or note.')):empty('🔎','Where did I pack it?','Search works across items, boxes, room names, tags, categories and notes. Try “passport”, “winter clothes” or a box code.')}</div>`;
  }

  function moreView(){
    const tools=[
      ['tasks','✓','Checklist','Tasks, due dates and moving steps'],['declutter','♻','Declutter','Keep, sell, donate or trash'],['move-day','🚚','Move Day','Load and unload box tracking'],['unpacking','🏡','Unpacking','Finish room by room'],['expenses','₱','Expenses','Moving costs and budget'],['supplies','🧻','Supplies','Boxes, tape and packing materials'],['backup','⇩','Backup & Export','Save or restore your Hako data'],['settings','⚙','Settings','Move details and preferences'],['about','♡','About Hako','Meaning, privacy and What’s New']
    ];
    return `<div class="hero"><div class="eyebrow">Hako tools</div><h2>Everything around the move.</h2><p>Use only what you need. Core data works locally and remains available offline.</p></div><div class="section tool-grid">${tools.map(t=>`<button class="tool-card" data-tool="${t[0]}"><span class="tool-icon">${t[1]}</span><h3>${t[2]}</h3><p>${t[3]}</p></button>`).join('')}</div>`;
  }

  function renderTool(tool){
    if(tool==='tasks') return tasksView();
    if(tool==='declutter') return declutterView();
    if(tool==='move-day') return moveDayView();
    if(tool==='unpacking') return unpackingView();
    if(tool==='expenses') return expensesView();
    if(tool==='supplies') return suppliesView();
    if(tool==='backup') return backupView();
    if(tool==='settings') return settingsView();
    if(tool==='about') return aboutView();
    return moreView();
  }

  function taskRow(t){
    return `<div class="row"><button class="check ${t.done?'done':''}" data-action="toggle-task" data-id="${t.id}" aria-label="Toggle task">${t.done?'✓':''}</button><div class="row-main"><div class="row-title" style="${t.done?'text-decoration:line-through;opacity:.55':''}">${esc(t.title)}</div><div class="row-sub">${t.due?`Due ${fmtDate(t.due)}`:'No due date'}${t.category?` · ${esc(t.category)}`:''}</div></div><button class="icon-btn" style="width:36px;height:36px" data-action="edit-task" data-id="${t.id}">⋯</button></div>`;
  }
  function tasksView(){
    const f=state.ui.taskFilter||'all'; let tasks=state.tasks;
    if(f==='open') tasks=tasks.filter(t=>!t.done); if(f==='done') tasks=tasks.filter(t=>t.done);
    return `<div class="section-head"><div><h2 class="section-title">Moving checklist</h2><div class="tiny">Plan before, during and after the move.</div></div><button class="primary-btn small-btn" data-action="add-task">＋ Task</button></div><div class="segmented" style="margin-bottom:12px"><button class="${f==='all'?'active':''}" data-task-filter="all">All</button><button class="${f==='open'?'active':''}" data-task-filter="open">Open</button><button class="${f==='done'?'active':''}" data-task-filter="done">Done</button></div>${tasks.length?`<div class="list-card">${tasks.sort((a,b)=>(a.done-b.done)||((a.due||'9999').localeCompare(b.due||'9999'))).map(taskRow).join('')}</div>`:empty('✅','Checklist is clear','Add tasks like book movers, change address, pack essentials or return keys.','Add a task','add-task')}`;
  }
  function declutterView(){
    const decisions=['keep','donate','sell','trash'];
    const undecided=state.items.filter(i=>!i.decision).length;
    return `<div class="grid-2"><div class="card stat"><span class="label">Undecided</span><span class="value">${undecided}</span></div><div class="card stat"><span class="label">Decided</span><span class="value">${state.items.length-undecided}</span></div></div><div class="section"><div class="section-head"><h2 class="section-title">Sort your things</h2><button class="primary-btn small-btn" data-action="add-item">＋ Item</button></div>${state.items.length?`<div class="stack">${state.items.map(i=>`<div class="card"><div class="card-top"><div><h3 style="margin:0">${esc(i.name)}</h3><p class="tiny">${esc(roomById(i.roomId)?.name||'No room')} ${i.boxId?'· '+esc(boxById(i.boxId)?.name||'Box'):''}</p></div><span class="pill ${i.decision?'good':'gray'}">${i.decision?i.decision.toUpperCase():'UNDECIDED'}</span></div><div class="decision-grid" style="margin-top:12px">${decisions.map(d=>`<button class="${i.decision===d?'active':''}" data-action="decide" data-id="${i.id}" data-value="${d}">${d[0].toUpperCase()+d.slice(1)}</button>`).join('')}</div></div>`).join('')}</div>`:empty('♻️','Nothing to sort yet','Add items first, then decide what stays, gets donated, sold or let go.','Add an item','add-item')}</div>`;
  }
  function moveDayView(){
    const loaded=state.boxes.filter(b=>['loaded','unloaded','unpacked'].includes(b.status)).length;
    return `<div class="hero"><div class="eyebrow">Move Day Mode</div><h2>${loaded}/${state.boxes.length} boxes loaded</h2><p>Large, simple controls for checking boxes onto the vehicle and into the new home.</p></div><div class="section">${state.boxes.length?`<div class="stack">${state.boxes.map(b=>`<div class="card"><div class="card-top"><div><div class="eyebrow">${boxCode(b)}</div><h3 style="margin:0">${esc(b.name)}</h3><p class="tiny">${esc(roomById(b.roomId)?.name||'No room')} · ${statusLabel(b.status)}</p></div><span class="badge">${itemsInBox(b.id).length}</span></div><div class="grid-2" style="margin-top:12px"><button class="${['loaded','unloaded','unpacked'].includes(b.status)?'primary-btn':'soft-btn'}" data-action="set-box-status" data-id="${b.id}" data-value="loaded">✓ Loaded</button><button class="${['unloaded','unpacked'].includes(b.status)?'primary-btn':'soft-btn'}" data-action="set-box-status" data-id="${b.id}" data-value="unloaded">⌂ Unloaded</button></div></div>`).join('')}</div>`:empty('🚚','No boxes to move','Add and pack boxes first. Hako will turn them into a move-day loading list.','Add a box','add-box')}</div>`;
  }
  function unpackingView(){
    const boxes=state.boxes.filter(b=>['sealed','loaded','unloaded','unpacked'].includes(b.status));
    const done=boxes.filter(b=>b.status==='unpacked').length;
    return `<div class="card dashboard-progress"><div class="progress-ring" style="--p:${boxes.length?Math.round(done/boxes.length*100):0}"><strong>${done}/${boxes.length}</strong><small>Unpacked</small></div><div class="copy"><h3>Settle in room by room</h3><p>Prioritize essentials and mark boxes empty as you finish them.</p></div></div><div class="section">${boxes.length?`<div class="stack">${boxes.map(b=>`<div class="card"><div class="card-top"><div><div class="eyebrow">${boxCode(b)}</div><h3 style="margin:0">${esc(b.name)}</h3><p class="tiny">→ ${esc(roomById(b.roomId)?.destination||roomById(b.roomId)?.name||'Destination room')}</p></div><span class="pill ${b.status==='unpacked'?'good':'gray'}">${statusLabel(b.status)}</span></div><button class="${b.status==='unpacked'?'soft-btn':'primary-btn'} wide" style="margin-top:12px" data-action="set-box-status" data-id="${b.id}" data-value="${b.status==='unpacked'?'unloaded':'unpacked'}">${b.status==='unpacked'?'Mark not finished':'Mark unpacked'}</button></div>`).join('')}</div>`:empty('🏡','Nothing ready to unpack','Seal boxes during packing, then they will appear here.','View boxes','go-boxes')}</div>`;
  }
  function expensesView(){
    const total=state.expenses.reduce((a,e)=>a+(Number(e.amount)||0),0);
    const cats={}; state.expenses.forEach(e=>cats[e.category||'Other']=(cats[e.category||'Other']||0)+Number(e.amount||0));
    return `<div class="grid-2"><div class="card stat"><span class="label">Total spent</span><span class="value" style="font-size:21px">${money(total)}</span></div><div class="card stat"><span class="label">Entries</span><span class="value">${state.expenses.length}</span></div></div><div class="section"><button class="primary-btn wide" data-action="add-expense">＋ Add expense</button></div>${Object.keys(cats).length?`<div class="section"><div class="section-head"><h2 class="section-title">By category</h2></div><div class="list-card">${Object.entries(cats).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`<div class="row"><div class="row-icon">₱</div><div class="row-main"><div class="row-title">${esc(k)}</div><div class="row-sub">${money(v)}</div></div></div>`).join('')}</div></div>`:''}<div class="section"><div class="section-head"><h2 class="section-title">Expenses</h2></div>${state.expenses.length?`<div class="list-card">${state.expenses.slice().reverse().map(e=>`<div class="row"><div class="row-icon">🧾</div><div class="row-main"><div class="row-title">${esc(e.title)}</div><div class="row-sub">${esc(e.category||'Other')} · ${money(e.amount)}</div></div><button class="icon-btn" style="width:34px;height:34px" data-action="delete-expense" data-id="${e.id}">×</button></div>`).join('')}</div>`:empty('💸','No moving expenses yet','Track movers, packing supplies, storage, cleaning, fuel, deposits and more.')}</div>`;
  }
  function suppliesView(){
    return `<div class="section-head"><div><h2 class="section-title">Packing supplies</h2><div class="tiny">Track what you have and what you still need.</div></div><button class="primary-btn small-btn" data-action="add-supply">＋ Supply</button></div>${state.supplies.length?`<div class="list-card">${state.supplies.map(s=>`<div class="row"><button class="check ${s.bought?'done':''}" data-action="toggle-supply" data-id="${s.id}">${s.bought?'✓':''}</button><div class="row-main"><div class="row-title">${esc(s.name)}</div><div class="row-sub">Need ${esc(s.qty||'1')} ${s.unit?esc(s.unit):''}${s.cost?` · ${money(s.cost)}`:''}</div></div><button class="icon-btn" style="width:34px;height:34px" data-action="delete-supply" data-id="${s.id}">×</button></div>`).join('')}</div>`:empty('📦','Supply list is empty','Add boxes, tape, markers, labels, bubble wrap, paper or anything else you need.','Add supply','add-supply')}`;
  }
  function backupView(){
    return `<div class="about-box"><strong>Local-first backup</strong><br>Your Hako data is stored in this browser on this device. Export a backup before changing phones, clearing browser data, or making major edits.</div><div class="section stack"><button class="primary-btn wide" data-action="export-json">⇩ Export Hako backup (.json)</button><button class="soft-btn wide" data-action="export-csv">⇩ Export item inventory (.csv)</button><button class="soft-btn wide" data-action="import-json">⇧ Restore from backup</button><input id="import-file" type="file" accept="application/json,.json" hidden></div><div class="section"><div class="card"><div class="row-title">What is included?</div><div class="row-sub" style="white-space:normal;line-height:1.6;margin-top:6px">Move setup, rooms, boxes, items, item photos, declutter decisions, tasks, expenses, supplies, activity and settings.</div></div></div>`;
  }
  function settingsView(){
    return `<div class="stack">
      <button class="card" style="text-align:left" data-action="open-project"><div class="row-title">Move setup</div><div class="row-sub">${esc(state.project.name)} · ${fmtDate(state.project.moveDate)}</div></button>
      <div class="card"><div class="row-title">Default look</div><div class="row-sub" style="white-space:normal;margin:6px 0 12px">Hako uses light pink as its signature color.</div><span class="pill">💗 Light Pink</span></div>
      <div class="card"><div class="row-title">Units & currency</div><div class="row-sub">${esc(state.project.units)} · ${esc(state.project.currency)}</div></div>
      <button class="danger-btn wide" data-action="reset-app">Erase all Hako data</button>
    </div>`;
  }
  function aboutView(){
    return `<div class="brand" style="padding:8px 0 18px"><img src="icons/icon-192.png" alt="Hako icon" style="width:96px;height:96px;border-radius:24px"><h1 style="font-size:34px;margin-top:8px">Hako</h1><p>Version ${APP_VERSION}</p></div><div class="about-box"><strong>Hako (箱)</strong> means “box” in Japanese. Moving often starts with putting everything into boxes, but Hako is really about what comes next—sorting what stays, finding where everything belongs, and making a new space feel like home.</div><div class="section"><div class="section-head"><h2 class="section-title">What’s New · ${APP_VERSION}</h2></div><div class="list-card"><div class="row"><div class="row-icon">💗</div><div class="row-main"><div class="row-title">First usable Hako build</div><div class="row-sub" style="white-space:normal">Rooms, boxes, items, photos, decluttering, search, tasks, expenses, supplies, move-day tracking, unpacking, labels, backup, offline PWA and app-like no-zoom behavior.</div></div></div></div></div><div class="section"><div class="card"><div class="row-title">Privacy</div><div class="row-sub" style="white-space:normal;line-height:1.55;margin-top:5px">No account is required. This build does not send your move inventory to a Hako server. Exported backups are files you control.</div></div></div>`;
  }

  function empty(icon,title,text,buttonText,action){ return `<div class="empty"><div class="big">${icon}</div><h3>${title}</h3><p>${text}</p>${buttonText?`<button class="primary-btn" data-action="${action}">${buttonText}</button>`:''}</div>`; }

  function openSheet(title, body, opts={}){
    $modal.innerHTML=`<div class="sheet-backdrop" data-action="close-modal"><section class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}" data-sheet><div class="sheet-handle"></div><div class="sheet-head"><h2>${esc(title)}</h2><button class="icon-btn" data-action="close-modal">×</button></div>${body}</section></div>`;
    setTimeout(()=>{ const el=$modal.querySelector('input:not([type=hidden]),select,textarea'); if(opts.focus!==false) el?.focus(); },60);
  }
  function closeModal(){ $modal.innerHTML=''; }

  function openSetup(first=false){
    const p=state.project;
    openSheet(first?'Set up your move':'Move setup',`<form class="form" id="project-form">
      <div class="field"><label>Your name (optional)</label><input name="name" maxlength="40" value="${esc(state.profile.name)}" placeholder="e.g. Cha"></div>
      <div class="field"><label>Move name</label><input name="projectName" maxlength="60" value="${esc(p.name)}" placeholder="e.g. New Apartment"></div>
      <div class="field"><label>Move date</label><input type="date" name="moveDate" value="${esc(p.moveDate)}"></div>
      <div class="grid-2"><div class="field"><label>Moving from</label><input name="from" maxlength="80" value="${esc(p.from)}" placeholder="Current home"></div><div class="field"><label>Moving to</label><input name="to" maxlength="80" value="${esc(p.to)}" placeholder="New home"></div></div>
      <div class="grid-2"><div class="field"><label>Currency</label><select name="currency">${['PHP','JPY','USD','EUR','GBP','SGD','HKD'].map(x=>`<option ${p.currency===x?'selected':''}>${x}</option>`).join('')}</select></div><div class="field"><label>Measurements</label><select name="units">${['cm','m','in','ft'].map(x=>`<option ${p.units===x?'selected':''}>${x}</option>`).join('')}</select></div></div>
      <div class="form-actions"><button type="button" class="soft-btn" data-action="close-modal">Cancel</button><button class="primary-btn" type="submit">Save move</button></div>
    </form>`);
  }
  function openRoomForm(id){
    const r=state.rooms.find(x=>x.id===id)||{name:'',emoji:'🏠',destination:'',notes:''};
    openSheet(id?'Edit room':'Add room',`<form class="form" id="room-form" data-id="${id||''}"><div class="grid-2"><div class="field"><label>Room name</label><input required name="name" maxlength="40" value="${esc(r.name)}" placeholder="Bedroom"></div><div class="field"><label>Emoji</label><input name="emoji" maxlength="4" value="${esc(r.emoji||'🏠')}"></div></div><div class="field"><label>Destination room / area</label><input name="destination" maxlength="50" value="${esc(r.destination||'')}" placeholder="New Home · Bedroom"></div><div class="field"><label>Notes</label><textarea name="notes" maxlength="300">${esc(r.notes||'')}</textarea></div><div class="form-actions">${id?`<button type="button" class="danger-btn" data-action="delete-room" data-id="${id}">Delete</button>`:`<button type="button" class="soft-btn" data-action="close-modal">Cancel</button>`}<button class="primary-btn" type="submit">Save room</button></div></form>`);
  }
  function openBoxForm(id){
    const b=state.boxes.find(x=>x.id===id)||{name:'',roomId:'',type:'Box',status:'empty',notes:'',fragile:false,openFirst:false};
    openSheet(id?'Edit box':'Add box',`<form class="form" id="box-form" data-id="${id||''}"><div class="field"><label>Box name</label><input required name="name" maxlength="60" value="${esc(b.name)}" placeholder="Kitchen essentials"></div><div class="grid-2"><div class="field"><label>Room</label><select name="roomId"><option value="">No room</option>${state.rooms.map(r=>`<option value="${r.id}" ${b.roomId===r.id?'selected':''}>${esc(r.name)}</option>`).join('')}</select></div><div class="field"><label>Container type</label><select name="type">${['Box','Bin','Bag','Suitcase','Crate','Other'].map(x=>`<option ${b.type===x?'selected':''}>${x}</option>`).join('')}</select></div></div><div class="field"><label>Status</label><select name="status">${['empty','packing','sealed','loaded','unloaded','unpacked'].map(x=>`<option value="${x}" ${b.status===x?'selected':''}>${statusLabel(x)}</option>`).join('')}</select></div><div class="field"><label>Notes</label><textarea name="notes" maxlength="400" placeholder="Plates, mugs, charger, open first…">${esc(b.notes||'')}</textarea></div><div class="grid-2"><label class="card" style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="fragile" ${b.fragile?'checked':''}> Fragile</label><label class="card" style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="openFirst" ${b.openFirst?'checked':''}> Open first</label></div><div class="form-actions">${id?`<button type="button" class="danger-btn" data-action="delete-box" data-id="${id}">Delete</button>`:`<button type="button" class="soft-btn" data-action="close-modal">Cancel</button>`}<button class="primary-btn" type="submit">Save box</button></div></form>`);
  }
  function openItemForm(id, forcedBoxId=''){
    const i=state.items.find(x=>x.id===id)||{name:'',category:'',roomId:'',boxId:forcedBoxId,status:forcedBoxId?'packed':'loose',decision:'',tags:'',notes:'',fragile:false,essential:false,value:'',photo:''};
    openSheet(id?'Edit item':'Add item',`<form class="form" id="item-form" data-id="${id||''}"><div class="field"><label>Item name</label><input required name="name" maxlength="80" value="${esc(i.name)}" placeholder="Blender"></div><div class="grid-2"><div class="field"><label>Category</label><input name="category" maxlength="40" value="${esc(i.category||'')}" placeholder="Kitchen"></div><div class="field"><label>Decision</label><select name="decision"><option value="">Undecided</option>${['keep','donate','sell','trash'].map(x=>`<option value="${x}" ${i.decision===x?'selected':''}>${x[0].toUpperCase()+x.slice(1)}</option>`).join('')}</select></div></div><div class="grid-2"><div class="field"><label>Current room</label><select name="roomId"><option value="">No room</option>${state.rooms.map(r=>`<option value="${r.id}" ${i.roomId===r.id?'selected':''}>${esc(r.name)}</option>`).join('')}</select></div><div class="field"><label>Packed in</label><select name="boxId"><option value="">Loose / no box</option>${state.boxes.map(b=>`<option value="${b.id}" ${i.boxId===b.id?'selected':''}>${boxCode(b)} · ${esc(b.name)}</option>`).join('')}</select></div></div><div class="field"><label>Tags</label><input name="tags" maxlength="120" value="${esc(i.tags||'')}" placeholder="winter, documents, favorite"></div><div class="field"><label>Estimated value</label><input type="number" min="0" step="0.01" name="value" value="${esc(i.value||'')}"></div><div class="field"><label>Photo</label>${i.photo?`<img class="photo-preview" src="${i.photo}" alt="Item photo">`:''}<input type="file" id="item-photo" accept="image/*" capture="environment"></div><div class="field"><label>Notes</label><textarea name="notes" maxlength="500">${esc(i.notes||'')}</textarea></div><div class="grid-2"><label class="card" style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="fragile" ${i.fragile?'checked':''}> Fragile</label><label class="card" style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="essential" ${i.essential?'checked':''}> Essential</label></div><div class="form-actions">${id?`<button type="button" class="danger-btn" data-action="delete-item" data-id="${id}">Delete</button>`:`<button type="button" class="soft-btn" data-action="close-modal">Cancel</button>`}<button class="primary-btn" type="submit">Save item</button></div></form>`);
  }
  function openTaskForm(id){
    const t=state.tasks.find(x=>x.id===id)||{title:'',due:'',category:'Packing',notes:'',done:false};
    openSheet(id?'Edit task':'Add task',`<form class="form" id="task-form" data-id="${id||''}"><div class="field"><label>Task</label><input required name="title" maxlength="100" value="${esc(t.title)}" placeholder="Book moving truck"></div><div class="grid-2"><div class="field"><label>Due date</label><input type="date" name="due" value="${esc(t.due||'')}"></div><div class="field"><label>Category</label><select name="category">${['Plan & Notify','Declutter','Packing','Move Day','After Move','Other'].map(x=>`<option ${t.category===x?'selected':''}>${x}</option>`).join('')}</select></div></div><div class="field"><label>Notes</label><textarea name="notes" maxlength="400">${esc(t.notes||'')}</textarea></div><label class="card" style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="done" ${t.done?'checked':''}> Completed</label><div class="form-actions">${id?`<button type="button" class="danger-btn" data-action="delete-task" data-id="${id}">Delete</button>`:`<button type="button" class="soft-btn" data-action="close-modal">Cancel</button>`}<button class="primary-btn" type="submit">Save task</button></div></form>`);
  }
  function openExpenseForm(){
    openSheet('Add expense',`<form class="form" id="expense-form"><div class="field"><label>Expense</label><input required name="title" maxlength="80" placeholder="Moving truck"></div><div class="grid-2"><div class="field"><label>Amount</label><input required type="number" min="0" step="0.01" name="amount" placeholder="0"></div><div class="field"><label>Category</label><select name="category">${['Movers','Packing Supplies','Storage','Cleaning','Travel','Deposits','Utilities','Other'].map(x=>`<option>${x}</option>`).join('')}</select></div></div><div class="field"><label>Notes</label><textarea name="notes" maxlength="300"></textarea></div><div class="form-actions"><button type="button" class="soft-btn" data-action="close-modal">Cancel</button><button class="primary-btn" type="submit">Save expense</button></div></form>`);
  }
  function openSupplyForm(){
    openSheet('Add packing supply',`<form class="form" id="supply-form"><div class="field"><label>Supply</label><input required name="name" maxlength="70" placeholder="Packing tape"></div><div class="grid-2"><div class="field"><label>Quantity needed</label><input name="qty" type="number" min="0" step="1" value="1"></div><div class="field"><label>Unit</label><input name="unit" maxlength="20" placeholder="rolls"></div></div><div class="field"><label>Estimated cost</label><input name="cost" type="number" min="0" step="0.01"></div><div class="form-actions"><button type="button" class="soft-btn" data-action="close-modal">Cancel</button><button class="primary-btn" type="submit">Save supply</button></div></form>`);
  }

  function openBoxDetail(id){
    const b=boxById(id); if(!b) return;
    const r=roomById(b.roomId), items=itemsInBox(id);
    openSheet(`${boxCode(b)} · ${b.name}`,`<div class="stack"><div class="card"><div class="card-top"><div><span class="pill">${statusLabel(b.status)}</span><h3 style="margin:10px 0 4px">${esc(r?.name||'No room')}</h3><p class="tiny">${esc(b.type||'Box')}${b.fragile?' · Fragile':''}${b.openFirst?' · Open first':''}</p></div><button class="soft-btn small-btn" data-action="box-label" data-id="${b.id}">Label</button></div>${b.notes?`<p style="line-height:1.5">${esc(b.notes)}</p>`:''}</div><div class="section-head"><h3 class="section-title">Contents (${items.length})</h3><button class="primary-btn small-btn" data-action="add-item-to-box" data-id="${b.id}">＋ Item</button></div>${items.length?`<div class="list-card">${items.map(i=>`<button class="row" style="width:100%;background:white;border-left:0;border-right:0;border-top:0;text-align:left" data-action="edit-item" data-id="${i.id}"><div class="row-icon">${i.photo?`<img src="${i.photo}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:11px">`:'•'}</div><div class="row-main"><div class="row-title">${esc(i.name)}</div><div class="row-sub">${esc(i.category||'Uncategorized')}${i.fragile?' · Fragile':''}</div></div><span>›</span></button>`).join('')}</div>`:empty('📭','Box is empty','Add items as you pack them. Use the + Item button above.')}<div class="grid-2"><button class="soft-btn" data-action="edit-box" data-id="${b.id}">Edit box</button><button class="primary-btn" data-action="share-box" data-id="${b.id}">Share box</button></div></div>`);
  }

  function openLabel(id){
    const b=boxById(id); if(!b)return;
    const r=roomById(b.roomId); const code=boxCode(b);
    openSheet('Box label',`<div class="label-preview"><div class="label-code">${code}</div><div class="qr"><canvas id="qr-canvas" width="172" height="172"></canvas></div><div class="label-room">${esc(b.name)}</div><div class="label-meta">${esc(r?.name||'No room')} · ${itemsInBox(id).length} items${b.fragile?' · FRAGILE':''}${b.openFirst?' · OPEN FIRST':''}</div></div><div class="section grid-2"><button class="soft-btn" data-action="copy-box-code" data-id="${id}">Copy code</button><button class="primary-btn" data-action="print-label">Print label</button></div><div class="print-only"><div class="label-preview"><div class="label-code">${code}</div><div class="qr"><canvas id="qr-print" width="172" height="172"></canvas></div><div class="label-room">${esc(b.name)}</div><div class="label-meta">${esc(r?.name||'No room')} · ${itemsInBox(id).length} items${b.fragile?' · FRAGILE':''}${b.openFirst?' · OPEN FIRST':''}</div></div></div>`);
    setTimeout(()=>{drawQR(code,document.getElementById('qr-canvas'));drawQR(code,document.getElementById('qr-print'));},20);
  }

  async function compressImage(file){
    if(!file) return '';
    const data = await new Promise((resolve,reject)=>{const fr=new FileReader();fr.onload=()=>resolve(fr.result);fr.onerror=reject;fr.readAsDataURL(file);});
    const img=await new Promise((resolve,reject)=>{const im=new Image();im.onload=()=>resolve(im);im.onerror=reject;im.src=data;});
    const max=900, scale=Math.min(1,max/Math.max(img.width,img.height));
    const c=document.createElement('canvas');c.width=Math.round(img.width*scale);c.height=Math.round(img.height*scale);
    c.getContext('2d').drawImage(img,0,0,c.width,c.height);
    return c.toDataURL('image/webp',.72);
  }

  function download(name,content,type='application/octet-stream'){
    const blob=new Blob([content],{type});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1500);
  }
  function csvCell(v){const s=String(v??'');return /[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s;}

  // Compact, dependency-free QR Code generator for short ASCII box codes (QR Version 1-L).
  // The payload is intentionally the short Hako code (e.g. KITCH-001), keeping labels scannable offline.
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
    const code=data.concat(ecc), stream=[]; code.forEach(b=>pushTo(stream,b,8));
    const size=21,m=Array.from({length:size},()=>Array(size).fill(false)),fn=Array.from({length:size},()=>Array(size).fill(false));
    function setf(xx,yy,v){if(xx>=0&&yy>=0&&xx<size&&yy<size){m[yy][xx]=!!v;fn[yy][xx]=true;}}
    for(let i=0;i<size;i++){setf(6,i,i%2===0);setf(i,6,i%2===0);}
    [[3,3],[size-4,3],[3,size-4]].forEach(([cx,cy])=>{for(let dy=-4;dy<=4;dy++)for(let dx=-4;dx<=4;dx++){const dist=Math.max(Math.abs(dx),Math.abs(dy));setf(cx+dx,cy+dy,dist!==2&&dist!==4);}});
    function formatBits(mask){let data5=(1<<3)|mask, rem=data5; for(let i=0;i<10;i++)rem=(rem<<1)^(((rem>>>9)&1)?0x537:0); let bits15=((data5<<10)|rem)^0x5412; const gb=i=>(bits15>>>i)&1; for(let i=0;i<=5;i++)setf(8,i,gb(i));setf(8,7,gb(6));setf(8,8,gb(7));setf(7,8,gb(8));for(let i=9;i<15;i++)setf(14-i,8,gb(i));for(let i=0;i<8;i++)setf(size-1-i,8,gb(i));for(let i=8;i<15;i++)setf(8,size-15+i,gb(i));setf(8,size-8,true);}
    formatBits(0);
    let k=0,up=true; for(let right=size-1;right>=1;right-=2){if(right===6)right=5;for(let vert=0;vert<size;vert++){const y=up?size-1-vert:vert;for(let j=0;j<2;j++){const xx=right-j;if(!fn[y][xx]){let bit=k<stream.length?stream[k]:0;k++;if((xx+y)%2===0)bit^=1;m[y][xx]=!!bit;}}}up=!up;}
    formatBits(0); return m;
    function pushTo(arr,val,n){for(let i=n-1;i>=0;i--)arr.push((val>>>i)&1);}
  }
  function drawQR(text,canvas){
    if(!canvas)return; const mat=qrMatrix(text),ctx=canvas.getContext('2d'),quiet=4,total=mat.length+quiet*2,scale=canvas.width/total;ctx.imageSmoothingEnabled=false;ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.fillStyle='#221820';for(let y=0;y<mat.length;y++)for(let x=0;x<mat.length;x++)if(mat[y][x])ctx.fillRect(Math.floor((x+quiet)*scale),Math.floor((y+quiet)*scale),Math.ceil(scale),Math.ceil(scale));
  }

  document.addEventListener('input', e=>{
    if(e.target.id==='find-input'){
      state.ui.findQuery=e.target.value; save();
      const pos=e.target.selectionStart; render();
      requestAnimationFrame(()=>{const n=document.getElementById('find-input');if(n){n.focus();n.setSelectionRange(pos,pos);}});
    }
  });

  document.addEventListener('submit', async e=>{
    e.preventDefault(); const f=e.target, fd=new FormData(f);
    if(f.id==='project-form'){
      state.profile.name=String(fd.get('name')||'').trim(); state.project.name=String(fd.get('projectName')||'My Move').trim()||'My Move'; state.project.moveDate=fd.get('moveDate')||'';state.project.from=String(fd.get('from')||'').trim();state.project.to=String(fd.get('to')||'').trim();state.project.currency=fd.get('currency')||'PHP';state.project.units=fd.get('units')||'cm';state.hasOnboarded=true;closeModal();commit('Updated move setup');return;
    }
    if(f.id==='room-form'){
      const id=f.dataset.id; const obj={id:id||uid('room'),name:String(fd.get('name')).trim(),emoji:String(fd.get('emoji')||'🏠').trim()||'🏠',destination:String(fd.get('destination')||'').trim(),notes:String(fd.get('notes')||'').trim()}; if(id)Object.assign(roomById(id),obj);else state.rooms.push(obj);closeModal();commit(`${id?'Updated':'Added'} room “${obj.name}”`);return;
    }
    if(f.id==='box-form'){
      const id=f.dataset.id; const obj={id:id||uid('box'),name:String(fd.get('name')).trim(),roomId:fd.get('roomId')||'',type:fd.get('type')||'Box',status:fd.get('status')||'empty',notes:String(fd.get('notes')||'').trim(),fragile:fd.get('fragile')==='on',openFirst:fd.get('openFirst')==='on'}; if(id)Object.assign(boxById(id),obj);else state.boxes.push(obj);closeModal();commit(`${id?'Updated':'Added'} box “${obj.name}”`);return;
    }
    if(f.id==='item-form'){
      const id=f.dataset.id; let old=id?itemById(id):null; let photo=old?.photo||''; const file=document.getElementById('item-photo')?.files?.[0]; if(file){try{photo=await compressImage(file);}catch(_){toast('Could not process that photo.');}}
      const boxId=fd.get('boxId')||''; const obj={id:id||uid('item'),name:String(fd.get('name')).trim(),category:String(fd.get('category')||'').trim(),roomId:fd.get('roomId')||'',boxId,status:boxId?'packed':'loose',decision:fd.get('decision')||'',tags:String(fd.get('tags')||'').trim(),value:fd.get('value')||'',notes:String(fd.get('notes')||'').trim(),fragile:fd.get('fragile')==='on',essential:fd.get('essential')==='on',photo}; if(id)Object.assign(old,obj);else state.items.push(obj); if(boxId){const b=boxById(boxId);if(b&&b.status==='empty')b.status='packing';}closeModal();commit(`${id?'Updated':'Added'} item “${obj.name}”`);return;
    }
    if(f.id==='task-form'){
      const id=f.dataset.id,obj={id:id||uid('task'),title:String(fd.get('title')).trim(),due:fd.get('due')||'',category:fd.get('category')||'Other',notes:String(fd.get('notes')||'').trim(),done:fd.get('done')==='on'}; if(id)Object.assign(state.tasks.find(x=>x.id===id),obj);else state.tasks.push(obj);closeModal();commit(`${id?'Updated':'Added'} task “${obj.title}”`);return;
    }
    if(f.id==='expense-form'){
      const obj={id:uid('exp'),title:String(fd.get('title')).trim(),amount:Number(fd.get('amount')||0),category:fd.get('category')||'Other',notes:String(fd.get('notes')||'').trim(),at:nowISO()};state.expenses.push(obj);closeModal();commit(`Added expense “${obj.title}”`);return;
    }
    if(f.id==='supply-form'){
      const obj={id:uid('sup'),name:String(fd.get('name')).trim(),qty:Number(fd.get('qty')||1),unit:String(fd.get('unit')||'').trim(),cost:Number(fd.get('cost')||0),bought:false};state.supplies.push(obj);closeModal();commit(`Added supply “${obj.name}”`);return;
    }
  });

  document.addEventListener('click', async e=>{
    const tab=e.target.closest('[data-tab]'); if(tab){state.ui.tab=tab.dataset.tab;state.ui.tool=null;state.ui.roomFilter=null;save();render();haptic();return;}
    const tool=e.target.closest('[data-tool]'); if(tool){state.ui.tool=tool.dataset.tool;save();render();haptic();return;}
    const act=e.target.closest('[data-action]'); if(!act)return; const a=act.dataset.action,id=act.dataset.id,val=act.dataset.value;
    if(a==='close-modal'){ if(!e.target.closest('[data-sheet]')||act.closest('.sheet-head,.form-actions'))closeModal(); return; }
    if(a==='start-setup'){state.hasOnboarded=true;save();render();setTimeout(()=>openSetup(true),20);return;}
    if(a==='skip-setup'){state.hasOnboarded=true;commit('Started Hako');return;}
    if(a==='back-tool'){state.ui.tool=null;save();render();return;}
    if(a==='open-project'){openSetup(false);return;}
    if(a==='quick-add'){openSheet('Quick add',`<div class="tool-grid"><button class="tool-card" data-action="add-item"><span class="tool-icon">＋</span><h3>Item</h3><p>Add something you own</p></button><button class="tool-card" data-action="add-box"><span class="tool-icon">📦</span><h3>Box</h3><p>Create a container</p></button><button class="tool-card" data-action="add-room"><span class="tool-icon">🏠</span><h3>Room</h3><p>Add a space</p></button><button class="tool-card" data-action="add-task"><span class="tool-icon">✓</span><h3>Task</h3><p>Add a checklist item</p></button></div>`);return;}
    if(a==='add-room'){openRoomForm();return;} if(a==='edit-room'){openRoomForm(id);return;}
    if(a==='delete-room'){ if(confirm('Delete this room? Boxes and items will stay but become unassigned.')){state.boxes.forEach(b=>{if(b.roomId===id)b.roomId='';});state.items.forEach(i=>{if(i.roomId===id)i.roomId='';});state.rooms=state.rooms.filter(r=>r.id!==id);closeModal();commit('Deleted room');}return;}
    if(a==='filter-room'){state.ui.roomFilter=id;state.ui.tab='boxes';save();render();return;} if(a==='clear-room-filter'){state.ui.roomFilter=null;save();render();return;}
    if(a==='add-box'){openBoxForm();return;} if(a==='edit-box'){openBoxForm(id);return;}
    if(a==='delete-box'){if(confirm('Delete this box? Items inside will become loose items.')){state.items.forEach(i=>{if(i.boxId===id){i.boxId='';i.status='loose';}});state.boxes=state.boxes.filter(b=>b.id!==id);closeModal();commit('Deleted box');}return;}
    if(a==='box-detail'){openBoxDetail(id);return;} if(a==='box-label'){openLabel(id);return;}
    if(a==='add-item'){openItemForm();return;} if(a==='add-item-to-box'){openItemForm('',id);return;} if(a==='edit-item'){openItemForm(id);return;}
    if(a==='delete-item'){if(confirm('Delete this item?')){state.items=state.items.filter(i=>i.id!==id);closeModal();commit('Deleted item');}return;}
    if(a==='add-task'){openTaskForm();return;} if(a==='edit-task'){openTaskForm(id);return;} if(a==='toggle-task'){const t=state.tasks.find(x=>x.id===id);if(t){t.done=!t.done;commit(`${t.done?'Completed':'Reopened'} task “${t.title}”`);}return;}
    if(a==='delete-task'){if(confirm('Delete this task?')){state.tasks=state.tasks.filter(t=>t.id!==id);closeModal();commit('Deleted task');}return;}
    if(a==='decide'){const i=itemById(id);if(i){i.decision=val;commit(`Marked “${i.name}” as ${val}`);}return;}
    if(a==='set-box-status'){const b=boxById(id);if(b){b.status=val;state.items.filter(i=>i.boxId===id).forEach(i=>i.status=val==='unpacked'?'unpacked':val==='unloaded'?'unloaded':val==='loaded'?'loaded':'packed');commit(`${boxCode(b)} marked ${statusLabel(val).toLowerCase()}`);}return;}
    if(a==='add-expense'){openExpenseForm();return;} if(a==='delete-expense'){state.expenses=state.expenses.filter(x=>x.id!==id);commit('Deleted expense');return;}
    if(a==='add-supply'){openSupplyForm();return;} if(a==='toggle-supply'){const s=state.supplies.find(x=>x.id===id);if(s){s.bought=!s.bought;commit(`${s.bought?'Bought':'Reopened'} supply “${s.name}”`);}return;} if(a==='delete-supply'){state.supplies=state.supplies.filter(x=>x.id!==id);commit('Deleted supply');return;}
    if(a==='go-find'){state.ui.tab='find';state.ui.tool=null;save();render();return;} if(a==='go-boxes'){state.ui.tab='boxes';state.ui.tool=null;save();render();return;}
    if(a==='clear-searches'){state.recentSearches=[];save();render();return;}
    if(a==='copy-box-code'){const b=boxById(id);if(b){await navigator.clipboard?.writeText(boxCode(b));toast('Box code copied');}return;}
    if(a==='print-label'){window.print();return;}
    if(a==='share-box'){const b=boxById(id);if(!b)return;const lines=itemsInBox(id).map(i=>`• ${i.name}`).join('\n');const text=`${boxCode(b)} — ${b.name}\nRoom: ${roomById(b.roomId)?.name||'Unassigned'}\nStatus: ${statusLabel(b.status)}\n${lines}`;try{if(navigator.share)await navigator.share({title:`Hako ${boxCode(b)}`,text});else{await navigator.clipboard.writeText(text);toast('Box summary copied');}}catch(_){}return;}
    if(a==='export-json'){download(`hako-backup-${new Date().toISOString().slice(0,10)}.json`,JSON.stringify({...state,exportedAt:nowISO(),appVersion:APP_VERSION},null,2),'application/json');toast('Backup exported');return;}
    if(a==='export-csv'){const head=['Item','Category','Decision','Room','Box Code','Box','Status','Fragile','Essential','Value','Tags','Notes'];const rows=state.items.map(i=>{const b=boxById(i.boxId),r=roomById(i.roomId);return [i.name,i.category,i.decision,r?.name||'',b?boxCode(b):'',b?.name||'',i.status,i.fragile?'Yes':'No',i.essential?'Yes':'No',i.value,i.tags,i.notes];});download(`hako-inventory-${new Date().toISOString().slice(0,10)}.csv`,[head,...rows].map(r=>r.map(csvCell).join(',')).join('\n'),'text/csv');return;}
    if(a==='import-json'){document.getElementById('import-file')?.click();return;}
    if(a==='reset-app'){if(confirm('Erase every room, box, item, task, expense and setting from this device? This cannot be undone.')){localStorage.removeItem(STORAGE_KEY);state=structuredClone(DEFAULT);closeModal();render();}return;}
    if(a==='install'&&deferredInstallPrompt){deferredInstallPrompt.prompt();await deferredInstallPrompt.userChoice;deferredInstallPrompt=null;render();return;}
    if(a==='voice-search'){startVoiceSearch();return;}
  });

  document.addEventListener('change', e=>{
    if(e.target.id==='import-file'){
      const file=e.target.files?.[0];if(!file)return;const fr=new FileReader();fr.onload=()=>{try{const data=JSON.parse(fr.result);if(!data.project||!Array.isArray(data.rooms)||!Array.isArray(data.boxes)||!Array.isArray(data.items))throw new Error();state={...structuredClone(DEFAULT),...data,hasOnboarded:true,ui:{...DEFAULT.ui,...(data.ui||{}),tool:'backup'}};save();toast('Backup restored');render();}catch(_){toast('That file is not a valid Hako backup.');}};fr.readAsText(file);
    }
  });

  document.addEventListener('click',e=>{
    const bf=e.target.closest('[data-box-filter]');if(bf){state.ui.boxFilter=bf.dataset.boxFilter;save();render();}
    const tf=e.target.closest('[data-task-filter]');if(tf){state.ui.taskFilter=tf.dataset.taskFilter;save();render();}
    const rs=e.target.closest('[data-recent-search]');if(rs){state.ui.findQuery=rs.dataset.recentSearch;save();render();}
    const result=e.target.closest('[data-result-type]');if(result){
      const q=(state.ui.findQuery||'').trim();if(q){state.recentSearches=[q,...state.recentSearches.filter(x=>x.toLowerCase()!==q.toLowerCase())].slice(0,6);save();}
      if(result.dataset.resultType==='box')openBoxDetail(result.dataset.id);
      else if(result.dataset.resultType==='item')openItemForm(result.dataset.id);
      else if(result.dataset.resultType==='room'){state.ui.roomFilter=result.dataset.id;state.ui.tab='boxes';save();render();}
    }
  });

  function startVoiceSearch(){
    const SR=window.SpeechRecognition||window.webkitSpeechRecognition;if(!SR){toast('Voice search is not supported on this browser.');return;}const rec=new SR();rec.lang=navigator.language||'en-US';rec.interimResults=false;rec.maxAlternatives=1;rec.onresult=e=>{state.ui.findQuery=e.results[0][0].transcript;save();render();};rec.onerror=()=>toast('Could not hear that. Try typing instead.');rec.start();
  }

  render();
})();
