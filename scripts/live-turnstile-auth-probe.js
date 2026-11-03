'use strict';

const { chromium } = require('playwright');
const crypto = require('node:crypto');

const site = (process.argv[2] || 'https://elan-scents.hossamthapitelgharib.workers.dev').replace(/\/$/, '');
const timeout = Number(process.env.TURNSTILE_PROBE_TIMEOUT_MS || 125000);

function classifyAuthResult(status, result) {
  if (result && result.error_code === 'captcha_failed') return 'turnstile_rejected';
  if (status === 200 || (result && result.access_token)) return 'unexpected_auth_success';
  if (result && result.error_code === 'invalid_credentials') return 'token_accepted';
  return `unexpected_rejection:${String(result && result.error_code || status)}`;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.setDefaultTimeout(15000);
    await page.goto(site, { waitUntil: 'domcontentloaded' });
    await page.locator('#mb').click();
    await page.locator('#menu [data-sheet="login"]').click();
    const form = page.locator('form[data-auth-mode="login"]');
    if (await form.count() !== 1) throw new Error('login_form_not_found');
    await form.locator('input[name="email"]').focus();

    const auth = await page.evaluate(async (waitMs) => {
      if (!window.ElanTurnstile || typeof window.ElanTurnstile.token !== 'function') throw new Error('turnstile_client_missing');
      const response = await fetch('/api/config');
      if (!response.ok) throw new Error('public_config_unavailable');
      const config = await response.json();
      if (!config.url || !config.key || !config.turnstile_site_key) throw new Error('turnstile_public_config_incomplete');
      if (config.url.replace(/\/$/, '') !== 'https://sbgdtuqfrnfeggkwqtrw.supabase.co') throw new Error('unexpected_supabase_project');
      if (config.turnstile_site_key !== '0x4AAAAAAFvBW0Qsb8VBNT08') throw new Error('unexpected_turnstile_sitekey');
      const form = document.querySelector('form[data-auth-mode="login"]');
      if (!form) throw new Error('login_form_not_found');
      const token = await Promise.race([
        window.ElanTurnstile.token(form),
        new Promise((_, reject) => setTimeout(() => reject(new Error('turnstile_probe_timeout')), waitMs))
      ]);
      if (!token) throw new Error('turnstile_empty_token');
      return { url: config.url, key: config.key, token };
    }, timeout);

    const email = `turnstile-probe-${Date.now()}@example.invalid`;
    const password = crypto.randomBytes(24).toString('base64url');
    const response = await fetch(`${auth.url.replace(/\/$/, '')}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: auth.key, 'content-type': 'application/json' },
      body: JSON.stringify({
        email,
        password,
        gotrue_meta_security: { captcha_token: auth.token }
      })
    });
    const result = await response.json().catch(() => ({}));
    const classification = classifyAuthResult(response.status, result);
    if (classification !== 'token_accepted') throw new Error(classification);
    console.log('PASS: Supabase accepted the live Turnstile token, then rejected the deliberately nonexistent test identity. No account was created and no email was sent.');
  } finally {
    await browser.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    // Never print tokens, credentials, request bodies, or full network response data.
    console.error(`FAIL: ${String(error && error.message || 'live_turnstile_probe_failed').replace(/[^a-zA-Z0-9_:-]/g, '_').slice(0, 140)}`);
    process.exitCode = 1;
  });
}

module.exports = { classifyAuthResult };
