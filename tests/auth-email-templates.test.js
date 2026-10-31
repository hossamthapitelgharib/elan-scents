'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'docs', 'auth-emails');
const TEMPLATES = ['confirm-signup.html', 'reset-password.html'];
const read = (name) => fs.readFileSync(path.join(DIR, name), 'utf8');

// WCAG relative luminance and contrast ratio, for the two colour pairs that carry text.
function luminance(hex) {
  const channel = (i) => { const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}
const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

for (const name of TEMPLATES) {
  test(`${name}: Arabic, right to left, one link only and no user data`, () => {
    const html = read(name);
    assert.match(html, /<html lang="ar" dir="rtl">/);
    assert.match(html, /<td dir="rtl"/);
    const variables = [...html.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => m[1]);
    assert.ok(variables.length >= 2, 'the link is the button and the fallback text');
    assert.ok(variables.every((v) => v === '.ConfirmationURL'), 'only .ConfirmationURL is used, never the email address or a name: ' + variables.join(','));
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    assert.deepEqual(hrefs, ['{{ .ConfirmationURL }}'], 'the one and only link is the confirmation link');
  });

  test(`${name}: nothing an email client or a spam filter dislikes`, () => {
    const html = read(name);
    assert.equal(/<script|<img|<iframe|<form|<link|@import|javascript:|onclick=/i.test(html), false);
    assert.equal(/https?:\/\//i.test(html), false, 'no address is written into the template');
    assert.ok(html.length < 5000, 'short, as authentication emails should be');
  });

  test(`${name}: keeps the shop identity and stays readable`, () => {
    const html = read(name);
    assert.match(html, /#c8962a/i);
    assert.match(html, /IBM Plex Sans Arabic/);
    assert.ok(contrast('#1a1a1a', '#c8962a') >= 4.5, 'button text on the gold button');
    assert.ok(contrast('#8a6a1b', '#ffffff') >= 4.5, 'brand line on white');
    assert.ok(contrast('#555555', '#ffffff') >= 4.5, 'small print on white');
    assert.match(html, /تجاهل هذه الرسالة/, 'says what to do if the person did not ask for it');
  });
}

test('the two templates differ in their words and the README names both files and subjects', () => {
  assert.notEqual(read(TEMPLATES[0]), read(TEMPLATES[1]));
  const readme = fs.readFileSync(path.join(DIR, 'README.ar.md'), 'utf8');
  for (const name of TEMPLATES) assert.ok(readme.includes(name), name);
  assert.match(readme, /\/account\.html/);
  assert.match(readme, /\/editor-reset/);
});
