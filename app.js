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
  var sheet=document.getElementById('sheet');
  if(!sheet)return;
  var sync=function(){ lockBodyScroll(!sheet.hasAttribute('hidden')); };
  sync();
  try{ var mo=new MutationObserver(sync); mo.observe(sheet,{attributes:true,attributeFilter:['hidden','style','class']}); }catch(e){}
  document.addEventListener('click',function(){ setTimeout(sync,0); setTimeout(sync,50); setTimeout(sync,200); },true);
}
function layoutNotesStack(strip){
  var cards=Array.prototype.slice.call(strip.querySelectorAll('.card'));
  if(!cards.length)return;
  var idx=parseInt(strip.dataset.stackIndex||'0',10)||0;
  var n=cards.length;
  cards.forEach(function(card,i){
    var order=(i-idx+n)%n;
    card.classList.toggle('stack-front',order===0);
    card.style.zIndex=String(30-order);
    card.style.pointerEvents=order===0?'auto':'none';
    if(order===0){ card.style.transform='translate(-50%, 0) scale(1)'; card.style.opacity='1'; }
    else if(order===1){ card.style.transform='translate(-50%, 14px) scale(0.94)'; card.style.opacity='0.9'; }
    else if(order===2){ card.style.transform='translate(-50%, 26px) scale(0.88)'; card.style.opacity='0.72'; }
    else { card.style.transform='translate(-50%, 34px) scale(0.84)'; card.style.opacity='0'; }
  });
  var ds=strip.querySelectorAll('.stack-dots i');
  ds.forEach(function(d,i){ d.classList.toggle('on',i===idx); });
}
function initNotesSwipeStack(){
  var sec=document.getElementById('notes');
  if(!sec)return;
  var strip=sec.querySelector('.strip');
  if(!strip)return;
  var cards=Array.prototype.slice.call(strip.querySelectorAll('.card'));
  if(cards.length<2)return;
  if(!strip.classList.contains('card-stack')){
    strip.classList.add('card-stack');
    strip.dataset.stackIndex='0';
    var dots=document.createElement('div'); dots.className='stack-dots';
    cards.forEach(function(){ dots.appendChild(document.createElement('i')); });
    var hint=document.createElement('div'); hint.className='stack-hint';
    hint.textContent=(document.documentElement.lang==='en')?'Swipe \u00b7 tap to open':'\u0627\u0633\u062d\u0628 \u00b7 \u0627\u0636\u063a\u0637 \u0644\u0644\u0641\u062a\u062d';
    strip.appendChild(dots); strip.appendChild(hint);
    var startX=0,startY=0,dx=0,dragging=false,axisLocked=0,frontEl=null,didDrag=false;
    strip.addEventListener('pointerdown',function(e){
      var c=e.target.closest('.card');
      if(!c||!c.classList.contains('stack-front'))return;
      dragging=true;axisLocked=0;dx=0;didDrag=false;startX=e.clientX;startY=e.clientY;frontEl=c;
      c.classList.add('stack-dragging');
      try{strip.setPointerCapture(e.pointerId);}catch(err){}
    });
    strip.addEventListener('pointermove',function(e){
      if(!dragging||!frontEl)return;
      var mx=e.clientX-startX,my=e.clientY-startY;
      if(!axisLocked){
        if(Math.abs(mx)+Math.abs(my)<10)return;
        axisLocked=Math.abs(mx)>Math.abs(my)?1:-1;
        if(axisLocked<0){dragging=false;frontEl.classList.remove('stack-dragging');frontEl.style.transform='';frontEl=null;return;}
      }
      didDrag=true;dx=mx;
      frontEl.style.transform='translate(calc(-50% + '+dx+'px), 0) rotate('+(dx*0.045)+'deg)';
      frontEl.style.opacity=String(Math.max(0.4,1-Math.abs(dx)/260));
    });
    function endDrag(){
      if(!frontEl)return;
      var el=frontEl;
      el.classList.remove('stack-dragging');
      if(Math.abs(dx)>70){
        var n=cards.length;
        var idx=parseInt(strip.dataset.stackIndex||'0',10)||0;
        idx=dx<0?(idx+1)%n:(idx-1+n)%n;
        strip.dataset.stackIndex=String(idx);
      }
      el.style.transform=''; el.style.opacity='';
      layoutNotesStack(strip);
      dragging=false;axisLocked=0;frontEl=null;
      setTimeout(function(){didDrag=false;},30);
    }
    strip.addEventListener('pointerup',endDrag);
    strip.addEventListener('pointercancel',endDrag);
    strip.addEventListener('click',function(e){ if(didDrag){e.preventDefault();e.stopPropagation();} },true);
  }
  layoutNotesStack(strip);
}
function applyArtAndHero(){
  if(typeof ART==='undefined')return;
  Object.assign(ART,{
    men:imgTag('/assets/cards/category-men.webp'),
    women:imgTag('/assets/cards/category-women.webp'),
    uni:imgTag('/assets/cards/category-unisex.webp'),
    master:imgTag('/assets/cards/masterpieces.webp'),
    day:imgTag('/assets/cards/occasion-day.webp'),
    night:imgTag('/assets/cards/occasion-night.webp'),
    notes1:imgTag('/assets/cards/note-citrus.webp'),
    notes2:S('<defs><linearGradient id="wo" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8a5a30"/><stop offset="1" stop-color="#2a1808"/></linearGradient></defs><rect width="200" height="140" fill="url(#wo)"/><ellipse cx="100" cy="70" rx="55" ry="55" fill="none" stroke="#6a4220" stroke-width="6"/><ellipse cx="100" cy="70" rx="40" ry="40" fill="none" stroke="#5a3818" stroke-width="5"/><ellipse cx="100" cy="70" rx="25" ry="25" fill="none" stroke="#4a2c12" stroke-width="4"/><ellipse cx="100" cy="70" rx="12" ry="12" fill="#3a200c"/>'),
    notes3:S('<defs><linearGradient id="o" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a2010"/><stop offset="1" stop-color="#0c0604"/></linearGradient></defs><rect width="200" height="140" fill="url(#o)"/><rect x="30" y="50" width="50" height="14" rx="3" fill="#5a3820" transform="rotate(-12 55 57)"/><rect x="80" y="70" width="60" height="16" rx="3" fill="#6a4028" transform="rotate(8 110 78)"/><rect x="50" y="95" width="45" height="12" rx="3" fill="#4a2818" transform="rotate(-5 72 101)"/><rect x="110" y="40" width="55" height="15" rx="3" fill="#5a3018" transform="rotate(15 137 47)"/>'),
    notes4:S('<defs><linearGradient id="c" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#88b060"/><stop offset="1" stop-color="#2a5020"/></linearGradient></defs><rect width="200" height="140" fill="url(#c)"/><ellipse cx="70" cy="75" rx="22" ry="38" fill="#3a6828"/><ellipse cx="100" cy="60" rx="22" ry="38" fill="#448030"/><ellipse cx="130" cy="80" rx="22" ry="38" fill="#3a6828"/><ellipse cx="70" cy="70" rx="10" ry="14" fill="#b8d070"/><ellipse cx="100" cy="55" rx="10" ry="14" fill="#c0d880"/><ellipse cx="130" cy="75" rx="10" ry="14" fill="#b8d070"/>')
  });
  if(typeof render==='function'){
    var _elanRender=render;
    render=function(){ _elanRender.apply(this,arguments); try{initNotesSwipeStack();}catch(err){} };
    try{render();}catch(e){}
  }
  watchSheet();
}
var CORE='/app-core.js?v=20261011-12';
loadScript(CORE, applyArtAndHero);
})();
