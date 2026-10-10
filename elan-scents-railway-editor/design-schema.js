/* Élan Scents — design file schema (design/home.json).
   One source of truth used by the storefront layer (browser) and the editor API (Node).
   The design file only ever holds layout/text/media references. It never holds prices, stock or customer data. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ElanDesign = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = 1;
  var BUILTIN = ['brands', 'offers', 'new', 'cats', 'master', 'occ', 'notes', 'soon', 'stores'];
  var TEXT_KEYS = ['magic', 'view', 'explore', 'contactT', 'send'];
  var TYPES = ['text', 'banner', 'image'];
  var SIZES = ['sm', 'md', 'lg', 'xl'];
  var ALIGNS = ['start', 'center', 'end'];
  var LIMITS = { bytes: 200000, blocks: 60, order: 100, text: 600, title: 160, url: 500 };
  var MEDIA_PREFIXES = [
    '/assets/',
    'https://sbgdtuqfrnfeggkwqtrw.supabase.co/storage/v1/object/public/site-media/'
  ];
  var BLOCK_ID_RE = /^x-[a-z0-9_-]{1,36}$/;
  var COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
  var HREF_RE = /^(?:\/(?!\/)|#|https:\/\/)[^\s"'<>\\]*$/;
  var LANGS = ['ar', 'en'];

  function isObj(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }
  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  function str(v, max) {
    if (typeof v !== 'string') return '';
    return v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
  }

  function loc(v, max) {
    var out = {};
    if (!isObj(v)) return out;
    LANGS.forEach(function (l) {
      var s = str(v[l], max);
      if (s) out[l] = s;
    });
    return out;
  }

  function mediaUrl(v) {
    if (typeof v !== 'string' || v.length > LIMITS.url || /[\s"'<>\\]/.test(v) || v.indexOf('..') !== -1) return '';
    for (var i = 0; i < MEDIA_PREFIXES.length; i++) if (v.indexOf(MEDIA_PREFIXES[i]) === 0 && v.length > MEDIA_PREFIXES[i].length) return v;
    return '';
  }

  function hrefUrl(v) {
    if (typeof v !== 'string' || v.length > LIMITS.url) return '';
    return HREF_RE.test(v) ? v : '';
  }

  function oneOf(v, list, dflt) { return list.indexOf(v) !== -1 ? v : dflt; }

  function blockOf(raw, errors, idx) {
    var where = 'blocks[' + idx + ']';
    if (!isObj(raw)) { errors.push(where + ': not an object'); return null; }
    var id = typeof raw.id === 'string' ? raw.id : '';
    if (!BLOCK_ID_RE.test(id)) { errors.push(where + ': invalid id'); return null; }
    var type = raw.type;
    if (TYPES.indexOf(type) === -1) { errors.push(where + ': invalid type'); return null; }
    var b = { id: id, type: type };
    var style = {};
    var rs = isObj(raw.style) ? raw.style : {};
    style.align = oneOf(rs.align, ALIGNS, 'center');
    style.size = oneOf(rs.size, SIZES, 'md');
    if (typeof rs.color === 'string') {
      if (COLOR_RE.test(rs.color)) style.color = rs.color; else errors.push(where + ': invalid color');
    }
    if (typeof rs.background === 'string') {
      if (COLOR_RE.test(rs.background)) style.background = rs.background; else errors.push(where + ': invalid background');
    }
    b.style = style;
    if (type === 'text') {
      b.text = loc(raw.text, LIMITS.text);
      if (!b.text.ar && !b.text.en) { errors.push(where + ': empty text'); return null; }
    } else if (type === 'banner') {
      b.title = loc(raw.title, LIMITS.title);
      b.subtitle = loc(raw.subtitle, LIMITS.text);
      if (raw.image !== undefined && raw.image !== '') {
        var img = mediaUrl(raw.image);
        if (img) b.image = img; else errors.push(where + ': image not allowed');
      }
      if (raw.href !== undefined && raw.href !== '') {
        var h = hrefUrl(raw.href);
        if (h) b.href = h; else errors.push(where + ': link not allowed');
      }
      if (!b.title.ar && !b.title.en && !b.image) { errors.push(where + ': banner needs a title or an image'); return null; }
    } else {
      var src = mediaUrl(raw.src);
      if (!src) { errors.push(where + ': image src not allowed'); return null; }
      b.src = src;
      b.alt = loc(raw.alt, LIMITS.title);
      if (raw.href !== undefined && raw.href !== '') {
        var h2 = hrefUrl(raw.href);
        if (h2) b.href = h2; else errors.push(where + ': link not allowed');
      }
    }
    return b;
  }

  /* normalize(input, {strict}) -> {ok, design, errors}
     Strict mode (server): any problem makes ok=false so nothing invalid is ever committed.
     Lenient mode (storefront): invalid parts are skipped so the page never breaks. */
  function normalize(input, opts) {
    var strict = !!(opts && opts.strict);
    var errors = [];
    var design = { version: VERSION, sections: {}, order: [], blocks: [], texts: {} };
    if (!isObj(input)) return { ok: false, design: design, errors: ['design must be an object'] };
    if (input.version !== VERSION) errors.push('unsupported version');

    if (isObj(input.sections)) {
      Object.keys(input.sections).forEach(function (id) {
        if (BUILTIN.indexOf(id) === -1) { errors.push('sections.' + id + ': unknown section'); return; }
        var e = input.sections[id];
        if (!isObj(e)) { errors.push('sections.' + id + ': not an object'); return; }
        var out = {};
        if (e.hidden === true) out.hidden = true;
        var t = loc(e.title, LIMITS.title);
        if (t.ar || t.en) out.title = t;
        if (out.hidden || out.title) design.sections[id] = out;
      });
    } else if (input.sections !== undefined) errors.push('sections must be an object');

    var seen = {};
    if (Array.isArray(input.blocks)) {
      if (input.blocks.length > LIMITS.blocks) errors.push('too many blocks');
      input.blocks.slice(0, LIMITS.blocks).forEach(function (raw, i) {
        var b = blockOf(raw, errors, i);
        if (!b) return;
        if (seen[b.id]) { errors.push('blocks[' + i + ']: duplicate id'); return; }
        seen[b.id] = true;
        design.blocks.push(b);
      });
    } else if (input.blocks !== undefined) errors.push('blocks must be an array');

    if (Array.isArray(input.order)) {
      if (input.order.length > LIMITS.order) errors.push('order too long');
      var inOrder = {};
      input.order.slice(0, LIMITS.order).forEach(function (id) {
        if (typeof id !== 'string' || (BUILTIN.indexOf(id) === -1 && !seen[id])) { errors.push('order: unknown id'); return; }
        if (inOrder[id]) { errors.push('order: duplicate id'); return; }
        inOrder[id] = true;
        design.order.push(id);
      });
    } else if (input.order !== undefined) errors.push('order must be an array');

    if (isObj(input.texts)) {
      LANGS.forEach(function (l) {
        if (!isObj(input.texts[l])) return;
        var out = {};
        Object.keys(input.texts[l]).forEach(function (k) {
          if (TEXT_KEYS.indexOf(k) === -1) { errors.push('texts.' + l + '.' + k + ': key not editable'); return; }
          var s = str(input.texts[l][k], LIMITS.title);
          if (s) out[k] = s;
        });
        if (Object.keys(out).length) design.texts[l] = out;
      });
    } else if (input.texts !== undefined) errors.push('texts must be an object');

    var ok = isObj(input) && input.version === VERSION && (!strict || errors.length === 0);
    return { ok: ok, design: design, errors: errors };
  }

  function isEmpty(design) {
    return !design || (!Object.keys(design.sections || {}).length && !(design.blocks || []).length &&
      !(design.order || []).length && !Object.keys(design.texts || {}).length);
  }

  /* Canonical text that gets committed. Throws if it would be unsafe to commit. */
  function serialize(design) {
    var n = normalize(design, { strict: true });
    if (!n.ok) throw new Error('invalid design: ' + n.errors.slice(0, 3).join('; '));
    var text = JSON.stringify(n.design, null, 2) + '\n';
    if (text.length > LIMITS.bytes) throw new Error('design too large');
    return text;
  }

  /* plan(): pure description of what the storefront layer must do. */
  function plan(design, presentIds, lang) {
    var l = lang === 'en' ? 'en' : 'ar';
    var out = { hide: [], titles: {}, blocks: [], order: [] };
    if (isEmpty(design)) return out;
    Object.keys(design.sections || {}).forEach(function (id) {
      if (presentIds.indexOf(id) === -1) return;
      var e = design.sections[id];
      if (e.hidden) out.hide.push(id);
      var t = e.title && (e.title[l] || e.title.ar || e.title.en);
      if (t) out.titles[id] = t;
    });
    out.blocks = (design.blocks || []).slice();
    var blockIds = out.blocks.map(function (b) { return b.id; });
    var all = presentIds.concat(blockIds);
    var seq = [];
    (design.order || []).forEach(function (id) { if (all.indexOf(id) !== -1 && seq.indexOf(id) === -1) seq.push(id); });
    all.forEach(function (id) { if (seq.indexOf(id) === -1) seq.push(id); });
    out.order = seq;
    return out;
  }

  function applyTexts(texts, design) {
    var n = 0;
    if (!texts || !design || !design.texts) return n;
    LANGS.forEach(function (l) {
      if (!design.texts[l] || !isObj(texts[l])) return;
      Object.keys(design.texts[l]).forEach(function (k) {
        if (TEXT_KEYS.indexOf(k) !== -1) { texts[l][k] = design.texts[l][k]; n++; }
      });
    });
    return n;
  }

  return {
    VERSION: VERSION, BUILTIN: BUILTIN, TEXT_KEYS: TEXT_KEYS, LIMITS: LIMITS,
    normalize: normalize, isEmpty: isEmpty, serialize: serialize, plan: plan, applyTexts: applyTexts
  };
});
