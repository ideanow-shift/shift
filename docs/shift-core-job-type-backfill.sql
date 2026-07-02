-- Shift/Core DB job type normalization helper
-- ------------------------------------------------------------
-- Purpose:
-- - Stop using legacy employment_type labels such as レセプションパート / 本部パート
-- - Move those meanings into employees.job_type_id
-- - Normalize employment_type to employment status only, e.g. パート・アルバイト
--
-- Usage:
-- 1. Run the preview SELECT first.
-- 2. Run the DO block inside a transaction.
-- 3. Confirm the after SELECT.
-- 4. Change ROLLBACK to COMMIT only after confirming the result.

begin;

-- Preview affected rows before update.
select
  e.id,
  e.employee_id,
  e.full_name,
  e.employment_type,
  e.position_id,
  e.job_type_id
from public.employees e
where coalesce(e.employment_type, '') ~ '(レセプション|受付|本部)'
order by e.employee_id;

do $$
declare
  job_type_label_column text;
  reception_job_type_id uuid;
  head_office_job_type_id uuid;
begin
  select column_name
    into job_type_label_column
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'job_types'
    and column_name in ('job_type_name', 'name', 'label')
  order by case column_name
    when 'job_type_name' then 1
    when 'name' then 2
    else 3
  end
  limit 1;

  if job_type_label_column is null then
    raise exception 'job_types label column not found. Expected job_type_name, name, or label.';
  end if;

  execute format(
    'select id from public.job_types where %I in ($1, $2) order by id limit 1',
    job_type_label_column
  )
  into reception_job_type_id
  using 'レセプション', '受付';

  execute format(
    'select id from public.job_types where %I in ($1, $2) order by id limit 1',
    job_type_label_column
  )
  into head_office_job_type_id
  using '本部スタッフ', '本部';

  if reception_job_type_id is null then
    raise exception 'job_types row for レセプション was not found.';
  end if;

  update public.employees
  set
    job_type_id = reception_job_type_id,
    employment_type = case
      when coalesce(employment_type, '') ~ '(パート|アルバイト)' then 'パート・アルバイト'
      else employment_type
    end
  where coalesce(employment_type, '') ~ '(レセプション|受付)';

  if head_office_job_type_id is not null then
    update public.employees
    set
      job_type_id = head_office_job_type_id,
      employment_type = case
        when coalesce(employment_type, '') ~ '(パート|アルバイト)' then 'パート・アルバイト'
        else employment_type
      end
    where coalesce(employment_type, '') ~ '(本部)';
  else
    raise notice 'job_types row for 本部スタッフ was not found. 本部系 rows were not updated.';
  end if;
end $$;

-- Confirm after update.
select
  e.id,
  e.employee_id,
  e.full_name,
  e.employment_type,
  e.position_id,
  e.job_type_id,
  coalesce(jt.job_type_name, jt.name) as job_type_name
from public.employees e
left join public.job_types jt on jt.id = e.job_type_id
where coalesce(e.employment_type, '') ~ '(レセプション|受付|本部)'
   or coalesce(jt.job_type_name, jt.name) in ('レセプション', '受付', '本部スタッフ', '本部')
order by e.employee_id;

-- Change this to COMMIT after confirming the result.
rollback;

