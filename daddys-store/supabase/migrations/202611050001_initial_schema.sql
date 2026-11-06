-- DADDYS STORE schema for Supabase Postgres.
-- Apply this entire file in Supabase SQL Editor before the first deploy.
create extension if not exists pgcrypto;

create table if not exists public.admins (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  password_hash text not null,
  created_at timestamptz not null default now(),
  last_login timestamptz
);

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null unique,
  phone text not null default '',
  password_hash text not null,
  email_verified boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.auth_tokens (
  token_hash text primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  purpose text not null check (purpose in ('verify_email','password_reset')),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_auth_tokens_user_purpose on public.auth_tokens(user_id,purpose,created_at desc);

create table if not exists public.settings (
  key text primary key,
  value_json jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.accounts (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  sku text not null unique,
  title text not null,
  description text not null default '',
  price_paise bigint not null check (price_paise >= 0),
  status text not null default 'draft' check (status in ('draft','available','reserved','sold')),
  featured boolean not null default false,
  verified boolean not null default false,
  account_level integer not null default 1,
  mythic_count integer not null default 0,
  legendary_count integer not null default 0,
  xsuit_count integer not null default 0,
  gun_labs integer not null default 0,
  glacier_level integer not null default 0 check (glacier_level between 0 and 7),
  rp_level integer not null default 0,
  inventory_json jsonb not null default '{}'::jsonb,
  gallery_json jsonb not null default '[]'::jsonb,
  glacier_images_json jsonb not null default '{}'::jsonb,
  video_url text not null default '',
  seller_name text not null default '',
  seller_submission_id uuid,
  views bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_accounts_status_price on public.accounts(status,price_paise);
create index if not exists idx_accounts_created on public.accounts(created_at desc);

create table if not exists public.catalog_items (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text not null,
  rarity text not null default '',
  image_url text not null default '',
  description text not null default '',
  metadata_json jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(name,category)
);
create index if not exists idx_catalog_category on public.catalog_items(category,active);

create table if not exists public.account_items (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  catalog_item_id uuid not null references public.catalog_items(id) on delete cascade,
  upgrade_level integer not null default 0,
  quantity integer not null default 1,
  created_at timestamptz not null default now(),
  unique(account_id,catalog_item_id)
);

create table if not exists public.uc_packages (
  id uuid primary key default gen_random_uuid(),
  sku text not null unique,
  name text not null,
  uc_amount integer not null check (uc_amount > 0),
  price_paise bigint not null check (price_paise >= 0),
  description text not null default '',
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.seller_submissions (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique,
  access_hash text not null,
  user_id uuid references public.users(id) on delete set null,
  seller_name text not null,
  email text not null,
  whatsapp text not null,
  expected_price_paise bigint not null,
  payload_json jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  admin_note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_sellers_created on public.seller_submissions(created_at desc);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique,
  access_hash text not null,
  user_id uuid references public.users(id) on delete set null,
  customer_name text not null,
  email text not null default '',
  whatsapp text not null,
  player_id text not null default '',
  subtotal_paise bigint not null,
  total_paise bigint not null,
  status text not null default 'pending',
  payment_status text not null default 'pending',
  payment_method text not null check (payment_method in ('upi','whatsapp','telegram')),
  payment_ref text not null default '',
  items_json jsonb not null default '[]'::jsonb,
  admin_note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_orders_created on public.orders(created_at desc);
create unique index if not exists idx_orders_unique_payment_ref on public.orders(payment_ref) where payment_ref <> '';

create table if not exists public.wishlist (
  id uuid primary key default gen_random_uuid(),
  visitor_id text not null,
  account_id uuid not null references public.accounts(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique(visitor_id,account_id)
);

create table if not exists public.price_alerts (
  id uuid primary key default gen_random_uuid(),
  visitor_id text not null,
  account_id uuid not null references public.accounts(id) on delete cascade,
  email text not null,
  target_price_paise bigint not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique(visitor_id,account_id,email)
);
create table if not exists public.alert_events (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  account_id uuid not null,
  message text not null,
  sent boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.api_rate_limits (
  rate_key text primary key,
  window_started timestamptz not null,
  attempts integer not null
);

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null,
  action text not null,
  entity text not null,
  entity_id text not null default '',
  detail text not null default '',
  created_at timestamptz not null default now()
);

-- Store defaults. Admin settings are intentionally initialized with blank contact/payment data.
insert into public.settings(key,value_json) values
('store', '{"name":"DADDYS STORE","tagline":"THE ULTIMATE BGMI MARKETPLACE","whatsapp":"","telegram":"","support_email":"","hero_title":"ENTER THE ARMORY","hero_subtitle":"Explore premium inventories, rare collections and authorized UC packages.","hero_image":"/assets/daddys-store-hero.svg"}'::jsonb),
('payments', '{"upi_enabled":true,"upi_id":"","payee_name":"DADDYS STORE","qr_image":"","whatsapp_enabled":true,"telegram_enabled":true,"default_method":"whatsapp","instructions":"Orders are confirmed after manual payment verification."}'::jsonb),
('policies', '{"account_sales_enabled":false,"terms_url":"/terms","privacy_url":"/privacy","authorization_note":"Only list inventory and transfers for which you hold the required rights and authorization."}'::jsonb)
on conflict(key) do nothing;

-- Atomic checkout: fetches all prices on the server and reserves accounts under row locks.
create or replace function public.create_store_order(
  p_reference text, p_access_hash text, p_user_id uuid, p_customer_name text,
  p_email text, p_whatsapp text, p_player_id text, p_payment_method text, p_items jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_item jsonb; v_type text; v_id uuid; v_qty integer; v_row record;
  v_lines jsonb := '[]'::jsonb; v_subtotal bigint := 0; v_line bigint;
  v_order_id uuid := gen_random_uuid();
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 30 then
    raise exception 'Cart is invalid';
  end if;
  for v_item in select value from jsonb_array_elements(p_items) loop
    v_type := v_item->>'item_type';
    v_id := (v_item->>'item_id')::uuid;
    v_qty := coalesce((v_item->>'quantity')::integer,1);
    if v_qty < 1 or v_qty > 10 then raise exception 'Invalid item quantity'; end if;
    if v_type = 'account' then
      if v_qty <> 1 then raise exception 'BGMI accounts are single-quantity listings'; end if;
      select id,slug,title,price_paise,status into v_row from public.accounts where id=v_id for update;
      if not found or v_row.status <> 'available' then raise exception 'An account in your cart is no longer available'; end if;
      v_line := v_row.price_paise;
      v_lines := v_lines || jsonb_build_array(jsonb_build_object('type','account','id',v_row.id,'slug',v_row.slug,'title',v_row.title,'price_paise',v_line,'quantity',1));
      update public.accounts set status='reserved',updated_at=now() where id=v_id and status='available';
      if not found then raise exception 'An account was just reserved by another customer. Refresh your cart.'; end if;
    elsif v_type = 'uc' then
      select id,sku,name,uc_amount,price_paise into v_row from public.uc_packages where id=v_id and active=true;
      if not found then raise exception 'UC package not available'; end if;
      v_line := v_row.price_paise * v_qty;
      v_lines := v_lines || jsonb_build_array(jsonb_build_object('type','uc','id',v_row.id,'sku',v_row.sku,'title',v_row.name,'uc_amount',v_row.uc_amount,'price_paise',v_row.price_paise,'quantity',v_qty,'line_total_paise',v_line));
    else
      raise exception 'Invalid cart item type';
    end if;
    v_subtotal := v_subtotal + v_line;
  end loop;
  insert into public.orders(id,reference,access_hash,user_id,customer_name,email,whatsapp,player_id,subtotal_paise,total_paise,status,payment_status,payment_method,items_json,created_at,updated_at)
  values(v_order_id,p_reference,p_access_hash,p_user_id,p_customer_name,lower(p_email),p_whatsapp,p_player_id,v_subtotal,v_subtotal,'pending','pending',p_payment_method,v_lines,now(),now());
  return jsonb_build_object('id',v_order_id,'reference',p_reference,'total_paise',v_subtotal,'items',v_lines);
end;
$$;
revoke all on function public.create_store_order(text,text,uuid,text,text,text,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.create_store_order(text,text,uuid,text,text,text,text,text,jsonb) to service_role;

create or replace function public.bump_account_views(p_account_id uuid) returns void
language sql security definer set search_path = public as $$
  update public.accounts set views=views+1 where id=p_account_id;
$$;
revoke all on function public.bump_account_views(uuid) from public, anon, authenticated;
grant execute on function public.bump_account_views(uuid) to service_role;

-- All application table access is through the trusted Netlify Function using the DB pool.
-- Enable RLS and intentionally create no anon/authenticated policies.
do $$ declare t text; begin
  foreach t in array array['admins','users','auth_tokens','settings','accounts','catalog_items','account_items','uc_packages','seller_submissions','orders','wishlist','price_alerts','alert_events','api_rate_limits','audit_logs'] loop
    execute format('alter table public.%I enable row level security',t);
  end loop;
end $$;

-- Public product/account media. Seller proof is private and accessed by signed URLs only.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('daddys-store-media','daddys-store-media',true,26214400,array['image/jpeg','image/png','image/webp','image/gif','video/mp4','video/webm'])
on conflict(id) do update set public=true,file_size_limit=26214400,allowed_mime_types=excluded.allowed_mime_types;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('daddys-seller-proof','daddys-seller-proof',false,10485760,array['image/jpeg','image/png','image/webp'])
on conflict(id) do update set public=false,file_size_limit=10485760,allowed_mime_types=excluded.allowed_mime_types;