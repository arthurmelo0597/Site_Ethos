-- =====================================================================
-- Ethos · Encontro com Deus — banco de dados (Supabase / PostgreSQL)
--
-- COMO USAR: Supabase > SQL Editor > New query > cole TUDO > Run.
-- ANTES de rodar: troque SEU_EMAIL_AQUI e SEU_NOME_AQUI (2 lugares no
-- final do arquivo) pelo e-mail e nome do primeiro Obreiro (você).
-- Pode rodar de novo sem medo: o arquivo é seguro para repetir.
-- =====================================================================

-- ---------------------------------------------------------------- tabelas
create table if not exists public.discipulados (
  id bigint generated always as identity primary key,
  nome text not null unique check (char_length(nome) between 1 and 80),
  vagas_encontrista int not null default 0 check (vagas_encontrista >= 0),
  vagas_servo int not null default 0 check (vagas_servo >= 0)
);

-- Quem o Obreiro convidou. Só e-mails desta tabela ganham acesso.
create table if not exists public.convites (
  email text primary key check (email = lower(email) and char_length(email) <= 120),
  nome text not null check (char_length(nome) between 1 and 80),
  nivel text not null check (nivel in ('obreiro','discipulador','lider')),
  discipulado_id bigint references public.discipulados(id) on delete cascade,
  senha_ok boolean not null default false,   -- true só para o Obreiro criado pelo painel do Supabase
  enviado_em timestamptz,                    -- preenchido pelo robô quando o e-mail de convite sai
  erro text,
  criado_em timestamptz not null default now(),
  check (nivel = 'obreiro' or discipulado_id is not null)
);

create table if not exists public.perfis (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  nome text not null,
  nivel text not null check (nivel in ('obreiro','discipulador','lider')),
  discipulado_id bigint references public.discipulados(id),
  le int check (le is null or le >= 0),      -- limite de Encontrista (líder)
  ls int check (ls is null or ls >= 0),      -- limite de Servo (líder)
  servo_livre boolean not null default false,
  senha_definida boolean not null default false,
  criado_em timestamptz not null default now(),
  check (nivel = 'obreiro' or discipulado_id is not null)
);

create table if not exists public.config (
  chave text primary key check (chave in ('link_encontrista','link_servo')),
  valor text not null default ''
);
insert into public.config(chave, valor) values ('link_encontrista',''), ('link_servo','')
  on conflict (chave) do nothing;

-- Vagas lidas pelo robô nas páginas da Videira
create table if not exists public.vagas_site (
  tipo text primary key check (tipo in ('encontrista','servo')),
  disponiveis int,
  atualizado_em timestamptz not null default now()
);

-- Sinal de vida do robô
create table if not exists public.robo_status (
  id int primary key default 1 check (id = 1),
  visto_em timestamptz not null default now()
);

create table if not exists public.inscricoes (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users(id) on delete set null,
  por text not null,
  discipulado_id bigint not null references public.discipulados(id),
  tipo text not null check (tipo in ('encontrista','servo')),
  nome text not null check (char_length(nome) <= 120),
  email text not null check (char_length(email) <= 120),
  telefone text not null check (char_length(telefone) <= 30),
  sexo text not null check (sexo in ('Masculino','Feminino')),
  nascimento date not null,
  endereco text not null default '' check (char_length(endereco) <= 250),
  discipulador text not null check (char_length(discipulador) <= 120),
  lider text not null check (char_length(lider) <= 120),
  obs text not null default '' check (char_length(obs) <= 500),
  status text not null default 'pendente'
    check (status in ('pendente','processando','ok','erro','cancelado')),
  pix text,
  erro text,
  criado_em timestamptz not null default now(),
  iniciado_em timestamptz
);
create index if not exists ix_insc_cota on public.inscricoes(discipulado_id, tipo, status);
create index if not exists ix_insc_user on public.inscricoes(user_id);
create index if not exists ix_insc_fila on public.inscricoes(status, id);

-- ---------------------------------------------------------------- funções auxiliares
-- (security definer: leem a tabela perfis sem cair na própria regra de acesso)
create or replace function public.meu_nivel() returns text
language sql stable security definer set search_path = public as
$$ select nivel from public.perfis where id = auth.uid() $$;

create or replace function public.meu_disc() returns bigint
language sql stable security definer set search_path = public as
$$ select discipulado_id from public.perfis where id = auth.uid() $$;

create or replace function public.sou_obreiro() returns boolean
language sql stable security definer set search_path = public as
$$ select coalesce((select nivel = 'obreiro' from public.perfis where id = auth.uid()), false) $$;

create or replace function public._usadas(p_disc bigint, p_tipo text, p_user uuid default null) returns int
language sql stable security definer set search_path = public as
$$ select count(*)::int from public.inscricoes
   where discipulado_id = p_disc and tipo = p_tipo and status in ('pendente','processando','ok')
     and (p_user is null or user_id = p_user) $$;

-- vagas que ainda restam para aquela pessoa (considera o limite do líder)
create or replace function public._restante(p public.perfis, p_disc bigint, p_tipo text) returns int
language plpgsql stable security definer set search_path = public as $$
declare tot int; r int; lim int;
begin
  select case p_tipo when 'encontrista' then vagas_encontrista else vagas_servo end
    into tot from public.discipulados where id = p_disc;
  r := greatest(coalesce(tot, 0) - public._usadas(p_disc, p_tipo), 0);
  if p.nivel = 'lider' then
    lim := case p_tipo when 'encontrista' then p.le else p.ls end;
    if lim is not null then
      r := least(r, greatest(lim - public._usadas(p_disc, p_tipo, p.id), 0));
    end if;
  end if;
  return r;
end $$;

-- Servo só é liberado depois que o líder fez um Encontrista concluído (ou se o Obreiro liberou)
create or replace function public._servo_liberado(p public.perfis) returns boolean
language sql stable security definer set search_path = public as
$$ select p.nivel = 'obreiro' or p.servo_livre
       or exists (select 1 from public.inscricoes
                  where user_id = p.id and tipo = 'encontrista' and status = 'ok') $$;

-- ---------------------------------------------------------------- novo usuário => perfil (só se foi convidado)
create or replace function public.novo_usuario() returns trigger
language plpgsql security definer set search_path = public as $$
declare cv public.convites%rowtype;
begin
  select * into cv from public.convites where email = lower(new.email);
  if found then
    insert into public.perfis(id, email, nome, nivel, discipulado_id, senha_definida)
    values (new.id, lower(new.email), cv.nome, cv.nivel, cv.discipulado_id, cv.senha_ok)
    on conflict (id) do nothing;
  end if;
  return new;
end $$;

drop trigger if exists ao_criar_usuario on auth.users;
create trigger ao_criar_usuario after insert on auth.users
  for each row execute function public.novo_usuario();

-- ---------------------------------------------------------------- funções chamadas pelo site
create or replace function public.saldo_disc(p_disc bigint) returns json
language plpgsql stable security definer set search_path = public as $$
declare p public.perfis; d public.discipulados;
begin
  select * into p from public.perfis where id = auth.uid();
  if not found then raise exception 'Acesso negado'; end if;
  if p.nivel <> 'obreiro' and p.discipulado_id is distinct from p_disc then raise exception 'Acesso negado'; end if;
  select * into d from public.discipulados where id = p_disc;
  if not found then raise exception 'Discipulado inválido'; end if;
  return json_build_object(
    'encontrista', public._restante(p, p_disc, 'encontrista'),
    'servo', public._restante(p, p_disc, 'servo'),
    'servo_liberado', public._servo_liberado(p),
    'usadas_e', public._usadas(p_disc, 'encontrista'), 'usadas_s', public._usadas(p_disc, 'servo'),
    'vagas_e', d.vagas_encontrista, 'vagas_s', d.vagas_servo, 'le', p.le, 'ls', p.ls);
end $$;

create or replace function public.criar_inscricao(
  p_disc bigint, p_tipo text, p_nome text, p_email text, p_telefone text, p_sexo text,
  p_nascimento date, p_endereco text, p_discipulador text, p_lider text, p_obs text) returns bigint
language plpgsql security definer set search_path = public as $$
declare p public.perfis; did bigint; novo bigint; vs public.vagas_site;
begin
  select * into p from public.perfis where id = auth.uid();
  if not found then raise exception 'Acesso negado'; end if;
  if p.nivel not in ('obreiro','lider') then raise exception 'Seu nível não pode fazer inscrições'; end if;
  did := case when p.nivel = 'obreiro' then p_disc else p.discipulado_id end;
  if did is null or not exists (select 1 from public.discipulados where id = did) then
    raise exception 'Discipulado inválido'; end if;
  if p_tipo not in ('encontrista','servo') then raise exception 'Tipo inválido'; end if;

  p_nome := btrim(coalesce(p_nome,'')); p_email := lower(btrim(coalesce(p_email,'')));
  p_telefone := btrim(coalesce(p_telefone,'')); p_discipulador := btrim(coalesce(p_discipulador,''));
  p_lider := btrim(coalesce(p_lider,'')); p_endereco := btrim(coalesce(p_endereco,''));
  p_obs := btrim(coalesce(p_obs,''));
  if p_nome = '' or p_telefone = '' or p_discipulador = '' or p_lider = '' or p_nascimento is null then
    raise exception 'Preencha todos os campos obrigatórios'; end if;
  if p_email !~ '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$' then raise exception 'E-mail inválido'; end if;
  if p_sexo not in ('Masculino','Feminino') then raise exception 'Sexo inválido'; end if;
  if p_nascimento > current_date or p_nascimento < date '1900-01-01' then
    raise exception 'Data de nascimento inválida'; end if;
  if char_length(p_nome) > 120 or char_length(p_telefone) > 30 or char_length(p_discipulador) > 120
     or char_length(p_lider) > 120 or char_length(p_endereco) > 250 or char_length(p_obs) > 500 then
    raise exception 'Algum campo está longo demais'; end if;

  perform pg_advisory_xact_lock(did);  -- evita duas inscrições disputando a mesma última vaga
  select * into vs from public.vagas_site where tipo = p_tipo;
  if found and vs.disponiveis = 0 and vs.atualizado_em > now() - interval '15 minutes' then
    raise exception 'Não há mais vagas de % no site', p_tipo; end if;
  if p_tipo = 'servo' and not public._servo_liberado(p) then
    raise exception 'Servo só é liberado depois da inscrição de Encontrista (ou se o Obreiro liberar)'; end if;
  if public._restante(p, did, p_tipo) <= 0 then
    raise exception 'Sem vagas disponíveis (ou limite do líder atingido)'; end if;

  insert into public.inscricoes(user_id, por, discipulado_id, tipo, nome, email, telefone, sexo, nascimento,
                                endereco, discipulador, lider, obs)
  values (p.id, p.nome, did, p_tipo, p_nome, p_email, p_telefone, p_sexo, p_nascimento,
          p_endereco, p_discipulador, p_lider, p_obs)
  returning id into novo;
  return novo;
end $$;

create or replace function public.cancelar_inscricao(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare p public.perfis;
begin
  select * into p from public.perfis where id = auth.uid();
  if not found or p.nivel <> 'obreiro' then raise exception 'Acesso negado'; end if;
  update public.inscricoes
     set status = 'cancelado',
         erro = 'Cancelada por ' || p.nome || ' em ' || to_char(now() at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI')
                || ' (cancele também no site da Videira)'
   where id = p_id and status = 'ok';
  if not found then raise exception 'Só inscrições concluídas podem ser canceladas'; end if;
end $$;

create or replace function public.definir_limites(p_user uuid, p_le int, p_ls int) returns void
language plpgsql security definer set search_path = public as $$
declare me public.perfis; alvo public.perfis; d public.discipulados;
begin
  select * into me from public.perfis where id = auth.uid();
  if not found or me.nivel not in ('obreiro','discipulador') then raise exception 'Acesso negado'; end if;
  select * into alvo from public.perfis where id = p_user and nivel = 'lider';
  if not found or (me.nivel = 'discipulador' and alvo.discipulado_id is distinct from me.discipulado_id) then
    raise exception 'Líder inválido'; end if;
  select * into d from public.discipulados where id = alvo.discipulado_id;
  if (p_le is not null and (p_le < 0 or p_le > d.vagas_encontrista))
     or (p_ls is not null and (p_ls < 0 or p_ls > d.vagas_servo)) then
    raise exception 'O limite não pode passar das vagas do discipulado'; end if;
  update public.perfis set le = p_le, ls = p_ls where id = p_user;
end $$;

-- Cria/atualiza um discipulado. Para AUMENTAR vagas, respeita as vagas livres do site.
create or replace function public.salvar_discipulado(p_nome text, p_ve int, p_vs int) returns void
language plpgsql security definer set search_path = public as $$
declare d public.discipulados; t text; novo int; antigo int; site int; rest int; usada int; maximo int;
begin
  if not public.sou_obreiro() then raise exception 'Acesso negado'; end if;
  p_nome := btrim(coalesce(p_nome,''));
  if p_nome = '' or char_length(p_nome) > 80 then raise exception 'Nome do discipulado inválido'; end if;
  if p_ve is null or p_vs is null or p_ve < 0 or p_vs < 0 then raise exception 'Número de vagas inválido'; end if;
  select * into d from public.discipulados where nome = p_nome;
  foreach t in array array['encontrista','servo'] loop
    novo := case t when 'encontrista' then p_ve else p_vs end;
    antigo := case when d.id is null then 0 when t = 'encontrista' then d.vagas_encontrista else d.vagas_servo end;
    if novo > antigo then   -- manter ou reduzir sempre é permitido
      select disponiveis into site from public.vagas_site where tipo = t;
      if site is null then
        raise exception 'Não consegui ler as vagas de % no site; não dá para aumentar agora. Confira o link e se o robô está ligado.', t; end if;
      select coalesce(sum(greatest((case t when 'encontrista' then x.vagas_encontrista else x.vagas_servo end)
                                   - public._usadas(x.id, t), 0)), 0)::int
        into rest from public.discipulados x where x.id is distinct from d.id;
      usada := case when d.id is null then 0 else public._usadas(d.id, t) end;
      maximo := usada + greatest(site - rest, 0);
      if novo > maximo then
        raise exception '%: o máximo possível para este discipulado é % (o site tem % vaga(s); o restante já está liberado a outros discipulados). Nada foi salvo.',
          initcap(t), maximo, site; end if;
    end if;
  end loop;
  insert into public.discipulados(nome, vagas_encontrista, vagas_servo) values (p_nome, p_ve, p_vs)
  on conflict (nome) do update set vagas_encontrista = excluded.vagas_encontrista, vagas_servo = excluded.vagas_servo;
end $$;

-- Convida alguém. O robô envia o e-mail de convite; quem já tem conta ganha acesso na hora.
create or replace function public.criar_convite(p_email text, p_nome text, p_nivel text, p_disc bigint) returns text
language plpgsql security definer set search_path = public as $$
declare u uuid; cv public.convites;
begin
  if not public.sou_obreiro() then raise exception 'Acesso negado'; end if;
  p_email := lower(btrim(coalesce(p_email,''))); p_nome := btrim(coalesce(p_nome,''));
  if p_email !~ '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$' or char_length(p_email) > 120 then
    raise exception 'E-mail inválido'; end if;
  if p_nome = '' or char_length(p_nome) > 80 then raise exception 'Nome inválido'; end if;
  if p_nivel not in ('obreiro','discipulador','lider') then raise exception 'Nível inválido'; end if;
  if p_nivel <> 'obreiro' and not exists (select 1 from public.discipulados where id = p_disc) then
    raise exception 'Escolha o discipulado deste login'; end if;
  if exists (select 1 from public.perfis where email = p_email) then
    raise exception 'Já existe um login com este e-mail'; end if;
  insert into public.convites(email, nome, nivel, discipulado_id)
  values (p_email, p_nome, p_nivel, case when p_nivel = 'obreiro' then null else p_disc end)
  on conflict (email) do update set nome = excluded.nome, nivel = excluded.nivel,
    discipulado_id = excluded.discipulado_id, enviado_em = null, erro = null
  returning * into cv;
  select id into u from auth.users where lower(email) = p_email;
  if u is not null then   -- já tinha conta: libera o acesso direto
    insert into public.perfis(id, email, nome, nivel, discipulado_id, senha_definida)
    values (u, p_email, cv.nome, cv.nivel, cv.discipulado_id, true)
    on conflict (id) do nothing;
    update public.convites set enviado_em = now() where email = p_email;
    return 'existente';
  end if;
  return 'enfileirado';
end $$;

create or replace function public.reenviar_convite(p_email text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.sou_obreiro() then raise exception 'Acesso negado'; end if;
  update public.convites set enviado_em = null, erro = null where email = lower(btrim(p_email));
  if not found then raise exception 'Convite não encontrado'; end if;
end $$;

create or replace function public.editar_perfil(p_id uuid, p_nivel text, p_disc bigint, p_le int, p_ls int, p_servo_livre boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.sou_obreiro() then raise exception 'Acesso negado'; end if;
  if p_nivel not in ('obreiro','discipulador','lider') then raise exception 'Nível inválido'; end if;
  if p_nivel <> 'obreiro' and not exists (select 1 from public.discipulados where id = p_disc) then
    raise exception 'Escolha o discipulado deste login'; end if;
  if p_id = auth.uid() and p_nivel <> 'obreiro' then
    raise exception 'Você não pode tirar o seu próprio acesso de Obreiro'; end if;
  update public.perfis
     set nivel = p_nivel,
         discipulado_id = case when p_nivel = 'obreiro' then null else p_disc end,
         le = case when p_nivel = 'lider' then p_le end,
         ls = case when p_nivel = 'lider' then p_ls end,
         servo_livre = (p_nivel = 'lider' and coalesce(p_servo_livre, false))
   where id = p_id;
  if not found then raise exception 'Login não encontrado'; end if;
end $$;

create or replace function public.remover_acesso(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare em text;
begin
  if not public.sou_obreiro() then raise exception 'Acesso negado'; end if;
  if p_id = auth.uid() then raise exception 'Você não pode remover o próprio acesso'; end if;
  select email into em from public.perfis where id = p_id;
  delete from public.perfis where id = p_id;
  delete from public.convites where email = em;
end $$;

create or replace function public.salvar_config(p_chave text, p_valor text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.sou_obreiro() then raise exception 'Acesso negado'; end if;
  if p_chave not in ('link_encontrista','link_servo') then raise exception 'Configuração inválida'; end if;
  p_valor := btrim(coalesce(p_valor,''));
  if p_valor <> '' and (p_valor !~ '^https://[^[:space:]]+$' or char_length(p_valor) > 500) then
    raise exception 'O link precisa começar com https:// e não ter espaços'; end if;
  update public.config set valor = p_valor where chave = p_chave;
  delete from public.vagas_site where tipo = replace(p_chave, 'link_', '');  -- o robô lê de novo com o link novo
end $$;

create or replace function public.marcar_senha_definida() returns void
language sql security definer set search_path = public as
$$ update public.perfis set senha_definida = true where id = auth.uid() $$;

-- ---------------------------------------------------------------- segurança (RLS)
alter table public.discipulados enable row level security;
alter table public.convites     enable row level security;
alter table public.perfis       enable row level security;
alter table public.config       enable row level security;
alter table public.vagas_site   enable row level security;
alter table public.robo_status  enable row level security;
alter table public.inscricoes   enable row level security;

drop policy if exists perfis_ler on public.perfis;
create policy perfis_ler on public.perfis for select to authenticated using (
  id = auth.uid() or public.sou_obreiro()
  or (public.meu_nivel() = 'discipulador' and discipulado_id = public.meu_disc()));

drop policy if exists disc_ler on public.discipulados;
create policy disc_ler on public.discipulados for select to authenticated using (
  public.sou_obreiro() or (public.meu_nivel() is not null and id = public.meu_disc()));

drop policy if exists convites_ler on public.convites;
create policy convites_ler on public.convites for select to authenticated using (public.sou_obreiro());

drop policy if exists config_ler on public.config;
create policy config_ler on public.config for select to authenticated using (public.sou_obreiro());

drop policy if exists vagas_ler on public.vagas_site;
create policy vagas_ler on public.vagas_site for select to authenticated
  using (public.meu_nivel() in ('obreiro','discipulador'));

drop policy if exists robo_ler on public.robo_status;
create policy robo_ler on public.robo_status for select to authenticated using (public.meu_nivel() is not null);

drop policy if exists insc_ler on public.inscricoes;
create policy insc_ler on public.inscricoes for select to authenticated using (
  public.sou_obreiro()
  or (public.meu_nivel() = 'discipulador' and discipulado_id = public.meu_disc())
  or (public.meu_nivel() = 'lider' and user_id = auth.uid()));

-- Ninguém escreve direto nas tabelas: só pelas funções acima (e o robô, com a chave secreta).
revoke all on all tables in schema public from anon, authenticated;
grant select on public.discipulados, public.convites, public.perfis, public.config,
                public.vagas_site, public.robo_status, public.inscricoes to authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on functions from public, anon;

revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
revoke execute on function public._restante(public.perfis, bigint, text) from authenticated;
revoke execute on function public._servo_liberado(public.perfis) from authenticated;
revoke execute on function public._usadas(bigint, text, uuid) from authenticated;
revoke execute on function public.novo_usuario() from authenticated;

-- ---------------------------------------------------------------- primeiro Obreiro (VOCÊ)
-- 1) Troque os dois textos abaixo.  2) No Supabase: Authentication > Users > Add user >
-- "Create new user" (e-mail + senha, marque Auto Confirm User). Pode ser antes ou depois de rodar este SQL.
insert into public.convites(email, nome, nivel, senha_ok, enviado_em)
values (lower('SEU_EMAIL_AQUI'), 'SEU_NOME_AQUI', 'obreiro', true, now())
on conflict (email) do nothing;

insert into public.perfis(id, email, nome, nivel, senha_definida)
select u.id, lower(u.email), 'SEU_NOME_AQUI', 'obreiro', true
  from auth.users u where lower(u.email) = lower('SEU_EMAIL_AQUI')
on conflict (id) do nothing;
