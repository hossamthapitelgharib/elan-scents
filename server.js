/* Compatibility entrypoint for the local Node.js test server. */
const server = require('./backend/server.js');

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  server.listen(port, () => console.log('elan-scents listening on ' + port));
}

module.exports = server;
