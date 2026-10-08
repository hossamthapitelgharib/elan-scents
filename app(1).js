/* Élan Scents app core — loaded from stable release; UI overrides live in /app.js */
(function(){
  var s=document.createElement('script');
  s.src='https://cdn.jsdelivr.net/gh/hossamthapitelgharib/elan-scents@38fe8eec291e99dfc3797593ae281b451abe39d4/app.js';
  s.onerror=function(){console.error('failed to load app core');};
  document.head.appendChild(s);
})();
