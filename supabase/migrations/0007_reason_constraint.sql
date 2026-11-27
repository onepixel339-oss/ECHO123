-- ═══════════════════════════════════════════════════════════════════════════
-- ECHO — migration 0007: extend conflict_archive reason codes
-- (v1.1 four-value → v1.3 PATCH1 six-value, §5.3.4).
--
-- Fresh databases built from migration 0001 already carry the six-value
-- constraint, so here this migration is a verified no-op (its preflight
-- passes and the re-added constraint is identical). For any environment
-- built from the v1.1 DDL text (four-value constraint), this is the explicit
-- correction: drop + re-add in ONE transaction — every pre-existing row
-- satisfies the new constraint (the old set is a subset), so re-validation
-- cannot fail on legacy data.
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare v_def text;
begin
  -- Preflight: fail loudly if the inherited shape differs from the
  -- documented DDL, instead of assuming. (If this raises, a human inspects.)
  select pg_get_constraintdef(oid) into v_def
    from pg_constraint
   where conrelid = 'echo_data.conflict_archive'::regclass
     and contype = 'c'
     and conname = 'conflict_archive_reason_check';
  if v_def is null then
    raise exception 'conflict_archive_reason_check not found — inspect the actual schema before migrating';
  end if;
  if v_def not like '%delete_vs_upsert%' then
    raise exception 'constraint definition does not match the documented v1.1 shape: %', v_def;
  end if;
end $$;

alter table echo_data.conflict_archive
  drop constraint conflict_archive_reason_check;

alter table echo_data.conflict_archive
  add constraint conflict_archive_reason_check
  check (reason in ('edit_edit','delete_vs_upsert','delete_vs_edit',
                    'applied_delete','stale_base_unknown_record','schema'));
