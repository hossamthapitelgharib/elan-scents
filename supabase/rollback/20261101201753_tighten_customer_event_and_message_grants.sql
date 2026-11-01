-- Rolls back migrations/20261101201753_tighten_customer_event_and_message_grants.sql.
begin;

grant update, delete on table public.analytics_events, public.contact_messages to authenticated;

commit;
