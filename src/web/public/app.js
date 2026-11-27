// EANyra local web UI. No build step, no dependencies.
// Collected posts and messages are untrusted: they are only ever inserted
// with textContent, never as HTML.

const $ = selector => document.querySelector(selector);

// ── DOM helper ────────────────────────────────────────────────────────────────

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const badge = (text, kind = text) => h('span', { class: `badge ${String(kind).toLowerCase()}` }, text);
const card = (...children) => h('section', { class: 'card stack' }, ...children);
const empty = text => h('div', { class: 'empty' }, text);

function when(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('uk-UA', { dateStyle: 'short', timeStyle: 'short' });
}

function age(hours) {
  if (hours === null || hours === undefined) return 'ніколи';
  if (hours < 1) return 'щойно';
  if (hours < 48) return `${Math.round(hours)} год тому`;
  return `${Math.round(hours / 24)} дн тому`;
}

const fmt = n => (n === null || n === undefined ? '—' : Number(n).toLocaleString('uk-UA'));

// ── API ───────────────────────────────────────────────────────────────────────

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: method === 'POST' ? { 'Content-Type': 'application/json', 'X-EANyra': '1' } : {},
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && path !== '/api/login') {
    showLogin();
    throw new ApiError(401, 'Сесія завершилась. Увійдіть знову.');
  }
  if (!response.ok) throw new ApiError(response.status, data.error ?? `HTTP ${response.status}`);
  return data;
}

const tool = (name, args = {}) => api(`/api/tools/${name}`, { method: 'POST', body: args });

// ── Shell ─────────────────────────────────────────────────────────────────────

let session = null;
let currentView = 'overview';
let refreshTimer = null;

function toast(message, ms = 4000) {
  const node = $('#toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.hidden = true; }, ms);
}

function confirmDialog(title, body, okLabel = 'Підтвердити') {
  const dialog = $('#confirm');
  $('#confirm-title').textContent = title;
  $('#confirm-body').textContent = body;
  $('#confirm-ok').textContent = okLabel;
  return new Promise(resolve => {
    const done = value => {
      dialog.close();
      $('#confirm-ok').onclick = null;
      $('#confirm-cancel').onclick = null;
      resolve(value);
    };
    $('#confirm-ok').onclick = () => done(true);
    $('#confirm-cancel').onclick = () => done(false);
    dialog.oncancel = () => done(false);
    dialog.showModal();
  });
}

function askDialog(title, label, { value = '', placeholder = '', type = 'text' } = {}) {
  const dialog = $('#ask');
  $('#ask-title').textContent = title;
  $('#ask-label').textContent = label;
  const input = $('#ask-input');
  input.type = type;
  input.value = value;
  input.placeholder = placeholder;
  return new Promise(resolve => {
    const done = result => {
      $('#ask-form').onsubmit = null;
      $('#ask-cancel').onclick = null;
      if (dialog.open) dialog.close();
      resolve(result);
    };
    $('#ask-form').onsubmit = event => { event.preventDefault(); done(input.value.trim()); };
    $('#ask-cancel').onclick = () => done(null);
    dialog.oncancel = () => done(null);
    dialog.showModal();
    input.focus();
  });
}

function showLogin() {
  clearInterval(refreshTimer);
  $('#app').hidden = true;
  $('#login').hidden = false;
  const tokenMode = session?.mode === 'token';
  $('#login-label').textContent = tokenMode ? 'Токен доступу' : 'Майстер-пароль';
  $('#login-hint').textContent = tokenMode
    ? 'Сховища ще немає. Введіть токен, який сервер показав у терміналі.'
    : 'Пароль також розблоковує сховище для збору й публікації.';
  $('#login-password').focus();
}

function showApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#version').textContent = session?.version ? `v${session.version}` : '';
  navigate(location.hash.slice(1) || 'overview');
}

async function navigate(view) {
  if (!VIEWS[view]) view = 'overview';
  currentView = view;
  if (location.hash.slice(1) !== view) history.replaceState(null, '', `#${view}`);
  for (const button of document.querySelectorAll('#tabs button')) {
    button.classList.toggle('active', button.dataset.view === view);
  }
  clearInterval(refreshTimer);
  await render();
}

async function render() {
  const view = currentView;
  const target = $('#view');
  try {
    const content = await VIEWS[view]();
    if (view === currentView) target.replaceChildren(...[content].flat(Infinity).filter(item => item !== null && item !== undefined && item !== false));
  } catch (error) {
    if (error.status === 401) return;
    target.replaceChildren(card(h('h2', {}, 'Помилка'), h('p', { class: 'error' }, error.message)));
  }
}

function alertsCard(alerts) {
  const channel = (label, value) => h('span', { class: 'row' }, label,
    value ? badge(value.enabled ? 'увімкнено' : 'вимкнено', value.enabled ? 'ok' : 'skipped') : badge('не налаштовано', 'skipped'));
  const test = async () => {
    try {
      const { results } = await api('/api/notify/test', { method: 'POST' });
      toast(results.join(' · ') || 'Немає увімкнених каналів.', 8000);
    } catch (error) {
      toast(error.message, 8000);
    }
  };
  return card(
    h('div', { class: 'row between' }, h('h2', {}, 'Сповіщення про проблеми'),
      alerts.configured ? h('button', { class: 'small', onclick: test }, 'Надіслати тест') : null),
    h('div', { class: 'row' }, channel('Telegram', alerts.telegram), channel('Discord', alerts.discord)),
    alerts.error && h('p', { class: 'error' }, alerts.error),
    !alerts.configured && h('p', { class: 'muted' }, 'Налаштуйте Telegram-бота або Discord-вебхук на вкладці «Налаштування».'),
    alerts.problems.length
      ? h('div', { class: 'stack' }, h('div', { class: 'muted' }, 'Зараз виявлено (повідомлення надсилаються після кожного збору, без повторів частіше ніж раз на добу):'),
        alerts.problems.map(text => h('div', { class: 'preserve' }, text)))
      : h('p', { class: 'muted' }, 'Проблем не виявлено.'),
  );
}

async function stopJob(job) {
  const ok = await confirmDialog('Зупинити збір?',
    'Поточний акаунт буде дозібрано, логіни збережуться, решта акаунтів збереться наступного разу.', 'Зупинити');
  if (!ok) return;
  try {
    const result = await api('/api/jobs/stop', { method: 'POST', body: { job_id: job.job_id } });
    toast(result.note ?? 'Зупиняється…', 7000);
  } catch (error) {
    toast(error.message, 7000);
  }
  render();
}

async function startScrape(args, label) {
  try {
    const job = await tool('scraper_run', args);
    toast(`Збір запущено: ${label}`);
    if (currentView === 'overview' || currentView === 'jobs') render();
    return job;
  } catch (error) {
    toast(`Не вдалося запустити збір: ${error.message}`, 7000);
    return null;
  }
}

/** Re-render periodically while a collection job is active. */
function autoRefresh(active) {
  clearInterval(refreshTimer);
  if (active) refreshTimer = setInterval(render, 5000);
}

// ── Views ─────────────────────────────────────────────────────────────────────

const HEALTH = { ok: 'Все гаразд', degraded: 'Потребує уваги', error: 'Помилки', running: 'Іде збір', unknown: 'Немає даних' };
const STATE = { ok: 'ok', stale: 'застаріло', never: 'не збиралось', error: 'помилка' };

/** Session states come from the CLI report in English; show them in Ukrainian. */
function sessionState(state) {
  const days = state.match(/valid (\d+) more day/);
  if (days) return `ok · ще ${days[1]} дн`;
  if (state.startsWith('from .env')) return 'з .env (без шифрування)';
  return { ok: 'ok', MISSING: 'немає логіна', EXPIRED: 'прострочено', 'logged out': 'не залогінено', 'needs the vault': 'потрібне сховище' }[state] ?? state;
}
const sessionKind = row => (row.ok ? (row.state.startsWith('from .env') ? 'stale' : 'ok') : 'error');

async function syncContext() {
  try {
    const result = await api('/api/context/sync', { method: 'POST' });
    const errors = result.errors?.length ? ` Помилки (файли не оновлено): ${result.errors.join('; ')}` : '';
    const warnings = result.warnings?.length ? ` Попередження: ${result.warnings.join('; ')}` : '';
    toast(`Контекст синхронізовано: оновлено ${result.updated?.length ?? 0}.${errors}${warnings}`, errors || warnings ? 15000 : 4000);
    render();
  } catch (error) {
    toast(`Синхронізація не вдалася: ${error.message}`, 7000);
  }
}

const VIEWS = {
  async overview() {
    const [status, plan, alerts] = await Promise.all([
      tool('scraper_status', { history_limit: 10 }),
      tool('content_plan_get').catch(() => null),
      api('/api/notify').catch(() => null),
    ]);
    autoRefresh(Boolean(status.active_job));

    const platforms = Object.entries(status.platforms).map(([id, p]) => card(
      h('div', { class: 'row between' }, h('h3', {}, p.display_name), badge(p.error ? 'помилки' : p.stale + p.never ? 'увага' : 'ok', p.error ? 'error' : p.stale + p.never ? 'stale' : 'ok')),
      h('div', { class: 'muted' }, `${p.accounts} акаунт(ів) · ok ${p.ok} · застаріло ${p.stale + p.never} · помилки ${p.error}`),
      h('div', {}, `Найсвіжіші дані: ${age(p.freshest_age_hours)}`),
      h('div', { class: 'row' }, h('button', { class: 'small', onclick: () => startScrape({ platform: id }, p.display_name) }, 'Зібрати')),
    ));

    const attention = status.accounts_needing_attention.length
      ? h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Акаунт'), h('th', {}, 'Стан'), h('th', {}, 'Дані'), h('th', {}, 'Остання помилка'))),
        h('tbody', {}, status.accounts_needing_attention.map(a => h('tr', {},
          h('td', {}, `${a.platform}/${a.username}`),
          h('td', {}, badge(STATE[a.state] ?? a.state, a.state)),
          h('td', {}, age(a.age_hours)),
          h('td', { class: 'preserve' }, a.last_error ?? '—'),
        )))))
      : empty('Усі акаунти зібрані вчасно.');

    const runs = h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'Початок'), h('th', {}, 'Стан'), h('th', {}, 'Акаунти'), h('th', {}, 'Нові пости'), h('th', {}, 'Нові сигнали'), h('th', {}, 'Тривалість'))),
      h('tbody', {}, status.recent_runs.map(run => h('tr', { class: 'clickable', onclick: () => showRun(run.id) },
        h('td', {}, run.id), h('td', {}, when(run.started_at)), h('td', {}, badge(run.status)),
        h('td', {}, fmt(run.accounts_processed)), h('td', {}, fmt(run.posts_saved)), h('td', {}, fmt(run.signals_saved)),
        h('td', {}, run.duration_seconds === null ? '—' : `${Math.round(run.duration_seconds / 60)} хв`),
      )))));

    return [
      session?.mode === 'token' ? vaultSetupCard() : null,
      card(
        h('div', { class: 'row between' },
          h('div', { class: 'row' }, h('h2', {}, 'Стан збору'), badge(HEALTH[status.health] ?? status.health, status.health)),
          h('button', { class: 'primary', disabled: Boolean(status.active_job), onclick: () => startScrape({}, 'усі акаунти') },
            status.active_job ? 'Збір триває…' : 'Зібрати все')),
        h('div', { class: 'grid' },
          h('div', {}, h('div', { class: 'muted' }, 'Останній успішний збір'), h('div', { class: 'stat' }, age(status.data_age_hours))),
          h('div', {}, h('div', { class: 'muted' }, 'Акаунтів з проблемами'), h('div', { class: 'stat' }, status.accounts_needing_attention.length)),
          status.active_job && h('div', {}, h('div', { class: 'muted' }, 'Активна задача'), h('div', {}, badge(status.active_job.status), ' ', status.active_job.source)),
        ),
      ),
      h('div', { class: 'grid' }, platforms.length ? platforms : card(empty('Немає активних акаунтів. Додайте їх на вкладці «Акаунти».'))),
      plan && card(
        h('div', { class: 'row between' }, h('h2', {}, 'Час публікувати'), h('button', { class: 'small', onclick: () => navigate('content') }, 'До контенту')),
        plan.due_now.length ? h('div', { class: 'plan-due' }, plan.due_now.map(item => h('div', { class: 'row' },
          badge(PLAN[item.status], PLAN_KIND[item.status]), h('span', { class: 'mono' }, item.account),
          h('span', { class: 'muted' }, item.days_since_last_post === null ? 'ще не публікував' : `${item.days_since_last_post} дн без поста`),
          item.drafts_waiting ? badge(`${item.drafts_waiting} чернетка чекає`, 'running') : null,
        ))) : empty('Усі акаунти публікуються за планом.'),
      ),
      card(h('h2', {}, 'Потребують уваги'), attention),
      alerts && alertsCard(alerts),
      card(h('h2', {}, 'Останні прогони'), h('p', { class: 'muted' }, 'Натисніть рядок, щоб побачити результат по кожному акаунту.'), runs),
      h('div', { id: 'run-detail' }),
    ];
  },

  async content() {
    const [plan, personas, perf] = await Promise.all([
      tool('content_plan_get'), tool('personas_list'), tool('content_performance_get', { days: 90 }).catch(() => null),
    ]);
    const state = VIEWS.content.state ??= { show: 'active', persona: '', platform: '' };
    const list = h('div', { class: 'stack' }, empty('Завантаження…'));

    const loadDrafts = async () => {
      try {
        const drafts = (await tool('drafts_list', {
          limit: 200, ...(state.persona ? { persona: state.persona } : {}), ...(state.platform ? { platform: state.platform } : {}),
        })).filter(d => state.show === 'all' || (state.show === 'active' ? ['draft', 'approved'].includes(d.status) : d.status === state.show));
        list.replaceChildren(...(drafts.length ? drafts.map(renderContentDraft) : [empty('Чернеток немає. Попросіть ШІ написати пост (промпт write_post або content_week) або створіть чернетку вище.')]));
      } catch (error) {
        list.replaceChildren(h('p', { class: 'error' }, error.message));
      }
    };
    VIEWS.content.reload = loadDrafts;

    const planRows = plan.personas.flatMap(group => group.accounts.map(item => h('tr', {},
      h('td', {}, group.persona?.name ?? h('span', { class: 'muted' }, 'без персони')),
      h('td', { class: 'mono' }, item.account),
      h('td', {}, item.target ? item.target.text : h('span', { class: 'muted' }, 'не задано')),
      h('td', {}, item.last_post_at ? `${when(item.last_post_at)} (${item.days_since_last_post} дн)` : 'ще не було'),
      h('td', {}, badge(PLAN[item.status] ?? item.status, PLAN_KIND[item.status]), item.data_warning ? h('div', { class: 'muted' }, 'дані застарілі') : null),
      h('td', {}, `${item.posts_last_7_days} / ${item.posts_last_30_days}`),
      h('td', {}, item.drafts_waiting ? badge(`${item.drafts_waiting} чекає`, 'running') : '—'),
      h('td', {}, ['due', 'overdue'].includes(item.status) && !item.drafts_waiting
        ? h('button', { class: 'small', onclick: () => copyText(aiRequest(group.persona, item), 'Запит для ШІ скопійовано') }, 'Запит для ШІ')
        : null),
    )));

    const filters = h('div', { class: 'filters' },
      selectField('Показати', [['active', 'Чекають рішення'], ['published', 'Опубліковані'], ['discarded', 'Відхилені'], ['all', 'Усі']], state.show, v => { state.show = v; loadDrafts(); }),
      selectField('Персона', [['', 'Усі'], ...personas.personas.map(p => [p.slug, p.name])], state.persona, v => { state.persona = v; loadDrafts(); }),
      selectField('Платформа', [['', 'Усі'], ['twitter', 'X'], ['telegram', 'Telegram'], ['linkedin', 'LinkedIn'], ['threads', 'Threads']], state.platform, v => { state.platform = v; loadDrafts(); }),
    );
    loadDrafts();
    return [
      card(
        h('h2', {}, 'План публікацій'),
        h('p', { class: 'muted' }, 'Ритм із posting_frequency персони порівнюється з реально зібраними постами (без репостів і відповідей). «Пости 7/30» — за останні 7 і 30 днів.'),
        planRows.length ? h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, 'Персона'), h('th', {}, 'Акаунт'), h('th', {}, 'Ціль'), h('th', {}, 'Останній пост'), h('th', {}, 'Стан'), h('th', {}, 'Пости 7/30'), h('th', {}, 'Чернетки'), h('th', {}, ''))),
          h('tbody', {}, planRows))) : empty('Немає акаунтів для публікацій.'),
      ),
      newDraftForm(personas),
      card(h('div', { class: 'row between' }, h('h2', {}, 'Чернетки'), filters), list),
      perf && performanceCard(perf),
    ];
  },

  async accounts() {
    const [list, personas, sessions, config, apiKeys, accountPersona] = await Promise.all([
      tool('accounts_list', { active_only: false }),
      tool('personas_list'),
      api('/api/sessions'),
      api('/api/accounts/config'),
      api('/api/secrets/api').catch(() => ({ telegram_api: false })),
      api('/api/context/account-personas').catch(() => ({})),
    ]);
    const stats = new Map(list.accounts.map(a => [`${a.platform}/${a.username}`, a]));
    const sessionByAccount = new Map();
    for (const row of sessions.sessions) {
      for (const ref of row.accounts) {
        if (!ref.endsWith('(publish)')) sessionByAccount.set(ref, row);
      }
    }
    ACCOUNT_CONTEXT.platforms = config.platforms;
    ACCOUNT_CONTEXT.sessions = sessions.sessions;
    ACCOUNT_CONTEXT.personas = personas.personas;
    ACCOUNT_CONTEXT.accountPersona = accountPersona;

    const rows = config.accounts.map(entry => {
      const key = `${entry.platform}/${entry.username}`;
      const a = stats.get(key);
      const s = sessionByAccount.get(key);
      const archived = entry.archive === true;
      const active = !archived && entry.active !== false;
      return h('tr', {},
        h('td', {}, h('div', {}, entry.display_name ?? entry.username), h('div', { class: 'muted mono' }, key)),
        h('td', {}, accountPersona[key] ?? h('span', { class: 'muted' }, 'без персони')),
        h('td', {}, s ? h('span', {}, s.name, ' ', badge(sessionState(s.state), sessionKind(s))) : '—'),
        h('td', {}, archived ? badge('архів', 'skipped') : active ? when(a?.last_scraped_at) : badge('вимкнено', 'skipped')),
        h('td', {}, fmt(a?.posts_in_db ?? 0), ' / ', fmt(a?.signals_in_db ?? 0)),
        h('td', {}, h('div', { class: 'draft-actions' },
          active && h('button', { class: 'small', onclick: () => startScrape({ platform: entry.platform, account: entry.username }, key) }, 'Зібрати'),
          h('button', { class: 'small', onclick: () => editAccount(entry) }, 'Редагувати'),
          h('button', { class: 'small ghost', onclick: () => archiveAccount(key, !archived) }, archived ? 'Відновити' : 'Архівувати'),
        )),
      );
    });

    const sessionRows = sessions.sessions.map(s => h('tr', {},
      h('td', { class: 'mono' }, `${s.kind}/${s.name}`),
      h('td', {}, badge(sessionState(s.state), sessionKind(s))),
      h('td', {}, s.accounts.join(', ') || h('span', { class: 'muted' }, 'не використовується')),
      h('td', {}, h('div', { class: 'draft-actions' }, sessionActions(s.kind, s.name, s))),
    ));

    return [
      card(
        h('div', { class: 'row between' }, h('h2', {}, `Акаунти (${config.accounts.length})`),
          h('button', { class: 'primary small', onclick: () => editAccount(null) }, 'Додати акаунт')),
        h('p', { class: 'muted' }, 'Зміни зберігаються в instance/accounts.json з перевіркою; застосовуються з наступним збором. Архів зберігає історію.'),
        rows.length ? h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, 'Акаунт'), h('th', {}, 'Персона'), h('th', {}, 'Сесія'), h('th', {}, 'Останній збір'), h('th', {}, 'Пости / сигнали'), h('th', {}, ''))),
          h('tbody', {}, rows))) : empty('Акаунтів ще немає — додайте перший.'),
      ),
      card(
        h('div', { class: 'row between' }, h('h2', {}, 'Сесії та логіни'),
          h('div', { class: 'row' },
            badge(sessions.encrypted ? (sessions.unlocked ? 'сховище відкрите' : 'сховище закрите') : 'без шифрування', sessions.encrypted ? (sessions.unlocked ? 'ok' : 'stale') : 'error'),
            h('button', { class: 'primary small', onclick: newSession, disabled: !sessions.encrypted }, 'Нова сесія'))),
        !sessions.encrypted && h('p', { class: 'error' }, 'Логіни зберігаються лише в зашифрованому сховищі: створіть його на вкладці «Огляд».'),
        h('p', { class: 'muted' }, 'Значення секретів ніколи не показуються — їх можна лише задати або видалити.'),
        sessionRows.length ? h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, 'Сесія'), h('th', {}, 'Стан'), h('th', {}, 'Акаунти'), h('th', {}, ''))),
          h('tbody', {}, sessionRows))) : empty('Немає сесій.'),
        h('div', { class: 'row between' },
          h('span', {}, 'Telegram API (my.telegram.org): ', badge(apiKeys.telegram_api ? 'задано' : 'не задано', apiKeys.telegram_api ? 'ok' : 'stale')),
          h('button', { class: 'small', onclick: setTelegramApi, disabled: !sessions.encrypted }, 'Задати…')),
      ),
      card(
        h('div', { class: 'row between' }, h('h2', {}, `Персони (${personas.count})`),
          h('button', { class: 'small', onclick: syncContext }, 'Синхронізувати контекст')),
        h('p', { class: 'muted' }, 'Кожна персона має власний голос, біо й правила платформ — редагуються на вкладці «Контекст». Акаунт додається до персони в його редакторі («Редагувати» → «Персона»). Після ручних змін у файлах натисніть «Синхронізувати контекст».'),
        personas.personas.length ? h('div', { class: 'grid' }, personas.personas.map(p => h('div', { class: 'card stack' },
          h('h3', {}, p.name), personaFacts(p), p.description && h('p', { class: 'muted preserve' }, p.description),
          h('div', { class: 'mono' }, p.accounts.join(', ')),
        ))) : empty('Персон ще немає — створіть їх на вкладці «Контекст».'),
      ),
    ];
  },

  async context() {
    const [files, synced] = await Promise.all([
      api('/api/context/files'), tool('personas_list').catch(() => ({ personas: [] })),
    ]);
    const personaOf = rel => synced.personas.find(p => `personas/${p.slug}.yaml` === rel);
    const state = VIEWS.context.state ??= { path: null, original: null, content: null, dirty: false };
    if (!files.some(file => file.path === state.path)) {
      state.path = (files.find(file => file.path.startsWith('personas/')) ?? files[0])?.path ?? null;
    }

    const editor = h('textarea', { class: 'yaml-editor', spellcheck: 'false', 'aria-label': 'YAML' });
    const messages = h('div', { class: 'messages' });
    const title = h('h2', {});
    const status = h('span', { class: 'muted' });
    const facts = h('div', {});
    const save = h('button', { class: 'primary' }, 'Зберегти й синхронізувати');
    const revert = h('button', { class: 'ghost' }, 'Відкотити');
    const remove = h('button', { class: 'ghost' }, 'Видалити…');
    let timer = null;

    const showValidation = result => {
      messages.replaceChildren(
        ...result.errors.map(text => h('div', { class: 'error' }, `✖ ${text}`)),
        ...result.warnings.map(text => h('div', { class: 'warn' }, `⚠ ${text}`)),
        ...(result.ok && !result.warnings.length ? [h('div', { class: 'muted' }, '✓ Перевірено: помилок немає.')] : []),
      );
      save.disabled = !result.ok || !state.dirty;
    };
    const validate = async () => {
      try {
        showValidation(await api('/api/context/validate', { method: 'POST', body: { path: state.path, content: editor.value } }));
      } catch (error) {
        messages.replaceChildren(h('div', { class: 'error' }, error.message));
      }
    };
    const markDirty = () => {
      state.content = editor.value;
      state.dirty = editor.value !== state.original;
      status.textContent = state.dirty ? 'є незбережені зміни' : '';
      revert.disabled = !state.dirty;
      clearTimeout(timer);
      timer = setTimeout(validate, 400);
    };
    editor.addEventListener('input', markDirty);
    // Tab inserts two spaces instead of leaving the editor (YAML indentation).
    editor.addEventListener('keydown', event => {
      if (event.key !== 'Tab' || event.shiftKey) return;
      event.preventDefault();
      editor.setRangeText('  ', editor.selectionStart, editor.selectionEnd, 'end');
      markDirty();
    });

    const open = async (rel, { force = false, preset } = {}) => {
      if (!force && state.dirty && rel !== state.path &&
          !await confirmDialog('Незбережені зміни', `Зміни у ${state.path} буде втрачено.`, 'Відкинути')) return;
      const file = preset ?? await api('/api/context/read', { method: 'POST', body: { path: rel } });
      state.path = rel;
      state.exists = file.exists;
      state.original = preset ? '' : file.content;
      editor.value = file.content;
      state.dirty = Boolean(preset);
      title.textContent = rel;
      const persona = personaOf(rel);
      facts.replaceChildren(...(persona ? [personaFacts(persona, { detailed: true })] : []));
      status.textContent = file.exists ? '' : 'файлу ще немає — буде створено при збереженні';
      remove.hidden = !/^(projects|personas)\//.test(rel) || !file.exists;
      revert.disabled = !state.dirty;
      list.querySelectorAll('button[data-path]').forEach(button => button.classList.toggle('active', button.dataset.path === rel));
      await validate();
    };

    save.addEventListener('click', async () => {
      try {
        const result = await api('/api/context/save', { method: 'POST', body: { path: state.path, content: editor.value } });
        state.original = editor.value;
        state.dirty = false;
        status.textContent = 'збережено';
        const syncErrors = result.sync?.errors?.length ? ` Синхронізація: ${result.sync.errors.join('; ')}` : '';
        toast(`Збережено й синхронізовано.${syncErrors}`, syncErrors ? 10000 : 4000);
        // A file created by this save: refresh the list labels.
        if (!state.exists || !files.some(file => file.path === state.path)) render();
        else showValidation(result.validation);
      } catch (error) {
        messages.replaceChildren(h('div', { class: 'error' }, error.message));
      }
    });
    revert.addEventListener('click', () => {
      editor.value = state.original ?? '';
      markDirty();
    });
    remove.addEventListener('click', async () => {
      if (!await confirmDialog(`Видалити ${state.path}?`,
        'Файл переміститься в context/.trash/. Проєкт стане архівним, персона розгрупує акаунти.', 'Видалити')) return;
      try {
        await api('/api/context/delete', { method: 'POST', body: { path: state.path } });
        state.dirty = false;
        state.path = null;
        toast('Переміщено в context/.trash/.');
        render();
      } catch (error) {
        toast(error.message, 7000);
      }
    });

    const create = async kind => {
      const slug = await askDialog(kind === 'project' ? 'Новий проєкт' : 'Нова персона', 'Назва файлу (латиницею, через дефіс)', { placeholder: kind === 'project' ? 'my-project' : 'brand' });
      if (!slug) return;
      try {
        const file = await api('/api/context/create', { method: 'POST', body: { kind, slug } });
        const button = h('button', { dataset: { path: file.path }, onclick: () => open(file.path) }, `${file.path.split('/')[1]} (новий)`);
        list.querySelector(`[data-group="${kind}"]`).after(button);
        await open(file.path, { force: true, preset: file });
      } catch (error) {
        toast(error.message, 7000);
      }
    };

    const group = (label, kind, items, newLabel) => [
      h('h3', { dataset: { group: kind } }, label),
      ...items.map(file => h('button', { dataset: { path: file.path }, onclick: () => open(file.path), title: file.description ?? '' },
        file.path.replace(/^(projects|personas)\//, '').replace(/\.yaml$/, ''), file.exists ? '' : ' (немає)',
        personaOf(file.path)?.disclosure && personaOf(file.path).disclosure !== 'public'
          ? h('span', { class: 'muted' }, ` · ${DISCLOSURE_LABELS[personaOf(file.path).disclosure]}`) : null)),
      newLabel && h('button', { class: 'muted', onclick: () => create(kind) }, `+ ${newLabel}`),
    ];
    const legacy = files.filter(f => !f.path.includes('/'));
    const migrate = async () => {
      if (!await confirmDialog('Перенести загальні файли в персони?',
        'Кожна персона отримає з voice/bio/platforms лише те, чого в ній ще немає, і лише для платформ її акаунтів. Загальні файли перемістяться в context/.trash/.', 'Перенести')) return;
      try {
        const result = await api('/api/context/migrate-legacy', { method: 'POST' });
        state.dirty = false;
        state.path = null;
        toast(`Перенесено. Оновлено персон: ${result.updated.length}. Загальні файли в context/.trash/.`, 8000);
        render();
      } catch (error) {
        toast(error.message, 9000);
      }
    };
    const list = h('nav', { class: 'file-list', 'aria-label': 'Файли контексту' },
      group('Персони', 'persona', files.filter(f => f.path.startsWith('personas/')), 'персона'),
      group('Проєкти', 'project', files.filter(f => f.path.startsWith('projects/')), 'проєкт'),
      legacy.length ? [
        ...group('Застарілі (не використовуються)', 'top', legacy, null),
        h('button', { class: 'small primary', onclick: migrate }, 'Перенести в персони'),
      ] : null,
    );

    const view = [card(
      h('p', { class: 'muted' }, 'Кожна персона самодостатня: власний голос (voice), біо (bio), правила платформ (platforms) і список акаунтів. Проєкти спільні — персона вибирає, про які з них говорить. Помилки блокують збереження, попередження — підказки. Коментарі у файлах зберігаються.'),
      legacy.length ? h('p', { class: 'warn' }, '⚠ Загальні voice.yaml / bio.yaml / platforms.yaml більше не використовуються. Натисніть «Перенести в персони», щоб скопіювати їх значення в кожну персону.') : null,
      h('div', { class: 'context-layout' },
        list,
        h('div', { class: 'stack' },
          h('div', { class: 'row between' }, title, status),
          facts, editor, messages,
          h('div', { class: 'row end' }, remove, revert, save)),
      ),
    )];
    if (state.path) queueMicrotask(() => open(state.path, { force: true }));
    else {
      title.textContent = 'Створіть першу персону';
      editor.disabled = true;
      save.disabled = true;
      revert.disabled = true;
      remove.hidden = true;
    }
    return view;
  },

  async settings() {
    const s = await api('/api/settings');
    const post = (path, body = {}) => api(path, { method: 'POST', body });
    const act = (fn, ok) => async () => {
      try {
        const result = await fn();
        if (ok) toast(typeof ok === 'function' ? ok(result) : ok, 6000);
        render();
      } catch (error) {
        toast(error.message, 8000);
      }
    };
    const n = s.notify;

    // ── Alerts ──
    const bot = h('input', { type: 'text', value: n.telegram?.bot ?? 'default', list: 'alert-bots' });
    const chatsBox = h('div', { class: 'stack' });
    const findChats = async () => {
      chatsBox.replaceChildren(h('span', { class: 'muted' }, 'Шукаю чати…'));
      try {
        const { chats } = await post('/api/settings/notify/telegram-chats', { bot: bot.value.trim() });
        chatsBox.replaceChildren(...chats.map(chat => h('div', { class: 'row between' },
          h('span', {}, `${chat.title || 'без назви'} · ${chat.type} · ${chat.id}`),
          h('button', { class: 'small primary', onclick: act(() => post('/api/settings/notify', { telegram: { enabled: true, bot: bot.value.trim() || 'default', chat_id: chat.id } }), 'Telegram-сповіщення увімкнено.') }, 'Обрати'))));
      } catch (error) {
        chatsBox.replaceChildren(h('p', { class: 'error' }, error.message));
      }
    };
    const webhook = h('input', { type: 'password', autocomplete: 'off', placeholder: 'https://discord.com/api/webhooks/…' });
    const rules = n.rules ?? {};
    const ruleInput = (key, value) => h('input', { type: 'number', min: 0, step: 1, value: String(value), dataset: { rule: key } });
    const rulesForm = h('form', { class: 'filters', onsubmit: event => {
      event.preventDefault();
      const values = Object.fromEntries([...rulesForm.querySelectorAll('[data-rule]')].map(input =>
        [input.dataset.rule, input.type === 'checkbox' ? input.checked : Number(input.value)]));
      act(() => post('/api/settings/notify', { rules: values }), 'Правила збережено.')();
    } },
    h('label', {}, 'Попереджати про логін X за, дн', ruleInput('auth_expiring_days', rules.auth_expiring_days ?? 3)),
    h('label', {}, 'Дані застарілі після, год', ruleInput('stale_hours', rules.stale_hours ?? 48)),
    h('label', {}, 'Повторювати не частіше, год', ruleInput('repeat_hours', rules.repeat_hours ?? 24)),
    h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: rules.notify_resolved !== false, dataset: { rule: 'notify_resolved' } }), 'Писати «вирішено»'),
    h('button', { type: 'submit' }, 'Зберегти правила'));

    const alerts = card(
      h('div', { class: 'row between' }, h('h2', {}, 'Сповіщення про проблеми'),
        h('button', { class: 'small', disabled: !n.configured, onclick: act(async () => (await api('/api/notify/test', { method: 'POST' })).results.join(' · ') || 'Немає увімкнених каналів.', r => r) }, 'Надіслати тест')),
      n.error && h('p', { class: 'error' }, n.error),
      h('h3', {}, 'Telegram-бот'),
      h('div', { class: 'row' },
        n.telegram ? badge(n.telegram.enabled ? `увімкнено → чат ${n.telegram.chat_id}` : 'вимкнено', n.telegram.enabled ? 'ok' : 'skipped') : badge('не налаштовано', 'skipped'),
        n.telegram && h('button', { class: 'small ghost', onclick: act(() => post('/api/settings/notify', { telegram: { enabled: !n.telegram.enabled } }), n.telegram.enabled ? 'Вимкнено.' : 'Увімкнено.') }, n.telegram.enabled ? 'Вимкнути' : 'Увімкнути')),
      h('p', { class: 'muted' }, 'Відкрийте свого бота в Telegram і натисніть Start, потім «Знайти чат». Токен бота задається в «Акаунти» → «Нова сесія» → Telegram-бот.'),
      h('div', { class: 'filters' }, h('label', {}, 'Бот', bot), h('button', { onclick: findChats }, 'Знайти чат')),
      datalist('alert-bots', ['default']),
      chatsBox,
      h('h3', {}, 'Discord-вебхук'),
      h('div', { class: 'row' },
        n.discord ? badge(n.discord.enabled ? (n.discord.webhook_set ? 'увімкнено' : 'увімкнено, але вебхука немає') : 'вимкнено', n.discord.enabled && n.discord.webhook_set ? 'ok' : 'skipped') : badge('не налаштовано', 'skipped'),
        n.discord && h('button', { class: 'small ghost', onclick: act(() => post('/api/settings/notify', { discord: { enabled: !n.discord.enabled } }), n.discord.enabled ? 'Вимкнено.' : 'Увімкнено.') }, n.discord.enabled ? 'Вимкнути' : 'Увімкнути')),
      h('div', { class: 'filters' }, h('label', {}, 'URL вебхука (зберігається зашифровано)', webhook),
        h('button', { onclick: act(() => post('/api/settings/notify/discord-webhook', { url: webhook.value }), 'Discord-вебхук збережено й увімкнено.') }, 'Зберегти')),
      h('h3', {}, 'Правила'), rulesForm,
    );

    // ── LinkedIn ──
    const liAccount = h('select', {}, s.linkedin.accounts.map(a => h('option', { value: a.username }, `${a.username} → ${a.import_file}`)));
    const liFile = h('input', { type: 'file', accept: '.csv,text/csv' });
    const linkedin = card(
      h('h2', {}, 'Імпорт LinkedIn'),
      h('p', { class: 'muted' }, 'LinkedIn → Settings → Data privacy → Get a copy of your data → Posts. Розпакуйте архів і виберіть Shares.csv. Імпорт запуститься одразу.'),
      s.linkedin.accounts.length ? h('div', { class: 'filters' },
        h('label', {}, 'Акаунт', liAccount), h('label', {}, 'Shares.csv', liFile),
        h('button', { class: 'primary', onclick: act(async () => {
          if (!liFile.files[0]) throw new Error('Виберіть файл Shares.csv.');
          return post('/api/settings/linkedin/upload', { account: liAccount.value, content: await liFile.files[0].text() });
        }, r => `Збережено як ${r.saved}; імпорт запущено (вкладка «Задачі»).`) }, 'Завантажити й імпортувати'))
        : empty('Немає акаунтів LinkedIn — додайте у вкладці «Акаунти».'),
      s.linkedin.history.length ? h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Коли'), h('th', {}, 'Акаунт'), h('th', {}, 'Файл'), h('th', {}, 'Стан'), h('th', {}, 'Рядків / нових'))),
        h('tbody', {}, s.linkedin.history.map(row => h('tr', {},
          h('td', {}, when(row.imported_at)), h('td', {}, row.username), h('td', { class: 'mono' }, row.file_name),
          h('td', {}, badge(row.status, row.status === 'imported' ? 'ok' : 'error'), row.error ? h('div', { class: 'error' }, row.error) : null),
          h('td', {}, `${row.rows} / ${row.new_posts}${row.conflicts ? ` (конфліктів ${row.conflicts})` : ''}`),
        ))))) : null,
    );

    // ── Backups and encryption at rest ──
    const includeEnv = h('input', { type: 'checkbox' });
    const backups = card(
      h('div', { class: 'row between' }, h('h2', {}, 'Бекапи'),
        h('div', { class: 'row' }, h('label', { class: 'row' }, includeEnv, 'з .env'),
          h('button', { class: 'primary small', onclick: act(() => post('/api/settings/backup', { include_env: includeEnv.checked }),
            r => `Бекап готовий: ${r.dir} (${r.files} файлів, ${(r.bytes / 1048576).toFixed(1)} МБ).`) }, 'Створити бекап'))),
      h('p', { class: 'muted' }, 'Знімок бази без зупинки збору + сховище, акаунти, сповіщення, контекст. Скопіюйте папку на інший диск. Відновлення: зупиніть сервер і виконайте npm.cmd run instance:restore -- <папка> --yes (у PowerShell саме npm.cmd, інакше прапорці не дійдуть).'),
      s.backups.length ? h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Папка'), h('th', {}, 'Створено'), h('th', {}, 'Версія'), h('th', {}, 'Розмір'))),
        h('tbody', {}, s.backups.map(b => h('tr', {}, h('td', { class: 'mono' }, b.name), h('td', {}, when(b.created_at)), h('td', {}, b.version ?? '—'), h('td', {}, `${(b.bytes / 1048576).toFixed(1)} МБ`)))))) : empty('Бекапів ще немає.'),
    );
    const efs = card(
      h('h2', {}, 'Шифрування на диску (Windows EFS)'),
      !s.efs.available ? h('p', { class: 'muted' }, 'Доступно лише у Windows. На macOS/Linux використовуйте FileVault, LUKS або fscrypt.')
        : s.efs.error ? h('p', { class: 'error' }, s.efs.error)
          : [h('div', { class: 'row' }, badge(`${s.efs.encrypted} з ${s.efs.total} зашифровано`, s.efs.encrypted === s.efs.total ? 'ok' : 'stale')),
            s.efs.plaintext.length ? h('div', { class: 'muted mono' }, s.efs.plaintext.join(', ')) : null,
            h('p', { class: 'muted' }, 'Не вмикається автоматично. Сховище з логінами вже зашифроване майстер-паролем; EFS додатково шифрує базу, акаунти й контекст ключем вашого користувача Windows. Щоб увімкнути: зупиніть npm run serve, npm start і MCP, виконайте npm run instance:protect, потім один раз збережіть сертифікат EFS: cipher /x (без нього після перевстановлення Windows файли не відкриються).')],
    );

    // ── Vault and MCP ──
    const current = h('input', { type: 'password', autocomplete: 'current-password' });
    const next = h('input', { type: 'password', autocomplete: 'new-password' });
    const repeat = h('input', { type: 'password', autocomplete: 'new-password' });
    const v = s.vault;
    const vaultCard = card(
      h('h2', {}, 'Сховище й доступ'),
      !v.encrypted ? h('p', { class: 'error' }, 'Сховища ще немає: створіть його на вкладці «Огляд».') : [
        h('div', { class: 'row between' },
          h('span', {}, 'Запам’ятати на цьому ПК (MCP і розклад без пароля): ', badge(v.remembered ? 'так' : 'ні', v.remembered ? 'ok' : 'skipped')),
          v.dpapi && h('button', { class: 'small', onclick: act(() => post(v.remembered ? '/api/settings/vault/forget' : '/api/settings/vault/remember'), v.remembered ? 'Забуто.' : 'Запам’ятовано (Windows DPAPI).') }, v.remembered ? 'Забути' : 'Запам’ятати')),
        h('h3', {}, 'Змінити майстер-пароль'),
        h('form', { class: 'filters', onsubmit: event => {
          event.preventDefault();
          act(() => post('/api/settings/vault/password', { current: current.value, next: next.value, repeat: repeat.value }), 'Майстер-пароль змінено. Перезапустіть MCP, якщо він працює окремо.')();
        } }, h('label', {}, 'Поточний', current), h('label', {}, 'Новий (від 10 символів)', next), h('label', {}, 'Ще раз', repeat), h('button', { type: 'submit' }, 'Змінити')),
        h('h3', {}, 'Токен MCP для ШІ-клієнтів (npm.cmd run serve -- --mcp)'),
        h('div', { class: 'row between' }, badge(v.mcp_token ? 'створено' : 'немає', v.mcp_token ? 'ok' : 'skipped'),
          h('button', { class: 'small', onclick: () => mcpToken(v.mcp_token) }, v.mcp_token ? 'Замінити…' : 'Створити')),
      ],
    );

    return [alerts, linkedin, backups, efs, vaultCard];
  },

  async posts() {
    const personas = await tool('personas_list');
    const state = VIEWS.posts.state ??= { persona: '', platform: '', type: 'recent', search: '', limit: 30 };
    const results = h('div', { class: 'stack' }, empty('Завантаження…'));

    const load = async () => {
      const args = { limit: state.limit, ...(state.persona ? { persona: state.persona } : {}), ...(state.platform ? { platform: state.platform } : {}) };
      try {
        const data = state.search
          ? await tool('posts_search', { ...args, query: state.search })
          : await tool('posts_get', { ...args, type: state.type });
        results.replaceChildren(...(data.posts.length ? data.posts.map(renderPost) : [empty('Нічого не знайдено.')]));
      } catch (error) {
        results.replaceChildren(h('p', { class: 'error' }, error.message));
      }
    };

    const filters = h('form', { class: 'filters', onsubmit: event => { event.preventDefault(); load(); } },
      selectField('Персона', [['', 'Усі'], ...personas.personas.map(p => [p.slug, p.name])], state.persona, v => { state.persona = v; load(); }),
      selectField('Платформа', [['', 'Усі'], ['twitter', 'X'], ['telegram', 'Telegram'], ['linkedin', 'LinkedIn'], ['threads', 'Threads']], state.platform, v => { state.platform = v; load(); }),
      selectField('Відбір', [['recent', 'Нові'], ['top_engagement', 'Найпопулярніші'], ['sample', 'Мікс для стилю']], state.type, v => { state.type = v; load(); }),
      h('label', {}, 'Пошук', h('input', { type: 'search', value: state.search, placeholder: 'текст…', oninput: e => { state.search = e.target.value; } })),
      h('button', { type: 'submit' }, 'Знайти'),
    );
    load();
    return [card(h('h2', {}, 'Опубліковані пости'), filters), results];
  },

  async signals() {
    const [data, personas] = await Promise.all([tool('signals_get', { limit: 50 }), tool('personas_list')]);
    return [ideaForm(personas), card(
      h('h2', {}, `Невикористані сигнали (${data.count})`),
      h('p', { class: 'muted' }, 'Сировина для майбутніх постів: релізи, коміти, нові репозиторії.'),
      data.signals.length ? h('div', { class: 'stack' }, data.signals.map(s => h('article', { class: 'card post' },
        h('div', { class: 'post-meta' }, badge(s.signal_type ?? s.type ?? 'signal', 'running'), h('span', {}, s.source), h('span', {}, when(s.occurred_at)), s.account && h('span', {}, `@${s.account}`)),
        h('strong', {}, s.title ?? ''),
        s.body && h('div', { class: 'preserve muted' }, String(s.body).slice(0, 600)),
        s.url && safeLink(s.url, 'Відкрити'),
      ))) : empty('Нових сигналів немає.'),
    )];
  },

  async telegram() {
    const [targets, drafts] = await Promise.all([tool('telegram_publish_targets'), api('/api/telegram/drafts')]);
    const form = composeForm(targets);
    const list = drafts.length ? h('div', { class: 'stack' }, drafts.map(renderDraft)) : empty('Чернеток ще немає. Їх готує ШІ через MCP або ця форма.');
    return [form, card(h('h2', {}, 'Чернетки та публікації'), list)];
  },

  async jobs() {
    const jobs = await tool('scraper_jobs_list', { limit: 30 });
    autoRefresh(jobs.some(job => ['queued', 'running'].includes(job.status)));
    return card(
      h('h2', {}, 'Задачі збору'),
      h('p', { class: 'muted' }, 'Задачі з MCP, браузера й планувальника. Оновлюється автоматично, поки є активна.'),
      jobs.length ? h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Створено'), h('th', {}, 'Джерело'), h('th', {}, 'Що'), h('th', {}, 'Стан'), h('th', {}, 'Результат'), h('th', {}, ''))),
        h('tbody', {}, jobs.map(job => h('tr', { class: job.result?.run_id ? 'clickable' : '', onclick: job.result?.run_id ? () => showRun(job.result.run_id, true) : null },
          h('td', {}, when(job.created_at)),
          h('td', {}, job.source),
          h('td', { class: 'mono' }, job.accounts?.join(', ') ?? job.platform ?? 'усі акаунти'),
          h('td', {}, badge(job.status)),
          h('td', { class: 'preserve' }, job.error ?? (job.result ? `+${job.result.posts_saved ?? 0} постів, +${job.result.signals_saved ?? 0} сигналів` : '—')),
          h('td', {}, ['queued', 'running'].includes(job.status)
            ? h('button', { class: 'small', onclick: event => { event.stopPropagation(); stopJob(job); } }, 'Зупинити')
            : null),
        ))))) : empty('Задач ще не було.'),
      h('div', { id: 'run-detail' }),
    );
  },
};

// ── View parts ────────────────────────────────────────────────────────────────

function selectField(label, options, value, onChange) {
  return h('label', {}, label, h('select', { onchange: e => onChange(e.target.value) },
    options.map(([v, text]) => h('option', { value: v, selected: v === value }, text))));
}

function safeLink(url, text) {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return h('a', { href: parsed.href, target: '_blank', rel: 'noopener noreferrer' }, text);
  } catch {
    return null;
  }
}

function renderPost(post) {
  return h('article', { class: 'card post' },
    h('div', { class: 'post-meta' },
      badge(post.platform, 'running'), post.account && h('span', {}, `@${post.account}`), h('span', {}, when(post.posted_at)),
      h('span', {}, `♥ ${fmt(post.likes)}`), h('span', {}, `↻ ${fmt(post.reposts)}`), h('span', {}, `💬 ${fmt(post.replies)}`),
      post.views !== null && h('span', {}, `👁 ${fmt(post.views)}`),
      post.raw_url && safeLink(post.raw_url, 'оригінал'),
    ),
    h('div', { class: 'preserve' }, post.text ?? ''),
  );
}

async function showRun(runId, inJobs = false) {
  const target = document.getElementById('run-detail');
  if (!target) return;
  const status = await tool('scraper_status', { history_limit: 1, run_id: runId });
  target.replaceChildren(card(
    h('div', { class: 'row between' }, h('h2', {}, `Прогін #${runId}`), h('button', { class: 'ghost small', onclick: () => target.replaceChildren() }, 'Закрити')),
    status.run_accounts.length ? h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Акаунт'), h('th', {}, 'Сесія'), h('th', {}, 'Стан'), h('th', {}, 'Знайдено'), h('th', {}, 'Нових'), h('th', {}, 'Помилка'))),
      h('tbody', {}, status.run_accounts.map(row => h('tr', {},
        h('td', {}, `${row.platform}/${row.username}`), h('td', {}, row.session ?? '—'), h('td', {}, badge(row.status)),
        h('td', {}, fmt(row.records_found)), h('td', {}, fmt(row.records_saved)), h('td', { class: 'preserve' }, row.error ?? ''),
      ))))) : empty(inJobs ? 'Деталі по акаунтах ще не записані.' : 'Для цього прогону немає деталей (старіший формат).'),
  ));
  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function composeForm(targets) {
  const textarea = h('textarea', { required: true, maxlength: 4096, placeholder: 'Текст поста (звичайний текст, без Markdown)' });
  const counter = h('span', { class: 'muted' }, '0 / 4096');
  textarea.addEventListener('input', () => { counter.textContent = `${textarea.value.length} / 4096`; });
  const channel = h('select', { required: true }, targets.map(t => h('option', { value: t.account }, `${t.display_name} (@${t.account})${t.bot ? ` · бот ${t.bot}` : ''}`)));
  const preview = h('input', { type: 'checkbox', checked: true });
  const error = h('p', { class: 'error' });

  const form = h('form', { class: 'stack', onsubmit: async event => {
    event.preventDefault();
    error.textContent = '';
    try {
      // The author writes as the channel's persona; the server still checks it.
      const owners = await api('/api/context/account-personas');
      const persona = owners[`telegram/${channel.value}`];
      if (!persona) throw new Error(`Канал @${channel.value} не належить жодній персоні. Призначте його персоні в «Акаунти» → «Редагувати».`);
      const draft = await tool('telegram_post_prepare', {
        request_id: `web-${crypto.randomUUID()}`, account: channel.value, persona, text: textarea.value, disable_preview: preview.checked,
      });
      textarea.value = '';
      counter.textContent = '0 / 4096';
      toast(`Чернетку збережено для @${draft.account}. Перевірте її нижче й опублікуйте.`);
      render();
    } catch (e) {
      error.textContent = e.message;
    }
  } },
    h('label', { class: 'field' }, h('span', {}, 'Канал'), channel),
    textarea,
    h('div', { class: 'row between' }, h('label', { class: 'row' }, preview, 'Без прев’ю посилань'), counter),
    h('div', { class: 'row end' }, h('button', { type: 'submit', class: 'primary' }, 'Зберегти чернетку')),
    error,
  );
  return card(
    h('h2', {}, 'Нова чернетка Telegram'),
    targets.length
      ? [h('p', { class: 'muted' }, 'Чернетка нічого не надсилає. Публікація — окрема дія з підтвердженням.'), form]
      : empty('Немає каналів для публікації. Додайте "publish_enabled": true акаунту Telegram в accounts.json.'),
  );
}

function renderDraft(draft) {
  const receipt = draft.receipt ? JSON.parse(draft.receipt) : null;
  const canPublish = ['draft', 'failed'].includes(draft.status);
  return h('article', { class: 'card post' },
    h('div', { class: 'post-meta' },
      badge(draft.status, draft.status === 'unknown' ? 'unknown-state' : draft.status),
      h('span', {}, `@${draft.account}`), h('span', {}, when(draft.created_at)),
      h('span', { class: 'mono' }, draft.request_id),
      receipt?.url && safeLink(receipt.url, 'відкрити пост'),
    ),
    h('div', { class: 'preserve' }, draft.text),
    draft.error && h('p', { class: 'error' }, draft.error),
    ['sending', 'unknown'].includes(draft.status) && h('p', { class: 'error' }, 'Стан доставки невідомий. Перевірте канал у Telegram; повторно ця чернетка автоматично не надсилається.'),
    canPublish && h('div', { class: 'row end' }, h('button', { class: 'danger', onclick: () => publishDraft(draft) }, 'Опублікувати…')),
  );
}

async function publishDraft(draft) {
  const ok = await confirmDialog(`Опублікувати в @${draft.account}?`, draft.text, 'Опублікувати');
  if (!ok) return;
  try {
    const current = await tool('telegram_post_get', { request_id: draft.request_id });
    const result = await tool('telegram_post_publish', { request_id: draft.request_id, content_hash: current.content_hash });
    toast(result.status === 'sent' ? 'Опубліковано.' : `Стан: ${result.status}${result.error ? ` — ${result.error}` : ''}`, 7000);
  } catch (error) {
    toast(`Публікація не вдалася: ${error.message}`, 8000);
  }
  render();
}

function ideaForm(personas) {
  const kind = h('select', {}, [['idea', 'Ідея'], ['article', 'Стаття / посилання'], ['note', 'Нотатка']].map(([v, t]) => h('option', { value: v }, t)));
  const title = h('input', { type: 'text', required: true, maxlength: 300, placeholder: 'Про що написати' });
  const url = h('input', { type: 'url', placeholder: 'https://… (необов’язково)' });
  const persona = h('select', {}, [h('option', { value: '' }, 'будь-яка'), ...personas.personas.map(p => h('option', { value: p.slug }, p.name))]);
  const body = h('textarea', { placeholder: 'Деталі, цитати, кут подачі (необов’язково)' });
  const error = h('p', { class: 'error' });
  const form = h('form', { class: 'stack', onsubmit: async event => {
    event.preventDefault();
    error.textContent = '';
    try {
      await tool('signal_add', {
        kind: kind.value, title: title.value,
        ...(body.value.trim() ? { body: body.value } : {}), ...(url.value.trim() ? { url: url.value.trim() } : {}),
        ...(persona.value ? { persona: persona.value } : {}),
      });
      toast('Ідею збережено. ШІ побачить її в signals_get.');
      render();
    } catch (e) {
      error.textContent = e.message;
    }
  } },
    h('div', { class: 'filters' }, h('label', {}, 'Тип', kind), h('label', {}, 'Персона', persona)),
    h('label', { class: 'field' }, h('span', {}, 'Заголовок'), title),
    h('label', { class: 'field' }, h('span', {}, 'Посилання'), url),
    body,
    h('div', { class: 'row end' }, h('button', { type: 'submit', class: 'primary' }, 'Зберегти ідею')),
    error,
  );
  return h('section', { class: 'card stack' }, h('details', {}, h('summary', {}, 'Додати ідею або посилання'), form));
}

// ── Accounts and sessions management ─────────────────────────────────────────

const ACCOUNT_CONTEXT = { platforms: [], sessions: [], personas: [], accountPersona: {} };
const SESSION_KINDS = {
  twitter: 'X (логін)', telegram: 'Telegram (логін)', github: 'GitHub (токен)',
  'telegram-bot': 'Telegram-бот (токен)', 'discord-bot': 'Discord-бот (токен)',
};
const USERNAME_HINT = {
  twitter: 'нік без @', telegram: 'username каналу без @ або -100…', github: 'логін GitHub',
  linkedin: 'будь-яка назва профілю', discord: 'числовий id каналу (Developer Mode → Copy Channel ID)',
};

/** Generic modal: returns { body, close }; resolves `closed` when dismissed. */
function openModal(title, ...content) {
  const dialog = $('#modal');
  $('#modal-title').textContent = title;
  const body = $('#modal-body');
  body.replaceChildren(...content.flat().filter(Boolean));
  let onClose = null;
  const close = () => {
    if (dialog.open) dialog.close();
  };
  dialog.onclose = () => { onClose?.(); onClose = null; };
  $('#modal-close').onclick = close;
  dialog.showModal();
  return { body, close, onClose: fn => { onClose = fn; } };
}

function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', {}, label), input, hint && h('span', { class: 'muted' }, hint));
}

function sessionNames(kind) {
  return [...new Set(['default', ...ACCOUNT_CONTEXT.sessions.filter(s => s.kind === kind).map(s => s.name)])];
}

function datalist(id, values) {
  return h('datalist', { id }, values.map(value => h('option', { value })));
}

function editAccount(entry) {
  const editing = Boolean(entry);
  const platform = h('select', { disabled: editing },
    ACCOUNT_CONTEXT.platforms.map(p => h('option', { value: p.id, selected: p.id === (entry?.platform ?? 'twitter') }, p.displayName)));
  const username = h('input', { type: 'text', value: entry?.username ?? '', required: true });
  const display = h('input', { type: 'text', value: entry?.display_name ?? '' });
  const active = h('input', { type: 'checkbox', checked: entry ? entry.active !== false : true });
  const session = h('input', { type: 'text', value: entry?.session ?? '', placeholder: 'default', list: 'session-names' });
  const publish = h('input', { type: 'checkbox', checked: entry?.publish_enabled === true });
  const bot = h('input', { type: 'text', value: entry?.bot ?? '', placeholder: 'default', list: 'bot-names' });
  const transport = h('select', {}, [['', 'типово (бот)'], ['bot', 'бот'], ['mtproto', 'сесія користувача']]
    .map(([v, t]) => h('option', { value: v, selected: (entry?.publish_transport ?? '') === v }, t)));
  const importFile = h('input', { type: 'text', value: entry?.import_file ?? '', placeholder: 'Shares.csv' });
  const discordFilter = h('select', {}, [['', 'лише питання'], ['all', 'усі повідомлення']]
    .map(([v, t]) => h('option', { value: v, selected: (entry?.discord_filter ?? '') === v }, t)));
  const originalPersona = entry ? ACCOUNT_CONTEXT.accountPersona?.[`${entry.platform}/${entry.username}`] ?? '' : '';
  const persona = h('select', {}, [['', '— без персони —'], ...(ACCOUNT_CONTEXT.personas ?? []).map(p => [p.slug, p.name])]
    .map(([v, t]) => h('option', { value: v, selected: v === originalPersona }, t)));
  const hint = h('span', { class: 'muted' });
  const extra = h('div', { class: 'stack' });
  const error = h('p', { class: 'error' });
  const lists = h('div', {});

  const refresh = () => {
    const p = platform.value;
    const kind = ACCOUNT_CONTEXT.platforms.find(item => item.id === p)?.session;
    hint.textContent = USERNAME_HINT[p] ?? '';
    lists.replaceChildren(datalist('session-names', kind ? sessionNames(kind) : []), datalist('bot-names', sessionNames('telegram-bot')));
    extra.replaceChildren(...[
      kind && field('Сесія (логін)', session, 'Назва логіна зі сховища; порожньо — default.'),
      p === 'telegram' && h('label', { class: 'row' }, publish, 'Дозволити публікацію в цей канал'),
      p === 'telegram' && field('Бот для публікації', bot),
      p === 'telegram' && field('Спосіб публікації', transport),
      p === 'linkedin' && field('Файл експорту', importFile, 'У папці імпорту; окремий для кожного акаунта LinkedIn.'),
      p === 'discord' && field('Що збирати', discordFilter),
    ].filter(Boolean));
  };
  platform.addEventListener('change', refresh);
  refresh();

  const form = h('form', { class: 'stack', onsubmit: async event => {
    event.preventDefault();
    error.textContent = '';
    const p = platform.value;
    const account = {
      platform: p, username: username.value.trim(), display_name: display.value.trim(), active: active.checked ? null : false,
      ...(ACCOUNT_CONTEXT.platforms.find(item => item.id === p)?.session ? { session: session.value.trim() } : {}),
      ...(p === 'telegram' ? { publish_enabled: publish.checked ? true : null, bot: bot.value.trim(), publish_transport: transport.value } : {}),
      ...(p === 'linkedin' ? { import_file: importFile.value.trim() } : {}),
      ...(p === 'discord' ? { discord_filter: discordFilter.value } : {}),
    };
    try {
      await api('/api/accounts/save', { method: 'POST', body: { account, original_key: entry ? `${entry.platform}/${entry.username}` : '' } });
    } catch (e) {
      error.textContent = e.message;
      return;
    }
    let personaNote = '';
    if (persona.value !== originalPersona) {
      try {
        await api('/api/context/account-persona', { method: 'POST', body: { account: `${p}/${account.username}`, persona: persona.value || null } });
        personaNote = persona.value ? ` Персона: ${persona.selectedOptions[0].textContent}.` : ' Прибрано з персони.';
      } catch (e) {
        personaNote = ` Персону не змінено: ${e.message}`;
      }
    }
    modal.close();
    toast(`${editing ? 'Акаунт оновлено.' : 'Акаунт додано. Він збиратиметься з наступним прогоном.'}${personaNote}`, personaNote.includes('не змінено') ? 9000 : 4000);
    render();
  } },
    field('Платформа', platform),
    field('Акаунт', username, hint),
    field('Назва для себе', display),
    field('Персона', persona, 'Чиїм голосом ШІ пише для цього акаунта. Нову персону створіть на вкладці «Контекст».'),
    h('label', { class: 'row' }, active, 'Активний (збирати)'),
    extra, lists,
    h('div', { class: 'row end' }, h('button', { type: 'submit', class: 'primary' }, editing ? 'Зберегти' : 'Додати')),
    error,
  );
  const modal = openModal(editing ? `Акаунт ${entry.platform}/${entry.username}` : 'Новий акаунт', form);
}

async function archiveAccount(key, archived) {
  const ok = await confirmDialog(archived ? `Архівувати ${key}?` : `Відновити ${key}?`,
    archived ? 'Акаунт більше не збиратиметься; пости й історія лишаються.' : 'Акаунт знову збиратиметься.', archived ? 'Архівувати' : 'Відновити');
  if (!ok) return;
  try {
    await api('/api/accounts/archive', { method: 'POST', body: { key, archived } });
    toast(archived ? 'Архівовано.' : 'Відновлено.');
  } catch (error) {
    toast(error.message, 7000);
  }
  render();
}

function sessionActions(kind, name, row) {
  const actions = [];
  if (kind === 'twitter') {
    actions.push(h('button', { class: 'small', onclick: () => importCookies(name) }, 'Cookies…'));
    actions.push(h('button', { class: 'small', onclick: () => twitterWindowLogin(name) }, 'Увійти у вікні…'));
  } else if (kind === 'telegram') {
    actions.push(h('button', { class: 'small', onclick: () => telegramQrLogin(name) }, 'Увійти через QR…'));
  } else if (SESSION_KINDS[kind]) {
    actions.push(h('button', { class: 'small', onclick: () => setToken(kind, name) }, 'Задати токен…'));
  }
  if (row && !/MISSING|needs the vault|from \.env/.test(row.state)) {
    actions.push(h('button', { class: 'small ghost', onclick: () => deleteSecret(kind, name) }, 'Видалити…'));
  }
  return actions;
}

function newSession() {
  const kind = h('select', {}, Object.entries(SESSION_KINDS).map(([v, t]) => h('option', { value: v }, t)));
  const name = h('input', { type: 'text', value: 'default', pattern: '[a-z0-9][a-z0-9_-]{0,63}', required: true });
  const modal = openModal('Нова сесія', h('form', { class: 'stack', onsubmit: event => {
    event.preventDefault();
    modal.close();
    const n = name.value.trim();
    if (kind.value === 'twitter') twitterChoice(n);
    else if (kind.value === 'telegram') telegramQrLogin(n);
    else setToken(kind.value, n);
  } },
  field('Тип', kind), field('Назва', name, 'Малими латинськими, напр. brand-a. Цю назву вказуєте в полі «Сесія» акаунта.'),
  h('div', { class: 'row end' }, h('button', { type: 'submit', class: 'primary' }, 'Далі'))));
}

function twitterChoice(name) {
  const modal = openModal(`X: сесія «${name}»`,
    h('p', {}, 'Як додати логін?'),
    h('div', { class: 'stack' },
      h('button', { onclick: () => { modal.close(); importCookies(name); } }, 'Вставити cookies (рекомендовано)'),
      h('button', { onclick: () => { modal.close(); twitterWindowLogin(name); } }, 'Увійти у вікні браузера на цьому ПК')));
}

function importCookies(name) {
  const area = h('textarea', { placeholder: '[{"name":"auth_token","value":"…","domain":".x.com", …}]' });
  const file = h('input', { type: 'file', accept: '.json,application/json' });
  file.addEventListener('change', async () => { if (file.files[0]) area.value = await file.files[0].text(); });
  const error = h('p', { class: 'error' });
  const modal = openModal(`Cookies X для «${name}»`,
    h('p', { class: 'muted' }, 'У звичайному браузері, де ви увійшли в X цим акаунтом, експортуйте cookies x.com розширенням (JSON) і вставте або виберіть файл. Видаліть файл експорту після імпорту.'),
    file, area, error,
    h('div', { class: 'row end' }, h('button', { class: 'primary', onclick: async () => {
      error.textContent = '';
      try {
        const result = await api('/api/sessions/twitter/cookies', { method: 'POST', body: { name, cookies: area.value } });
        area.value = '';
        modal.close();
        toast(`Сесію X «${name}» збережено в сховищі (${result.cookies} cookies).`);
        render();
      } catch (e) {
        error.textContent = e.message;
      }
    } }, 'Зберегти')));
}

async function twitterWindowLogin(name) {
  let login;
  try {
    login = await api('/api/sessions/twitter/login', { method: 'POST', body: { name } });
  } catch (error) {
    toast(error.message, 8000);
    return;
  }
  const error = h('p', { class: 'error' });
  let finished = false;
  const modal = openModal(`Вхід у X: «${name}»`,
    h('p', {}, login.message),
    h('p', { class: 'muted' }, 'X іноді блокує вхід у браузері під автоматизацією — тоді скористайтесь імпортом cookies.'),
    error,
    h('div', { class: 'row end' },
      h('button', { class: 'ghost', onclick: () => modal.close() }, 'Скасувати'),
      h('button', { class: 'primary', onclick: async () => {
        error.textContent = '';
        try {
          const result = await api('/api/sessions/twitter/finish', { method: 'POST', body: { id: login.id } });
          finished = true;
          modal.close();
          toast(result.message);
          render();
        } catch (e) {
          error.textContent = e.message;
        }
      } }, 'Готово, я увійшов')));
  modal.onClose(() => { if (!finished) api('/api/sessions/login/cancel', { method: 'POST', body: { id: login.id } }).catch(() => {}); });
}

async function telegramQrLogin(name) {
  let login;
  try {
    login = await api('/api/sessions/telegram/login', { method: 'POST', body: { name } });
  } catch (error) {
    toast(error.message, 8000);
    return;
  }
  const message = h('p', {});
  const qr = h('img', { alt: 'QR-код входу в Telegram', width: 240, height: 240, hidden: true });
  const password = h('input', { type: 'password', autocomplete: 'off' });
  const passwordForm = h('form', { class: 'stack', hidden: true, onsubmit: async event => {
    event.preventDefault();
    try {
      await api('/api/sessions/telegram/password', { method: 'POST', body: { id: login.id, password: password.value } });
      password.value = '';
    } catch (e) {
      message.textContent = e.message;
    }
  } }, field('Пароль 2FA', password), h('div', { class: 'row end' }, h('button', { type: 'submit', class: 'primary' }, 'Надіслати')));
  let done = false;
  const modal = openModal(`Вхід у Telegram: «${name}»`, message, qr, passwordForm,
    h('div', { class: 'row end' }, h('button', { class: 'ghost', onclick: () => modal.close() }, 'Закрити')));
  const show = state => {
    message.textContent = state.message ?? '';
    if (state.qr_svg) qr.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(state.qr_svg)}`;
    qr.hidden = state.status !== 'qr';
    passwordForm.hidden = state.status !== 'password';
    if (state.status === 'password') password.focus();
  };
  show(login);
  const timer = setInterval(async () => {
    try {
      const state = await api('/api/sessions/login/status', { method: 'POST', body: { id: login.id } });
      show(state);
      if (['done', 'failed', 'cancelled'].includes(state.status)) {
        clearInterval(timer);
        done = true;
        if (state.status === 'done') {
          modal.close();
          toast(state.message);
          render();
        }
      }
    } catch {
      clearInterval(timer);
    }
  }, 1500);
  modal.onClose(() => {
    clearInterval(timer);
    if (!done) api('/api/sessions/login/cancel', { method: 'POST', body: { id: login.id } }).catch(() => {});
  });
}

function setToken(kind, name) {
  const input = h('input', { type: 'password', autocomplete: 'off', required: true });
  const error = h('p', { class: 'error' });
  const help = {
    github: 'Fine-grained token з доступом лише на читання (Contents, Metadata).',
    'telegram-bot': 'Токен від @BotFather.',
    'discord-bot': 'Discord Developer Portal → Bot → Reset Token. Увімкніть Message Content intent.',
  }[kind];
  const modal = openModal(`${SESSION_KINDS[kind]}: «${name}»`, h('form', { class: 'stack', onsubmit: async event => {
    event.preventDefault();
    try {
      await api('/api/secrets/set', { method: 'POST', body: { kind, name, token: input.value } });
      input.value = '';
      modal.close();
      toast('Токен збережено в сховищі.');
      render();
    } catch (e) {
      error.textContent = e.message;
    }
  } }, help && h('p', { class: 'muted' }, help), field('Токен', input), error,
  h('div', { class: 'row end' }, h('button', { type: 'submit', class: 'primary' }, 'Зберегти'))));
}

function setTelegramApi() {
  const apiId = h('input', { type: 'text', inputmode: 'numeric', required: true });
  const apiHash = h('input', { type: 'password', autocomplete: 'off', required: true });
  const error = h('p', { class: 'error' });
  const modal = openModal('Telegram API', h('form', { class: 'stack', onsubmit: async event => {
    event.preventDefault();
    try {
      await api('/api/secrets/set', { method: 'POST', body: { kind: 'telegram-api', api_id: apiId.value.trim(), api_hash: apiHash.value.trim() } });
      modal.close();
      toast('Ключі Telegram API збережено.');
      render();
    } catch (e) {
      error.textContent = e.message;
    }
  } }, h('p', { class: 'muted' }, 'my.telegram.org → API development tools.'), field('api_id', apiId), field('api_hash', apiHash), error,
  h('div', { class: 'row end' }, h('button', { type: 'submit', class: 'primary' }, 'Зберегти'))));
}

async function deleteSecret(kind, name) {
  const password = await askDialog(`Видалити ${kind}/${name}?`, 'Підтвердіть майстер-паролем. Акаунти з цією сесією перестануть збиратись.', { type: 'password' });
  if (password === null) return;
  try {
    const result = await api('/api/secrets/delete', { method: 'POST', body: { kind, name, password } });
    toast(result.removed ? 'Видалено.' : 'Такої сесії не було.');
  } catch (error) {
    toast(error.message, 7000);
  }
  render();
}

/** First run: create the encrypted vault (the session was opened with the terminal token). */
function vaultSetupCard() {
  const password = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 10 });
  const repeat = h('input', { type: 'password', autocomplete: 'new-password', required: true });
  const remember = h('input', { type: 'checkbox', checked: true });
  const submit = h('button', { type: 'submit', class: 'primary' }, 'Створити сховище');
  return h('section', { class: 'card stack' },
    h('h2', {}, 'Перший запуск: створіть зашифроване сховище'),
    h('p', {}, 'Усі логіни, cookies і токени зберігаються лише зашифрованими майстер-паролем. Далі ви входите цим паролем замість токена з термінала.'),
    h('p', { class: 'error' }, 'Майстер-пароль неможливо відновити — збережіть його в менеджері паролів.'),
    h('form', { class: 'filters', onsubmit: async event => {
      event.preventDefault();
      submit.disabled = true;
      try {
        const result = await api('/api/setup/vault', { method: 'POST', body: { password: password.value, repeat: repeat.value, remember: remember.checked } });
        session = { ...session, mode: 'vault' };
        toast(`Сховище створено${result.imported.length ? `; з .env імпортовано: ${result.imported.join(', ')}` : ''}. Тепер додайте акаунти й логіни у вкладці «Акаунти».`, 10000);
        render();
      } catch (error) {
        toast(error.message, 8000);
        submit.disabled = false;
      }
    } },
    h('label', {}, 'Майстер-пароль (від 10 символів)', password),
    h('label', {}, 'Ще раз', repeat),
    h('label', { class: 'row' }, remember, 'Запам’ятати на цьому ПК (розклад і MCP без пароля, лише Windows)'),
    submit));
}

async function mcpToken(exists) {
  if (exists && !await confirmDialog('Замінити токен MCP?', 'Старий токен одразу перестане працювати; оновіть конфіг ШІ-клієнта.', 'Замінити')) return;
  try {
    const result = await api('/api/settings/mcp-token', { method: 'POST', body: { rotate: Boolean(exists) } });
    const header = h('input', { type: 'text', readonly: true, value: result.header, class: 'mono' });
    openModal('Токен MCP',
      h('p', {}, 'Скопіюйте зараз — повторно токен не показується.'),
      field('Заголовок для клієнта', header),
      h('p', { class: 'muted' }, `Адреса: ${location.origin}/mcp (сервер має бути запущений з --mcp).`),
      h('div', { class: 'row end' }, h('button', { class: 'primary', onclick: () => copyText(result.header, 'Скопійовано') }, 'Копіювати')));
    render();
  } catch (error) {
    toast(error.message, 8000);
  }
}

// ── Content: drafts ───────────────────────────────────────────────────────────

const PLAN = { overdue: 'прострочено', due: 'час публікувати', on_track: 'за планом', no_target: 'без цілі' };
const PLAN_KIND = { overdue: 'error', due: 'stale', on_track: 'ok', no_target: 'skipped' };
const DRAFT = { draft: 'чернетка', approved: 'схвалено', published: 'опубліковано', discarded: 'відхилено' };
const DRAFT_KIND = { draft: 'draft', approved: 'running', published: 'success', discarded: 'skipped' };
const PLATFORM_LABEL = { twitter: 'X', telegram: 'Telegram', linkedin: 'LinkedIn', threads: 'Threads' };
const LIMIT = { twitter: 280, linkedin: 3000, telegram: 4096, threads: 500 };

async function copyText(text, message = 'Скопійовано') {
  try {
    await navigator.clipboard.writeText(text);
    toast(message);
  } catch {
    toast('Не вдалося скопіювати: браузер заборонив доступ до буфера.', 6000);
  }
}

const TYPE_LABELS = { person: 'людина', brand: 'бренд', fan: 'фан-акаунт', faceless: 'безлика' };
const DISCLOSURE_LABELS = { public: 'публічна', linked: 'пов\'язана', isolated: 'ізольована' };
const DISCLOSURE_HINTS = {
  public: 'видна агенту й може згадуватися будь-де',
  linked: 'згадує лише персони зі списку linked_to; заборона на решту додається автоматично',
  isolated: 'агент бачить її лише за явним slug; інструменти без персони її даних не повертають',
};

/** Type, disclosure, links and projects of a synced persona. */
function personaFacts(persona, { detailed = false } = {}) {
  const disclosure = persona.disclosure ?? 'public';
  const parts = [
    `Тип: ${persona.type ? TYPE_LABELS[persona.type] ?? persona.type : 'не задано'}`,
    `Розкриття: ${DISCLOSURE_LABELS[disclosure] ?? disclosure}`,
    ...(disclosure === 'linked' ? [`Пов'язана з: ${persona.linked_to?.length ? persona.linked_to.join(', ') : 'ніким'}`] : []),
    ...(detailed ? [`Проєкти: ${persona.talks_about_projects?.length ? persona.talks_about_projects.join(', ') : 'жодного'}`] : []),
  ];
  return h('div', { class: 'stack' },
    h('div', { class: disclosure === 'isolated' ? 'warn' : 'muted' }, parts.join(' · ')),
    detailed ? h('div', { class: 'muted' }, `Після останньої синхронізації. ${DISCLOSURE_HINTS[disclosure] ?? ''}`) : null);
}

function aiRequest(persona, item) {
  return `Напиши пост для ${item.account}${persona ? ` (персона ${persona.slug})` : ''} через EANyra: ` +
    'context_get, візьми матеріал із signals_get, збережи через draft_create.';
}

/** Official share dialogs with the text filled in; the author presses Post. */
function composeUrl(platform, text) {
  if (platform === 'twitter') return `https://x.com/intent/post?text=${encodeURIComponent(text)}`;
  if (platform === 'linkedin') return `https://www.linkedin.com/feed/?shareActive=true&text=${encodeURIComponent(text)}`;
  if (platform === 'threads') return `https://www.threads.net/intent/post?text=${encodeURIComponent(text)}`;
  return null;
}

function lengthCounter(platform, length) {
  const limit = LIMIT[platform];
  return h('span', { class: `counter muted ${limit && length > limit ? 'over' : ''}` }, limit ? `${length} / ${limit}` : `${length}`);
}

function newDraftForm(personas) {
  const platform = h('select', {}, Object.entries(PLATFORM_LABEL).map(([v, label]) => h('option', { value: v }, label)));
  const account = h('input', { type: 'text', placeholder: 'username (необов’язково)' });
  const persona = h('select', {}, [h('option', { value: '' }, '—'), ...personas.personas.map(p => h('option', { value: p.slug }, p.name))]);
  const text = h('textarea', { required: true, placeholder: 'Текст поста' });
  const counter = h('span', {});
  const updateCounter = () => counter.replaceChildren(lengthCounter(platform.value, [...text.value].length));
  text.addEventListener('input', updateCounter);
  platform.addEventListener('change', updateCounter);
  updateCounter();
  const error = h('p', { class: 'error' });
  const form = h('form', { class: 'stack', onsubmit: async event => {
    event.preventDefault();
    error.textContent = '';
    try {
      await api('/api/drafts', { method: 'POST', body: { platform: platform.value, account: account.value.trim(), persona: persona.value, text: text.value } });
      text.value = '';
      updateCounter();
      toast('Чернетку збережено.');
      VIEWS.content.reload?.();
    } catch (e) {
      error.textContent = e.message;
    }
  } },
    h('div', { class: 'filters' },
      h('label', {}, 'Платформа', platform), h('label', {}, 'Акаунт', account), h('label', {}, 'Персона', persona)),
    text,
    h('div', { class: 'row between' }, counter, h('button', { type: 'submit', class: 'primary' }, 'Зберегти чернетку')),
    error,
  );
  const details = h('details', {}, h('summary', {}, 'Нова чернетка вручну'), form);
  return h('section', { class: 'card stack' }, details);
}

function renderContentDraft(draft) {
  const node = h('article', { class: 'card post draft' });
  // append() would print null/undefined as text; h() skips empty children.
  const fill = (...children) => node.replaceChildren(...h('div', {}, ...children).childNodes);
  const update = async (changes, message) => {
    try {
      await tool('draft_update', { id: draft.id, ...changes });
      if (message) toast(message);
      VIEWS.content.reload?.();
    } catch (error) {
      toast(error.message, 7000);
    }
  };
  const open = ['draft', 'approved'].includes(draft.status);
  const sending = draft.telegram && ['sending', 'unknown'].includes(draft.telegram.status);
  const textView = h('div', { class: 'preserve' }, draft.text);

  const edit = () => {
    const area = h('textarea', {}, draft.text);
    const counter = h('span', {});
    const refresh = () => counter.replaceChildren(lengthCounter(draft.platform, [...area.value].length));
    area.addEventListener('input', refresh);
    refresh();
    textView.replaceWith(h('div', { class: 'stack' }, area, h('div', { class: 'row between' }, counter, h('div', { class: 'row' },
      h('button', { class: 'ghost', onclick: () => VIEWS.content.reload?.() }, 'Скасувати'),
      h('button', { class: 'primary', onclick: () => update({ text: area.value }, 'Збережено.') }, 'Зберегти')))));
    area.focus();
  };

  const actions = [];
  if (open && !sending) actions.push(h('button', { class: 'small', onclick: edit }, 'Редагувати'));
  if (draft.status === 'draft') actions.push(h('button', { class: 'small', onclick: () => update({ status: 'approved' }, 'Схвалено.') }, 'Схвалити'));
  if (draft.status === 'approved') actions.push(h('button', { class: 'small', onclick: () => update({ status: 'draft' }) }, 'Повернути в чернетки'));
  actions.push(h('button', { class: 'small', onclick: () => copyText(draft.text, 'Текст скопійовано') }, 'Копіювати'));
  if (open && draft.publishing === 'manual') {
    const url = composeUrl(draft.platform, draft.text);
    if (url) actions.push(h('a', { class: 'linkbutton small', href: url, target: '_blank', rel: 'noopener noreferrer' }, `Відкрити в ${PLATFORM_LABEL[draft.platform]} ↗`));
    actions.push(h('button', { class: 'small primary', onclick: () => markPublished(draft) }, 'Я опублікував…'));
  }
  if (open && draft.platform === 'telegram' && !sending) {
    actions.push(h('button', { class: 'small danger', onclick: () => publishTelegramDraft(draft) }, 'Опублікувати в Telegram…'));
  }
  if (open && !sending) actions.push(h('button', { class: 'small ghost', onclick: () => update({ status: 'discarded' }, 'Відхилено.') }, 'Відхилити'));

  fill(
    h('div', { class: 'post-meta' },
      badge(DRAFT[draft.status] ?? draft.status, DRAFT_KIND[draft.status]),
      badge(PLATFORM_LABEL[draft.platform] ?? draft.platform, 'running'),
      h('span', {}, draft.account ? `@${draft.account}` : 'акаунт не вибрано'),
      draft.persona && h('span', {}, `персона ${draft.persona}`),
      h('span', {}, draft.created_by === 'user' ? 'вручну' : 'від ШІ'),
      h('span', {}, when(draft.updated_at)),
      lengthCounter(draft.platform, draft.length),
      draft.signal_ids.length ? h('span', {}, `на основі ${draft.signal_ids.length} сигн.`) : null,
      draft.published_url && safeLink(draft.published_url, 'відкрити пост'),
    ),
    draft.post && h('div', { class: 'post-meta' },
      h('strong', {}, 'Результат:'), h('span', {}, `♥ ${fmt(draft.post.likes)}`), h('span', {}, `↻ ${fmt(draft.post.reposts)}`),
      h('span', {}, `💬 ${fmt(draft.post.replies)}`), draft.post.views !== null && h('span', {}, `👁 ${fmt(draft.post.views)}`)),
    draft.status === 'published' && !draft.post && h('div', { class: 'muted' }, 'Метрики з’являться після наступного збору цього акаунта.'),
    textView,
    draft.notes && h('div', { class: 'muted preserve' }, draft.notes),
    draft.warning && h('p', { class: 'error' }, `Довше за ${LIMIT[draft.platform]} символів.`),
    draft.telegram?.error && h('p', { class: 'error' }, `Telegram: ${draft.telegram.error}`),
    sending && h('p', { class: 'error' }, 'Стан доставки в Telegram невідомий. Перевірте канал; автоматично ця чернетка повторно не надсилається.'),
    actions.length && h('div', { class: 'draft-actions' }, actions),
  );
  return node;
}

function ratio(value) {
  if (value === null || value === undefined) return '—';
  return h('span', { class: `badge ${value >= 1.2 ? 'ok' : value <= 0.8 ? 'error' : 'skipped'}` }, `×${value}`);
}

function performanceCard(perf) {
  const types = Object.entries(perf.by_signal_type);
  return card(
    h('h2', {}, 'Що працює (90 днів)'),
    h('p', { class: 'muted' }, '×1 — як типовий пост цього акаунта, ×2 — вдвічі більше реакцій (лайки + 2·репости + відповіді).'),
    perf.measured ? [
      h('div', { class: 'grid' },
        h('div', {}, h('div', { class: 'muted' }, 'Чернетки від ШІ'), h('div', { class: 'row' }, ratio(perf.by_author.ai.median_vs_account), h('span', { class: 'muted' }, `${perf.by_author.ai.measured} пост.`))),
        h('div', {}, h('div', { class: 'muted' }, 'Написані вручну'), h('div', { class: 'row' }, ratio(perf.by_author.author.median_vs_account), h('span', { class: 'muted' }, `${perf.by_author.author.measured} пост.`))),
      ),
      types.length ? h('div', { class: 'row' }, h('span', { class: 'muted' }, 'За типом матеріалу:'),
        types.map(([type, entry]) => h('span', { class: 'row' }, h('span', { class: 'mono' }, type), ratio(entry.median_vs_account)))) : null,
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Пост'), h('th', {}, 'Акаунт'), h('th', {}, 'Реакції'), h('th', {}, 'Відносно типового'))),
        h('tbody', {}, perf.drafts.slice(0, 10).map(d => h('tr', {},
          h('td', { class: 'preserve' }, d.text.length > 120 ? `${d.text.slice(0, 120)}…` : d.text),
          h('td', { class: 'mono' }, `${d.platform}/${d.account ?? '—'}`),
          h('td', {}, `♥ ${fmt(d.likes)} ↻ ${fmt(d.reposts)} 💬 ${fmt(d.replies)}`),
          h('td', {}, ratio(d.vs_median)),
        ))))),
    ] : empty(perf.published
      ? `Опубліковано ${perf.published}, але пости ще не зібрані. Запустіть збір відповідних акаунтів.`
      : 'Ще немає опублікованих чернеток за цей період.'),
    perf.not_yet_collected.length && perf.measured
      ? h('p', { class: 'muted' }, `Ще без метрик: ${perf.not_yet_collected.length} (чекають на збір).`) : null,
  );
}

async function markPublished(draft) {
  const url = await askDialog('Пост опубліковано?', 'Посилання на опублікований пост (необов’язково)', { placeholder: 'https://x.com/…/status/…' });
  if (url === null) return;
  try {
    await tool('draft_mark_published', { id: draft.id, ...(url ? { url } : {}) });
    toast('Позначено як опубліковане. Сигнали-джерела позначені використаними.');
  } catch (error) {
    toast(error.message, 7000);
  }
  VIEWS.content.reload?.();
}

async function publishTelegramDraft(draft) {
  try {
    const prepared = await tool('draft_prepare_telegram', { id: draft.id });
    const ok = await confirmDialog(`Опублікувати в @${prepared.account}?`, prepared.text, 'Опублікувати');
    if (!ok) return;
    const result = await tool('telegram_post_publish', { request_id: prepared.request_id, content_hash: prepared.content_hash });
    toast(result.status === 'sent' ? 'Опубліковано в Telegram.' : `Стан: ${result.status}${result.error ? ` — ${result.error}` : ''}`, 7000);
  } catch (error) {
    toast(`Публікація не вдалася: ${error.message}`, 8000);
  }
  VIEWS.content.reload?.();
}

// ── Boot ──────────────────────────────────────────────────────────────────────

$('#login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.target.querySelector('button');
  button.disabled = true;
  $('#login-error').textContent = '';
  try {
    await api('/api/login', { method: 'POST', body: { password: $('#login-password').value } });
    $('#login-password').value = '';
    session = await api('/api/session');
    showApp();
  } catch (error) {
    $('#login-error').textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$('#logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  session.authenticated = false;
  showLogin();
});

$('#tabs').addEventListener('click', event => {
  const view = event.target.closest('button')?.dataset.view;
  if (view) navigate(view);
});
window.addEventListener('hashchange', () => navigate(location.hash.slice(1)));

session = await api('/api/session').catch(() => ({ authenticated: false, mode: 'vault' }));
if (session.authenticated) showApp();
else showLogin();
