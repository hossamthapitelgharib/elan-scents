const { getContext, requireRoles } = require('./_auth');

function reply(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).setHeader('Content-Type', 'application/json').json(body);
}

module.exports = async function platformCustomers(req, res) {
  if (req.method !== 'GET') return reply(res, 405, { ok: false, error: 'method_not_allowed' });
  try {
    const context = requireRoles(await getContext(req), ['platform_admin']);
    if (context.error) return reply(res, context.status, { ok: false, error: context.error });
    const headers = { apikey: context.serviceRoleKey, Authorization: `Bearer ${context.serviceRoleKey}` };
    const base = `${context.supabaseUrl}/rest/v1/`;
    const profileParams = new URLSearchParams({ select: 'id,full_name,phone,created_at', role: 'eq.customer', order: 'created_at.desc', limit: '500' });
    const guestParams = new URLSearchParams({ select: 'id,fingerprint_hash,cart_snapshot,status,captured_at,first_seen_at,last_seen_at', status: 'eq.guest', order: 'last_seen_at.desc', limit: '500' });
    const [profileResponse, guestResponse] = await Promise.all([
      fetch(`${base}profiles?${profileParams}`, { headers }),
      fetch(`${base}guest_visitors?${guestParams}`, { headers })
    ]);
    if (!profileResponse.ok || !guestResponse.ok) return reply(res, 502, { ok: false, error: 'customer_data_unavailable' });
    const customers = await profileResponse.json();
    const visitors = await guestResponse.json();
    const cartStats = new Map();

    if (customers.length) {
      const ids = customers.map(customer => customer.id).filter(Boolean);
      const params = new URLSearchParams({ select: 'user_id,quantity', user_id: `in.(${ids.join(',')})`, limit: '5000' });
      const cartsResponse = await fetch(`${base}cart_items?${params}`, { headers });
      if (!cartsResponse.ok) return reply(res, 502, { ok: false, error: 'customer_cart_data_unavailable' });
      const rows = await cartsResponse.json();
      for (const row of rows) {
        const stats = cartStats.get(row.user_id) || { cartItems: 0, cartUnits: 0 };
        stats.cartItems += 1;
        stats.cartUnits += Math.max(0, Number(row.quantity) || 0);
        cartStats.set(row.user_id, stats);
      }
    }

    const registeredCustomers = customers.map(customer => Object.assign({}, customer, cartStats.get(customer.id) || { cartItems: 0, cartUnits: 0 }));
    const guestVisitors = visitors.map(visitor => {
      const items = Array.isArray(visitor.cart_snapshot) ? visitor.cart_snapshot : [];
      return Object.assign({}, visitor, {
        cart_items_count: items.length,
        cart_units: items.reduce((sum, item) => sum + Math.max(0, Number(item && (item.q || item.quantity)) || 0), 0)
      });
    });
    return reply(res, 200, { ok: true, registeredCustomers, guestVisitors, counts: { registered: registeredCustomers.length, visitors: guestVisitors.length } });
  } catch (_) {
    return reply(res, 502, { ok: false, error: 'customer_data_unavailable' });
  }
};
