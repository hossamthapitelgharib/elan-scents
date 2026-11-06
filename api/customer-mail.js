const { getContext } = require('./_auth');
const smtp = require('../lib/smtp');
const templates = require('../lib/mail-templates');
const { createLimiter, clientIp, setRateLimitHeaders } = require('../lib/rate-limit');

/* Service e-mails from the shop's own mailbox (Gmail over SMTP), asked for by the signed-in customer's page. A new account gets two, each once:
     welcome    -> a welcome to the customer (once per account, from the moment its e-mail is confirmed)
     registered -> a notice to the platform mailbox (once per account), with the account's registration and confirmation time
   The page asks with `registered` (right after sign-up, or when the confirmation link is opened) and with `login` (every sign-in): a `login` only
   counts while the account is young, in case the confirmation link was opened on another device; for an older account it does nothing. There is no
   goodbye mail and no welcome after every sign-in (owner's decision, 5 Nov 2026: customers must not be tired by e-mails).
   The recipient is never taken from the request: it is the address of the token's own account (and PLATFORM_NOTIFY_EMAIL for the notice),
   so this cannot be used to mail anyone else. Nothing is sent until SMTP_USER and SMTP_PASSWORD are set on the Worker. The send itself
   runs after the answer (waitUntil on Cloudflare), so a page that is closing does not cut it off. See docs/customer-mail.ar.md. */

const EVENTS = ['registered', 'login'];
const ONCE = '100 years';   // a slot in public.customer_mail_log that is taken once per account for good
const limiter = createLimiter({ max: 60, windowMs: 60 * 1000 });

function reply(res, status, body) { res.setHeader('Cache-Control', 'no-store'); res.status(status).setHeader('Content-Type', 'application/json').json(body); }

function mailConfig() {
  const user = String(process.env.SMTP_USER || '').trim();
  // Google shows an app password in four groups ("abcd efgh ijkl mnop"); the spaces are not part of it, so a paste with them still works.
  const pass = String(process.env.SMTP_PASSWORD || '').replace(/\s+/g, '');
  if (!user || !pass) return null;
  return {
    user, pass,
    host: String(process.env.SMTP_HOST || 'smtp.gmail.com').trim(),
    port: Number(process.env.SMTP_PORT) || 465,
    fromName: String(process.env.MAIL_FROM_NAME || 'Élan Scents').trim(),
    platformEmail: String(process.env.PLATFORM_NOTIFY_EMAIL || '').trim()
  };
}

async function rpc(context, name, args) {
  const response = await fetch(`${context.supabaseUrl}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: context.serviceRoleKey, Authorization: `Bearer ${context.serviceRoleKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args)
  });
  if (!response.ok) throw new Error(`${name}_failed`);
  return response.json();
}
const claim = (context, kind) => rpc(context, 'claim_customer_mail', { p_user_id: context.user.id, p_kind: kind, p_min_interval: ONCE });
const release = (context, kind) => rpc(context, 'release_customer_mail', { p_user_id: context.user.id, p_kind: kind }).catch(() => {});

const YOUNG_ACCOUNT_MS = 3 * 24 * 60 * 60 * 1000;

/* Takes the slot of one mail and, when it was free, adds the mail to the jobs. A database failure loses nothing that an earlier slot already took:
   that mail still goes out, and only when nothing was claimed yet is the failure raised. */
async function addJob(jobs, context, kind, to, mail) {
  let due = false;
  try { due = await claim(context, kind); } catch (error) { if (!jobs.length) throw error; return; }
  if (due) jobs.push({ kind, to, mail });
}

module.exports = async function customerMail(req, res) {
  if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'method_not_allowed' });
  const event = req.body && typeof req.body.event === 'string' ? req.body.event : '';
  if (!EVENTS.includes(event)) return reply(res, 400, { ok: false, error: 'unknown_event' });
  const limit = limiter(clientIp(req));
  if (!limit.allowed) { setRateLimitHeaders(res, limit, 60); return reply(res, 429, { ok: false, error: 'rate_limited' }); }
  try {
    const config = mailConfig();
    if (!config) return reply(res, 200, { ok: true, sent: false, reason: 'mail_not_configured' });
    const context = await getContext(req);
    if (context.error) return reply(res, context.status, { ok: false, error: context.error });
    if (context.profile.role !== 'customer') return reply(res, 200, { ok: true, sent: false, reason: 'not_customer' });
    const email = String(context.user.email || '');
    if (!smtp.validAddress(email)) return reply(res, 200, { ok: true, sent: false, reason: 'no_email' });
    if (!context.user.email_confirmed_at && !context.user.confirmed_at) return reply(res, 200, { ok: true, sent: false, reason: 'email_not_confirmed' });

    if (event === 'login') {
      const created = Date.parse(context.user.created_at || '');
      if (!created || Date.now() - created >= YOUNG_ACCOUNT_MS) return reply(res, 200, { ok: true, sent: false, reason: 'not_new_account' });
    }
    const jobs = [];   // { kind, to, mail }
    if (smtp.validAddress(config.platformEmail)) {
      await addJob(jobs, context, 'registered', config.platformEmail, templates.registeredNotice({ name: context.profile.full_name, email, createdAt: context.user.created_at, confirmedAt: context.user.email_confirmed_at || context.user.confirmed_at }));
    }
    await addJob(jobs, context, 'welcome', email, templates.welcome());
    if (!jobs.length) return reply(res, 200, { ok: true, sent: false, reason: 'already_sent' });

    const work = Promise.all(jobs.map(async (job) => {
      try {
        await smtp.sendMail({ host: config.host, port: config.port, user: config.user, pass: config.pass, from: { name: config.fromName, address: config.user }, to: job.to, ...job.mail });
      } catch (error) {
        console.error('customer mail failed', job.kind, error && error.code ? error.code : 'error');
        await release(context, job.kind);   // the next attempt may try again
      }
    }));
    if (typeof req.waitUntil === 'function') req.waitUntil(work); else await work;
    return reply(res, 202, { ok: true, sent: true, queued: true });
  } catch (_) {
    return reply(res, 502, { ok: false, error: 'customer_mail_failed' });
  }
};
