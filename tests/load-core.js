const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.join(__dirname, '..');
function loadCoreSource() {
  const local = fs.readFileSync(path.join(root, 'app-core.js'), 'utf8');
  const pin = local.match(/raw\.githubusercontent\.com\/hossamthapitelgharib\/elan-scents\/([0-9a-f]{40})\/app-core\.js/);
  if (!pin) return local;
  const url = 'https://raw.githubusercontent.com/hossamthapitelgharib/elan-scents/' + pin[1] + '/app-core.js';
  return execFileSync('curl', ['-sL', url], { encoding: 'utf8', maxBuffer: 5 * 1024 * 1024 });
}
module.exports = { loadCoreSource, root };
