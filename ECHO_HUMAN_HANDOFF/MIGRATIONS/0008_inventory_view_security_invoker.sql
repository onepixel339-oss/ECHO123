-- ECHO migration 0008:
-- Ensure the function inventory view uses caller permissions.

ALTER VIEW public.v_sync_function_inventory
SET (security_invoker = true);
