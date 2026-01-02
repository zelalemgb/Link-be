-- Sample stock seed for testing the stock management module.
-- Uses the current user's facility/user via RLS helpers, with fallbacks.
-- Run in Supabase SQL editor or via psql with an authenticated session.

with ctx as (
  select get_user_facility_id() as facility_id, auth.uid() as user_id
),
fallback_facility as (
  select id as facility_id
  from public.facilities
  order by created_at
  limit 1
),
fallback_user as (
  select id as user_id
  from public.users
  order by created_at
  limit 1
),
target as (
  select
    coalesce(ctx.facility_id, ff.facility_id) as facility_id,
    coalesce(ctx.user_id, fu.user_id) as user_id
  from ctx
  cross join fallback_facility ff
  cross join fallback_user fu
  limit 1
),
item_rows as (
  select * from (
    values
      ('Amoxicillin 500mg Capsule', 'Amoxicillin', 'Capsule', '500mg', 'capsule', 'Antibiotic', 100, 1000, 1.20),
      ('Amoxicillin-Clavulanate 625mg Tablet', 'Amoxicillin-Clavulanic Acid', 'Tablet', '625mg', 'tablet', 'Antibiotic', 120, 1200, 2.40),
      ('Paracetamol 500mg Tablet', 'Paracetamol', 'Tablet', '500mg', 'tablet', 'Analgesic', 200, 2000, 0.05),
      ('Ceftriaxone 1g Vial', 'Ceftriaxone', 'Injection', '1g', 'vial', 'Antibiotic', 50, 500, 4.50),
      ('Normal Saline 1L', 'Sodium Chloride', 'IV Fluid', '0.9%', 'bottle', 'Fluids', 80, 800, 1.10),
      ('Rapid Malaria Test', 'Malaria Ag', 'Test Kit', 'Single-use', 'kit', 'Diagnostics', 30, 300, 0.90)
  ) as v(name, generic_name, dosage_form, strength, unit_of_measure, category, reorder_level, max_stock_level, unit_cost)
),
supplier as (
  insert into public.suppliers (
    name, contact_person, phone, email, address, facility_id, created_by
  )
  select
    'MedSupply Ltd',
    'Alemu Bekele',
    '+251911000111',
    'orders@medsupply.et',
    'Addis Ababa, Ethiopia',
    target.facility_id,
    target.user_id
  from target
  on conflict (facility_id, name) do update set updated_at = now()
  returning id
),
ins_items as (
  insert into public.inventory_items (
    name, generic_name, dosage_form, strength, unit_of_measure,
    category, reorder_level, max_stock_level, unit_cost,
    facility_id, created_by
  )
  select
    v.name, v.generic_name, v.dosage_form, v.strength, v.unit_of_measure,
    v.category, v.reorder_level, v.max_stock_level, v.unit_cost,
    target.facility_id, target.user_id
  from item_rows v
  cross join target
  on conflict (facility_id, name) do nothing
  returning id, name, facility_id
),
existing_items as (
  select id, name, facility_id
  from public.inventory_items
  where facility_id = (select facility_id from target)
    and name in (select name from item_rows)
),
items as (
  select * from ins_items
  union all
  select * from existing_items
),
seed_receipts as (
  select i.id as inventory_item_id, r.qty, r.cost
  from items i
  join (
    values
      ('Amoxicillin 500mg Capsule', 600, 1.20),
      ('Amoxicillin-Clavulanate 625mg Tablet', 800, 2.40),
      ('Paracetamol 500mg Tablet', 1500, 0.05),
      ('Ceftriaxone 1g Vial', 300, 4.50),
      ('Normal Saline 1L', 500, 1.10),
      ('Rapid Malaria Test', 200, 0.90)
  ) as r(name, qty, cost)
    on r.name = i.name
),
insert_receipts as (
  insert into public.stock_movements (
    inventory_item_id, movement_type, quantity, balance_after,
    batch_number, expiry_date, supplier_id,
    facility_id, unit_cost, total_cost, notes, created_by
  )
  select
    s.inventory_item_id,
    'receipt',
    s.qty,
    s.qty,
    concat('BATCH-', to_char(now(), 'YYYYMMDD')),
    now() + interval '12 months',
    (select id from supplier limit 1),
    (select facility_id from target),
    s.cost,
    s.qty * s.cost,
    'Sample seed stock',
    (select user_id from target)
  from seed_receipts s
  where not exists (
    select 1 from public.stock_movements sm
    where sm.inventory_item_id = s.inventory_item_id
      and sm.notes = 'Sample seed stock'
  )
  returning id
)
select
  'Seed completed' as status,
  (select count(*) from items) as items_available,
  (select count(*) from insert_receipts) as receipts_inserted;

-- After running, verify with: select * from current_stock order by name;
