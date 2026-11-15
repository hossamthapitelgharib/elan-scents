begin;

-- WARNING: rolling this back removes active 24-hour refusal/claim barriers. The guest rows themselves are not restored;
-- applying this rollback during the window can let a delayed request use the pre-barrier RPCs again.

drop function public.purge_expired_guest_fingerprints(interval);
alter function public.purge_expired_guest_fingerprints_pre_barrier_20261114(interval) rename to purge_expired_guest_fingerprints;
grant execute on function public.purge_expired_guest_fingerprints(interval) to service_role;

drop function public.guest_signal_behavior(text);
alter function public.guest_signal_behavior_pre_barrier_20261114(text) rename to guest_signal_behavior;
grant execute on function public.guest_signal_behavior(text) to service_role;

drop function public.guest_identity_link_many(jsonb);
alter function public.guest_identity_link_many_pre_barrier_20261114(jsonb) rename to guest_identity_link_many;
grant execute on function public.guest_identity_link_many(jsonb) to service_role;

drop function public.guest_identity_link(text, text, numeric, jsonb);
alter function public.guest_identity_link_pre_barrier_20261114(text, text, numeric, jsonb) rename to guest_identity_link;
grant execute on function public.guest_identity_link(text, text, numeric, jsonb) to service_role;

drop function public.guest_signal_store(text, text, jsonb, text, text, text, text, text, integer, integer, integer);
alter function public.guest_signal_store_pre_barrier_20261114(text, text, jsonb, text, text, text, text, text, integer, integer, integer) rename to guest_signal_store;
grant execute on function public.guest_signal_store(text, text, jsonb, text, text, text, text, text, integer, integer, integer) to service_role;

drop function public.record_guest_product_activity(text, text, uuid, text);
alter function public.record_guest_product_activity_pre_barrier_20261114(text, text, uuid, text) rename to record_guest_product_activity;
grant execute on function public.record_guest_product_activity(text, text, uuid, text) to service_role;

drop function public.record_customer_search(text, text, uuid, uuid, text, jsonb);
alter function public.record_customer_search_pre_barrier_20261114(text, text, uuid, uuid, text, jsonb) rename to record_customer_search;
grant execute on function public.record_customer_search(text, text, uuid, uuid, text, jsonb) to service_role;

drop function public.record_customer_product_event(text, text, uuid, uuid, text, uuid, uuid, uuid, integer);
alter function public.record_customer_product_event_pre_barrier_20261114(text, text, uuid, uuid, text, uuid, uuid, uuid, integer) rename to record_customer_product_event;
grant execute on function public.record_customer_product_event(text, text, uuid, uuid, text, uuid, uuid, uuid, integer) to service_role;

drop function public.record_customer_session(text, uuid, uuid, text);
alter function public.record_customer_session_pre_barrier_20261114(text, uuid, uuid, text) rename to record_customer_session;
grant execute on function public.record_customer_session(text, uuid, uuid, text) to service_role;

drop function public.claim_guest_browser_cart(text, text, uuid);
alter function public.claim_guest_browser_cart_pre_barrier_20261114(text, text, uuid) rename to claim_guest_browser_cart;
grant execute on function public.claim_guest_browser_cart(text, text, uuid) to service_role;

drop function public.merge_guest_browser(text, text, text, text);
alter function public.merge_guest_browser_pre_barrier_20261114(text, text, text, text) rename to merge_guest_browser;
grant execute on function public.merge_guest_browser(text, text, text, text) to service_role;

drop function public.save_guest_browser_cart(text, text, jsonb);
alter function public.save_guest_browser_cart_pre_barrier_20261114(text, text, jsonb) rename to save_guest_browser_cart;
grant execute on function public.save_guest_browser_cart(text, text, jsonb) to service_role;

drop function public.resolve_guest_browser(text, text);
alter function public.resolve_guest_browser_pre_barrier_20261114(text, text) rename to resolve_guest_browser;
grant execute on function public.resolve_guest_browser(text, text) to service_role;

drop function public.forget_guest_browser(text, text);
alter function public.forget_guest_browser_pre_barrier_20261114(text, text) rename to forget_guest_browser;
grant execute on function public.forget_guest_browser(text, text) to service_role;

drop function private.guest_identity_is_blocked(text, text);
drop function private.guest_identity_lock_links(jsonb);
drop function private.guest_identity_lock_analytics_pair(text, text);
drop function private.guest_identity_lock_merge(text, text, text, text);
drop function private.guest_identity_lock(text, text);
drop table private.guest_identity_blocks;

notify pgrst, 'reload schema';
commit;
