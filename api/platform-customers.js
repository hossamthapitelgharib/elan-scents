const { getContext, requireRoles } = require('./_auth');

const PAGE_SIZE = 50;
const CART_PAGE_SIZE = 1000;
const MAX_CART_OFFSET = 100000;

function reply(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).setHeader('Content-Type', 'application/json').json(body);
}

function pageOffset(value) {
  const offset = Number(value);
  return Number.isSafeInteger(offset) && offset >= 0 && offset <= 10000000 ? offset : 0;
}

function countFrom(response) {
  const value = response.headers.get('content-range') || '';
  const match = value.match(/\/(\d+)$/);
  return match ? Number(match[1]) : null;
}

async function readPage(base, table, params, headers, offset) {
  const query = new URLSearchParams(params);
  query.set('limit', String(PAGE_SIZE));
  query.set('offset', String(offset));
  const response = await fetch(`${base}${table}?${query}`, { headers: { ...headers, Prefer: 'count=exact' } });
  if (!response.ok) return null;
  const rows = await response.json();
  if (!Array.isArray(rows)) return null;
  const total = countFrom(response);
  if (total === null) return null;
  return { rows, total };
}

async function collectCartStats(base, headers, customers) {
  const ids = customers.map(customer => customer.id).filter(Boolean);
  const cartStats = new Map();
  if (!ids.length) return cartStats;
  const baseParams = new URLSearchParams({ select: 'user_id,quantity', user_id: `in.(${ids.join(',')})`, order: 'user_id.asc,store_product_id.asc' });

  for (let offset = 0; offset <= MAX_CART_OFFSET; offset += CART_PAGE_SIZE) {
    const params = new URLSearchParams(baseParams);
    params.set('limit', String(CART_PAGE_SIZE));
    params.set('offset', String(offset));
    const response = await fetch(`${base}cart_items?${params}`, { headers });
    if (!response.ok) throw new Error('customer_cart_data_unavailable');
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error('customer_cart_data_unavailable');
    for (const row of rows) {
      const stats = cartStats.get(row.user_id) || { cartItems: 0, cartUnits: 0 };
      stats.cartItems += 1;
      stats.cartUnits += Math.max(0, Number(row.quantity) || 0);
      cartStats.set(row.user_id, stats);
    }
    if (rows.length < CART_PAGE_SIZE) return cartStats;
  }
  throw new Error('customer_cart_data_unavailable');
}

module.exports = async function platformCustomers(req, res) {
  if (req.method !== 'GET') return reply(res, 405, { ok: false, error: 'method_not_allowed' });
  try {
    const context = requireRoles(await getContext(req), ['platform_admin']);
    if (context.error) return reply(res, context.status, { ok: false, error: context.error });
    const headers = { apikey: context.serviceRoleKey, Authorization: `Bearer ${context.serviceRoleKey}` };
    const base = `${context.supabaseUrl}/rest/v1/`;
    const registeredOffset = pageOffset(req.query && req.query.registeredOffset);
    const visitorOffset = pageOffset(req.query && req.query.visitorOffset);
    const profileParams = new URLSearchParams({ select: 'id,full_name,phone,created_at', role: 'eq.customer', order: 'created_at.desc,id.asc' });
    const guestParams = new URLSearchParams({ select: 'id,fingerprint_hash,cart_snapshot,status,captured_at,first_seen_at,last_seen_at', status: 'eq.guest', identity_version: 'eq.2', order: 'last_seen_at.desc,id.asc' });
    const [profilePage, guestPage] = await Promise.all([
      readPage(base, 'profiles', profileParams, headers, registeredOffset),
      readPage(base, 'guest_visitors', guestParams, headers, visitorOffset)
    ]);
    if (!profilePage || !guestPage) return reply(res, 502, { ok: false, error: 'customer_data_unavailable' });
    const customers = profilePage.rows;
    const visitors = guestPage.rows;
    const cartStats = await collectCartStats(base, headers, customers);

    const registeredCustomers = customers.map(customer => Object.assign({}, customer, cartStats.get(customer.id) || { cartItems: 0, cartUnits: 0 }));
    const guestVisitors = visitors.map(visitor => {
      const items = Array.isArray(visitor.cart_snapshot) ? visitor.cart_snapshot : [];
      const { cart_snapshot: _cartSnapshot, ...visitorSummary } = visitor;
      return Object.assign({}, visitorSummary, {
        cart_items_count: items.length,
        cart_units: items.reduce((sum, item) => sum + Math.max(0, Number(item && (item.q || item.quantity)) || 0), 0)
      });
    });
    const pagination = {
      registered: { offset: registeredOffset, limit: PAGE_SIZE, total: profilePage.total, hasMore: registeredOffset + registeredCustomers.length < profilePage.total },
      visitors: { offset: visitorOffset, limit: PAGE_SIZE, total: guestPage.total, hasMore: visitorOffset + guestVisitors.length < guestPage.total }
    };
    return reply(res, 200, {
      ok: true,
      registeredCustomers,
      guestVisitors,
      counts: { registered: profilePage.total, visitors: guestPage.total },
      pagination
    });
  } catch (error) {
    return reply(res, 502, { ok: false, error: error && error.message === 'customer_cart_data_unavailable' ? error.message : 'customer_data_unavailable' });
  }
};
