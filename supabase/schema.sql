create table if not exists public.wealth_engine_accounts (
  user_id uuid primary key references auth.users (id) on delete cascade,
  data jsonb not null default '{"plan":null,"scenarios":{},"actuals":[],"debts":[],"savings_goals":[]}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint wealth_engine_accounts_data_is_object
    check (jsonb_typeof(data) = 'object')
);

alter table public.wealth_engine_accounts enable row level security;

revoke all on public.wealth_engine_accounts from anon, public;
grant select, insert, update, delete on public.wealth_engine_accounts to authenticated;

drop policy if exists "Users can read their own Wealth Engine data"
  on public.wealth_engine_accounts;
create policy "Users can read their own Wealth Engine data"
  on public.wealth_engine_accounts for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can create their own Wealth Engine data"
  on public.wealth_engine_accounts;
create policy "Users can create their own Wealth Engine data"
  on public.wealth_engine_accounts for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own Wealth Engine data"
  on public.wealth_engine_accounts;
create policy "Users can update their own Wealth Engine data"
  on public.wealth_engine_accounts for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete their own Wealth Engine data"
  on public.wealth_engine_accounts;
create policy "Users can delete their own Wealth Engine data"
  on public.wealth_engine_accounts for delete to authenticated
  using (auth.uid() = user_id);
