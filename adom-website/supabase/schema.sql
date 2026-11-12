-- =====================================================================================
-- ADOM lead-management schema for Supabase (PostgreSQL). Paste this whole file into
-- Supabase > SQL Editor > New query > Run. It is safe to run more than once.
--
-- Security model:
--   * Row Level Security is ON for every table and there are NO policies, so the public
--     "anon" key and logged-in "authenticated" users can read/write NOTHING.
--   * All access happens from the ADOM server using the secret service_role key.
--   * Money is stored as whole pesewas (1 GHS = 100 pesewas) to avoid rounding errors.
-- =====================================================================================

create table if not exists public.enquiries (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  customer_name text not null,
  customer_phone text not null,                       -- normalised +233XXXXXXXXX
  customer_area text not null,
  service_type text not null,
  vehicle_details text,
  enquiry_message text,
  consent_at timestamptz not null,
  privacy_notice_version text not null,
  source_page text,
  lead_status text not null default 'new'
    check (lead_status in ('new','contacted','qualified','referred','booked','completed','cancelled')),
  referred_to text,
  referral_date timestamptz,
  job_value_pesewas bigint check (job_value_pesewas is null or job_value_pesewas >= 0),
  commission_rate_bp integer check (commission_rate_bp is null or commission_rate_bp between 0 and 10000),
  commission_pesewas bigint check (commission_pesewas is null or commission_pesewas >= 0),
  internal_notes text
);
create index if not exists enquiries_created_idx on public.enquiries (created_at desc);
create index if not exists enquiries_status_idx on public.enquiries (lead_status);
create index if not exists enquiries_dup_idx on public.enquiries (customer_phone, service_type, created_at);

create table if not exists public.notification_outbox (
  id bigint generated always as identity primary key,
  enquiry_id uuid not null references public.enquiries(id) on delete cascade,
  recipient_role text not null default 'lead_partner',
  channel text not null default 'email',
  status text not null default 'pending' check (status in ('pending','sending','sent','failed')),
  attempts int not null default 0,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  last_error text
);
create index if not exists outbox_due_idx on public.notification_outbox (status, next_attempt_at);

create table if not exists public.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor text not null,
  action text not null,
  enquiry_id uuid,                                    -- no foreign key: audit history survives deletion
  detail jsonb
);

-- ---- Lock everything down ----
alter table public.enquiries enable row level security;
alter table public.notification_outbox enable row level security;
alter table public.audit_log enable row level security;
revoke all on public.enquiries, public.notification_outbox, public.audit_log from anon, authenticated;

-- ---- Status workflow guard (same rules as the application) ----
create or replace function public.enforce_status_transition() returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  if new.lead_status is distinct from old.lead_status and not (
    (old.lead_status = 'new' and new.lead_status in ('contacted','cancelled')) or
    (old.lead_status = 'contacted' and new.lead_status in ('qualified','cancelled')) or
    (old.lead_status = 'qualified' and new.lead_status in ('referred','cancelled')) or
    (old.lead_status = 'referred' and new.lead_status in ('booked','cancelled')) or
    (old.lead_status = 'booked' and new.lead_status in ('completed','cancelled')) or
    (old.lead_status = 'cancelled' and new.lead_status = 'new')
  ) then raise exception 'Invalid status transition % -> %', old.lead_status, new.lead_status; end if;
  return new;
end $$;
drop trigger if exists enquiries_status_guard on public.enquiries;
create trigger enquiries_status_guard before update on public.enquiries
  for each row execute function public.enforce_status_transition();

-- ---- Server-side functions (callable only by the service_role key) ----
-- 1) Save an enquiry, queue the lead-partner notification and write the audit entry in ONE transaction.
create or replace function public.create_enquiry(p jsonb) returns jsonb
language plpgsql set search_path = public as $$
declare v_id uuid;
begin
  insert into enquiries (reference, customer_name, customer_phone, customer_area, service_type,
                         vehicle_details, enquiry_message, consent_at, privacy_notice_version, source_page)
  values (p->>'reference', p->>'customer_name', p->>'customer_phone', p->>'customer_area', p->>'service_type',
          nullif(p->>'vehicle_details',''), nullif(p->>'enquiry_message',''), now(), p->>'privacy_notice_version', nullif(p->>'source_page',''))
  returning id into v_id;
  insert into notification_outbox (enquiry_id) values (v_id);
  insert into audit_log (actor, action, enquiry_id, detail)
  values ('public-form', 'enquiry.created', v_id, jsonb_build_object('reference', p->>'reference'));
  return jsonb_build_object('id', v_id, 'reference', p->>'reference');
end $$;

-- 2) Claim due notifications (safe if the server ever runs twice: SKIP LOCKED).
create or replace function public.claim_notifications(p_limit int default 5) returns jsonb
language sql set search_path = public as $$
  with due as (
    select id from notification_outbox
    where (status = 'pending' and next_attempt_at <= now())
       or (status = 'sending' and locked_at < now() - interval '10 minutes')
    order by id limit p_limit for update skip locked
  ), upd as (
    update notification_outbox o set status = 'sending', locked_at = now(), attempts = o.attempts + 1
    from due where o.id = due.id returning o.*
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'attempts', u.attempts, 'enquiry', to_jsonb(e))), '[]'::jsonb)
  from upd u join enquiries e on e.id = u.enquiry_id
$$;

-- 3) Record the result of a send attempt.
create or replace function public.finish_notification(p_id bigint, p_ok boolean, p_error text, p_final boolean, p_retry_at timestamptz)
returns void language plpgsql set search_path = public as $$
begin
  if p_ok then
    update notification_outbox set status = 'sent', sent_at = now(), locked_at = null, last_error = null where id = p_id;
  else
    update notification_outbox set status = case when p_final then 'failed' else 'pending' end,
           next_attempt_at = coalesce(p_retry_at, now()), locked_at = null, last_error = left(p_error, 300) where id = p_id;
  end if;
end $$;

-- 4) Optional retention clean-up (only used when RETENTION_DAYS is configured).
create or replace function public.purge_closed_enquiries(p_before timestamptz) returns int
language plpgsql set search_path = public as $$
declare n int;
begin
  delete from enquiries where lead_status in ('completed','cancelled') and updated_at < p_before;
  get diagnostics n = row_count;
  if n > 0 then insert into audit_log (actor, action, detail) values ('system', 'retention.purge', jsonb_build_object('deleted', n, 'before', p_before)); end if;
  return n;
end $$;

revoke all on function public.create_enquiry(jsonb), public.claim_notifications(int),
  public.finish_notification(bigint, boolean, text, boolean, timestamptz), public.purge_closed_enquiries(timestamptz)
  from public, anon, authenticated;
grant execute on function public.create_enquiry(jsonb), public.claim_notifications(int),
  public.finish_notification(bigint, boolean, text, boolean, timestamptz), public.purge_closed_enquiries(timestamptz)
  to service_role;
