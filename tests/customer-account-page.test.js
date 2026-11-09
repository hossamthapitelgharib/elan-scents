/* «حسابي»: the page where the customer's name, mobile, address, delivery address and optional recipient are written once and reused
   by every later order (table public.customer_details, migration 20261106211851_customer_account_details).
   The real functions from app-core.js run in a small VM; the real browser walk-through is journey 15 in tests/browser. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const core = read('app-core.js');
const css = read('style-3.css');
const oneLine = (start) => { const i = core.indexOf(start); assert.ok(i >= 0, start); return core.slice(i, core.indexOf('\n', i)); };
const START = '/* ===== «حسابي»', END = '/* ===== end of «حسابي» ===== */';
const block = core.slice(core.indexOf(START), core.indexOf(END) + END.length);

function harness({ lang = 'ar', auth = { access_token: 'tok-1', user: { id: 'user-1', email: 'buyer@example.invalid', user_metadata: { full_name: 'أحمد' } } }, responses = [] } = {}) {
  const sheetBody = { innerHTML: '' }, sheetEl = { hidden: true, dataset: {} };
  const fetches = [], toasts = [], timers = [], listeners = {};
  const document = {
    getElementById: (id) => (id === 'sheet' ? sheetEl : id === 'sheetB' ? sheetBody : id === 'menu' ? { classList: { remove() {} } } : null),
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    body: { classList: { add() {}, remove() {} } }
  };
  const context = vm.createContext({ document, window: {}, lang, AUTH: auth, console, Object, Promise, Math, Number, String, JSON, RegExp, Array, Error, isFinite, encodeURIComponent, TypeError,
    SB: { url: 'https://project.example.invalid', key: 'anon-key' }, LB: { ar: { notin: 'أنت غير مسجّل الدخول حاليًا' }, en: { notin: 'You are not signed in' } },
    PENDING_STORE: '', toast: (m) => toasts.push(m), sheet: () => {}, closeSheet: () => { sheetEl.hidden = true; },
    showOrderForm: (s) => { context.__order = s; },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: () => {},
    fetch: async (url, init) => { fetches.push({ url: String(url), init: init || {} }); const r = responses.shift() || { status: 200, body: [] }; return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body }; } });
  vm.runInContext([oneLine('function esc('), oneLine('function authUserId'), oneLine('function authHeaders'), block].join('\n'), context);
  return { context, sheetBody, sheetEl, fetches, toasts, timers, listeners, run: (src) => vm.runInContext(src, context) };
}

const form = (values) => ({ elements: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, k === 'ship_same' ? { checked: v } : { value: v }])), dataset: {} });
const valid = { full_name: 'أحمد محمد علي حسن', phone: '010 1234 5678', governorate: 'القاهرة', city: 'الدقي', address: 'شارع التحرير', building_no: '12', floor_no: '3', apartment_no: '5', address_lat: '', address_lng: '', ship_same: true,
  recipient_name: '', recipient_phone: '', delivery_notes: '' };

test('a mobile number is accepted only as an Egyptian mobile, whatever digits and prefix the customer types', () => {
  const { run } = harness();
  const good = { '01012345678': '01012345678', '010 1234 5678': '01012345678', '+20 101 234 5678': '01012345678', '0020 1012345678': '01012345678', '201012345678': '01012345678',
    '٠١٠١٢٣٤٥٦٧٨': '01012345678', '۰۱۰۱۲۳۴۵۶۷۸': '01012345678', '010-1234-5678': '01012345678', '(010) 1234 5678': '01012345678', '01112345678': '01112345678', '01212345678': '01212345678', '01512345678': '01512345678' };
  for (const [typed, saved] of Object.entries(good)) assert.equal(run(`normPhone(${JSON.stringify(typed)})`), saved, typed);
  for (const bad of ['', '1012345678', '01312345678', '0101234567', '010123456789', '0225753000', 'abc', '+971501234567']) assert.equal(run(`normPhone(${JSON.stringify(bad)})`), '', bad);
});

test('the name must have four parts; the form says so before anything is sent', () => {
  const h = harness(), u = h.run('ACCT_UI.ar');
  const r = h.context.acctRead(form({ ...valid, full_name: 'أحمد محمد علي' }), u);
  assert.equal(r.field, 'full_name'); assert.equal(r.error, u.eName);
  assert.equal(h.context.acctRead(form({ ...valid, full_name: '  أحمد   محمد  علي   حسن  ' }), u).row.full_name, 'أحمد محمد علي حسن', 'extra spaces are tidied');
  assert.equal(h.run('nameParts("  a  b c ").length'), 3);
});

test('every wrong or missing field is named, with its own message', () => {
  const h = harness(), u = h.run('ACCT_UI.ar'), read = (patch) => h.context.acctRead(form({ ...valid, ...patch }), u);
  assert.deepEqual([read({ phone: '123' }).field, read({ phone: '123' }).error], ['phone', u.ePhone]);
  assert.deepEqual([read({ governorate: '' }).field, read({ governorate: '' }).error], ['governorate', u.eGov]);
  assert.equal(read({ governorate: 'مدينة وهمية' }).field, 'governorate', 'only a real governorate is accepted');
  assert.deepEqual([read({ city: '' }).field, read({ city: '' }).error], ['city', u.eCity]);
  assert.deepEqual([read({ address: 'abc' }).field, read({ address: 'abc' }).error], ['address', u.eAddr]);
  assert.deepEqual([read({ building_no: '  ' }).field, read({ building_no: '  ' }).error], ['building_no', u.eBld]);
  assert.ok(read({ floor_no: '', apartment_no: '' }).row, 'the floor and the flat are optional (a house has neither)');
  const sh = { ship_same: false, ship_governorate: 'الجيزة', ship_city: 'المعادي', ship_address: '5 شارع النيل', ship_building_no: '5' };
  assert.deepEqual([read({ ...sh, ship_governorate: '' }).field], ['ship_governorate']);
  assert.deepEqual([read({ ...sh, ship_city: '' }).field, read({ ...sh, ship_city: '' }).error], ['ship_city', u.eShipCity]);
  assert.deepEqual([read({ ...sh, ship_address: 'x' }).field], ['ship_address']);
  assert.deepEqual([read({ ...sh, ship_building_no: '' }).field, read({ ...sh, ship_building_no: '' }).error], ['ship_building_no', u.eShipBld]);
  assert.ok(read(sh).row, 'a complete delivery address passes');
  assert.deepEqual([read({ recipient_name: 'م' }).field], ['recipient_name']);
  assert.deepEqual([read({ recipient_phone: '12' }).field, read({ recipient_phone: '12' }).error], ['recipient_phone', u.eRPhone]);
  assert.ok(read({}).row, 'the valid sample passes');
});

test('the row sent is the customer\'s own: phone tidied, a half point dropped, delivery copied by the database when the address is the same', () => {
  const h = harness(), u = h.run('ACCT_UI.ar');
  const same = h.context.acctRead(form({ ...valid, address_lat: '30.0381', address_lng: '' }), u).row;
  assert.equal(same.user_id, 'user-1');
  assert.equal(same.phone, '01012345678');
  assert.equal(same.address_lat, null); assert.equal(same.address_lng, null, 'a latitude without a longitude is not saved');
  assert.equal(same.ship_same, true);
  for (const k of ['ship_address', 'ship_governorate', 'ship_city', 'ship_building_no', 'ship_floor_no', 'ship_apartment_no', 'ship_lat', 'ship_lng']) assert.equal(k in same, false, k + ' is left to the database trigger');
  assert.deepEqual([same.city, same.address, same.building_no, same.floor_no, same.apartment_no], ['الدقي', 'شارع التحرير', '12', '3', '5'], 'the home address is sent in its parts');
  assert.deepEqual([h.context.acctRead(form({ ...valid, floor_no: ' ', apartment_no: '' }), u).row.floor_no, h.context.acctRead(form({ ...valid, apartment_no: '' }), u).row.apartment_no], [null, null], 'an empty floor or flat is sent as null');
  assert.equal(same.recipient_name, null); assert.equal(same.recipient_phone, null); assert.equal(same.delivery_notes, null);

  const other = h.context.acctRead(form({ ...valid, address_lat: '30.0381', address_lng: '31.2101', ship_same: false, ship_governorate: 'الجيزة', ship_city: ' المعادي  الجديدة ', ship_address: ' 5 شارع النيل، المعادي ', ship_building_no: '7 ب', ship_floor_no: '2', ship_apartment_no: '',
    ship_lat: '29.96', ship_lng: '31.25', recipient_name: 'منى سيد', recipient_phone: '+20 111 222 3334', delivery_notes: 'اتصل قبل الوصول' }), u).row;
  assert.equal(other.address_lat, 30.0381); assert.equal(other.address_lng, 31.2101);
  assert.deepEqual([other.ship_same, other.ship_governorate, other.ship_address, other.ship_lat, other.ship_lng], [false, 'الجيزة', '5 شارع النيل، المعادي', 29.96, 31.25]);
  assert.deepEqual([other.ship_city, other.ship_building_no, other.ship_floor_no, other.ship_apartment_no], ['المعادي الجديدة', '7 ب', '2', null]);
  assert.deepEqual([other.recipient_name, other.recipient_phone, other.delivery_notes], ['منى سيد', '01112223334', 'اتصل قبل الوصول']);
});

test('the address that comes back from the map lookup is short, in order, and the governorate is matched to the list', () => {
  const { run } = harness();
  const d = { display_name: 'x', address: { house_number: '12', road: 'شارع التحرير', suburb: 'الدقي', city_district: 'الدقي', city: 'الجيزة', state: 'محافظة الجيزة', country: 'مصر', postcode: '12311' } };
  run('var D1=' + JSON.stringify(d));
  assert.equal(run('acctPickAddress(D1).text'), 'شارع التحرير', 'the street only: the city and the building have their own fields, no country or postcode');
  assert.equal(run('acctPickAddress(D1).city'), 'الدقي', 'the city is the governorate\'s own name only when nothing smaller is known: here the district is used');
  assert.equal(run('acctPickAddress(D1).building'), '12');
  assert.equal(run('acctPickAddress(D1).gov'), 'الجيزة');
  assert.equal(run('acctMatchGov("محافظة القاهرة")'), 'القاهرة');
  assert.equal(run('acctMatchGov("الاسكندرية")'), 'الإسكندرية', 'hamza and spelling variants');
  assert.equal(run('acctMatchGov("Alexandria Governorate")'), 'الإسكندرية');
  assert.equal(run('acctMatchGov("Kafr El Sheikh")'), 'كفر الشيخ');
  assert.equal(run('acctMatchGov("Dubai")'), '');
  assert.equal(run('acctPickAddress({display_name:"Tahrir Square, Cairo, Egypt, 11511"}).text'), 'Tahrir Square, Cairo, Egypt');
  assert.equal(run('acctPickAddress(null).text'), '');
  assert.equal(run('acctPickAddress(null).city'), '');
  run('var D3=' + JSON.stringify({ address: { house_number: 'x'.repeat(30), road: 'شارع النصر', state: 'محافظة القاهرة', city: 'القاهرة' } }));
  assert.equal(run('acctPickAddress(D3).building'), '', 'a house number that is not a number of a building is not copied');
  assert.equal(run('acctPickAddress(D3).city'), '', 'a city that is only the governorate again is not copied');
  assert.equal(run('acctPickAddress(D3).text'), 'شارع النصر');
  run('var D4=' + JSON.stringify({ address: { road: 'شارع الهرم', city: 'الجيزة', city_district: 'قسم الهرم', state: 'محافظة الجيزة' } }));
  assert.equal(run('acctPickAddress(D4).city'), 'قسم الهرم');
  assert.equal(run('acctPickAddress(D4).text'), 'شارع الهرم');
  assert.equal(run('GOVS.length'), 27, 'the 27 governorates');
});

test('the page shows the saved values escaped, the e-mail read-only, and a map only where a point is saved', () => {
  const { run } = harness();
  const trap = '"><img src=x onerror=alert(1)>';
  run('var ROW=' + JSON.stringify({ full_name: trap, phone: '01012345678', governorate: 'القاهرة', address: trap, city: trap, building_no: trap, floor_no: trap, apartment_no: trap, address_lat: 30.0381, address_lng: 31.2101, ship_same: true,
    recipient_name: trap, recipient_phone: '01112223334', delivery_notes: trap }));
  const html = run('acctHTML(ROW,"",false)');
  assert.doesNotMatch(html, /<img src=x/i, 'nothing a customer typed becomes a tag');
  assert.match(html, /name="full_name"[^>]*value="&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;"/);
  assert.match(html, /name="email" type="email" readonly[^>]*value="buyer@example\.invalid"/, 'the e-mail is the account\'s, read-only');
  assert.match(html, /<option value="القاهرة" selected>/);
  assert.match(html, /name="ship_same" checked/);
  assert.match(html, /class="acct-ship" hidden/, 'the delivery block is closed while the address is the same');
  assert.match(html, /src="https:\/\/www\.google\.com\/maps\?q=30\.0381,31\.2101&amp;z=17&amp;output=embed"/, 'the saved point is shown on Google Maps');
  // The map is only shown. A tap on the embedded map used to hand the customer to the Google Maps app, and he could not get back to the page.
  assert.match(html, /<iframe title="[^"]*" loading="lazy" tabindex="-1" sandbox="allow-scripts allow-same-origin" src=/, 'sandboxed: no popup, no navigation of the page');
  assert.doesNotMatch(html.slice(html.indexOf('data-map')), /<a [^>]*href=[^>]*maps/, 'no link out to Google Maps from the page');
  assert.match(css, /\.acct-map iframe\{[^}]*pointer-events:none/, 'nothing in the frame can be tapped');
  assert.doesNotMatch(html, /اكتب بياناتك مرة واحدة/, 'no explanatory sentence on the card (owner, 7 Nov)');
  assert.doesNotMatch(css, /acct-lead/);
  for (const n of ['city', 'building_no', 'floor_no', 'apartment_no', 'ship_city', 'ship_building_no', 'ship_floor_no', 'ship_apartment_no']) assert.match(html, new RegExp('name="' + n + '"'), n + ' has its own field');
  assert.equal((html.match(/class="acct-row3"/g) || []).length, 2, 'building, floor and flat sit in one row for the address and for the delivery address');
  assert.match(css, /\.acct-row3\{[^}]*repeat\(3/);
  assert.equal((html.match(/data-acct-locate/g) || []).length, 2, 'one "find my location" button for the address and one for the delivery address');
  assert.equal((html.match(/<div class="acct-map" data-map hidden>/g) || []).length, 1, 'the delivery map stays hidden until a point exists');
  assert.doesNotMatch(html, /data-back-cart/, 'opened from the menu there is no way back to a cart');
  assert.match(run('acctHTML(ROW,"Afnan Egypt",false)'), /data-back-cart/);
  assert.match(run('acctHTML(ROW,"Afnan Egypt",false)'), /data-next="Afnan Egypt"/);
});

test('a new customer sees an empty form with the name he gave when he signed up, and a failed load says so', () => {
  const { run } = harness();
  const html = run('acctHTML(null,"",false)');
  assert.match(html, /name="full_name"[^>]*value="أحمد"/, 'the signup name is only a starting point');
  assert.match(html, /name="ship_same" checked/, 'the delivery address starts as the same address');
  assert.doesNotMatch(html, /<iframe[^>]*src=/, 'no map before a location is chosen');
  assert.doesNotMatch(html, /order-error" role="alert">/);
  assert.match(run('acctHTML(null,"",true)'), /class="order-error" role="alert">تعذر تحميل بياناتك المحفوظة/);
});

test('what the order form gets from «حسابي»: the delivery details, the map link, and the buyer when someone else receives', () => {
  const h = harness();
  assert.deepEqual(JSON.parse(JSON.stringify(h.run('acctOrderPrefill()'))), { name: '', phone: '', email: 'buyer@example.invalid', address: '', notes: '' }, 'nothing saved yet');
  h.run('ACCT_UID="user-1";ACCT=' + JSON.stringify({ full_name: 'أحمد محمد علي حسن', phone: '01012345678', governorate: 'القاهرة', address: '12 شارع التحرير', address_lat: 30.0381, address_lng: 31.2101,
    ship_same: true, ship_governorate: 'القاهرة', ship_address: '12 شارع التحرير', ship_lat: 30.0381, ship_lng: 31.2101, recipient_name: null, recipient_phone: null, delivery_notes: 'الدور الثالث' }));
  assert.deepEqual(JSON.parse(JSON.stringify(h.run('acctOrderPrefill()'))), { name: 'أحمد محمد علي حسن', phone: '01012345678', email: 'buyer@example.invalid',
    address: 'القاهرة، 12 شارع التحرير\nhttps://www.google.com/maps?q=30.0381,31.2101', notes: 'الدور الثالث' });
  h.run('ACCT.ship_city="مدينة نصر";ACCT.ship_building_no="12";ACCT.ship_floor_no="3";ACCT.ship_apartment_no="5"');
  assert.equal(h.run('acctOrderPrefill().address'), 'القاهرة، مدينة نصر، 12 شارع التحرير، مبنى 12، الدور 3، شقة 5\nhttps://www.google.com/maps?q=30.0381,31.2101', 'the courier reads the line in order: governorate, city, street, building, floor, flat');
  h.run('ACCT.ship_city="القاهرة";ACCT.ship_floor_no="";ACCT.ship_apartment_no="";ACCT.ship_building_no=""');
  assert.equal(h.run('acctOrderPrefill().address.split("\\n")[0]'), 'القاهرة، 12 شارع التحرير', 'a part equal to another is said once; empty parts are left out');
  h.run('ACCT.ship_city=null;ACCT.ship_building_no=null;ACCT.ship_floor_no=null;ACCT.ship_apartment_no=null');
  h.run('ACCT.ship_same=false;ACCT.ship_governorate="الجيزة";ACCT.ship_address="5 شارع النيل";ACCT.ship_lat=null;ACCT.ship_lng=null;ACCT.recipient_name="منى سيد";ACCT.recipient_phone="01112223334"');
  assert.deepEqual(JSON.parse(JSON.stringify(h.run('acctOrderPrefill()'))), { name: 'منى سيد', phone: '01112223334', email: 'buyer@example.invalid', address: 'الجيزة، 5 شارع النيل',
    notes: 'المشتري: أحمد محمد علي حسن - 01012345678\nالدور الثالث' }, 'the store delivers to the recipient and still sees who bought');
  h.run('ACCT_UID="someone-else"');
  assert.equal(h.run('acctOrderPrefill().name'), '', 'details kept in memory for another account are never offered');
});

test('opening «حسابي» loads the row, shows it, and the order flow starts from it', async () => {
  const row = { user_id: 'user-1', full_name: 'أحمد محمد علي حسن', phone: '01012345678', governorate: 'القاهرة', address: '12 شارع التحرير', ship_same: true };
  const h = harness({ responses: [{ status: 200, body: [row] }] });
  const p = h.run('openAccount("Afnan Egypt")');
  assert.equal(h.sheetEl.dataset.kind, 'account'); assert.equal(h.sheetEl.hidden, false);
  assert.match(h.sheetBody.innerHTML, /جارٍ تحميل بياناتك/, 'a message while it loads');
  await p;
  assert.equal(h.fetches.length, 1);
  assert.equal(h.fetches[0].url, 'https://project.example.invalid/rest/v1/customer_details?select=*&user_id=eq.user-1');
  assert.equal(h.fetches[0].init.headers.Authorization, 'Bearer tok-1', 'read with the customer\'s own token');
  assert.match(h.sheetBody.innerHTML, /name="full_name"[^>]*value="أحمد محمد علي حسن"/);
  assert.match(h.sheetBody.innerHTML, /data-next="Afnan Egypt"/);
  assert.match(h.sheetBody.innerHTML, /data-back-cart/);
});

test('a visitor is asked to create an account first; from the menu he is told he is not signed in', async () => {
  const h = harness({ auth: null }); let signup = '';
  h.context.sheet = (k) => { signup = k; };
  await h.run('openAccount("Afnan Egypt")');
  assert.equal(signup, 'signup'); assert.equal(h.run('PENDING_STORE'), 'Afnan Egypt', 'after signing up he lands on «حسابي» for the same store');
  assert.equal(h.fetches.length, 0, 'nothing is requested without a session');
  await h.run('openAccount("")');
  assert.deepEqual(h.toasts, ['أنت غير مسجّل الدخول حاليًا']);
});

test('a load that fails or hangs still opens an empty form with a message; an old answer never replaces a newer sheet', async () => {
  const h = harness({ responses: [{ status: 500, body: {} }] });
  await h.run('openAccount("")');
  assert.match(h.sheetBody.innerHTML, /تعذر تحميل بياناتك المحفوظة/);
  assert.match(h.sheetBody.innerHTML, /data-acct-form/);
  const g = harness({ responses: [{ status: 200, body: [] }] });
  const first = g.run('openAccount("")');
  g.sheetEl.dataset.kind = 'cart';                    // the customer moved on to another sheet while it loaded
  g.sheetBody.innerHTML = 'cart';
  await first;
  assert.equal(g.sheetBody.innerHTML, 'cart', 'the late answer does not paint over the cart');
});

test('saving is one upsert on the customer\'s own row, with the customer\'s own token', async () => {
  const h = harness({ responses: [{ status: 201, body: [{ user_id: 'user-1', full_name: 'أحمد محمد علي حسن' }] }] });
  const row = h.context.acctRead(form(valid), h.run('ACCT_UI.ar')).row;
  const saved = await h.context.acctSave(row);
  const call = h.fetches[0];
  assert.equal(call.url, 'https://project.example.invalid/rest/v1/customer_details?on_conflict=user_id');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.Prefer, 'resolution=merge-duplicates,return=representation');
  assert.equal(call.init.headers.Authorization, 'Bearer tok-1');
  assert.equal(JSON.parse(call.init.body).user_id, 'user-1');
  assert.equal(saved.full_name, 'أحمد محمد علي حسن');
  assert.equal(h.run('acctMine().full_name'), 'أحمد محمد علي حسن', 'kept in memory for the order form');
  const bad = harness({ responses: [{ status: 401, body: {} }] });
  await assert.rejects(() => bad.context.acctSave(row), /acct_auth/);
});

test('«OK» saves and goes on to the order form from the cart, or just closes from the menu', async () => {
  const box = { hidden: true, textContent: '' }, btn = { disabled: false, textContent: 'موافق' };
  const mk = (next, responses) => { const h = harness({ responses }); const f = form(valid); f.dataset = { next }; f.isConnected = true;
    f.querySelector = (s) => (s === '.order-error' ? box : s === 'button[type="submit"]' ? btn : null); return { h, f }; };
  let { h, f } = mk('Afnan Egypt', [{ status: 201, body: [{ user_id: 'user-1' }] }]);
  await h.context.acctSubmit(f);
  assert.equal(h.context.__order, 'Afnan Egypt'); assert.deepEqual(h.toasts, ['تم حفظ بياناتك']);
  ({ h, f } = mk('', [{ status: 201, body: [{ user_id: 'user-1' }] }]));
  h.sheetEl.hidden = false;
  await h.context.acctSubmit(f);
  assert.equal(h.context.__order, undefined); assert.equal(h.sheetEl.hidden, true, 'from the menu the sheet closes');
  ({ h, f } = mk('Afnan Egypt', [{ status: 500, body: {} }]));
  await h.context.acctSubmit(f);
  assert.equal(h.context.__order, undefined, 'a failed save never goes on to the order'); assert.equal(box.textContent, h.run('ACCT_UI.ar.eSave')); assert.equal(btn.disabled, false);
  ({ h, f } = mk('Afnan Egypt', []));
  f.elements.full_name.value = 'اسم قصير';
  await h.context.acctSubmit(f);
  assert.equal(h.fetches.length, 0, 'a form that does not pass is not sent'); assert.equal(box.textContent, h.run('ACCT_UI.ar.eName'));
});

test('the Arabic and English texts have the same keys, and the page has its handlers on the document (no inline handlers)', () => {
  const { run } = harness();
  assert.deepEqual(run('Object.keys(ACCT_UI.ar)').sort(), run('Object.keys(ACCT_UI.en)').sort());
  assert.doesNotMatch(block, /onclick=|onsubmit=|onchange=|<script/i);
  assert.match(block, /document\.addEventListener\('click'/); assert.match(block, /document\.addEventListener\('submit'/); assert.match(block, /document\.addEventListener\('change'/);
});

test('the menu has «حسابي» under the sign-out item, and "place order" opens it before the order form', () => {
  const texts = read('texts.js');
  assert.match(texts, /'تسجيل الخروج','حسابي'\],/); assert.match(texts, /'Sign Out','My Account'\],/);
  const menu = oneLine('function buildMenu');
  assert.match(menu, /<a data-logout>'\+t\.menu\[15\]\+'<\/a><a data-account>'\+\(t\.menu\[16\]\|\|'حسابي'\)\+'<\/a>/, 'signed in: right under sign out');
  assert.match(menu, /data-menu-note="notin">'\+t\.menu\[15\]\+'<\/a><a class="off" data-menu-note="notin">'\+\(t\.menu\[16\]/, 'signed out: greyed, like sign out');
  assert.match(oneLine('function openStoreOrder'), /openAccount\(store\)\}$/, 'a signed-in customer goes through «حسابي» first');
  assert.match(oneLine('function openStoreOrder'), /PENDING_STORE=store;sheet\('signup'\)/, 'a visitor still creates an account first');
  // Phase 1: the customer's data is read from the account, never typed again. The order sheet is a read-only review.
  const form = oneLine('function orderFormHTML');
  assert.match(form, /acctOrderPrefill\(\)/, 'the review shows what the account holds');
  assert.match(form, /row=function\(k,v\)\{return v\?'<div class="orv-row"><span>'\+esc\(k\)\+'<\/span><b>'\+esc\(v\)\+'<\/b>/, 'every value shown from the account is escaped');
  assert.doesNotMatch(form, /<input|<textarea|<select/, 'no field to type in: the data comes from the account');
  assert.match(form, /data-acct-edit=/, 'a wrong detail is corrected in «حسابي»');
  const send = oneLine('function sendStoreOrder');
  assert.doesNotMatch(send, /form\.elements|customer=|unitPrice|lines=/, 'the browser sends no customer data, no lines and no prices');
  assert.match(send, /payload:\{storeId:storeId,idempotencyKey:form\.dataset\.orderKey,expectedSubtotal:subtotal\}/, 'the browser sends the store, the retry key and the total it showed');
  assert.match(core, /if\(next&&!edit&&!failed&&acctComplete\(row\)\)\{showOrderForm\(next\);return\}/, 'a complete account goes straight to the review');
});

test('the files that belong to the table are all there, under the version the database recorded', () => {
  const V = '20261106211851', migration = read('supabase', 'migrations', V + '_customer_account_details.sql');
  assert.ok(fs.existsSync(path.join(root, 'supabase', 'rollback', V + '_customer_account_details.sql')), 'rollback');
  const sqlTest = read('tests', 'customer-account-details.test.sql');
  assert.match(sqlTest, new RegExp(V + '_customer_account_details\\.sql')); assert.match(sqlTest, /^begin;/m); assert.match(sqlTest, /rollback;\s*$/);
  assert.match(migration, /user_id\s+uuid primary key references auth\.users \(id\) on delete cascade/);
  assert.match(migration, /enable row level security/); assert.match(migration, /using \(user_id = \(select auth\.uid\(\)\)\)/); assert.match(migration, /with check \(user_id = \(select auth\.uid\(\)\)\)/);
  assert.match(migration, /grant select, insert, update on public\.customer_details to authenticated;/);
  const code = migration.replace(/--.*$/gm, '');
  assert.doesNotMatch(code, /to anon|grant delete|grant all on public\.customer_details to authenticated|disable row level security/i, 'no access for visitors, no delete for clients');
  assert.match(read('tests', 'rls-attack-surface.test.sql'), /'contact_messages', 'customer_details', 'favorites'/, 'the grants check knows the table');
});

test('the page policy lets the map frame and the address lookup through, and geolocation only for the site itself', () => {
  const vercel = JSON.parse(read('vercel.json'));
  const csp = JSON.stringify(vercel);
  assert.match(csp, /connect-src 'self' https:\/\/sbgdtuqfrnfeggkwqtrw\.supabase\.co https:\/\/nominatim\.openstreetmap\.org;/);
  assert.match(csp, /frame-src https:\/\/challenges\.cloudflare\.com https:\/\/www\.google\.com;/);
  for (const file of ['railway/server.js', 'scripts/build-cloudflare.js', 'cloudflare/worker-core.js']) {
    assert.match(read(file), /geolocation=\(self\)/, file); assert.doesNotMatch(read(file), /geolocation=\(\)/, file);
  }
});

const geoMock = () => { const g = { watchOpts: null, getCalls: [], cleared: [], gpsStep: null,
  watchPosition: (ok, no, o) => { g.watchOpts = o; g.ok = ok; g.no = no; return 7; },
  clearWatch: (id) => g.cleared.push(id),
  getCurrentPosition: (ok, no, o) => { g.getCalls.push(o); if (g.gpsStep) g.gpsStep(ok, no); } }; return g; };
const fix = (accuracy) => ({ coords: { latitude: 30.04, longitude: 31.23, accuracy } });

test('«find my location» takes the best of the quick network readings (no GPS window), uses the GPS only when the network gives nothing, and never asks again after «denied»', async () => {
  // a precise first reading is taken at once
  let h = harness(), g = geoMock(); h.context.navigator = { geolocation: g };
  let p = h.run('acctPosition()'); g.ok(fix(40));
  assert.equal((await p).coords.accuracy, 40);
  assert.deepEqual([g.watchOpts.enableHighAccuracy, g.watchOpts.timeout], [false, 12000], 'the first try is the network position: the device\'s own location window is not forced');
  assert.deepEqual(g.cleared, [7], 'the watch is closed'); assert.equal(g.getCalls.length, 0, 'no GPS call');
  // a rough reading is followed by a better one: the better one wins, and the answer does not wait for the timer
  h = harness(); g = geoMock(); h.context.navigator = { geolocation: g };
  p = h.run('acctPosition()'); g.ok(fix(900)); g.ok(fix(60));
  assert.equal((await p).coords.accuracy, 60);
  // only rough readings: the best of them is used after a few seconds
  h = harness(); g = geoMock(); h.context.navigator = { geolocation: g };
  p = h.run('acctPosition()'); g.ok(fix(1200)); g.ok(fix(700)); g.ok(fix(900));
  h.timers.find((t) => t.ms === 5000).fn();
  assert.equal((await p).coords.accuracy, 700, 'the most accurate reading, not the last one');
  // an error after a reading still gives the reading
  h = harness(); g = geoMock(); h.context.navigator = { geolocation: g };
  p = h.run('acctPosition()'); g.ok(fix(300)); g.no({ code: 3 });
  assert.equal((await p).coords.accuracy, 300); assert.equal(g.getCalls.length, 0);
  // nothing from the network: the GPS gets one turn
  h = harness(); g = geoMock(); g.gpsStep = (ok) => ok(fix(15)); h.context.navigator = { geolocation: g };
  p = h.run('acctPosition()'); g.no({ code: 2 });
  assert.equal((await p).coords.accuracy, 15);
  assert.deepEqual(g.getCalls.map((o) => [o.enableHighAccuracy, o.timeout]), [[true, 15000]]);
  h = harness(); g = geoMock(); g.gpsStep = (ok) => ok(fix(15)); h.context.navigator = { geolocation: g };
  p = h.run('acctPosition()'); h.timers.find((t) => t.ms === 13000).fn();
  assert.equal((await p).coords.accuracy, 15, 'no reading at all after 13 seconds also turns to the GPS');
  // denied is final
  h = harness(); g = geoMock(); g.gpsStep = (ok) => ok(fix(15)); h.context.navigator = { geolocation: g };
  p = h.run('acctPosition()'); g.no({ code: 1 });
  await assert.rejects(() => p, (e) => e.code === 1);
  assert.equal(g.getCalls.length, 0, 'the customer is not asked twice');
  // both fail
  h = harness(); g = geoMock(); g.gpsStep = (ok, no) => no({ code: 3 }); h.context.navigator = { geolocation: g };
  p = h.run('acctPosition()'); g.no({ code: 2 });
  await assert.rejects(() => p, (e) => e.code === 3);
});

function locateBox() {
  const el = (extra) => ({ value: '', dataset: {}, ...extra });
  const els = { note: { textContent: '', hidden: true }, hidden: [{ value: '' }, { value: '' }], iframe: { src: '' }, ta: el(), sel: el(), city: el(), bld: el() };
  els.map = { hidden: true, querySelector: () => els.iframe };
  const map = { '.acct-loc-note': els.note, '[data-map]': els.map, textarea: els.ta, select: els.sel, '[data-part="city"]': els.city, '[data-part="building"]': els.bld };
  const box = { isConnected: true, querySelector: (q) => map[q] || null, querySelectorAll: () => els.hidden };
  const btn = { dataset: {}, disabled: false, closest: () => box };
  return { els, btn };
}
async function locate(h, btn, accuracy, address) {
  h.context.navigator = { geolocation: { watchPosition: (ok) => { ok(fix(accuracy)); return 3; }, clearWatch() {}, getCurrentPosition() {} } };
  h.context.acctLocate(btn);
  const wait = h.timers.find((t) => t.ms === 5000); if (wait) wait.fn(); // a rough reading waits a few seconds for a better one
  for (let i = 0; i < 30 && btn.dataset.busy; i++) await new Promise((r) => setImmediate(r));
}
const lookup = { address: { house_number: '12', road: 'شارع عباس العقاد', suburb: 'مدينة نصر', city: 'القاهرة', state: 'محافظة القاهرة', country: 'مصر' } };

test('«find my location» fills the governorate, the city, the street and the building, keeps what the customer typed, and does not pretend to know the street when the position is rough', async () => {
  let h = harness({ responses: [{ status: 200, body: lookup }] }), b = locateBox();
  await locate(h, b.btn, 40);
  assert.match(h.fetches[0].url, /zoom=18/, 'a precise position asks for the building level');
  assert.deepEqual([b.els.sel.value, b.els.city.value, b.els.ta.value, b.els.bld.value], ['القاهرة', 'مدينة نصر', 'شارع عباس العقاد', '12']);
  assert.deepEqual([b.els.hidden[0].value, b.els.hidden[1].value, b.els.map.hidden], [30.04, 31.23, false], 'the point is kept and the map shown');
  assert.equal(b.els.note.textContent, h.run('ACCT_UI.ar.locOk'));
  assert.equal(b.btn.disabled, false);

  // the customer typed his own street and building: they stay. The governorate and city that were filled automatically are replaced by a second tap.
  b.els.ta.value = 'شارع كتبته أنا'; b.els.ta.dataset.auto = ''; b.els.bld.value = '99'; b.els.city.value = 'مكان قديم'; b.els.sel.value = 'الجيزة';
  h = harness({ responses: [{ status: 200, body: lookup }] });
  await locate(h, b.btn, 40);
  assert.deepEqual([b.els.ta.value, b.els.bld.value, b.els.city.value, b.els.sel.value], ['شارع كتبته أنا', '99', 'مكان قديم', 'الجيزة'], 'typed values are never overwritten');
  assert.equal(b.els.note.textContent, '', 'nothing is said when the typed address is kept');

  // a rough position (more than 500 m): the area-level lookup, governorate and city only, and a sentence saying so
  h = harness({ responses: [{ status: 200, body: lookup }] }); b = locateBox();
  await locate(h, b.btn, 1500);
  assert.match(h.fetches[0].url, /zoom=14/, 'a rough position asks for the district level, not for a street');
  assert.deepEqual([b.els.sel.value, b.els.city.value, b.els.ta.value, b.els.bld.value], ['القاهرة', 'مدينة نصر', '', ''], 'no street and no building are guessed');
  assert.equal(b.els.note.textContent, h.run('ACCT_UI.ar.locApprox'));

  // the lookup failing, or knowing nothing, says so in a few words and writes nothing
  h = harness({ responses: [{ status: 500, body: {} }] }); b = locateBox();
  await locate(h, b.btn, 40);
  assert.equal(b.els.note.textContent, h.run('ACCT_UI.ar.locNoAddr')); assert.equal(b.els.ta.value, '');
  h = harness({ responses: [{ status: 200, body: { address: { country: 'مصر' } } }] }); b = locateBox();
  await locate(h, b.btn, 40);
  assert.equal(b.els.note.textContent, h.run('ACCT_UI.ar.locNoAddr'));
});

test('the address from the lookup keeps the village or city and the district (markaz) too, and the hint asks for the building, floor and flat', () => {
  const { run } = harness();
  run('var D2=' + JSON.stringify({ address: { road: 'شارع الجمهورية', neighbourhood: 'حي الشرق', village: 'ميت غمر', county: 'مركز ميت غمر', state: 'محافظة الدقهلية' } }));
  assert.equal(run('acctPickAddress(D2).city'), 'ميت غمر', 'the village or town is the city');
  assert.equal(run('acctPickAddress(D2).text'), 'شارع الجمهورية، حي الشرق، مركز ميت غمر', 'the markaz stays in the street and area line');
  assert.equal(run('acctPickAddress(D2).gov'), 'الدقهلية');
  assert.match(run('ACCT_UI.ar.locOk'), /المبنى والدور والشقة/);
  assert.match(run('ACCT_UI.en.locOk'), /building, floor and flat/);
});

test('the location messages are a few plain words the customer understands, with no instructions about device windows', () => {
  const { run } = harness();
  for (const l of ['ar', 'en']) {
    for (const k of ['locating', 'locOk', 'locApprox', 'locKept', 'locNoAddr', 'locDenied', 'locFail', 'locNone']) {
      const m = run('ACCT_UI.' + l + '.' + k);
      assert.ok(m.length <= 60, l + '.' + k + ' is short: ' + m);
      assert.doesNotMatch(m, /نافذة|إعدادات|خدمة الموقع|window|settings/i, l + '.' + k + ' does not explain the device to the customer');
    }
  }
  assert.equal(run('ACCT_UI.ar.locKept'), '', 'nothing is said when the typed address is kept');
});
