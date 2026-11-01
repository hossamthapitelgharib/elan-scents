'use strict';
/* Preloaded into the test server only: any request to a host outside this machine fails at once,
   so a browser test can never reach the live Supabase project, GitHub or anything else. */
const realFetch = global.fetch;
global.fetch = function (input, init) {
  const url = new URL(typeof input === 'string' ? input : input.url || String(input));
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return realFetch(input, init);
  return Promise.reject(new TypeError('offline in browser tests: ' + url.hostname));
};
