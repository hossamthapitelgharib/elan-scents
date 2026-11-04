'use strict';

const { getContext, requireRoles } = require('../api/_auth');

const CUSTOMER_ROLES = ['customer', 'store_admin', 'platform_admin'];

function jsonError(response) {
  return response.json().catch(() => ({})).then((body) => ({
    status: response.status,
    code: body && body.code,
    message: body && body.message
  }));
}

async function callCustomerRpc(context, name, body) {
  const response = await fetch(`${context.supabaseUrl}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: context.serviceRoleKey,
      Authorization: `Bearer ${context.serviceRoleKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (response.ok) return { ok: true, status: response.status, data: await response.json().catch(() => null) };
  return { ok: false, ...(await jsonError(response)) };
}

function errorKey(result) {
  const text = `${result.code || ''} ${result.message || ''}`;
  if (/Authentication required|JWT|token/i.test(text)) return 'unauthorized';
  if (/Order not found/i.test(text)) return 'order_not_found';
  if (/no longer waiting/i.test(text)) return 'order_not_waiting';
  if (/Reason is too long/i.test(text)) return 'reason_too_long';
  if (/Customer details are required/i.test(text)) return 'customer_details_required';
  if (/Customer details are too long/i.test(text)) return 'customer_details_too_long';
  if (/Invalid retry key/i.test(text)) return 'invalid_retry_key';
  if (/Too many orders/i.test(text)) return 'order_rate_limited';
  if (/Price changed/i.test(text)) return 'price_changed';
  if (/stock|unavailable/i.test(text)) return 'stock_unavailable';
  if (/Subtotal mismatch/i.test(text)) return 'subtotal_mismatch';
  if (/Invalid order item|Order items are required|Invalid or inactive store|Mixed currencies/i.test(text)) return 'invalid_order';
  if (/Cart items must be an array|cart holds at most 100 lines/i.test(text)) return 'invalid_cart';
  return 'customer_action_failed';
}

async function authenticateCustomer(req) {
  return requireRoles(await getContext(req), CUSTOMER_ROLES);
}

module.exports = { authenticateCustomer, callCustomerRpc, errorKey };
