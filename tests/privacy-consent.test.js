// The privacy policy page, the refuse-only choice on it (owner decision of 2026-10-29: no consent notice, tracking by default,
// one "refuse" button that erases the fingerprint and activity), and a guard that keeps the policy honest:
// every browser-storage key or cookie the storefront uses must be listed on the page, and its retention figures
// must match what the database really enforces.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const privacy = read('privacy.html');
const vercel = JSON.parse(read('vercel.json'));

const STOREFRONT_SCRIPTS = ['app-core.js', 'app.js', 'account.js', 'auth-session.js', 'guest-identity.js', 'consent.js', 'texts.js', 'portal.js', 'hero-video.js'];
// names in those files that are not stored in the browser
const NOT_STORAGE = new Set(['elan_editor']);

test('the policy lists every browser-storage key and cookie the storefront uses', () => {
  const used = new Set(['elan_gid']);           // the server cookie is set in api/guest-cart.js as a template string
  for (const file of STOREFRONT_SCRIPTS) for (const m of read(file).matchAll(/'(elan_[a-z0-9_]+)'/g)) if (!NOT_STORAGE.has(m[1])) used.add(m[1]);
  assert.ok(used.size >= 10, 'found the keys: ' + [...used].join(', '));
  for (const name of used) assert.ok(privacy.includes('<code>' + name + '</code>'), name + ' is explained on the privacy page');
  assert.ok(read('api/guest-cart.js').includes('elan_gid='), 'the server cookie is still named elan_gid');
});

test('the retention periods on the page are the ones the database enforces', () => {
  assert.match(privacy, /بعد 400 يوم/);
  assert.match(privacy, /بعد 365 يومًا/);
  assert.match(privacy, /ولا يُحذف منها شيء تلقائيًا/, 'registered customers are never purged automatically (owner decision of 2026-10-28)');
  assert.doesNotMatch(privacy, /عمليات البحث المسجّلة على الحسابات تُحذف/);
  const migrations = fs.readdirSync(path.join(root, 'supabase', 'migrations')).map((f) => read('supabase/migrations/' + f)).join('\n');
  assert.match(migrations, /guest-fingerprint-retention-400d/);
  assert.match(migrations, /customer-searches-retention-365d/);
  // the cookies live 400 days (34,560,000 seconds) on both sides
  assert.equal(34560000 / 86400, 400);
  assert.match(read('guest-identity.js'), /max-age=34560000/);
  assert.match(read('api/guest-cart.js'), /Max-Age=34560000/);
});

test('privacy.html is a plain page: right-to-left, external assets only, no inline script, a way back to the shop', () => {
  assert.match(privacy, /^<!doctype html>/i);
  assert.match(privacy, /<html lang="ar" dir="rtl">/);
  assert.match(privacy, /<link rel="stylesheet" href="\/privacy\.css\?v=[0-9A-Za-z-]+">/);
  assert.match(privacy, /<link rel="stylesheet" href="\/consent\.css\?v=[0-9A-Za-z-]+">/);
  assert.match(privacy, /<script src="\/consent\.js\?v=[0-9A-Za-z-]+"><\/script>/);
  assert.doesNotMatch(privacy, /<script(?![^>]*\ssrc=)[^>]*>/i, 'no inline script');
  assert.doesNotMatch(privacy, /\son[a-z]+\s*=|javascript:/i, 'no inline handler');
  assert.match(privacy, /href="\/#contact"/, 'rights requests go through the contact form');
  assert.match(privacy, /data-consent-refuse/, 'the refuse choice is on the page');
  assert.ok(fs.existsSync(path.join(root, 'privacy.css')));
});

test('the policy separates the visitor (the refusal) from the account holder (account activity), as the owner decided', () => {
  assert.match(privacy, /بإنشاء حسابك توافق على تسجيل نشاطك في المتجر/);
  assert.match(privacy, /فلا يتوقف برفضك أعلاه/);
  assert.match(privacy, /ولا نستخدم له بصمة جهاز ولا معرّف متصفح ولا كوكي/);
  assert.match(privacy, /registered|signed-in customer's own activity/i);
  const texts = read('texts.js'), core = read('app-core.js');
  assert.equal((texts.match(/\bac:'/g) || []).length, 2, 'the sign-up notice exists in Arabic and English');
  assert.match(texts, /ac:'[^']*href=\\?"\/privacy\.html\\?"/);
  assert.match(core, /k=='signup'\?'<p class="auth-consent">'\+t\.ac\+'<\/p>':''/, 'shown on the sign-up form only');
});

test('the page says what it must: it records by default, one refusal, what the refusal erases, purposes, no sale, rights, the law, last update', () => {
  for (const needle of ['أرفض', 'دون أن نطلب موافقتك', 'نسجّل افتراضيًا', 'نمسح فورًا من قاعدة بياناتنا', 'لا نبيع بياناتك', 'الإعلانات', 'الاعتراض', '151 لسنة 2020', 'آخر تحديث', 'ThumbmarkJS', 'Cloudflare', 'Supabase', 'Global Privacy Control']) {
    assert.ok(privacy.includes(needle), 'mentions ' + needle);
  }
  assert.match(privacy, /لا نخزّنه كما هو/, 'states that the IP address is stored only as a keyed hash');
  assert.match(privacy, /ولا يمسّ هذا الرفض حسابك المسجّل/, 'the refusal does not touch a registered account');
  assert.match(privacy, /Refusing never stops you from browsing, shopping or ordering/);
  assert.match(privacy, /by default and without asking first/);
});

test('the only choice on the policy page is to refuse: no accept button, in Arabic or English', () => {
  const buttons = [...privacy.matchAll(/<button\b[^>]*>([^<]*)<\/button>/g)];
  assert.equal(buttons.length, 2, 'one refuse button in Arabic and one in English');
  for (const [tag, label] of buttons) {
    assert.match(tag, /data-consent-refuse/);
    assert.match(label, /أرفض|Refuse/);
    assert.doesNotMatch(label, /أوافق|موافقة|Accept|Agree|Allow/i);
  }
  assert.doesNotMatch(privacy, /data-consent-choice|data-consent-open|data-consent-accept/);
  // both states exist for the script to toggle, in both languages, and the refused one starts hidden
  assert.equal((privacy.match(/data-consent-when="open"/g) || []).length, 2);
  assert.equal((privacy.match(/data-consent-when="refused" hidden/g) || []).length, 2);
});

test('every page that loads the identity script loads the consent script first, with its stylesheet', () => {
  const pages = fs.readdirSync(root).filter((f) => f.endsWith('.html'));
  const loading = pages.filter((f) => /guest-identity\.js/.test(read(f)));
  assert.deepEqual(loading.sort(), ['account.html', 'index.html']);
  for (const file of loading) {
    const html = read(file);
    assert.ok(html.indexOf('/consent.js?v=') > 0 && html.indexOf('/consent.js?v=') < html.indexOf('/guest-identity.js?v='), file + ': consent.js comes before guest-identity.js');
    assert.match(html, /<link rel="stylesheet" href="\/consent\.css\?v=/, file + ' loads consent.css');
    assert.doesNotMatch(html, /data-consent-open|elan-consent/, file + ' has no consent notice or opener');
  }
  assert.match(read('account.html'), /<p class="privacy-links"><a href="\/privacy\.html">[^<]+<\/a><\/p>/, 'the account page links the policy');
});

test('the shop footer links the policy in both languages, and offers no consent button', () => {
  const core = read('app-core.js');
  assert.match(core, /<a href=\\?"\/privacy\.html\\?">'\+f\.pv\+'<\/a>/);
  assert.match(core, /pv:'سياسة الخصوصية'/);
  assert.match(core, /pv:'Privacy policy'/);
  assert.doesNotMatch(core, /data-consent-open|consent-open|ps:'/);
});

test('the new files are cached like the other assets and the policy page is served with the page policy', () => {
  const cacheRule = vercel.headers.find((r) => /consent\\?\.js/.test(r.source));
  assert.ok(cacheRule, 'consent.js is in a cache rule');
  for (const f of ['consent.js', 'consent.css', 'privacy.css']) assert.ok(cacheRule.source.includes(f), f + ' is in the cache rule');
  const rules = vercel.headers.filter((r) => /index\.html\|privacy\.html\|account\.html/.test(r.source));
  assert.equal(rules.length, 2, 'privacy.html is in the page-policy rule and the no-store rule');
});

test('there is no consent notice anywhere: no styles, no markup, no opener, no script that builds one', () => {
  const css = read('consent.css');
  assert.doesNotMatch(css, /elan-consent|consent-open|sheet-open/);
  for (const file of ['index.html', 'account.html', 'privacy.html', 'app-core.js', 'app.js', 'consent.js', 'guest-identity.js']) {
    assert.doesNotMatch(read(file).replace(/\/\/.*$/gm, ''), /elan-consent|data-consent-open|consent-open/, file);
  }
});

test('the dashboards never track visitors and carry no notice', () => {
  for (const f of ['dashboard.html', 'store-dashboard.html', 'platform-dashboard.html', 'customers-dashboard.html', 'stores-dashboard.html']) {
    assert.doesNotMatch(read(f), /guest-identity\.js|consent\.js/, f);
  }
});
