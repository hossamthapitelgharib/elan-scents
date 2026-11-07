-- Rollback for 20261106211851_customer_account_details.sql. It deletes every customer's saved delivery details.
drop trigger if exists customer_details_normalize on public.customer_details;
drop function if exists private.customer_details_normalize();
drop table if exists public.customer_details;
