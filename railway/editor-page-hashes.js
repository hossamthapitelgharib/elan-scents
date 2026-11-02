/* Content-Security-Policy hashes of the inline scripts and event-handler attributes of the owner editor page.
   railway/editor-host.js computes them when it builds the page. The Cloudflare build (scripts/build-cloudflare.js) computes them once
   at build time, because a Worker on the free plan has only a few milliseconds of CPU per request and scanning the 200 KB page
   would use most of it. `digest` ties the stored result to the exact page it was computed from. */
const crypto = require('node:crypto');

function sha(text) { return "'sha256-" + crypto.createHash('sha256').update(text, 'utf8').digest('base64') + "'"; }
function digest(html) { return crypto.createHash('sha256').update(html, 'utf8').digest('base64'); }

/* Inline scripts before </head> and after it (the host adds one script right at </head>, so order matters), plus handler attributes. */
function scan(html) {
  const headEnd = html.indexOf('</head>');
  const headScripts = [];
  const bodyScripts = [];
  html.replace(/<script>([\s\S]*?)<\/script>/g, (match, code, offset) => { (headEnd !== -1 && offset < headEnd ? headScripts : bodyScripts).push(sha(code)); return ''; });
  const handlers = [];
  html.replace(/\son[a-z]+="([^"]*)"/g, (_, code) => { handlers.push(sha(code.replace(/&quot;/g, '"').replace(/&#39;/g, "'"))); return ''; });
  return { digest: digest(html), headScripts, bodyScripts, handlers };
}

module.exports = { sha, digest, scan };
