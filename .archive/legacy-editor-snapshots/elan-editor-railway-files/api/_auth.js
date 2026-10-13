async function getContext(req) {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !serviceRoleKey) return { error: 'supabase_service_configuration_missing', status: 503 };
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return { error: 'unauthorized', status: 401 };
  const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, { headers: { apikey: serviceRoleKey, Authorization: `Bearer ${token}` } });
  if (!userResponse.ok) return { error: 'unauthorized', status: 401 };
  const user = await userResponse.json();
  const profileResponse = await fetch(`${supabaseUrl}/rest/v1/profiles?select=id,full_name,phone,role&id=eq.${encodeURIComponent(user.id)}&limit=1`, { headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` } });
  const profiles = profileResponse.ok ? await profileResponse.json() : [];
  return { supabaseUrl, serviceRoleKey, token, user, profile: profiles[0] || { id: user.id, role: 'customer' } };
}

function requireRoles(context, roles) {
  if (context.error) return context;
  if (!roles.includes(context.profile.role)) return { error: 'forbidden', status: 403 };
  return context;
}

module.exports = { getContext, requireRoles };
