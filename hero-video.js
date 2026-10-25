(function(){
  var v=document.getElementById('heroVideo');
  if(!v)return;
  var hero=document.getElementById('hero');
  var header=document.querySelector('header');
  v.__elanHeroVisible=true;
  v.muted=true;
  v.defaultMuted=true;
  v.autoplay=true;
  v.loop=true;
  v.playsInline=true;
  v.setAttribute('muted','');
  v.setAttribute('playsinline','');
  v.setAttribute('webkit-playsinline','');
  var pauseRetries=0,retryTimer=0;
  function tryPlay(){
    if(v.__elanHeroVisible===false||document.hidden){v.pause();return;}
    v.muted=true;
    var p;
    try{p=v.play();}catch(e){return;}
    if(p&&p.catch)p.catch(function(){});
  }
  // The video plays while the header is still over the hero. Once the hero's lower edge has scrolled up to the
  // header's lower edge the video stops, and it plays again as soon as the header is back above the hero's end.
  function headerPassedHero(){
    if(!hero)return false;
    var heroEnd=hero.getBoundingClientRect().bottom;
    var headerEnd=header?header.getBoundingClientRect().bottom:0;
    return heroEnd<=headerEnd;
  }
  function syncHero(){
    var visible=!headerPassedHero();
    if(visible===v.__elanHeroVisible)return;
    v.__elanHeroVisible=visible;
    if(visible){pauseRetries=0;tryPlay();}
    else{clearTimeout(retryTimer);v.pause();}
  }
  window.addEventListener('scroll',syncHero,{passive:true});
  window.addEventListener('resize',syncHero);
  window.addEventListener('orientationchange',syncHero);
  window.addEventListener('load',syncHero);
  // Some browsers pause muted autoplay on their own (power saving, tab restore); resume while the hero is in view.
  v.addEventListener('pause',function(){
    if(v.ended||v.__elanHeroVisible===false||document.hidden||pauseRetries>=10)return;
    pauseRetries++;
    clearTimeout(retryTimer);
    retryTimer=setTimeout(tryPlay,250);
  });
  // Safety net for engines that ignore the loop attribute.
  v.addEventListener('ended',function(){try{v.currentTime=0}catch(e){}tryPlay();});
  v.addEventListener('stalled',function(){if(v.paused)tryPlay();});
  v.addEventListener('suspend',function(){if(v.paused)tryPlay();});
  v.addEventListener('loadedmetadata',tryPlay);
  v.addEventListener('loadeddata',tryPlay);
  v.addEventListener('canplay',tryPlay);
  v.addEventListener('canplaythrough',tryPlay);
  document.addEventListener('visibilitychange',function(){if(document.hidden)v.pause();else{pauseRetries=0;syncHero();tryPlay();}});
  window.addEventListener('pageshow',function(){pauseRetries=0;syncHero();tryPlay();});
  // iOS Low Power Mode and strict autoplay policies need one real gesture; touchend/pointerup/keydown count as activation.
  ['touchend','pointerup','click','keydown'].forEach(function(name){document.addEventListener(name,function(){tryPlay();},{once:true,passive:true,capture:true});});
  syncHero();
  tryPlay();
  setTimeout(tryPlay,300);
  setTimeout(tryPlay,1000);
  setTimeout(tryPlay,2500);
})();
