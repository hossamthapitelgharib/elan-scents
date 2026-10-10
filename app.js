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
  var sync=function(){
    lockBodyScroll(!sheet.hasAttribute('hidden'));
  };
  sync();
  try{
    var mo=new MutationObserver(sync);
    mo.observe(sheet,{attributes:true,attributeFilter:['hidden','style','class']});
  }catch(e){}
  // also catch programmatic toggles via clicks on cart/fav/notif buttons
  document.addEventListener('click',function(){
    setTimeout(sync,0);
    setTimeout(sync,50);
    setTimeout(sync,200);
  },true);
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
    }else if(typeof _hero==='function'){
      _hero();
    }
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
  if(typeof render==='function'){try{render();}catch(e){}}
  watchSheet();
}
var CORE='/app-core.js?v=20261009-11';
loadScript(CORE, applyArtAndHero);
})();
