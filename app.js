(function(){
function loadScript(src, cb){
  var s=document.createElement('script');
  s.src=src;
  s.onload=cb;
  s.onerror=function(){console.error('failed to load',src)};
  document.head.appendChild(s);
}
function lockBodyScroll(lock){
  var body=document.body;
  if(!body)return;
  if(lock){
    if(body.classList.contains('sheet-open'))return;
    body.dataset.scrollY=String(window.scrollY||window.pageYOffset||0);
    body.classList.add('sheet-open');
    body.style.top='-'+body.dataset.scrollY+'px';
  }else{
    if(!body.classList.contains('sheet-open'))return;
    var y=parseInt(body.dataset.scrollY||'0',10)||0;
    body.classList.remove('sheet-open');
    body.style.top='';
    window.scrollTo(0,y);
  }
}
function watchSheet(){
  var sheet=document.getElementById('sheet'),menu=document.getElementById('menu');
  if(!sheet)return;
  var sync=function(){ lockBodyScroll(!sheet.hasAttribute('hidden')||!!(menu&&menu.classList.contains('open'))); };
  sync();
  try{ var mo=new MutationObserver(sync); mo.observe(sheet,{attributes:true,attributeFilter:['hidden','style','class']}); if(menu)mo.observe(menu,{attributes:true,attributeFilter:['class']}); }catch(e){}
  document.addEventListener('click',function(){ setTimeout(sync,0); setTimeout(sync,50); setTimeout(sync,200); },true);
}
function navGo(target){
  if(!target)return;
  if(typeof window.go==='function') window.go(target);
  else if(typeof go==='function') go(target);
}

/* ---------- Notes: full-page pager ---------- */
function layoutNotesPager(strip){
  var cards=Array.prototype.slice.call(strip.querySelectorAll('.card'));
  if(!cards.length)return;
  var idx=parseInt(strip.dataset.pageIndex||'0',10)||0;
  var n=cards.length;
  if(idx<0)idx=0; if(idx>=n)idx=n-1;
  strip.dataset.pageIndex=String(idx);
  cards.forEach(function(card,i){
    card.classList.remove('page-active','page-prev','page-next','page-dragging');
    card.style.transform=''; card.style.opacity='';
    if(i===idx) card.classList.add('page-active');
    else if(i===((idx-1+n)%n)) card.classList.add('page-prev');
    else card.classList.add('page-next');
  });
  var dots=strip.querySelectorAll('.pager-dots button');
  dots.forEach(function(d,i){
    d.classList.toggle('on',i===idx);
    d.setAttribute('aria-current',i===idx?'true':'false');
  });
}
function initNotesPager(){
  var sec=document.getElementById('notes');
  if(!sec)return;
  var strip=sec.querySelector('.strip');
  if(!strip)return;
  var cards=Array.prototype.slice.call(strip.querySelectorAll('.card'));
  if(cards.length<1)return;
  if(strip.classList.contains('card-pager')){ layoutNotesPager(strip); return; }
  strip.classList.add('card-pager');
  strip.classList.remove('card-stack');
  strip.dataset.pageIndex='0';
  var track=document.createElement('div'); track.className='pager-track';
  var viewport=document.createElement('div'); viewport.className='pager-viewport';
  cards.forEach(function(c){ viewport.appendChild(c); });
  track.appendChild(viewport);
  strip.insertBefore(track, strip.firstChild);
  var dots=document.createElement('div'); dots.className='pager-dots';
  dots.setAttribute('role','tablist');
  cards.forEach(function(_,i){
    var b=document.createElement('button'); b.type='button';
    b.addEventListener('click',function(e){ e.preventDefault(); e.stopPropagation(); strip.dataset.pageIndex=String(i); layoutNotesPager(strip); });
    dots.appendChild(b);
  });
  strip.appendChild(dots);
  var hint=document.createElement('div'); hint.className='pager-hint';
  hint.textContent=document.documentElement.lang==='en'?'Swipe · tap to open':'اسحب · اضغط للفتح';
  strip.appendChild(hint);
  var startX=0,dx=0,dragging=false,axisLocked=0,activeEl=null,didDrag=false;
  function goPage(delta){
    var n=cards.length; if(n<2)return;
    var idx=parseInt(strip.dataset.pageIndex||'0',10)||0;
    strip.dataset.pageIndex=String((idx+delta+n)%n);
    layoutNotesPager(strip);
  }
  strip.addEventListener('pointerdown',function(e){
    var c=e.target.closest('.card');
    if(!c||!c.classList.contains('page-active'))return;
    if(e.target.closest('.pager-dots'))return;
    dragging=true; axisLocked=0; dx=0; didDrag=false; startX=e.clientX; activeEl=c;
    c.classList.add('page-dragging');
    try{strip.setPointerCapture(e.pointerId);}catch(err){}
  });
  strip.addEventListener('pointermove',function(e){
    if(!dragging||!activeEl)return;
    var mx=e.clientX-startX, my=e.clientY-(e.clientY);
    if(!axisLocked){
      if(Math.abs(mx)<10)return;
      axisLocked=1;
    }
    didDrag=true; dx=mx;
    activeEl.style.transform='translateX('+dx+'px)';
    activeEl.style.opacity=String(Math.max(0.35,1-Math.abs(dx)/320));
  });
  function endDrag(){
    if(!activeEl)return;
    activeEl.classList.remove('page-dragging');
    activeEl.style.transform=''; activeEl.style.opacity='';
    if(Math.abs(dx)>60) goPage(dx<0?1:-1); else layoutNotesPager(strip);
    dragging=false; activeEl=null;
    setTimeout(function(){didDrag=false;},40);
  }
  strip.addEventListener('pointerup',endDrag);
  strip.addEventListener('pointercancel',endDrag);
  strip.addEventListener('click',function(e){ if(didDrag){e.preventDefault();e.stopPropagation();} },true);
  layoutNotesPager(strip);
}

/* ---------- Occasion: Fan / Deck Spread ---------- */
function layoutFanDeck(strip){
  var cards=Array.prototype.slice.call(strip.querySelectorAll('.card'));
  if(!cards.length)return;
  var n=cards.length;
  var focus=parseInt(strip.dataset.fanFocus||'-1',10);
  var mid=(n-1)/2;
  var maxAngle=Math.min(28,10+n*3);
  var step=n>1?(maxAngle*2)/(n-1):0;
  cards.forEach(function(card,i){
    var offset=i-mid;
    var angle=-maxAngle+i*step;
    if(n===1) angle=0;
    var x=offset*38, y=Math.abs(offset)*6, scale=0.88, z=10+i;
    if(focus===i){ angle=0; x=0; y=-18; scale=1.08; z=40; card.classList.add('fan-focus'); }
    else {
      card.classList.remove('fan-focus');
      if(focus>=0){ x=offset*48; scale=0.82; y=Math.abs(offset)*10+8; }
    }
    card.style.zIndex=String(z);
    card.style.transform='translate(-50%, -50%) translate('+x+'px,'+y+'px) rotate('+angle+'deg) scale('+scale+')';
    card.style.opacity=focus>=0&&focus!==i?'0.72':'1';
  });
  strip.classList.toggle('has-focus', focus>=0);
}
function initOccFanDeck(){
  var sec=document.getElementById('occ');
  if(!sec)return;
  var strip=sec.querySelector('.strip');
  if(!strip)return;
  var cards=Array.prototype.slice.call(strip.querySelectorAll('.card'));
  if(cards.length<1)return;
  if(strip.classList.contains('fan-deck')){ layoutFanDeck(strip); return; }
  strip.classList.add('fan-deck');
  strip.dataset.fanFocus='-1';
  cards.forEach(function(card){
    if(card.querySelector('.fan-fg'))return;
    var fg=document.createElement('div'); fg.className='fan-fg';
    Array.prototype.slice.call(card.childNodes).forEach(function(node){
      if(node.nodeType===1&&node.classList&&node.classList.contains('artbg'))return;
      fg.appendChild(node);
    });
    card.appendChild(fg);
  });
  var stage=document.createElement('div'); stage.className='fan-stage';
  cards.forEach(function(c){ stage.appendChild(c); });
  strip.insertBefore(stage, strip.firstChild);
  var hint=document.createElement('div'); hint.className='fan-hint';
  hint.textContent=document.documentElement.lang==='en'?'Tap a card · fan spread':'اضغط على كارت · مروحة';
  strip.appendChild(hint);
  var openBtn=document.createElement('button'); openBtn.type='button'; openBtn.className='fan-open-btn';
  openBtn.textContent=document.documentElement.lang==='en'?'Open':'فتح';
  strip.appendChild(openBtn);
  openBtn.addEventListener('click',function(e){
    e.preventDefault(); e.stopPropagation();
    var focus=parseInt(strip.dataset.fanFocus||'-1',10);
    if(focus<0||!cards[focus])return;
    navGo(cards[focus].getAttribute('data-go'));
  });
  cards.forEach(function(card,i){
    card.addEventListener('click',function(e){
      e.preventDefault(); e.stopPropagation();
      var cur=parseInt(strip.dataset.fanFocus||'-1',10);
      if(cur===i){ navGo(card.getAttribute('data-go')); return; }
      strip.dataset.fanFocus=String(i); layoutFanDeck(strip);
    },true);
  });
  var startX=0,dx=0,dragging=false;
  stage.addEventListener('pointerdown',function(e){
    if(e.target.closest('.fan-open-btn'))return;
    dragging=true; dx=0; startX=e.clientX;
    try{stage.setPointerCapture(e.pointerId);}catch(err){}
  });
  stage.addEventListener('pointermove',function(e){ if(dragging) dx=e.clientX-startX; });
  function endSwipe(){
    if(!dragging)return; dragging=false;
    if(Math.abs(dx)<50)return;
    var n=cards.length, cur=parseInt(strip.dataset.fanFocus||'-1',10);
    if(cur<0) cur=Math.floor(n/2);
    var next=dx<0?Math.min(n-1,cur+1):Math.max(0,cur-1);
    strip.dataset.fanFocus=String(next); layoutFanDeck(strip);
  }
  stage.addEventListener('pointerup',endSwipe);
  stage.addEventListener('pointercancel',endSwipe);
  strip.dataset.fanFocus=String(Math.floor(cards.length/2));
  layoutFanDeck(strip);
}

/* ---------- Categories: Cover Flow 3D ---------- */
function layoutCoverFlow(sec){
  var items=Array.prototype.slice.call(sec.querySelectorAll('.cf-stage .cb'));
  if(!items.length)return;
  var idx=parseInt(sec.dataset.cfIndex||'0',10)||0;
  var n=items.length;
  if(idx<0)idx=0; if(idx>=n)idx=n-1;
  sec.dataset.cfIndex=String(idx);
  items.forEach(function(el,i){
    var d=i-idx;
    el.classList.remove('cf-center','cf-side','cf-far');
    var x, rot, scale, z, opacity;
    if(d===0){
      el.classList.add('cf-center');
      x=0; rot=0; scale=1; z=20; opacity=1;
    }else if(Math.abs(d)===1){
      el.classList.add('cf-side');
      x=d*130; rot=d*-42; scale=0.78; z=10; opacity=0.85;
    }else{
      el.classList.add('cf-far');
      x=d*150; rot=d*-55; scale=0.62; z=2; opacity=0.3;
    }
    el.style.zIndex=String(z);
    el.style.opacity=String(opacity);
    el.style.transform='translate(-50%, -50%) translateX('+x+'px) rotateY('+rot+'deg) scale('+scale+')';
  });
  var dots=sec.querySelectorAll('.cf-dots button');
  dots.forEach(function(d,i){ d.classList.toggle('on',i===idx); });
}
function initCatsCoverFlow(){
  var sec=document.getElementById('cats');
  if(!sec)return;
  var blocks=Array.prototype.slice.call(sec.querySelectorAll('.cb'));
  if(blocks.length<1)return;
  if(sec.classList.contains('cover-flow-sec')){
    layoutCoverFlow(sec);
    return;
  }
  sec.classList.add('cover-flow-sec');
  sec.dataset.cfIndex='0';

  var stage=document.createElement('div');
  stage.className='cf-stage';
  blocks.forEach(function(b){ stage.appendChild(b); });
  // insert after h3/sub
  var sub=sec.querySelector('.sub');
  if(sub&&sub.nextSibling) sec.insertBefore(stage, sub.nextSibling);
  else sec.appendChild(stage);

  var dots=document.createElement('div');
  dots.className='cf-dots';
  blocks.forEach(function(_,i){
    var b=document.createElement('button'); b.type='button';
    b.addEventListener('click',function(e){
      e.preventDefault(); e.stopPropagation();
      sec.dataset.cfIndex=String(i);
      layoutCoverFlow(sec);
    });
    dots.appendChild(b);
  });
  stage.parentNode.insertBefore(dots, stage.nextSibling);

  var hint=document.createElement('div');
  hint.className='cf-hint';
  hint.textContent=document.documentElement.lang==='en'?'Swipe · Cover Flow':'اسحب · كفر فلو';
  dots.parentNode.insertBefore(hint, dots.nextSibling);

  // click center to open, side to focus
  stage.addEventListener('click',function(e){
    var cb=e.target.closest('.cb');
    if(!cb||!stage.contains(cb))return;
    e.preventDefault(); e.stopPropagation();
    var items=Array.prototype.slice.call(stage.querySelectorAll('.cb'));
    var i=items.indexOf(cb);
    if(i<0)return;
    var cur=parseInt(sec.dataset.cfIndex||'0',10)||0;
    if(i===cur){
      var card=cb.querySelector('.card[data-go]');
      if(card) navGo(card.getAttribute('data-go'));
    }else{
      sec.dataset.cfIndex=String(i);
      layoutCoverFlow(sec);
    }
  },true);

  // swipe
  var startX=0,dx=0,dragging=false;
  stage.addEventListener('pointerdown',function(e){
    dragging=true; dx=0; startX=e.clientX;
    try{stage.setPointerCapture(e.pointerId);}catch(err){}
  });
  stage.addEventListener('pointermove',function(e){ if(dragging) dx=e.clientX-startX; });
  function endSwipe(){
    if(!dragging)return; dragging=false;
    if(Math.abs(dx)<50)return;
    var n=blocks.length;
    var cur=parseInt(sec.dataset.cfIndex||'0',10)||0;
    var next=dx<0?Math.min(n-1,cur+1):Math.max(0,cur-1);
    sec.dataset.cfIndex=String(next);
    layoutCoverFlow(sec);
  }
  stage.addEventListener('pointerup',endSwipe);
  stage.addEventListener('pointercancel',endSwipe);

  layoutCoverFlow(sec);
}

function applyArtAndHero(){
  window.playHeroVideo=function(){
    var v=document.getElementById('heroVideo');
    if(!v)return;
    if(v.__elanHeroVisible===false||document.hidden){v.pause();return;}
    v.muted=true;
    var p=v.play();
    if(p&&p.catch)p.catch(function(){});
  };
  var _hero=window.hero;
  window.hero=function(){
    var e=document.getElementById('hero');
    var v=document.getElementById('heroVideo');
    if(e&&v){
      e.style.background='transparent';
      if(typeof _hero==='function'){
        try{
          var h=typeof HS!=='undefined'&&HS.length?HS[(typeof hi!=='undefined'?hi:0)%HS.length]:null;
          if(h){e.style.setProperty('--hc',h.c);e.style.setProperty('--hs',h.s);}
        }catch(err){}
      }
      playHeroVideo();
    }else if(typeof _hero==='function'){ _hero(); }
  };
  try{playHeroVideo();}catch(e){}
  document.addEventListener('click',function(e){
    var b=e.target.closest('[data-bc]');
    if(b&&!+b.dataset.bc){setTimeout(playHeroVideo,50);}
  },true);
  function imgTag(src){return '<img src="'+src+'" alt="" loading="lazy">';}
  function S(paths){return '<svg viewBox="0 0 200 140" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">'+paths+'</svg>';}
  window.ART=Object.assign({}, typeof ART==='object'&&ART?ART:{}, {
    cats0:imgTag('/assets/cards/category-men.webp'),
    cats1:imgTag('/assets/cards/category-women.webp'),
    cats2:imgTag('/assets/cards/category-unisex.webp'),
    occ0:imgTag('/assets/cards/occasion-day.webp'),
    occ1:imgTag('/assets/cards/occasion-night.webp'),
    occ2:S('<defs><linearGradient id="w" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3d5068"/><stop offset="1" stop-color="#141a24"/></linearGradient></defs><rect width="200" height="140" fill="url(#w)"/><rect y="95" width="200" height="45" fill="#3e3022"/><rect x="50" y="48" width="100" height="55" rx="4" fill="#1e2228"/><rect x="55" y="52" width="90" height="40" rx="2" fill="#5a88a8"/><rect x="155" y="78" width="22" height="18" rx="3" fill="#f0ece4"/>'),
    occ3:S('<defs><linearGradient id="d" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6a1a38"/><stop offset="1" stop-color="#1a0610"/></linearGradient></defs><rect width="200" height="140" fill="url(#d)"/><path d="M55 120 L65 55 L75 55 L85 120 Z" fill="#b03a52"/><ellipse cx="70" cy="122" rx="16" ry="6" fill="#9a2e44"/><rect x="68" y="120" width="4" height="18" fill="#d4c4a0"/><path d="M115 120 L125 55 L135 55 L145 120 Z" fill="#b03a52"/><ellipse cx="130" cy="122" rx="16" ry="6" fill="#9a2e44"/><rect x="128" y="120" width="4" height="18" fill="#d4c4a0"/><rect x="93" y="70" width="14" height="50" fill="#fff8e0"/><ellipse cx="100" cy="62" rx="6" ry="10" fill="#ffc040"/>'),
    occ4:S('<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f0d090"/><stop offset="1" stop-color="#b07a28"/></linearGradient></defs><rect width="200" height="140" fill="url(#g)"/><rect x="45" y="55" width="110" height="70" rx="6" fill="#b02438"/><rect x="92" y="55" width="16" height="70" fill="#e0c050"/><rect x="45" y="82" width="110" height="14" fill="#e0c050"/><ellipse cx="90" cy="42" rx="16" ry="12" fill="#e0c050"/><ellipse cx="110" cy="42" rx="16" ry="12" fill="#e0c050"/>'),
    notes0:S('<defs><linearGradient id="a" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c07020"/><stop offset="1" stop-color="#301404"/></linearGradient><linearGradient id="ad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffd060"/><stop offset="1" stop-color="#c87818"/></linearGradient></defs><rect width="200" height="140" fill="url(#a)"/><path d="M100 20 C130 50 145 75 145 95 C145 120 125 135 100 135 C75 135 55 120 55 95 C55 75 70 50 100 20Z" fill="url(#ad)"/><ellipse cx="100" cy="85" rx="28" ry="35" fill="#ffe090" opacity=".5"/>'),
    notes1:imgTag('/assets/cards/note-citrus.webp'),
    notes2:S('<defs><linearGradient id="wo" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8a5a30"/><stop offset="1" stop-color="#2a1808"/></linearGradient></defs><rect width="200" height="140" fill="url(#wo)"/><ellipse cx="100" cy="70" rx="55" ry="55" fill="none" stroke="#6a4220" stroke-width="6"/><ellipse cx="100" cy="70" rx="40" ry="40" fill="none" stroke="#5a3818" stroke-width="5"/><ellipse cx="100" cy="70" rx="25" ry="25" fill="none" stroke="#4a2c12" stroke-width="4"/><ellipse cx="100" cy="70" rx="12" ry="12" fill="#3a200c"/>'),
    notes3:S('<defs><linearGradient id="o" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a2010"/><stop offset="1" stop-color="#0c0604"/></linearGradient></defs><rect width="200" height="140" fill="url(#o)"/><rect x="30" y="50" width="50" height="14" rx="3" fill="#5a3820" transform="rotate(-12 55 57)"/><rect x="80" y="70" width="60" height="16" rx="3" fill="#6a4028" transform="rotate(8 110 78)"/><rect x="50" y="95" width="45" height="12" rx="3" fill="#4a2818" transform="rotate(-5 72 101)"/><rect x="110" y="40" width="55" height="15" rx="3" fill="#5a3018" transform="rotate(15 137 47)"/>'),
    notes4:S('<defs><linearGradient id="c" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#88b060"/><stop offset="1" stop-color="#2a5020"/></linearGradient></defs><rect width="200" height="140" fill="url(#c)"/><ellipse cx="70" cy="75" rx="22" ry="38" fill="#3a6828"/><ellipse cx="100" cy="60" rx="22" ry="38" fill="#448030"/><ellipse cx="130" cy="80" rx="22" ry="38" fill="#3a6828"/><ellipse cx="70" cy="70" rx="10" ry="14" fill="#b8d070"/><ellipse cx="100" cy="55" rx="10" ry="14" fill="#c0d880"/><ellipse cx="130" cy="75" rx="10" ry="14" fill="#b8d070"/>')
  });
  if(typeof render==='function'){
    var _elanRender=render;
    render=function(){
      _elanRender.apply(this,arguments);
      try{initNotesPager();}catch(err){}
      try{initOccFanDeck();}catch(err){}
      try{initCatsCoverFlow();}catch(err){}
    };
    try{render();}catch(e){}
  }
  watchSheet();
}
var CORE='/app-core.js?v=20261012-07';
loadScript(CORE, applyArtAndHero);
})();
