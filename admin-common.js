/* The admin panel (platform-dashboard.html) is ONE document: a shell and several pages that share this global scope. This file loads first and holds
   what the pages share, so no page script declares its own copy (two classic scripts that declare the same top-level const throw, and
   two that declare the same function silently replace each other):
   - escP / numberP / dateP / errorTextP / $   small helpers;
   - AdminPages    how a page script hands its loader to the shell:  AdminPages.register('customers', { load: loadCustomersDashboard });
   - AdminAttention  one-line "needs your attention" items any page (or the alert centre) can set, read by the overview page.
   A page script never touches the sign-in box or the navigation: the shell owns #login, #app, #logout, #refresh and #message. */

function errorTextP(error, fallback) {
  return typeof Portal !== 'undefined' && typeof Portal.errorText === 'function' ? Portal.errorText(error, fallback) : (error && error.message) || fallback;
}
function escP(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[character]));
}
function numberP(value) { return Math.max(0, Number(value) || 0).toLocaleString('ar-EG'); }
function dateP(value) {
  if (value === null || value === undefined || value === '') return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('ar-EG');
}
function $(selector) { return document.querySelector(selector); }

const AdminPages = (() => {
  const modules = {};
  return {
    /* spec: { load(): Promise|void, refresh?(): Promise|void }. `load` runs the first time a page of the module is opened; `refresh` (or `load` again)
       when the admin presses the refresh button. */
    register(key, spec) { if (key && spec && typeof spec.load === 'function') modules[key] = spec; return spec; },
    get(key) { return modules[key] || null; },
    keys() { return Object.keys(modules); }
  };
})();

const AdminAttention = (() => {
  const items = new Map();
  const listeners = [];
  const emit = () => { const list = AdminAttention.list(); listeners.forEach(callback => { try { callback(list); } catch (_) {} }); };
  return {
    /* item: { count, text, href, tone } with `text` already a sentence; a count of 0 removes the item. */
    set(key, item) {
      const count = Number(item && item.count) || 0;
      if (count > 0) items.set(key, { key, count, text: String(item.text || ''), href: String(item.href || ''), tone: item.tone || 'info', order: Number(item.order) || 50 });
      else items.delete(key);
      emit();
    },
    list() { return [...items.values()].sort((a, b) => a.order - b.order); },
    onChange(callback) { if (typeof callback === 'function') listeners.push(callback); }
  };
})();
