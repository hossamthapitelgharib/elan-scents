-- Rolls back migrations/20261029050311_forget_guest_browser.sql.
-- Removes the function that erases a refusing visitor's data. api/guest-cart.js calls it for action "forget"; without it that action
-- answers 502 and the browser keeps retrying, so roll back the API change first.
begin;

drop function if exists public.forget_guest_browser(text, text);

commit;
