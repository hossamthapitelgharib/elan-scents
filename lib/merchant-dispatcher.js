'use strict';

/* The outgoing side of step 3 of docs/purchase-flow-final.ar.md: Élan sends the order to the merchant, signed, and the merchant answers
   by itself (approve with ITS payment window, or reject with a reason) within ten seconds. Nobody at the store is involved.

   The database owns the queue and the rules (supabase/migrations/20261115193039_stage1_send_review_payment_window.sql):
     claim_merchant_deliveries  hands out the due messages (an order, or a cancellation of an unpaid order) with the store's address and secret
     finish_merchant_delivery   takes the outcome of one attempt: a reply (applied through merchant_review_order) or a classified failure
   This module only talks to the merchant: it signs, sends with a ten second limit, classifies what came back and reports. It is driven by
   (1) the request that places the order (first attempt), (2) the order page's polling (the next attempts, about ten seconds apart),
   (3) a Cron Trigger every minute (the safety net for a closed tab, the cancellation messages, and the 24-hour alert for a payment window left open: nothing is cancelled by a clock of ours). */

const { digest } = require('./store-webhook-signature');
const { DEFAULT_SITE_ORIGIN } = require('./site-origin');

const SEND_TIMEOUT_MS = 10000;
const MAX_REPLY_BYTES = 32768;
const CRON_BATCH = 20;
const REPLY_KEYS = ['decision', 'reason', 'paymentWindowUrl', 'idleSeconds'];

function serviceContext(env) {
  const source = env || process.env;
  const supabaseUrl = source.SUPABASE_URL || source.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = source.SUPABASE_SERVICE_ROLE_KEY || source.SUPABASE_SECRET_KEY;
  return supabaseUrl && serviceRoleKey ? { supabaseUrl, serviceRoleKey } : null;
}

async function rpc(context, name, body, fetchImpl) {
  const response = await fetchImpl(`${context.supabaseUrl}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: context.serviceRoleKey, Authorization: `Bearer ${context.serviceRoleKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`rpc ${name} failed (${response.status}) ${text.slice(0, 200)}`);
  }
  return response.json().catch(() => null);
}

/* The address is typed by the store's admin, so it is held to the same standard as any outgoing request: https, the default port, a real
   host name (no IP literal, no localhost, no internal suffix), and no credentials in it. Anything else is treated as a network failure. */
function safeEndpoint(value) {
  let u;
  try { u = new URL(String(value || '')); } catch (_) { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  if (!host.includes('.') || host.startsWith('[') || host.includes(':')) return null;
  if (/^\d+(\.\d+){0,3}$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) return null;
  if (host === 'localhost' || /\.(localhost|local|internal|lan|home|corp|invalid)$/.test(host)) return null;
  return u.toString();
}

/* What goes to the merchant. An order is the database's own frozen message (type elan_order); a cancellation says only which order,
   why and when. Neither carries a secret, a signature, a payment detail or anything about the customer beyond the order's own snapshot. */
function buildMessage(job, options = {}) {
  if (job.kind === 'cancel') {
    const cancel = job.cancel || {};
    return {
      event: 'order_cancelled',
      body: JSON.stringify({
        type: 'elan_order_cancelled', version: 1, elanOrderId: job.requestId, trackingNumber: job.trackingNumber,
        reason: cancel.reason || null, cancelledAt: cancel.cancelledAt || null
      })
    };
  }
  return { event: 'order', body: JSON.stringify({ ...(job.payload || {}), returnUrls: returnUrls(job.requestId, options.siteOrigin) }) };
}

/* Where the merchant's payment windows send the customer back to: one address for each way out of a window: "done" (success), "cancelled" (cancel),
   "shut" (closed) and "the payment failed" (failed). They carry only the order and what the customer did; the page they open reports it from the
   customer's own signed-in browser, and nothing there proves a payment (only a neutral confirmation does). */
function returnUrls(orderId, siteOrigin) {
  const origin = String(siteOrigin || process.env.ELAN_STORE_ORIGIN || DEFAULT_SITE_ORIGIN).replace(/\/+$/, '');
  const base = `${origin}/payment-return.html?o=${encodeURIComponent(orderId)}`;
  return { success: `${base}&r=success`, cancel: `${base}&r=cancel`, closed: `${base}&r=closed`, failed: `${base}&r=failed` };
}

function signedHeaders(job, body, event, nowSeconds) {
  const timestamp = String(nowSeconds);
  const eventId = `${job.deliveryId}:${job.attemptNo}`;
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': 'Elan-Scents-Orders/1',
    'X-Store-Id': String(job.storeId),
    'X-Elan-Event': event,
    'X-Elan-Attempt': String(job.attemptNo),
    'X-Webhook-Timestamp': timestamp,
    'X-Webhook-Id': eventId,
    'X-Webhook-Signature': digest(job.secret, timestamp, eventId, body)
  };
}

async function readCapped(response, limit) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    return text.length > limit ? null : text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { try { await reader.cancel(); } catch (_) { /* nothing left to read */ } return null; }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/* Only the decision's own fields are passed on, whatever else the merchant sent; the database validates every value. */
function cleanReply(parsed) {
  const out = {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
  for (const key of REPLY_KEYS) {
    const value = parsed[key];
    if (typeof value === 'string') out[key] = key === 'reason' ? value.slice(0, 500) : value.slice(0, 2100);
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

/* One answer from the merchant (or the lack of one) as the database's result object: { outcome, httpStatus, failureKind, detail, reply }. */
async function classify(response, kind) {
  const httpStatus = response.status;
  if (httpStatus === 401 || httpStatus === 403) return { outcome: 'failed', failureKind: 'signature_rejected', httpStatus, detail: `HTTP ${httpStatus}` };
  if (httpStatus < 200 || httpStatus >= 300) {
    const redirect = httpStatus >= 300 && httpStatus < 400;
    return { outcome: 'failed', failureKind: 'merchant_error', httpStatus, detail: redirect ? `HTTP ${httpStatus} redirect refused` : `HTTP ${httpStatus}` };
  }
  if (kind === 'cancel') {
    try { await response.arrayBuffer(); } catch (_) { /* a cancellation is delivered once the merchant has answered 2xx */ }
    return { outcome: 'responded', httpStatus };
  }
  let text;
  try { text = await readCapped(response, MAX_REPLY_BYTES); } catch (_) { return { outcome: 'failed', failureKind: 'network', httpStatus, detail: 'reply interrupted' }; }
  if (text == null) return { outcome: 'failed', failureKind: 'invalid_response', httpStatus, detail: 'reply too large' };
  let parsed;
  try { parsed = JSON.parse(text); } catch (_) { return { outcome: 'failed', failureKind: 'invalid_response', httpStatus, detail: 'reply is not JSON' }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { outcome: 'failed', failureKind: 'invalid_response', httpStatus, detail: 'reply is not an object' };
  return { outcome: 'responded', httpStatus, reply: cleanReply(parsed) };
}

async function sendJob(job, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs || SEND_TIMEOUT_MS;
  const endpoint = safeEndpoint(job.endpoint);
  if (!endpoint) return { outcome: 'failed', failureKind: 'network', detail: 'unsafe order address' };
  const { event, body } = buildMessage(job, options);
  const headers = signedHeaders(job, body, event, options.nowSeconds || Math.floor(Date.now() / 1000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(endpoint, { method: 'POST', headers, body, redirect: 'manual', signal: controller.signal });
    return await classify(response, job.kind);
  } catch (error) {
    if (controller.signal.aborted || (error && error.name === 'AbortError')) return { outcome: 'failed', failureKind: 'timeout', detail: 'no reply in time' };
    return { outcome: 'failed', failureKind: 'network', detail: 'connection failed' };
  } finally {
    clearTimeout(timer);
  }
}

/* Claims what is due (for one order, or for anyone when requestId is omitted), sends every message at once and reports each outcome. */
async function runDeliveries(context, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  if (!context) return [];
  const jobs = await rpc(context, 'claim_merchant_deliveries', { p_request_id: options.requestId || null, p_limit: options.limit || 5 }, fetchImpl);
  if (!Array.isArray(jobs) || !jobs.length) return [];
  return Promise.all(jobs.map(async (job) => {
    let result;
    try { result = await sendJob(job, options); } catch (_) { result = { outcome: 'failed', failureKind: 'network', detail: 'send failed' }; }
    let finished = null;
    try { finished = await rpc(context, 'finish_merchant_delivery', { p_delivery_id: job.deliveryId, p_attempt_no: job.attemptNo, p_result: result }, fetchImpl); }
    catch (error) { console.error('merchant delivery report failed', job.deliveryId, error && error.message); }
    return { deliveryId: job.deliveryId, requestId: job.requestId, kind: job.kind, attemptNo: job.attemptNo, outcome: result.outcome, failureKind: result.failureKind || null, finished };
  }));
}

/* The Cron Trigger: due messages of any order, then the payment windows whose customer stopped moving for the idle time (cancelled), then the one
   alert that remains. Never throws. */
async function runScheduled(context, options = {}) {
  const summary = { sent: 0, failed: 0, closed: 0, alerted: 0, error: null };
  if (!context) { summary.error = 'supabase_service_configuration_missing'; return summary; }
  const fetchImpl = options.fetchImpl || fetch;
  try {
    const done = await runDeliveries(context, { ...options, limit: CRON_BATCH });
    summary.sent = done.filter((d) => d.outcome === 'responded').length;
    summary.failed = done.length - summary.sent;
  } catch (error) { summary.error = String(error && error.message || error).slice(0, 200); }
  try {
    // A window whose customer made no move for the whole idle time (30 minutes, or the merchant's own) is closed: the purchase is cancelled, the cart is kept,
    // and the customer, the platform dashboard and the store are told. A window the customer took to the provider has no clock and is never touched here.
    const closed = await rpc(context, 'close_idle_payment_windows', {}, fetchImpl);
    summary.closed = Number.isInteger(closed) ? closed : 0;
  } catch (error) { summary.error = summary.error || String(error && error.message || error).slice(0, 200); }
  try {
    // A customer who went on to the provider and heard nothing for more than 24 hours tells the platform dashboard once. Nothing is cancelled here:
    // a payment may be in progress.
    const alerted = await rpc(context, 'alert_stale_payment_windows', {}, fetchImpl);
    summary.alerted = Number.isInteger(alerted) ? alerted : 0;
  } catch (error) { summary.error = summary.error || String(error && error.message || error).slice(0, 200); }
  return summary;
}

module.exports = {
  SEND_TIMEOUT_MS, MAX_REPLY_BYTES, CRON_BATCH, serviceContext, safeEndpoint, buildMessage, returnUrls, signedHeaders, cleanReply, classify, sendJob, runDeliveries, runScheduled
};
