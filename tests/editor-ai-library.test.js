const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('the library AI box needs an explicit cost confirmation and never reaches the provider, the key or the page', () => {
  const ui = read('editor/editor-live-library.js');
  const bridge = read('editor/editor-data-bridge.js');
  assert.match(ui, /dataset\.aiBox/);
  assert.match(ui, /const aiState = document\.createElement\('span'\)/, 'a <span>: the dialog note is located with dialog.querySelector("small")');
  assert.match(ui, /aiConfirm\.checked/);
  assert.match(ui, /generateImage\(prompt, \{ confirmCost: true \}\)/);
  assert.match(ui, /status\.configured !== true/);
  assert.match(ui, /status\.remaining > 0/);
  assert.doesNotMatch(ui, /OPENAI|api\.openai\.com|Bearer|sk-/);
  assert.doesNotMatch(ui, /innerHTML|insertAdjacentHTML/);
  assert.doesNotMatch(ui, /saveLive\s*\(|publishLive\s*\(|page\.save/, 'a generated image only lands in the library; saving stays an explicit owner action');
  assert.match(bridge, /options\.confirmCost !== true\) throw Error\('cost_confirmation_required'\)/);
  assert.match(bridge, /call\('ai\.generate'/);
  assert.match(bridge, /call\('ai\.status'\)/);
  assert.doesNotMatch(bridge, /OPENAI|api\.openai\.com|Bearer|sk-/);
});

test('only the server talks to the image service, with a key taken from the environment and never logged', () => {
  const ai = read('railway/editor-ai.js');
  const data = read('railway/editor-data.js');
  assert.match(ai, /https:\/\/api\.openai\.com\/v1\/images\/generations/);
  assert.match(ai, /process\.env/);
  assert.match(ai, /OPENAI_API_KEY/);
  assert.doesNotMatch(ai, /console\./);
  assert.match(data, /action === 'ai\.status'/);
  assert.match(data, /action === 'ai\.generate' && req\.method === 'POST'/);
  for (const file of ['edit-mode.js', 'edit-panels.js', 'design-layer.js', 'index.html', 'editor/editor-data-bridge.js', 'editor/editor-live-library.js']) {
    if (fs.existsSync(path.join(__dirname, '..', file))) assert.doesNotMatch(read(file), /api\.openai\.com|OPENAI_API_KEY/, file + ' must not know about the provider or its key');
  }
});
