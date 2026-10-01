/* Ethos · Encontro com Deus — site (GitHub Pages + Supabase).
   Toda regra de segurança (quem vê o quê, cotas, limites) está no banco (supabase/schema.sql).
   Este arquivo só desenha as telas e chama o banco. */
(function () {
  'use strict';
  const CFG = window.ETHOS_CONFIG || {};
  const app = document.getElementById('app');
  const NIVEIS = { obreiro: 'Obreiro', discipulador: 'Discipulador', lider: 'Líder de célula' };
  const POLL = CFG.POLL_MS || 3000, TICK = CFG.TICK_MS || 6000;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const dt = (x) => (x ? new Date(x).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }) : '');
  const dnasc = (x) => (/^\d{4}-\d{2}-\d{2}$/.test(x || '') ? x.split('-').reverse().join('/') : x || '');
  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');
  const ATIVA = ['pendente', 'processando', 'ok'];

  // ---------------------------------------------------------------- verificação da configuração
  function chaveSecreta(k) {
    if (/^sb_secret_/.test(k)) return true;
    try { return JSON.parse(atob(k.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).role === 'service_role'; } catch (e) { return false; }
  }
  if (!CFG.SUPABASE_URL || !CFG.SUPABASE_KEY || /COLE_AQUI/.test(CFG.SUPABASE_URL + CFG.SUPABASE_KEY)) {
    app.innerHTML = '<div class="card"><h3>Falta configurar</h3><p>Abra o arquivo <code>docs/config.js</code> e cole a URL e a chave <b>publishable</b> do seu Supabase (veja o GUIA.md).</p></div>';
    return;
  }
  if (chaveSecreta(CFG.SUPABASE_KEY)) {
    app.innerHTML = '<div class="card"><h3 class="err">⚠ Chave errada em config.js</h3><p>Você colou a chave <b>secreta</b> (secret/service_role). Ela dá controle total e <b>não pode</b> ficar no site. Troque pela chave <b>publishable</b> (ou anon) e gere uma chave secreta nova no Supabase, pois esta já ficou exposta.</p></div>';
    return;
  }
  const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  // ---------------------------------------------------------------- estado
  const S = {
    session: null, perfil: null, view: 'carregando', aba: 'inscricoes', discSel: null, msg: null, modal: null, aguardando: null,
    disc: [], insc: [], contagem: [], vagasSite: {}, robo: null, saldo: null, config: {}, perfis: [], convites: [], logs: [], recovery: false,
  };
  const eu = () => S.perfil;
  const nivel = () => (S.perfil ? S.perfil.nivel : null);
  const discNome = (id) => { const d = S.disc.find((x) => x.id === id); return d ? d.nome : ''; };

  function flash(t, ok) {
    S.msg = t ? { t, ok: !!ok } : null;
    const el = document.getElementById('msg');
    if (el) el.innerHTML = msgHtml();
    if (t) window.scrollTo(0, 0);
  }
  const msgHtml = () => (S.msg ? `<p class="${S.msg.ok ? 'aviso' : 'alerta'}">${esc(S.msg.t)}</p>` : '');
  function erroAuth(e) {
    const m = ((e && e.message) || '').toLowerCase();
    if (m.includes('invalid login')) return 'E-mail ou senha inválidos.';
    if (m.includes('not confirmed')) return 'Confirme seu e-mail pelo link que enviamos.';
    if (m.includes('rate limit') || (e && e.status === 429)) return 'Muitas tentativas. Aguarde alguns minutos e tente de novo.';
    if (m.includes('password')) return 'Senha recusada. Use 10 ou mais caracteres, com letras e números.';
    return 'Não foi possível concluir. Tente de novo.';
  }
  function senhaOk(s, email) {
    if (s.length < 10) return 'A senha precisa ter pelo menos 10 caracteres.';
    if (!/[A-Za-z]/.test(s) || !/\d/.test(s)) return 'Use letras e números na senha.';
    if (email && (s.toLowerCase() === email.toLowerCase() || s.toLowerCase() === email.split('@')[0].toLowerCase())) return 'A senha não pode ser igual ao e-mail.';
    return '';
  }

  // ---------------------------------------------------------------- acesso aos dados
  async function fetchAll(tabela, cols, filtro) {
    let out = [], de = 0;
    for (;;) {
      let q = sb.from(tabela).select(cols).order('id', { ascending: true }).range(de, de + 999);
      if (filtro) q = filtro(q);
      const { data, error } = await q;
      if (error) throw error;
      out = out.concat(data);
      if (data.length < 1000) return out;
      de += 1000;
    }
  }
  async function carregarPerfil() {
    const { data: u } = await sb.auth.getUser();
    if (!u || !u.user) return null;
    const { data, error } = await sb.from('perfis').select('*').eq('id', u.user.id).maybeSingle();
    if (error) throw error;
    return data;
  }
  async function carregar() {
    const [d, r] = await Promise.all([sb.from('discipulados').select('*').order('nome'), sb.from('robo_status').select('visto_em').maybeSingle()]);
    if (d.error) throw d.error;
    S.disc = d.data; S.robo = r.data ? r.data.visto_em : null;
    if (nivel() === 'obreiro') { if (!S.disc.some((x) => x.id === S.discSel)) S.discSel = S.disc.length ? S.disc[0].id : null; }
    else S.discSel = eu().discipulado_id;
    if (S.aba === 'admin' && nivel() === 'obreiro') await carregarAdmin(); else await carregarInscricoes();
  }
  async function carregarLista() {
    let q = sb.from('inscricoes').select('*').order('id', { ascending: false }).limit(300);
    if (S.discSel) q = q.eq('discipulado_id', S.discSel);
    const { data, error } = await q; if (error) throw error;
    S.insc = data;
  }
  async function carregarVagas() {
    const [c, v] = await Promise.all([fetchAll('inscricoes', 'id,discipulado_id,tipo,status'), sb.from('vagas_site').select('*')]);
    S.contagem = c; S.vagasSite = {};
    (v.data || []).forEach((x) => { S.vagasSite[x.tipo] = x; });
  }
  async function carregarInscricoes() {
    await carregarLista();
    if (nivel() !== 'discipulador' && S.discSel) {
      const { data, error } = await sb.rpc('saldo_disc', { p_disc: S.discSel });
      if (error) throw error; S.saldo = data;
    }
    if (nivel() !== 'lider') await carregarVagas();
    if (nivel() === 'discipulador') {
      const { data } = await sb.from('perfis').select('*').eq('nivel', 'lider').eq('discipulado_id', S.discSel).order('nome');
      S.perfis = data || [];
    }
  }
  async function carregarAdmin() {
    const [cf, pf, cv, lg] = await Promise.all([
      sb.from('config').select('*'), sb.from('perfis').select('*').order('nome'), sb.from('convites').select('*').order('criado_em', { ascending: false }),
      sb.from('inscricoes').select('*').order('id', { ascending: false }).limit(300)]);
    S.config = {}; (cf.data || []).forEach((x) => { S.config[x.chave] = x.valor; });
    S.perfis = pf.data || []; S.convites = cv.data || []; S.logs = lg.data || [];
    await carregarVagas();
  }

  // ---------------------------------------------------------------- inicialização / sessão
  async function boot() {
    try {
      if (!S.session) { S.view = S.view === 'esqueci' ? 'esqueci' : 'login'; S.perfil = null; return render(); }
      if (S.recovery) { S.view = 'novasenha'; return render(); }
      S.perfil = await carregarPerfil();
      if (!S.perfil) { S.view = 'semacesso'; return render(); }
      if (!S.perfil.senha_definida) { S.view = 'novasenha'; return render(); }
      S.view = 'app';
      await carregar();
      render();
    } catch (e) { flash('Erro ao carregar: ' + (e.message || e)); S.view = S.perfil ? 'app' : 'login'; render(); }
  }
  sb.auth.onAuthStateChange((evento, session) => {
    S.session = session;
    if (evento === 'PASSWORD_RECOVERY') S.recovery = true;
    if (evento === 'SIGNED_IN' && S.perfil && session && S.perfil.id === session.user.id && !S.recovery) return; // não recarrega à toa
    if (evento === 'TOKEN_REFRESHED') return;
    setTimeout(boot, 0); // (não chamar o Supabase direto dentro deste callback)
  });

  // ---------------------------------------------------------------- telas
  const header = () => '<div class="hd"><img src="logo.png" alt="Ethos"><b>ETHOS · Encontro com Deus</b></div>';
  function nav() {
    if (!S.session || S.view !== 'app') return '';
    const tab = (k, t) => `<a href="#" data-act="aba" data-aba="${k}" class="${S.aba === k ? 'on' : ''}">${t}</a>`;
    return `<nav><b>${esc(eu().nome)}</b> <span class="muted">(${NIVEIS[nivel()]})</span>${nivel() === 'obreiro' ? tab('inscricoes', 'Inscrições') + tab('admin', 'Admin') : ''}<span class="sp"></span><a href="#" data-act="sair">Sair</a></nav>`;
  }
  function viewLogin() {
    return `<h2>Entrar</h2><form data-form="login"><label>E-mail<input name="email" type="email" required autocomplete="username"></label>
      <label>Senha<input name="senha" type="password" required autocomplete="current-password"></label><button>Entrar</button></form>
      <p><a href="#" data-act="irEsqueci">Esqueci minha senha</a></p>
      <p class="muted">Só entra quem foi convidado pelo Obreiro. Primeiro acesso: use o link que chegou no seu e-mail.</p>`;
  }
  const viewEsqueci = () => `<h2>Esqueci minha senha</h2><form data-form="esqueci"><label>Seu e-mail<input name="email" type="email" required></label>
      <button>Enviar link</button></form><p><a href="#" data-act="irLogin">Voltar</a></p>`;
  const viewNovaSenha = () => `<h2>${S.recovery ? 'Nova senha' : 'Crie a sua senha'}</h2><form data-form="novasenha">
      <label>Nova senha (mínimo 10 caracteres, com letras e números)<input name="s1" type="password" required minlength="10" autocomplete="new-password"></label>
      <label>Repita a senha<input name="s2" type="password" required minlength="10" autocomplete="new-password"></label><button>Salvar senha</button></form>`;
  const viewSemAcesso = () => `<h2>Sem acesso</h2><p class="err">Este e-mail ainda não foi convidado (ou o acesso foi removido). Peça ao Obreiro para cadastrá-lo.</p><p><a href="#" data-act="sair">Sair</a></p>`;

  function roboBanner() {
    const off = !S.robo || Date.now() - new Date(S.robo).getTime() > 120000;
    return off ? '<p class="alerta">⚠ O robô está desligado. As inscrições entram na fila e só andam quando ele ligar.</p>' : '';
  }
  const stBadge = (s) => `<span class="badge b-${esc(s)}">${esc(s === 'pendente' ? 'na fila' : s)}</span>`;
  function tabInsc(rows, cancelar) {
    const acao = (r) => {
      if (r.status === 'ok') return `<button class="s" data-act="pix" data-id="${r.id}">PIX/QR</button>` + (cancelar ? ` <button class="d" data-act="cancelar" data-id="${r.id}">Cancelar</button>` : '');
      return esc(r.erro || '');
    };
    const linhas = rows.map((r) => `<tr><td>${dt(r.criado_em)}</td><td>${esc(r.por)}</td><td>${esc(discNome(r.discipulado_id))}</td><td>${cap(r.tipo)}</td><td>${esc(r.nome)}</td><td>${esc(r.email)}</td><td>${stBadge(r.status)}</td><td>${acao(r)}</td></tr>`).join('');
    return `<div class="tw"><table><tr><th>Data/hora</th><th>Quem fez</th><th>Discipulado</th><th>Tipo</th><th>Inscrito</th><th>Email</th><th>Status</th><th></th></tr>${linhas || '<tr><td colspan="8" class="muted">Nenhuma inscrição ainda.</td></tr>'}</table></div>`;
  }
  const cont = (disc, tipo) => S.contagem.filter((c) => c.discipulado_id === disc && c.tipo === tipo && ATIVA.includes(c.status)).length;
  function barras(itens) {
    const mx = Math.max(1, ...itens.map((i) => i.v || 0));
    return itens.map((i) => `<div class="bl">${esc(i.l)}: <b>${i.v == null ? 'indisponível' : i.v}</b></div><div class="bw"><div class="bb ${i.c}" data-w="${i.v == null ? 0 : Math.round((100 * i.v) / mx)}"></div></div>`).join('');
  }
  function livres(tipo, ignorar) {
    const s = S.vagasSite[tipo]; if (!s || s.disponiveis == null) return null;
    const col = tipo === 'encontrista' ? 'vagas_encontrista' : 'vagas_servo';
    const rest = S.disc.filter((d) => d.id !== ignorar).reduce((a, d) => a + Math.max(d[col] - cont(d.id, tipo), 0), 0);
    return Math.max(s.disponiveis - rest, 0);
  }
  function graficoVagas() {
    let cols = '', avisos = '';
    [['encontrista', 'Encontrista'], ['servo', 'Servo']].forEach(([t, n]) => {
      const s = S.vagasSite[t], col = t === 'encontrista' ? 'vagas_encontrista' : 'vagas_servo', site = s ? s.disponiveis : null;
      const rest = S.disc.reduce((a, d) => a + Math.max(d[col] - cont(d.id, t), 0), 0);
      const usadas = S.contagem.filter((c) => c.tipo === t && ATIVA.includes(c.status)).length;
      const itens = [{ l: 'Disponíveis no site', v: site, c: 'c-site' }, { l: nivel() === 'obreiro' ? 'Liberadas aos discipulados (restantes)' : 'Restantes no seu discipulado', v: rest, c: 'c-rest' }];
      if (nivel() === 'obreiro') itens.splice(1, 0, { l: 'Livres para distribuir', v: livres(t), c: 'c-livre' });
      itens.push({ l: 'Inscritos pela plataforma', v: usadas, c: 'c-insc' });
      cols += `<div><h4>${n}</h4>${barras(itens)}</div>`;
      if (site == null) avisos += `<p class="alerta">Ainda não li as vagas de ${n} no site (link não configurado ou robô desligado).</p>`;
      else if (nivel() === 'obreiro' && rest > site) avisos += `<p class="alerta">⚠ ${n}: você liberou ${rest} vaga(s) aos discipulados, mas o site só tem ${site}.</p>`;
    });
    const quando = Object.values(S.vagasSite).map((x) => x.atualizado_em).sort().pop();
    return `<div class="card"><h3>Vagas disponíveis no site</h3><div class="g">${cols}</div>${avisos}<p class="muted">Lido pelo robô direto das páginas de inscrição${quando ? ' · atualizado ' + dt(quando) : ''}. <a href="#" data-act="atualizar">Atualizar agora</a></p></div>`;
  }
  function formInsc(tipo, restante) {
    if (restante <= 0) return `<p class="err">Sem vagas de ${tipo}.</p>`;
    return `<form data-form="insc" data-tipo="${tipo}"><div class="g">
      <label>Nome *<input name="nome" required maxlength="120" autocomplete="off"></label>
      <label>Email *<input name="email" type="email" required maxlength="120" autocomplete="off"></label>
      <label>Telefone *<input name="telefone" required maxlength="30" autocomplete="off"></label>
      <label>Sexo *<select name="sexo" required><option value="">Selecione</option><option>Masculino</option><option>Feminino</option></select></label>
      <label>Data nascimento *<input name="nascimento" type="date" required></label>
      <label>Discipulador (se souber) *<input name="discipulador" required maxlength="120" autocomplete="off"></label>
      <label>Líder (se souber) *<input name="lider" required maxlength="120" autocomplete="off"></label>
      <label>Endereço (opcional)<input name="endereco" maxlength="250" autocomplete="off"></label>
      <label class="full">Observações (opcional)<input name="obs" maxlength="500" autocomplete="off"></label></div>
      <button>Inscrever ${tipo} (restam ${restante})</button></form>`;
  }
  function cardsInscrever() {
    const sd = S.saldo || { encontrista: 0, servo: 0, servo_liberado: false };
    const lim = nivel() === 'lider' && (sd.le != null || sd.ls != null) ? `<p>Seu limite: Encontrista ${sd.le == null ? 'sem limite' : sd.le} · Servo ${sd.ls == null ? 'sem limite' : sd.ls}</p>` : '';
    const servo = sd.servo_liberado ? formInsc('servo', sd.servo) : '<p class="err">Servo bloqueado: faça primeiro a inscrição de Encontrista (ou peça ao Obreiro para liberar).</p>';
    const aguard = S.aguardando ? `<div class="card" id="aguardando">⏳ Inscrição de <b>${esc(S.aguardando.nome)}</b> enviada. O robô está fazendo a inscrição no site e gerando o PIX… pode levar alguns minutos (se o robô estiver desligado, ela fica na fila).</div>` : '';
    return `${lim}${aguard}<div class="card"><h3>Encontrista · ${sd.encontrista} vaga(s)</h3>${formInsc('encontrista', sd.encontrista)}</div>
      <div class="card"><h3>Servo · ${sd.servo} vaga(s)</h3><small class="muted">O Servo só é liberado depois que o líder fizer a inscrição de Encontrista.</small>${servo}</div>`;
  }
  function viewInscricoes() {
    const n = nivel(); let h = roboBanner();
    if (n === 'obreiro') {
      h += `<label>Discipulado<select data-change="disc">${S.disc.map((d) => `<option value="${d.id}" ${d.id === S.discSel ? 'selected' : ''}>${esc(d.nome)}</option>`).join('')}</select></label>`;
      if (!S.disc.length) return h + '<p class="muted">Crie um discipulado na aba Admin.</p>';
    } else h += `<h2>${esc(discNome(S.discSel))}</h2>`;
    if (n !== 'lider') h += graficoVagas() + '<p><a href="#" data-act="exportar" data-escopo="disc">⬇ Exportar inscrições para Excel</a></p>';
    if (n === 'discipulador') {
      const d = S.disc.find((x) => x.id === S.discSel) || { vagas_encontrista: 0, vagas_servo: 0 };
      const linhas = S.perfis.map((l) => `<tr><td>${esc(l.nome)}<form id="lim-${l.id}" data-form="limite" data-id="${l.id}"></form></td>
        <td>${usadasLider(l.id, 'encontrista')}</td>
        <td><input form="lim-${l.id}" name="le" type="number" min="0" max="${d.vagas_encontrista}" value="${l.le == null ? '' : l.le}" placeholder="sem limite"></td>
        <td>${usadasLider(l.id, 'servo')}</td>
        <td><input form="lim-${l.id}" name="ls" type="number" min="0" max="${d.vagas_servo}" value="${l.ls == null ? '' : l.ls}" placeholder="sem limite"></td>
        <td><button form="lim-${l.id}">Salvar</button></td></tr>`).join('');
      h += `<div class="card"><h3>Limite por líder de célula</h3><small class="muted">Deixe em branco para não limitar. O limite não pode passar das vagas do discipulado.</small>
        <div class="tw"><table><tr><th>Líder</th><th>Encontrista usadas</th><th>Limite Encontrista</th><th>Servo usadas</th><th>Limite Servo</th><th></th></tr>${linhas || '<tr><td colspan="6" class="muted">Sem líderes neste discipulado.</td></tr>'}</table></div></div>`;
    } else if (S.discSel) h += cardsInscrever();
    return `${h}<h3>${n === 'lider' ? 'Suas inscrições' : 'Inscrições do discipulado'}</h3><div id="lista-insc">${tabInsc(S.insc, false)}</div>`;
  }
  const usadasLider = (uid, tipo) => S.insc.filter((r) => r.user_id === uid && r.tipo === tipo && ATIVA.includes(r.status)).length;

  function viewAdmin() {
    const opts = (sel) => '<option value="0">—</option>' + S.disc.map((d) => `<option value="${d.id}" ${d.id === sel ? 'selected' : ''}>${esc(d.nome)}</option>`).join('');
    const fl = (t) => { const v = livres(t); return v == null ? 'indisponível' : v; };
    const discs = S.disc.map((d) => `<tr><td>${esc(d.nome)}</td><td>${cont(d.id, 'encontrista')}/${d.vagas_encontrista}</td><td>${cont(d.id, 'servo')}/${d.vagas_servo}</td></tr>`).join('');
    const comSenha = new Set(S.perfis.filter((p) => p.senha_definida).map((p) => p.email));
    const pend = S.convites.filter((c) => !comSenha.has(c.email)).map((c) => {
      const st = c.erro ? `<span class="err">${esc(c.erro)}</span>` : c.enviado_em ? `convite enviado ${dt(c.enviado_em)} · falta criar a senha` : 'aguardando o robô enviar';
      return `<tr><td>${esc(c.nome)}</td><td>${esc(c.email)}</td><td>${NIVEIS[c.nivel]}</td><td>${st}</td><td><button class="s" data-act="reenviar" data-email="${esc(c.email)}">Reenviar</button></td></tr>`;
    }).join('');
    const cards = S.perfis.map((p) => `<form class="card" data-form="perfil" data-id="${p.id}"><b>${esc(p.nome)}</b> <small class="muted">${esc(p.email)} · ${p.senha_definida ? '✔ senha criada' : '⏳ falta criar a senha'}</small>
      <div class="g"><label>Nível<select name="nivel">${Object.keys(NIVEIS).map((k) => `<option value="${k}" ${k === p.nivel ? 'selected' : ''}>${NIVEIS[k]}</option>`).join('')}</select></label>
      <label>Discipulado<select name="disc">${opts(p.discipulado_id)}</select></label>
      <label>Limite Encontrista (líder)<input name="le" type="number" min="0" value="${p.le == null ? '' : p.le}" placeholder="sem limite"></label>
      <label>Limite Servo (líder)<input name="ls" type="number" min="0" value="${p.ls == null ? '' : p.ls}" placeholder="sem limite"></label>
      <label class="full"><input type="checkbox" name="servo_livre" ${p.servo_livre ? 'checked' : ''}> Liberar Servo sem Encontrista (só líder)</label></div>
      <button>Salvar</button> <button type="button" class="d" data-act="remover" data-id="${p.id}">Remover acesso</button></form>`).join('');
    return `${roboBanner()}<h2>Administração · Obreiro</h2>
      <p><a href="#" data-act="exportar" data-escopo="todas">⬇ Exportar todas as inscrições (Excel)</a></p>${graficoVagas()}
      <div class="card"><h3>Links das inscrições</h3><form data-form="links">
        <label>Link ENCONTRISTA<input name="link_encontrista" value="${esc(S.config.link_encontrista)}" placeholder="https://..."></label>
        <label>Link SERVO<input name="link_servo" value="${esc(S.config.link_servo)}" placeholder="https://..."></label><button>Salvar links</button></form></div>
      <div class="card"><h3>Discipulados e vagas</h3><small class="muted">Livres para distribuir agora (conforme o site): Encontrista <b>${fl('encontrista')}</b> · Servo <b>${fl('servo')}</b></small>
        <form data-form="disc" class="g"><label class="full">Nome do discipulado<input name="nome" required maxlength="80"></label>
        <label>Vagas Encontrista<input name="ve" type="number" min="0" required></label><label>Vagas Servo<input name="vs" type="number" min="0" required></label>
        <div class="full"><button>Salvar (cria ou atualiza)</button></div></form>
        <div class="tw"><table><tr><th>Discipulado</th><th>Encontrista (usadas/total)</th><th>Servo (usadas/total)</th></tr>${discs}</table></div></div>
      <div class="card"><h3>Convidar pessoa</h3><small class="muted">A pessoa recebe um e-mail com um link para confirmar o endereço e criar a própria senha.</small>
        <form data-form="convite" class="g"><label>Nome<input name="nome" required maxlength="80"></label><label>E-mail (real)<input name="email" type="email" required maxlength="120"></label>
        <label>Nível<select name="nivel">${Object.keys(NIVEIS).map((k) => `<option value="${k}">${NIVEIS[k]}</option>`).join('')}</select></label>
        <label>Discipulado<select name="disc">${opts(0)}</select></label><div class="full"><button>Enviar convite</button></div></form>
        ${pend ? `<h4>Convites pendentes</h4><div class="tw"><table><tr><th>Nome</th><th>E-mail</th><th>Nível</th><th>Situação</th><th></th></tr>${pend}</table></div>` : ''}</div>
      <h3>Logins</h3>${cards || '<p class="muted">Nenhum login ainda.</p>'}
      <h3>Logs de inscrições</h3>${tabInsc(S.logs, true)}`;
  }
  function modalPix() {
    const r = [...S.insc, ...S.logs].find((x) => x.id === S.modal);
    if (!r || !r.pix) return '';
    let img = '';
    try { const q = window.qrcode(0, 'L'); q.addData(r.pix); q.make(); img = q.createDataURL(6, 2); } catch (e) { img = ''; }
    return `<div class="modal" data-act="fechar"><div class="box" data-stop="1"><h3>Pagamento PIX</h3><p>${esc(r.nome)} · ${cap(r.tipo)}</p>
      ${img ? `<img alt="QR Code do PIX" src="${img}">` : '<p class="err">Não consegui desenhar o QR. Use o código abaixo.</p>'}
      <p class="muted">Copia e cola:</p><textarea id="pixtxt" readonly>${esc(r.pix)}</textarea>
      <p><button data-act="copiar">Copiar código</button> <button class="s" data-act="fechar">Fechar</button></p></div></div>`;
  }

  // ---------------------------------------------------------------- desenho
  function render() {
    let corpo;
    if (S.view === 'login') corpo = viewLogin(); else if (S.view === 'esqueci') corpo = viewEsqueci();
    else if (S.view === 'novasenha') corpo = viewNovaSenha(); else if (S.view === 'semacesso') corpo = viewSemAcesso();
    else if (S.view === 'app') corpo = S.aba === 'admin' && nivel() === 'obreiro' ? viewAdmin() : viewInscricoes();
    else corpo = '<p class="muted">Carregando…</p>';
    app.innerHTML = header() + nav() + `<div id="msg">${msgHtml()}</div>` + corpo + (S.view === 'app' && S.modal ? modalPix() : '');
    app.querySelectorAll('[data-w]').forEach((e) => { e.style.width = e.dataset.w + '%'; });
  }

  // ---------------------------------------------------------------- formulários
  const num = (v) => { v = String(v == null ? '' : v).trim(); return /^\d+$/.test(v) ? parseInt(v, 10) : null; };
  const rpc = async (fn, args) => { const { data, error } = await sb.rpc(fn, args); if (error) throw error; return data; };
  const FORMS = {
    async login(f, d) {
      const { error } = await sb.auth.signInWithPassword({ email: d.get('email').trim().toLowerCase(), password: d.get('senha') });
      if (error) return flash(erroAuth(error)); flash(null);
    },
    async esqueci(f, d) {
      await sb.auth.resetPasswordForEmail(d.get('email').trim().toLowerCase(), { redirectTo: CFG.SITE_URL || location.origin + location.pathname });
      flash('Se o e-mail estiver cadastrado, enviamos um link para criar uma nova senha (vale por pouco tempo).', true);
    },
    async novasenha(f, d) {
      const s1 = d.get('s1'), s2 = d.get('s2');
      const e = s1 !== s2 ? 'As senhas não conferem.' : senhaOk(s1, S.session && S.session.user.email);
      if (e) return flash(e);
      const { error } = await sb.auth.updateUser({ password: s1 });
      if (error) return flash(erroAuth(error));
      await sb.rpc('marcar_senha_definida');
      S.recovery = false; try { history.replaceState(null, '', location.pathname); } catch (x) { /* ok */ }
      flash('Senha definida!', true); await boot();
    },
    async insc(f, d) {
      const tipo = f.dataset.tipo;
      const id = await rpc('criar_inscricao', { p_disc: S.discSel, p_tipo: tipo, p_nome: d.get('nome'), p_email: d.get('email'), p_telefone: d.get('telefone'), p_sexo: d.get('sexo'),
        p_nascimento: d.get('nascimento'), p_endereco: d.get('endereco') || '', p_discipulador: d.get('discipulador'), p_lider: d.get('lider'), p_obs: d.get('obs') || '' });
      S.aguardando = { id, nome: d.get('nome'), tipo }; flash(null);
      await carregar(); render(); aguardar(id);
    },
    async links(f, d) {
      await rpc('salvar_config', { p_chave: 'link_encontrista', p_valor: d.get('link_encontrista') });
      await rpc('salvar_config', { p_chave: 'link_servo', p_valor: d.get('link_servo') });
      flash('Links salvos. O robô lê as vagas de novo em instantes.', true); await carregar(); render();
    },
    async disc(f, d) {
      await rpc('salvar_discipulado', { p_nome: d.get('nome'), p_ve: num(d.get('ve')), p_vs: num(d.get('vs')) });
      flash('Discipulado salvo.', true); await carregar(); render();
    },
    async convite(f, d) {
      const r = await rpc('criar_convite', { p_email: d.get('email'), p_nome: d.get('nome'), p_nivel: d.get('nivel'), p_disc: num(d.get('disc')) || null });
      flash(r === 'existente' ? 'Essa pessoa já tinha conta: o acesso foi liberado.' : 'Convite criado. O robô envia o e-mail em instantes (ele precisa estar ligado).', true);
      await carregar(); render();
    },
    async perfil(f, d) {
      await rpc('editar_perfil', { p_id: f.dataset.id, p_nivel: d.get('nivel'), p_disc: num(d.get('disc')) || null, p_le: num(d.get('le')), p_ls: num(d.get('ls')), p_servo_livre: d.get('servo_livre') === 'on' });
      flash('Login atualizado.', true); await carregar(); render();
    },
    async limite(f) {
      const g = (n) => (document.querySelector(`input[form="${f.id}"][name="${n}"]`) || {}).value;
      await rpc('definir_limites', { p_user: f.dataset.id, p_le: num(g('le')), p_ls: num(g('ls')) });
      flash('Limites salvos.', true); await carregar(); render();
    },
  };

  // ---------------------------------------------------------------- ações
  async function aguardar(id) {
    for (let i = 0; i < 400 && S.aguardando && S.aguardando.id === id; i++) {
      await sleep(POLL);
      const { data } = await sb.from('inscricoes').select('id,status,pix,erro').eq('id', id).maybeSingle();
      if (!data || !S.aguardando || S.aguardando.id !== id) continue;
      if (data.status === 'ok') { S.aguardando = null; await carregar(); S.modal = id; flash('Inscrição concluída! Pague o PIX.', true); return render(); }
      if (data.status === 'erro' || data.status === 'cancelado') {
        S.aguardando = null; await carregar();
        flash('Não foi possível concluir: ' + (data.erro || 'erro no site') + ' (a vaga foi liberada).'); return render();
      }
    }
  }
  const COLS = [['id', 'ID'], ['criado_em', 'Data/hora'], ['por', 'Quem fez'], ['disc', 'Discipulado'], ['tipo', 'Tipo'], ['nome', 'Nome'], ['email', 'Email'], ['telefone', 'Telefone'], ['sexo', 'Sexo'],
    ['nascimento', 'Data nascimento'], ['endereco', 'Endereço'], ['discipulador', 'Discipulador'], ['lider', 'Líder'], ['obs', 'Observações'], ['status', 'Status'], ['erro', 'Detalhe']];
  async function exportar(escopo) {
    const unico = nivel() === 'obreiro' && escopo !== 'todas' && S.discSel;
    const rows = await fetchAll('inscricoes', '*', unico ? (q) => q.eq('discipulado_id', S.discSel) : null);
    const val = (k, r) => (k === 'criado_em' ? dt(r.criado_em) : k === 'disc' ? discNome(r.discipulado_id) : k === 'tipo' ? cap(r.tipo) : k === 'nascimento' ? dnasc(r.nascimento) : r[k] == null ? '' : r[k]);
    const aoa = [COLS.map((c) => c[1])].concat(rows.map((r) => COLS.map((c) => val(c[0], r))));
    const ws = window.XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = COLS.map((c, i) => ({ wch: Math.min(Math.max(...aoa.map((l) => String(l[i]).length)) + 2, 42) }));
    ws['!autofilter'] = { ref: ws['!ref'] };
    const resumo = [['Discipulado', 'Tipo', 'Vagas', 'Usadas', 'Restantes']];
    S.disc.filter((d) => !unico || d.id === S.discSel).forEach((d) => [['encontrista', d.vagas_encontrista], ['servo', d.vagas_servo]].forEach(([t, v]) => {
      const u = rows.filter((r) => r.discipulado_id === d.id && r.tipo === t && ATIVA.includes(r.status)).length; resumo.push([d.nome, cap(t), v, u, v - u]);
    }));
    const wb = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(wb, ws, 'Inscrições');
    window.XLSX.utils.book_append_sheet(wb, window.XLSX.utils.aoa_to_sheet(resumo), 'Resumo de vagas');
    const n = new Date(), p2 = (x) => String(x).padStart(2, '0');
    window.XLSX.writeFile(wb, `inscricoes_${n.getFullYear()}${p2(n.getMonth() + 1)}${p2(n.getDate())}_${p2(n.getHours())}${p2(n.getMinutes())}.xlsx`);
    flash(`Planilha gerada com ${rows.length} inscrição(ões).`, true);
  }
  const ACTS = {
    async sair() { await sb.auth.signOut(); S.session = null; S.perfil = null; S.view = 'login'; flash(null); render(); },
    async aba(el) { S.aba = el.dataset.aba; flash(null); await carregar(); render(); },
    irEsqueci() { S.view = 'esqueci'; flash(null); render(); },
    irLogin() { S.view = 'login'; flash(null); render(); },
    pix(el) { S.modal = parseInt(el.dataset.id, 10); render(); },
    fechar(el, ev) { if (ev.target.closest('[data-stop]') && !ev.target.closest('button[data-act="fechar"]')) return; S.modal = null; render(); },
    async copiar() { const t = document.getElementById('pixtxt'); try { await navigator.clipboard.writeText(t.value); flash('Código copiado.', true); } catch (e) { t.select(); } },
    async atualizar() { await carregar(); render(); flash('Atualizado.', true); },
    async exportar(el) { await exportar(el.dataset.escopo); },
    async cancelar(el) { if (!confirm('Cancelar esta inscrição e liberar a vaga? (Cancele também no site da Videira.)')) return; await rpc('cancelar_inscricao', { p_id: parseInt(el.dataset.id, 10) }); flash('Inscrição cancelada e vaga liberada.', true); await carregar(); render(); },
    async remover(el) { if (!confirm('Remover o acesso desta pessoa?')) return; await rpc('remover_acesso', { p_id: el.dataset.id }); flash('Acesso removido.', true); await carregar(); render(); },
    async reenviar(el) { await rpc('reenviar_convite', { p_email: el.dataset.email }); flash('Convite recolocado na fila. O robô envia em instantes.', true); await carregar(); render(); },
  };

  document.addEventListener('submit', async (ev) => {
    const f = ev.target.closest('form[data-form]'); if (!f) return;
    ev.preventDefault();
    const btn = f.querySelector('button:not([type=button])') || document.querySelector(`button[form="${f.id}"]`);
    if (btn) btn.disabled = true;
    try { await FORMS[f.dataset.form](f, new FormData(f)); } catch (e) { flash(e.message || String(e)); }
    if (btn) btn.disabled = false;
  });
  document.addEventListener('click', async (ev) => {
    const el = ev.target.closest('[data-act]'); if (!el) return;
    ev.preventDefault();
    try { await ACTS[el.dataset.act](el, ev); } catch (e) { flash(e.message || String(e)); }
  });
  document.addEventListener('change', async (ev) => {
    const el = ev.target.closest('[data-change="disc"]'); if (!el) return;
    S.discSel = parseInt(el.value, 10); S.aguardando = null;
    try { await carregarInscricoes(); render(); } catch (e) { flash(e.message || String(e)); }
  });
  // atualiza só a lista (sem apagar o que a pessoa está digitando) enquanto houver inscrição na fila
  setInterval(async () => {
    if (S.view !== 'app' || S.aba !== 'inscricoes' || S.modal || !S.insc.some((r) => r.status === 'pendente' || r.status === 'processando')) return;
    try { await carregarLista(); const el = document.getElementById('lista-insc'); if (el) el.innerHTML = tabInsc(S.insc, false); } catch (e) { /* tenta de novo */ }
  }, TICK);

  boot();
})();
