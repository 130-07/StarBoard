-- Run once in a new Supabase project's SQL Editor. No credentials belong here.
-- All writes lock one board row, so concurrent registrations cannot overwrite
-- each other. Retries use a request UUID and cannot award the same action twice.
begin;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create schema if not exists star_private;
revoke all on schema star_private from public, anon, authenticated;

create table if not exists star_private.boards (
  id uuid primary key default gen_random_uuid(),
  token_hash text unique not null,
  state jsonb not null,
  revision bigint not null default 0,
  created_at timestamptz not null default now()
);
create table if not exists star_private.requests (
  board_id uuid not null references star_private.boards(id) on delete cascade,
  request_id uuid not null,
  payload_hash text not null,
  created_at timestamptz not null default now(),
  primary key(board_id,request_id)
);
alter table star_private.boards enable row level security;
alter table star_private.requests enable row level security;
revoke all on all tables in schema star_private from public, anon, authenticated;

create or replace function star_private.total(s jsonb)
returns integer language sql immutable set search_path = '' as $$
  select (s->>'carry')::integer + coalesce(sum((e->>'points')::integer),0)::integer
  from jsonb_array_elements(s->'entries') as e
  where (e->>'round')::integer=(s->>'round')::integer;
$$;

create or replace function star_private.winner(s jsonb)
returns text language sql immutable set search_path = '' as $$
  with tally as (
    select v->>'event' as event,count(*) as n
    from jsonb_array_elements(s->'poll'->'votes') as v
    group by v->>'event'
  ), top_choices as (select event from tally where n=(select max(n) from tally))
  select case when count(*)=1 then min(event) else null end from top_choices;
$$;
revoke all on function star_private.total(jsonb) from public,anon,authenticated;
revoke all on function star_private.winner(jsonb) from public,anon,authenticated;

-- Only the project owner can create boards from the SQL Editor. This function
-- is deliberately NOT executable by the browser's anon/authenticated roles.
create or replace function public.star_create_board()
returns text language plpgsql security definer set search_path = '' as $$
declare token text := encode(extensions.gen_random_bytes(32),'hex');
begin
  insert into star_private.boards(token_hash,state)
  values(encode(extensions.digest(token,'sha256'),'hex'),
    '{"round":1,"carry":0,"entries":[],"events":0,"poll":{"votes":[],"closed":false,"winner":null}}'::jsonb);
  return token;
end;
$$;
revoke all on function public.star_create_board() from public,anon,authenticated;

create or replace function public.star_read(p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare b star_private.boards%rowtype;
begin
  if p_token is null or p_token !~ '^[a-fA-F0-9]{64}$' then
    raise exception 'Open the complete team link.';
  end if;
  select * into b from star_private.boards
    where token_hash=encode(extensions.digest(p_token,'sha256'),'hex');
  if not found then raise exception 'This team link is not valid.'; end if;
  return b.state || jsonb_build_object('revision',b.revision);
end;
$$;
revoke all on function public.star_read(text) from public;
grant execute on function public.star_read(text) to anon,authenticated;

create or replace function public.star_apply(
  p_token text, p_action text, p_data jsonb, p_request_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  b star_private.boards%rowtype;
  s jsonb; entry jsonb; last_entry jsonb; votes jsonb;
  task_id integer; label text; pts integer; person text; reference_text text;
  event_id text; winner text; n integer; normalized_name text;
  payload_hash text; old_payload_hash text;
  labels text[] := array['Close major DV','Close weekly sterile documentation','Trend report',
    'Re-validation','Initial validation','Monitoring','APS','FMECA','ECC','CA','Cycle development','Close minor DV'];
  task_points integer[] := array[4,7,5,8,10,3,5,10,2,4,8,1];
begin
  if p_request_id is null or p_data is null or jsonb_typeof(p_data)<>'object' then
    raise exception 'Invalid registration request.';
  end if;
  if p_token is null or p_token !~ '^[a-fA-F0-9]{64}$' then
    raise exception 'Open the complete team link.';
  end if;
  select * into b from star_private.boards
    where token_hash=encode(extensions.digest(p_token,'sha256'),'hex') for update;
  if not found then raise exception 'This team link is not valid.'; end if;
  payload_hash := encode(extensions.digest(jsonb_build_object('action',p_action,'data',p_data)::text,'sha256'),'hex');
  select r.payload_hash into old_payload_hash from star_private.requests r
    where r.board_id=b.id and r.request_id=p_request_id;
  if found then
    if old_payload_hash<>payload_hash then
      raise exception 'A retry must contain the original action. Close and reopen the form to register a different task.';
    end if;
    return b.state || jsonb_build_object('revision',b.revision);
  end if;
  s:=b.state;
  n:=star_private.total(s);

  case p_action
  when 'register' then
    if n>=100 then raise exception 'This round is complete. Start the next round first.'; end if;
    if p_data->>'task'='custom' then
      label:=btrim(p_data->>'title');
      if label is null or length(label)=0 or length(label)>160 then raise exception 'Task description is required (maximum 160 characters).'; end if;
      if coalesce(p_data->>'points','') !~ '^[0-9]{1,3}$' then raise exception 'Choose a whole number of points from 1 to 100.'; end if;
      pts:=(p_data->>'points')::integer;
      if pts<1 or pts>100 then raise exception 'Choose a whole number of points from 1 to 100.'; end if;
    else
      if coalesce(p_data->>'task','') !~ '^([0-9]|1[01])$' then raise exception 'Choose a valid task.'; end if;
      task_id:=(p_data->>'task')::integer;
      label:=labels[task_id+1];pts:=task_points[task_id+1];
    end if;
    person:=btrim(p_data->>'name');reference_text:=btrim(p_data->>'reference');
    if person is null or length(person)=0 or length(person)>100 then raise exception 'Performed by is required (maximum 100 characters).'; end if;
    if reference_text is null or length(reference_text)=0 or length(reference_text)>2000 then raise exception 'Reference is required (maximum 2000 characters).'; end if;
    entry:=jsonb_build_object('id',p_request_id::text,'taskLabel',label,'points',pts,'name',person,
      'reference',reference_text,'round',(s->>'round')::integer,
      'time',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
    s:=jsonb_set(s,'{entries}',(s->'entries')||jsonb_build_array(entry));
    if n+pts>=100 then s:=jsonb_set(s,'{events}',to_jsonb((s->>'events')::integer+1)); end if;

  when 'undo' then
    last_entry:=s->'entries'->-1;
    if last_entry is null or last_entry->>'id' is distinct from p_data->>'id'
      or (last_entry->>'round')::integer<>(s->>'round')::integer then
      raise exception 'The log changed. Please select Undo again.';
    end if;
    s:=jsonb_set(s,'{entries}',(s->'entries')-(-1));
    if n>=100 and n-(last_entry->>'points')::integer<100 then
      s:=jsonb_set(s,'{events}',to_jsonb((s->>'events')::integer-1));
    end if;

  when 'next' then
    if n<100 then raise exception 'Reach 100 points before starting a new round.'; end if;
    s:=jsonb_set(s,'{carry}',to_jsonb(n-100));
    s:=jsonb_set(s,'{round}',to_jsonb((s->>'round')::integer+1));

  when 'vote' then
    if (s->'poll'->>'closed')::boolean then raise exception 'Voting is closed.'; end if;
    person:=regexp_replace(btrim(p_data->>'name'),'\s+',' ','g');
    if person is null or length(person)=0 or length(person)>100 then raise exception 'Your name is required (maximum 100 characters).'; end if;
    normalized_name:=lower(person);event_id:=p_data->>'event';
    if event_id is null or event_id not in ('escape','shuffle','cook','pottery') then raise exception 'Choose a valid event.'; end if;
    select coalesce(jsonb_agg(v order by ord),'[]'::jsonb) into votes
      from jsonb_array_elements(s->'poll'->'votes') with ordinality as x(v,ord)
      where lower(regexp_replace(btrim(v->>'name'),'\s+',' ','g'))<>normalized_name;
    votes:=votes||jsonb_build_array(jsonb_build_object('name',person,'event',event_id));
    s:=jsonb_set(s,'{poll,votes}',votes);

  when 'finalize' then
    winner:=star_private.winner(s);
    if winner is null then raise exception 'A clear winner is needed to finalize voting.'; end if;
    s:=jsonb_set(s,'{poll,closed}','true'::jsonb);
    s:=jsonb_set(s,'{poll,winner}',to_jsonb(winner));

  when 'reopen' then
    s:=jsonb_set(s,'{poll,closed}','false'::jsonb);
    s:=jsonb_set(s,'{poll,winner}','null'::jsonb);
  else raise exception 'Unknown action.';
  end case;

  update star_private.boards set state=s,revision=revision+1 where id=b.id;
  insert into star_private.requests(board_id,request_id,payload_hash) values(b.id,p_request_id,payload_hash);
  return s || jsonb_build_object('revision',b.revision+1);
end;
$$;
revoke all on function public.star_apply(text,text,jsonb,uuid) from public;
grant execute on function public.star_apply(text,text,jsonb,uuid) to anon,authenticated;
commit;

-- Next, run SEPARATELY in SQL Editor:
-- select public.star_create_board();
-- Keep that result private. Add it to the deployed URL as #board=THE_RESULT.
-- Do not commit this result to GitHub or put it in config.js.
