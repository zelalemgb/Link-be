-- Persist uploaded external diagnostic source files and link them to clinical orders.
create table if not exists public.external_diagnostic_documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  facility_id uuid null references public.facilities(id) on delete set null,
  patient_id uuid not null references public.patients(id) on delete cascade,
  visit_id uuid not null references public.visits(id) on delete cascade,
  order_type text not null check (order_type in ('lab_test', 'imaging')),
  order_id uuid not null,
  storage_bucket text not null default 'patient-health-records',
  storage_path text not null,
  file_url text not null,
  original_filename text not null,
  mime_type text not null,
  file_size_bytes bigint not null,
  ai_extracted_text text null,
  uploaded_by uuid null references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_external_diag_docs_tenant
  on public.external_diagnostic_documents (tenant_id, created_at desc);

create index if not exists idx_external_diag_docs_patient_visit
  on public.external_diagnostic_documents (patient_id, visit_id, created_at desc);

create index if not exists idx_external_diag_docs_order
  on public.external_diagnostic_documents (order_type, order_id, created_at desc);

drop trigger if exists trg_external_diagnostic_documents_updated_at on public.external_diagnostic_documents;
create trigger trg_external_diagnostic_documents_updated_at
before update on public.external_diagnostic_documents
for each row execute function public.update_updated_at_column();

alter table public.external_diagnostic_documents enable row level security;
