(function(){
function loadScript(src, cb){
  var s=document.createElement('script');
  s.src=src;
  s.onload=cb;
  s.onerror=function(){console.error('failed to load',src)};
  document.head.appendChild(s);
}
var CDN='https://cdn.jsdelivr.net/gh/hossamthapitelgharib/elan-scents@38fe8eec291e99dfc3797593ae281b451abe39d4/app.js';
loadScript(CDN, function(){
  window.playHeroVideo=function(){
    var v=document.getElementById('heroVideo');
    if(!v)return;
    v.muted=true;
    var p=v.play();
    if(p&&p.catch)p.catch(function(){});
  };
  window.hero=function(){
    var e=document.getElementById('hero');
    if(e){e.style.setProperty('--hc','#fff');e.style.setProperty('--hs','#4a2f0a99');}
    playHeroVideo();
  };
  try{playHeroVideo();}catch(e){}
  document.addEventListener('click',function(e){
    var b=e.target.closest('[data-bc]');
    if(b&&!+b.dataset.bc){setTimeout(playHeroVideo,50);}
  },true);
});
})();
