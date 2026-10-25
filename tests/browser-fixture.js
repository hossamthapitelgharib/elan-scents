'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ED = require('../design-schema.js');
const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));

class Style {
  constructor() { this.values = {}; }
  get cssText() { return Object.entries(this.values).map(([k, v]) => `${k}:${v}`).join(';'); }
  set cssText(text) {
    this.values = {};
    String(text || '').split(';').forEach((item) => { const p = item.indexOf(':'); if (p >= 0) this.values[item.slice(0, p).trim()] = item.slice(p + 1).trim(); });
  }
  setProperty(name, value) { this.values[name] = String(value); }
}
function style() {
  return new Proxy(new Style(), {
    get(target, name) { return name in target ? target[name] : target.values[String(name).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())] || ''; },
    set(target, name, value) { if (name in target) target[name] = value; else target.setProperty(String(name).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()), value); return true; }
  });
}
class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase(); this.nodeType = 1; this.attributes = {}; this.children = []; this.parentNode = null;
    this.style = style(); this.dataset = {}; this.listeners = {}; this._text = ''; this.value = ''; this.paused = true;
    this.classList = {
      contains: (c) => this.className.split(/\s+/).includes(c),
      add: (...items) => { this.className = [...new Set(this.className.split(/\s+/).filter(Boolean).concat(items))].join(' '); },
      remove: (...items) => { this.className = this.className.split(/\s+/).filter((c) => !items.includes(c)).join(' '); },
      toggle: (c) => { const add = !this.classList.contains(c); this.classList[add ? 'add' : 'remove'](c); return add; }
    };
  }
  get id() { return this.attributes.id || ''; } set id(v) { this.attributes.id = v; }
  get className() { return this.attributes.class || ''; } set className(v) { this.attributes.class = v; }
  get hidden() { return this.hasAttribute('hidden'); } set hidden(v) { v ? this.setAttribute('hidden', '') : this.removeAttribute('hidden'); }
  get parentElement() { return this.parentNode; }
  get firstElementChild() { return this.children.find((c) => c.tagName !== '#COMMENT') || null; }
  get firstChild() { return this.children[0] || null; } get lastChild() { return this.children.at(-1) || null; }
  get nextSibling() { return this.parentNode && this.parentNode.children[this.parentNode.children.indexOf(this) + 1] || null; }
  get childNodes() { return (this._text ? [Object.assign(new Element('span'), { textContent: this._text })] : []).concat(this.children); }
  get options() { return this.querySelectorAll('option'); }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(value) { this.children.forEach((c) => { c.parentNode = null; }); this.children = []; this._text = String(value); }
  get innerHTML() { return this.textContent; }
  set innerHTML(html) {
    this.replaceChildren(); const stack = [this];
    for (const token of String(html).match(/<[^>]*>|[^<]+/g) || []) {
      if (/^<\//.test(token)) { if (stack.length > 1) stack.pop(); }
      else if (/^<[a-z]/i.test(token)) {
        const tag = /^<([\w-]+)/.exec(token)[1]; const node = new Element(tag);
        const attrs = token.slice(tag.length + 1, -1);
        for (const m of attrs.matchAll(/([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) node.setAttribute(m[1], m[2] ?? m[3] ?? m[4] ?? '');
        stack.at(-1).appendChild(node);
        if (!/^(img|input|br|hr|source|meta|link)$/i.test(tag) && !/\/>$/.test(token)) stack.push(node);
      } else if (!/^<!/.test(token)) stack.at(-1)._text += token;
    }
  }
  setAttribute(name, value) { if (name === 'style') this.style.cssText = value; else this.attributes[name] = String(value); }
  getAttribute(name) { return name === 'style' ? this.style.cssText || null : this.attributes[name] ?? null; }
  hasAttribute(name) { return this.getAttribute(name) !== null; }
  removeAttribute(name) { if (name === 'style') this.style.cssText = ''; else delete this.attributes[name]; }
  appendChild(child) { if (child.parentNode) child.remove(); child.parentNode = this; this.children.push(child); return child; }
  append(...children) { children.forEach((c) => this.appendChild(typeof c === 'string' ? Object.assign(new Element('span'), { textContent: c }) : c)); }
  insertBefore(child, ref) { if (!ref) return this.appendChild(child); if (child.parentNode) child.remove(); child.parentNode = this; this.children.splice(this.children.indexOf(ref), 0, child); return child; }
  replaceChild(child, old) { if (child.parentNode) child.remove(); const at = this.children.indexOf(old); child.parentNode = this; this.children.splice(at, 1, child); old.parentNode = null; return old; }
  replaceChildren(...children) { this.textContent = ''; this.append(...children); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this); this.parentNode = null; }
  contains(node) { return this === node || this.children.some((c) => c.contains(node)); }
  matches(selector) {
    const parts = selector.trim().split(/\s+/); const last = parts.pop();
    const tag = /^[\w-]+/.exec(last); if (tag && this.tagName !== tag[0].toUpperCase()) return false;
    for (const m of last.matchAll(/([#.])([\w-]+)|\[([\w-]+)(?:=["']?([^"'\]]+)["']?)?\]/g)) {
      if (m[1] === '#' && this.id !== m[2]) return false;
      if (m[1] === '.' && !this.classList.contains(m[2])) return false;
      if (m[3] && (!this.hasAttribute(m[3]) || (m[4] && this.getAttribute(m[3]) !== m[4]))) return false;
    }
    if (!parts.length) return true;
    let parent = this.parentNode; while (parent) { if (parent.matches(parts.join(' '))) return true; parent = parent.parentNode; } return false;
  }
  querySelectorAll(selector) {
    const out = []; const selectors = selector.split(',').map((s) => s.trim());
    const visit = (node) => node.children.forEach((c) => { if (selectors.some((s) => c.matches(s))) out.push(c); visit(c); }); visit(this); return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return this.matches(selector) ? this : this.parentNode && this.parentNode.closest(selector); }
  addEventListener(name, fn, capture) { (this.listeners[name] ||= []).push({ fn, capture }); }
  click() {
    if (this.disabled) return;
    let stopped = false; const event = { preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() { stopped = true; } };
    let result;
    for (const listener of this.listeners.click || []) { result = listener.fn(event); if (stopped) return result; }
    return this.onclick && this.onclick(event) || result;
  }
  showModal() { this.open = true; }
  close() { this.open = false; (this.listeners.close || []).forEach(({ fn }) => fn()); }
  getBoundingClientRect() { return { left: 0, top: 0, right: 300, bottom: 200, width: 300, height: 200 }; }
  scrollIntoView() {} focus() {}
  pause() { this.paused = true; } play() { this.paused = false; return Promise.resolve(); }
}
function browser() {
  const html = new Element('html'); html.lang = 'ar'; const head = new Element('head'); const body = new Element('body'); html.append(head, body);
  body.innerHTML = read('index.html').split('<body>')[1].split('</body>')[0];
  const document = {
    documentElement: html, head, body, hidden: false, listeners: {},
    createElement: (tag) => new Element(tag), createComment: () => new Element('#comment'), getElementById: (id) => html.querySelector('#' + id),
    querySelector: (s) => html.querySelector(s), querySelectorAll: (s) => html.querySelectorAll(s),
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  };
  const window = { parent: {}, innerWidth: 1300, innerHeight: 900, scrollY: 180, listeners: {}, render() {}, view() {}, addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }, scrollTo() {} };
  const context = vm.createContext({ window, document, location: { origin: 'https://elan.example.test' }, console, URL, URLSearchParams, Map, Blob, Uint8Array,
    crypto: require('node:crypto').webcrypto, setTimeout() { return 0; }, clearTimeout() {}, setInterval() { return 0; }, clearInterval() {}, requestAnimationFrame() {},
    MutationObserver: class { observe() {} }, scrollTo() {}, getComputedStyle(node) { return { fontFamily: node.style.fontFamily || 'Tahoma', fontSize: node.style.fontSize || '16px', color: 'rgb(34, 34, 34)', backgroundColor: 'rgba(0, 0, 0, 0)', textAlign: 'right' }; },
    fetch: async () => ({ ok: false }), P: [], D: undefined, innerWidth: 1300, innerHeight: 900
  });
  window.ElanDesign = ED;
  return { document, window, context, run: (code) => vm.runInContext(code, context), add(tag, id, parent = body) { const e = new Element(tag); e.id = id; parent.append(e); return e; } };
}
function designBrowser() {
  const b = browser(); b.run(read('design-layer.js')); b.layer = b.window.ElanDesignLayer; return b;
}
async function editBrowser() {
  const b = designBrowser(); let bridge;
  b.window.ElanHostBridge = { install(options) { bridge = options; return { dirty() {}, selection() {}, context() {}, revision() {} }; } };
  b.context.fetch = async (url) => {
    if (url === '/api/editor?action=state') return { ok: true, json: async () => ({ ok: true, design: { version: 1 }, revision: 'initial' }) };
    if (url === '/api/editor-session') return { ok: true };
    throw new Error('Unexpected network in editor test: ' + url);
  };
  b.run(read('edit-mode.js')); await bridge.getState(); b.mode = b.window.ElanEditMode; b.bridge = bridge; return b;
}
function liveUI() {
  const b = browser(); const calls = [];
  for (const id of ['font', 'size', 'color', 'bg', 'align', 'format', 'apply', 'undo', 'redo', 'save', 'library']) b.add(id === 'format' ? 'dialog' : id === 'font' ? 'select' : 'button', id);
  const font = b.document.getElementById('font'); const option = new Element('option'); option.value = 'Tahoma'; font.append(option);
  Object.assign(b.context, { menu: b.document.getElementById('menu'), liveFrame: new Element('iframe'), liveMode: true, selectedLive: null, effectSelect: { value: 'none' },
    fontDefinitions: [['fonts', ED.FONTS]], bridgeReady: true, bridgeRevision: 'initial', bridgeDirty: false,
    async requestLive(action, payload) { calls.push([action, plain(payload || {})]); if (action === 'library.open') return { openLibrary: true }; return { archive: [{ id: 'hero', name: 'الواجهة' }] }; }, markBridge() {}, saveLive() {}
  });
  b.context.action = (label, callback, enabled) => { const e = new Element('button'); e.textContent = label; e.disabled = !enabled; e.onclick = callback; b.context.menu.append(e); };
  const source = read('editor/elan-editor.html');
  b.run(source.split('\n').find((line) => line.startsWith('async function runLive(')));
  b.run(source.slice(source.indexOf('/* The original right-click menu'), source.indexOf("window.addEventListener('blur'")));
  return { ...b, calls };
}
module.exports = { Element, browser, designBrowser, editBrowser, liveUI, plain, read };
