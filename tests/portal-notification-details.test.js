const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createPortal() {
  const count = { textContent: '', hidden: true };
  const list = { innerHTML: '' };
  const wrap = { querySelector(selector) { return selector === '[data-notification-count]' ? count : list; } };
  const document = {
    querySelector(selector) { return selector === '#portalNotifications' ? wrap : null; },
    addEventListener() {},
    body: {}
  };
  const context = {
    document, localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    location: { reload() {} }, fetch: async () => {}, setTimeout, clearTimeout, setInterval, clearInterval,
    URL, console, Date
  };
  context.window = context;
  context.addEventListener = () => {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'portal.js'), 'utf8'), context);
  return { Portal: context.Portal, list, count };
}

test('order notification details escape customer and item text before inserting HTML', () => {
  const { Portal, list } = createPortal();
  Portal.notifications.items = [{
    id: 'notification-1', title: 'طلب جديد', body: 'رسالة <img src=x>', is_read: false, created_at: '2026-11-02T18:00:00Z',
    order: {
      trackingNumber: 'ELN-20261102-123456', checkoutTrackingNumber: 'ELN-20261102-123456', subtotal: 1250, currency: 'EGP', itemCount: 1,
      store: { name: 'متجر' }, customer: { name: '<script>alert(1)</script>', phone: '0100', email: 'a@example.test', address: 'شارع <b>', notes: 'ملاحظة' },
      items: [{ productName: '<svg onload=alert(1)>', brandName: 'علامة', size: '50 مل', quantity: 1, unitPrice: 1250, lineTotal: 1250 }]
    }
  }];
  Portal.renderNotifications();
  assert.match(list.innerHTML, /<details class="notification-order-details">/);
  assert.match(list.innerHTML, /ELN-20261102-123456/);
  assert.match(list.innerHTML, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(list.innerHTML, /&lt;svg onload=alert\(1\)&gt;/);
  assert.equal(list.innerHTML.includes('<script>'), false);
  assert.equal(list.innerHTML.includes('<svg'), false);
  assert.equal(list.innerHTML.includes('<img src=x>'), false);
});
