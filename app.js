(function(){
function loadScript(src, cb){
  var s=document.createElement('script');
  s.src=src;
  s.onload=cb;
  s.onerror=function(){console.error('failed to load',src)};
  document.head.appendChild(s);
}
/* Local full app core — category cards images + masterpieces + hero video overrides */
var CORE='/app(1).js';
loadScript(CORE, function(){
  window.playHeroVideo=function(){
    var v=document.getElementById('heroVideo');
    if(!v)return;
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
  /* ART map: real images for categories, day/night occasions, citrus note */
  window.ART=Object.assign({}, typeof ART==='object'&&ART?ART:{}, {
    cats0:'<img src="/assets/cards/category-men.webp" alt="" loading="lazy">',
    cats1:'<img src="/assets/cards/category-women.webp" alt="" loading="lazy">',
    cats2:'<img src="/assets/cards/category-unisex.webp" alt="" loading="lazy">',
    occ0:'<img src="/assets/cards/occasion-day.webp" alt="" loading="lazy">',
    occ1:'<img src="/assets/cards/occasion-night.webp" alt="" loading="lazy">',
    notes1:'<img src="/assets/cards/note-citrus.webp" alt="" loading="lazy">'
  });
  if(typeof render==='function'){
    try{render();}catch(e){}
  }
});
})();
