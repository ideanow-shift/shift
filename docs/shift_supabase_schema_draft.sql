-- シフト自動生成システム Supabase schema draft
-- 作成日: 2026-06-28
-- 目的:
--   現行のGitHub Pages + GAS + Spreadsheet運用を止めずに、
--   シフト関連データを段階的にSupabaseへ移行するためのドラフト。
--
-- 注意:
--   本番投入前に、既存Core DBのテーブル定義と権限ポリシーを必ず確認する。
--   フロントエンドからservice_roleを使わない。
--   Phase 1ではGASまたはEdge Functionがservice_roleでアクセスする前提。

create extension if not exists pgcrypto;

create table if not exists public.shift_store_settings (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  weekday_min_staff integer not null default 2 check (weekday_min_staff >= 0),
  saturday_min_staff integer not null default 2 check (saturday_min_staff >= 0),
  sunday_min_staff integer not null default 2 check (sunday_min_staff >= 0),
  holiday_min_staff integer not null default 2 check (holiday_min_staff >= 0),
  max_requested_days integer not null default 2 check (max_requested_days >= 0),
  no_holiday_on_saturday boolean not null default true,
  no_holiday_on_sunday boolean not null default true,
  no_holiday_on_holiday boolean not null default true,
  enable_requested_off_as_off boolean not null default false,
  enable_remarks_column boolean not null default false,
  enable_consecutive_holiday_limit boolean not null default false,
  consecutive_holiday_limit_count integer not null default 1 check (consecutive_holiday_limit_count >= 0),
  enabled_extra_stamps jsonb not null default '{}'::jsonb,
  custom_rule text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_id)
);

create table if not exists public.shift_staff_rules (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  store_id uuid references public.stores(id) on delete set null,
  holiday_type text not null default 'full_two_days'
    check (holiday_type in ('full_two_days', 'alternate_two_days', 'custom')),
  work_type text not null default 'regular'
    check (work_type in ('regular', 'short_time', 'reception_part', 'custom')),
  start_time time,
  end_time time,
  max_requested_days integer not null default 2 check (max_requested_days >= 0),
  fixed_weekdays smallint[] not null default '{}'::smallint[],
  sunday_unavailable boolean not null default false,
  note text,
  parsed_note_rules jsonb not null default '[]'::jsonb,
  irregular_rules jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (employee_id, store_id)
);

create table if not exists public.shift_schedules (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  year integer not null check (year between 2000 and 2100),
  month integer not null check (month between 1 and 12),
  status text not null default 'draft'
    check (status in ('draft', 'confirmed', 'published', 'archived')),
  source text not null default 'generated'
    check (source in ('generated', 'imported', 'manual', 'migrated')),
  generated_run_id uuid,
  created_by uuid references public.employees(id) on delete set null,
  updated_by uuid references public.employees(id) on delete set null,
  confirmed_by uuid references public.employees(id) on delete set null,
  published_by uuid references public.employees(id) on delete set null,
  confirmed_at timestamptz,
  published_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_id, year, month)
);

create table if not exists public.shift_schedule_cells (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references public.shift_schedules(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  work_date date not null,
  stamp text not null default 'blank'
    check (stamp in (
      'blank',
      'work',
      'required_work',
      'off',
      'manual_off',
      'requested_off',
      'paid_leave',
      'ng_work',
      'short_time',
      'training',
      'meeting',
      'half_day',
      'outside',
      'bereavement',
      'special_leave',
      'closed'
    )),
  source text not null default 'auto'
    check (source in ('auto', 'manual', 'ai', 'imported', 'request', 'note', 'migration')),
  start_time time,
  end_time time,
  note text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (schedule_id, employee_id, work_date)
);

create table if not exists public.shift_requests (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  store_id uuid references public.stores(id) on delete set null,
  request_date date not null,
  request_type text not null
    check (request_type in ('requested_off', 'paid_leave', 'required_work', 'ng_work', 'time_preference', 'other')),
  status text not null default 'submitted'
    check (status in ('draft', 'submitted', 'approved', 'rejected', 'cancelled')),
  reason text,
  approved_by uuid references public.employees(id) on delete set null,
  approved_at timestamptz,
  source text not null default 'staff'
    check (source in ('staff', 'manager', 'migration', 'import')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.shift_generation_runs (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  schedule_id uuid references public.shift_schedules(id) on delete set null,
  year integer not null check (year between 2000 and 2100),
  month integer not null check (month between 1 and 12),
  run_type text not null default 'auto'
    check (run_type in ('auto', 'ai_adjust', 'rebuild', 'migration')),
  input_snapshot jsonb not null default '{}'::jsonb,
  result_summary jsonb not null default '{}'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  executed_by uuid references public.employees(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.shift_audit_logs (
  id uuid primary key default gen_random_uuid(),
  store_id uuid references public.stores(id) on delete set null,
  schedule_id uuid references public.shift_schedules(id) on delete set null,
  actor_employee_id uuid references public.employees(id) on delete set null,
  action text not null,
  target_table text,
  target_id uuid,
  before_data jsonb,
  after_data jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'shift_schedules_generated_run_fk'
  ) then
    alter table public.shift_schedules
      add constraint shift_schedules_generated_run_fk
      foreign key (generated_run_id)
      references public.shift_generation_runs(id)
      on delete set null;
  end if;
end;
$$;

create index if not exists idx_shift_store_settings_store_id
  on public.shift_store_settings(store_id);

create index if not exists idx_shift_staff_rules_employee_id
  on public.shift_staff_rules(employee_id);

create index if not exists idx_shift_staff_rules_store_id
  on public.shift_staff_rules(store_id);

create index if not exists idx_shift_schedules_store_year_month
  on public.shift_schedules(store_id, year, month);

create index if not exists idx_shift_schedule_cells_schedule_id
  on public.shift_schedule_cells(schedule_id);

create index if not exists idx_shift_schedule_cells_employee_date
  on public.shift_schedule_cells(employee_id, work_date);

create index if not exists idx_shift_requests_employee_date
  on public.shift_requests(employee_id, request_date);

create index if not exists idx_shift_generation_runs_store_month
  on public.shift_generation_runs(store_id, year, month, created_at desc);

create index if not exists idx_shift_audit_logs_schedule_id
  on public.shift_audit_logs(schedule_id, created_at desc);

create or replace function public.shift_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_shift_store_settings_updated_at on public.shift_store_settings;
create trigger trg_shift_store_settings_updated_at
before update on public.shift_store_settings
for each row execute function public.shift_set_updated_at();

drop trigger if exists trg_shift_staff_rules_updated_at on public.shift_staff_rules;
create trigger trg_shift_staff_rules_updated_at
before update on public.shift_staff_rules
for each row execute function public.shift_set_updated_at();

drop trigger if exists trg_shift_schedules_updated_at on public.shift_schedules;
create trigger trg_shift_schedules_updated_at
before update on public.shift_schedules
for each row execute function public.shift_set_updated_at();

drop trigger if exists trg_shift_schedule_cells_updated_at on public.shift_schedule_cells;
create trigger trg_shift_schedule_cells_updated_at
before update on public.shift_schedule_cells
for each row execute function public.shift_set_updated_at();

drop trigger if exists trg_shift_requests_updated_at on public.shift_requests;
create trigger trg_shift_requests_updated_at
before update on public.shift_requests
for each row execute function public.shift_set_updated_at();

alter table public.shift_store_settings enable row level security;
alter table public.shift_staff_rules enable row level security;
alter table public.shift_schedules enable row level security;
alter table public.shift_schedule_cells enable row level security;
alter table public.shift_requests enable row level security;
alter table public.shift_generation_runs enable row level security;
alter table public.shift_audit_logs enable row level security;

comment on table public.shift_store_settings is 'シフト作成の店舗別設定。stores.idを正本として参照する。';
comment on table public.shift_staff_rules is '社員別の固定休、勤務タイプ、特記事項解析後ルール。employees.idを正本として参照する。';
comment on table public.shift_schedules is '店舗・年月ごとのシフト表ヘッダ。';
comment on table public.shift_schedule_cells is '社員x日付のシフトセル。';
comment on table public.shift_requests is '希望休、有休、出勤希望などの申請。';
comment on table public.shift_generation_runs is '自動生成、AI調整、再生成、移行の実行履歴。';
comment on table public.shift_audit_logs is '保存、確定、公開、手修正、AI適用の監査ログ。';

-- Phase 1 policy note:
-- RLSは有効化するが、ここではanon向けの許可ポリシーを作らない。
-- GASまたはEdge Functionのservice_role経由で読み書きする。
-- staff/store manager向けの直接RLS policyはNOV HUB認証統合後に追加する。
