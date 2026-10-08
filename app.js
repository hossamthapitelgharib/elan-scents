(function(){
function loadScript(src, cb){
  var s=document.createElement('script');
  s.src=src;
  s.onload=cb;
  s.onerror=function(){console.error('failed to load',src)};
  document.head.appendChild(s);
}
function applyArtAndHero(){
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

  var imgs=window.__CARD_IMGS||{};
  function imgTag(src){return '<img src="'+src+'" alt="" loading="lazy">';}
  window.ART=Object.assign({}, typeof ART==='object'&&ART?ART:{}, {
    cats0:imgTag('/assets/cards/category-men.webp'),
    cats1:imgTag('/assets/cards/category-women.webp'),
    cats2:imgTag('/assets/cards/category-unisex.webp'),
    occ0:imgTag('/assets/cards/occasion-day.webp'),
    occ1:imgTag('/assets/cards/occasion-night.webp'),
    occ2:imgTag(imgs.occ2||'/assets/cards/occasion-work.webp'),
    occ3:imgTag(imgs.occ3||'/assets/cards/occasion-date.webp'),
    occ4:imgTag(imgs.occ4||'/assets/cards/occasion-gift.webp'),
    notes0:imgTag(imgs.notes0||'/assets/cards/note-amber.webp'),
    notes1:imgTag('/assets/cards/note-citrus.webp'),
    notes2:imgTag(imgs.notes2||'/assets/cards/note-woody.webp'),
    notes3:imgTag(imgs.notes3||'/assets/cards/note-oud.webp'),
    notes4:imgTag(imgs.notes4||'/assets/cards/note-cardamom.webp')
  });
  if(typeof render==='function'){
    try{render();}catch(e){}
  }
}
/* Local full app core */
loadScript('/app(1).js', function(){
  loadScript('/card-imgs.js', applyArtAndHero);
});
})();
