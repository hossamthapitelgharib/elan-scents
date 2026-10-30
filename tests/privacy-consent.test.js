// The privacy policy page and the refuse-only choice on it (owner decisions of 2026-10-29 and 2026-10-30: no consent notice, the
// visitor's activity is followed by default, one "refuse" button at the bottom that deletes what was saved). The policy is a
// gentle four-line summary for the visitor, with no platform details, and the same in English. The retention figure the database
// enforces is still checked against the code below.
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

test('the policy is a short, gentle summary for the visitor: no storage keys, tables, providers, code names or lists', () => {
  const text = privacy.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const words = text.trim().split(' ').length;
  assert.ok(words < 220, 'the whole page, English included, stays very short (' + words + ' words)');
  const arabic = (privacy.match(/<p class="privacy-lead">([^<]*)<\/p>/) || [])[1] || '';
  assert.ok(arabic.split(/\s+/).length < 75, 'the Arabic summary is about four lines (' + arabic.split(/\s+/).length + ' words)');
  assert.doesNotMatch(privacy, /<table|<code>|<ul>|<ol>/i, 'no key tables, code names or lists');
  for (const platform of ['elan_', 'HttpOnly', 'ThumbmarkJS', 'Cloudflare', 'Supabase', 'localStorage', 'HMAC', 'canvas', 'pg_cron', '151']) {
    assert.ok(!text.includes(platform), 'no platform detail on the page: ' + platform);
  }
  // it still says plainly, in the visitor's words, what is followed, that it is anonymous, that refusing is the visitor's right, and that an account comes at ordering
  for (const need of ['منذ زيارتك الأولى', 'ما يهمّك من عطور', 'رقم مجهول لا يدل على هويتك', 'ولك كامل الحق في رفض ذلك', 'نحذف فورًا ما حفظناه عنك', 'إنشاء حساب ببياناتك الحقيقية']) assert.ok(text.includes(need), 'says: ' + need);
  for (const need of ['from your first visit', 'an anonymous number', 'free to refuse this', 'delete what we saved about you right away', 'creating an account with your real details']) assert.ok(text.includes(need), 'says in English: ' + need);
});

test('the retention periods the code and the database enforce are still in place (the policy page itself no longer quotes them)', () => {
  const migrations = fs.readdirSync(path.join(root, 'supabase', 'migrations')).map((f) => read('supabase/migrations/' + f)).join('\n');
  assert.match(migrations, /guest-fingerprint-retention-400d/);
  assert.match(migrations, /customer-searches-retention-365d/);
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
  assert.match(privacy, /data-consent-refuse/, 'the refuse choice is on the page');
  assert.ok(fs.existsSync(path.join(root, 'privacy.css')));
});

test('the account holder agrees at sign-up, in the sign-up sentence (owner decision of 2026-10-28), not in a long policy', () => {
  const texts = read('texts.js'), core = read('app-core.js');
  assert.equal((texts.match(/\bac:'/g) || []).length, 2, 'the sign-up notice exists in Arabic and English');
  assert.match(texts, /ac:'[^']*href=\\?"\/privacy\.html\\?"/);
  assert.match(texts, /ac:'بإنشاء حسابك توافق على [^']*وعلى حفظ نشاطك في المتجر/);
  assert.match(core, /k=='signup'\?'<p class="auth-consent">'\+t\.ac\+'<\/p>':''/, 'shown on the sign-up form only');
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

test('the refuse button comes right after the summary the visitor reads, and the English summary ends with its own (owner decision 30 Oct)', () => {
  const at = (needle) => privacy.indexOf(needle);
  const arButton = at('data-consent-refuse>أرفض'), enButton = at('data-consent-refuse>Refuse');
  assert.ok(at('class="privacy-lead"') > -1 && at('class="privacy-lead"') < arButton, 'the Arabic summary comes before the Arabic refuse button');
  assert.ok(arButton < at('id="english"'), 'the Arabic part ends with its button, before the English summary');
  assert.ok(enButton > at('id="english"'), 'the English summary ends with its own button');
  assert.match(privacy.split('</button>').pop(), /^\s*<\/div>\s*<\/div>\s*<\/main>/, 'nothing but closing tags follows the last button');
});

test('the policy does not promise a purchase without an account: browsing is free, an account comes with the order', () => {
  assert.match(privacy, /إلى أن تسجّل رسميًا بإنشاء حساب ببياناتك الحقيقية عند طلبك/);
  assert.match(privacy, /until you register officially by creating an account with your real details when you order/);
  assert.doesNotMatch(privacy, /والشراء كما هو|browsing and ordering as before/);
});

test('the tone is calm and friendly: nothing on the page sounds like surveillance (owner decision 30 Oct)', () => {
  const text = privacy.replace(/<[^>]+>/g, ' ');
  for (const word of ['بصمة', 'نسجّل', 'نسجل', 'توثيق', 'نوثّق', 'تتبّع', 'تتبع', 'رصد', 'مراقبة', 'نمسح', 'تسجيل نشاط']) assert.ok(!text.includes(word), 'no alarming word on the page: ' + word);
  assert.doesNotMatch(text, /fingerprint|track|monitor|surveil|\bspy|record/i, 'no alarming English word on the page');
  assert.match(text, /يسعدنا مرورك الكريم ويشرّفنا خدمتك/, 'it opens by welcoming the visitor');
  const texts = read('texts.js');
  assert.doesNotMatch(texts.match(/\bac:'[^']*'/g).join(' '), /تسجيل نشاطك|recording of your activity/, 'the sign-up sentence is as calm as the policy');
});
