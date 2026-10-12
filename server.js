/* Compatibility entrypoint: Railway's server is the single authoritative HTTP server. */
const server = require('./railway/server.js');

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  server.listen(port, () => console.log('elan-scents listening on ' + port));
}

module.exports = server;
