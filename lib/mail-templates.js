'use strict';
/* The three service e-mails the shop sends from its own mailbox (api/customer-mail.js). Each returns { subject, text, html }.
   The wording is the owner's (2 Nov 2026). Everything that came from a customer (name, address) is escaped in the HTML. */

const BRAND = 'Élan Scents';
const escape = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function page(heading, paragraphs, note) {
  const body = paragraphs.map((p) => `<p style="margin:0 0 14px;font-size:15px;">${p}</p>`).join('\n');
  return `<!doctype html>
<html lang="ar" dir="rtl">
<body style="margin:0;padding:0;background:#f6f1e7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f1e7;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-top:4px solid #c8962a;border-radius:12px;">
<tr><td dir="rtl" style="padding:28px 24px;font-family:'IBM Plex Sans Arabic',Tahoma,Arial,sans-serif;color:#1a1a1a;text-align:right;line-height:1.8;">
<div style="font-size:13px;letter-spacing:1px;color:#8a6a1b;">${BRAND}</div>
<h1 style="font-size:20px;margin:8px 0 12px;">${heading}</h1>
${body}
<p style="margin:18px 0 0;font-size:12px;color:#555555;">${note}</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

const AUTOMATIC = 'هذه رسالة تلقائية من حسابك في متجر Élan Scents.';

/* After a customer signs in. */
function welcome() {
  const line = 'أهلًا ومرحبًا بك ونتمنى لك رحلة تسويقية ممتعة.';
  return {
    subject: `أهلًا بك في ${BRAND}`,
    text: `${line}\n\n${BRAND}\n${AUTOMATIC}`,
    html: page('أهلًا ومرحبًا بك', [line], AUTOMATIC)
  };
}

/* After a customer signs out. */
function goodbye() {
  const line = 'كنا سعداء بوجودك معنا، وفي انتظارك دائمًا.';
  return {
    subject: 'كنا سعداء بوجودك معنا',
    text: `${line}\n\n${BRAND}\n${AUTOMATIC}`,
    html: page('كنا سعداء بوجودك معنا', [line], AUTOMATIC)
  };
}

/* To the platform's own mailbox when a customer's account is confirmed. */
function registeredNotice({ name, email }) {
  const who = String(name || '').trim().slice(0, 120);
  const address = String(email || '').trim().slice(0, 254);
  const note = 'إشعار تلقائي من لوحة المنصة.';
  return {
    subject: `عميل جديد: ${(who || address).slice(0, 80)}`,
    text: `تم تسجيل عميل جديد بنجاح.\nالاسم: ${who || '—'}\nالبريد: ${address}\n\n${note}`,
    html: page('تم تسجيل عميل جديد بنجاح', [`الاسم: <b>${escape(who || '—')}</b>`, `البريد: <b dir="ltr">${escape(address)}</b>`], note)
  };
}

module.exports = { welcome, goodbye, registeredNotice };
