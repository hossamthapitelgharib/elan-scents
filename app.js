(function(){
function loadScript(src, cb){
  var s=document.createElement('script');
  s.src=src;
  s.onload=cb;
  s.onerror=function(){console.error('failed to load',src)};
  document.head.appendChild(s);
}
/* Full app with category card images from stable commit */
var CORE='https://cdn.jsdelivr.net/gh/hossamthapitelgharib/elan-scents@38fe8eec291e99dfc3797593ae281b451abe39d4/app.js';
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
    if(typeof _hero==='function')_hero();
    playHeroVideo();
  };
  try{playHeroVideo();}catch(e){}
  document.addEventListener('click',function(e){
    var b=e.target.closest('[data-bc]');
    if(b&&!+b.dataset.bc){setTimeout(playHeroVideo,50);}
  },true);
  /* Ensure ART map for grid/round cards if missing */
  if(typeof ART==='undefined'||!ART||!ART.cats0){
    window.ART={
      cats0:'<img src="/assets/cards/category-men.webp" alt="" loading="lazy">',
      cats1:'<img src="/assets/cards/category-women.webp" alt="" loading="lazy">',
      cats2:'<img src="/assets/cards/category-unisex.webp" alt="" loading="lazy">',
      occ0:'<img src="/assets/cards/occasion-day.webp" alt="" loading="lazy">',
      occ1:'<img src="/assets/cards/occasion-night.webp" alt="" loading="lazy">',
      notes0:'<img src="/assets/cards/note-citrus.webp" alt="" loading="lazy">',
      notes1:'<img src="/assets/cards/note-citrus.webp" alt="" loading="lazy">'
    };
  }
});
})();
