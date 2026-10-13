/* Élan editor — Railway host for api/editor.js (no framework, no dependencies).
   The browser never talks to this address directly: vercel.json rewrites /api/editor here,
   so the page, the login token and the editor all stay on the same origin. */
const http = require('http');
const editor = require('./api/editor.js');

const PORT = Number(process.env.PORT) || 3000;
const MAX_BYTES = 400000;

function wrap(res) {
  res.status = function (code) { this.statusCode = code; return this; };
  res.json = function (body) {
    const text = JSON.stringify(body);
    if (!this.getHeader('Content-Type')) this.setHeader('Content-Type', 'application/json');
    this.end(text);
    return this;
  };
  return res;
}

const server = http.createServer(function (req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (url.pathname !== '/api/editor') { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{"ok":false,"error":"not_found"}'); }

  const chunks = []; let size = 0; let tooBig = false;
  req.on('data', function (c) { size += c.length; if (size > MAX_BYTES) { tooBig = true; return; } chunks.push(c); });
  req.on('end', function () {
    wrap(res);
    if (tooBig) return res.status(413).json({ ok: false, error: 'invalid_request' });
    req.query = Object.fromEntries(url.searchParams);
    req.body = chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined;
    Promise.resolve(editor(req, res)).catch(function () {
      if (!res.headersSent) res.status(500).json({ ok: false, error: 'editor_failed' });
    });
  });
});

server.listen(PORT, function () { console.log('elan-editor listening on ' + PORT); });
