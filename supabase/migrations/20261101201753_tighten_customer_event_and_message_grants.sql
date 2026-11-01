-- A signed-in customer only ever INSERTS into analytics_events and contact_messages (the only customer policies are
-- event_insert and auth_insert); reading and changing them is admin-only through the server. The UPDATE and DELETE grants were
-- leftovers of the old Supabase defaults that row-level security alone was holding back, so they go too.
revoke update, delete on table public.analytics_events, public.contact_messages from authenticated;
