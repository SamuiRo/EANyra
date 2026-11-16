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

function askDialog(title, label, { value = '', placeholder = '' } = {}) {
  const dialog = $('#ask');
  $('#ask-title').textContent = title;
  $('#ask-label').textContent = label;
  const input = $('#ask-input');
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
    if (view === currentView) target.replaceChildren(...[content].flat());
  } catch (error) {
    if (error.status === 401) return;
    target.replaceChildren(card(h('h2', {}, 'Помилка'), h('p', { class: 'error' }, error.message)));
  }
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
    const errors = result.errors?.length ? ` Помилки: ${result.errors.map(e => e.error ?? e).join('; ')}` : '';
    toast(`Контекст синхронізовано: оновлено ${result.updated?.length ?? 0}.${errors}`, errors ? 9000 : 4000);
    render();
  } catch (error) {
    toast(`Синхронізація не вдалася: ${error.message}`, 7000);
  }
}

const VIEWS = {
  async overview() {
    const [status, plan] = await Promise.all([
      tool('scraper_status', { history_limit: 10 }),
      tool('content_plan_get').catch(() => null),
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
      h('div', { class: 'grid' }, platforms.length ? platforms : card(empty('Немає активних акаунтів. Додайте їх в instance/accounts.json.'))),
      plan && card(
        h('div', { class: 'row between' }, h('h2', {}, 'Час публікувати'), h('button', { class: 'small', onclick: () => navigate('content') }, 'До контенту')),
        plan.due_now.length ? h('div', { class: 'plan-due' }, plan.due_now.map(item => h('div', { class: 'row' },
          badge(PLAN[item.status], PLAN_KIND[item.status]), h('span', { class: 'mono' }, item.account),
          h('span', { class: 'muted' }, item.days_since_last_post === null ? 'ще не публікував' : `${item.days_since_last_post} дн без поста`),
          item.drafts_waiting ? badge(`${item.drafts_waiting} чернетка чекає`, 'running') : null,
        ))) : empty('Усі акаунти публікуються за планом.'),
      ),
      card(h('h2', {}, 'Потребують уваги'), attention),
      card(h('h2', {}, 'Останні прогони'), h('p', { class: 'muted' }, 'Натисніть рядок, щоб побачити результат по кожному акаунту.'), runs),
      h('div', { id: 'run-detail' }),
    ];
  },

  async content() {
    const [plan, personas] = await Promise.all([tool('content_plan_get'), tool('personas_list')]);
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
      selectField('Платформа', [['', 'Усі'], ['twitter', 'X'], ['telegram', 'Telegram'], ['linkedin', 'LinkedIn']], state.platform, v => { state.platform = v; loadDrafts(); }),
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
    ];
  },

  async accounts() {
    const [list, personas, sessions] = await Promise.all([
      tool('accounts_list', { active_only: false }),
      tool('personas_list'),
      api('/api/sessions'),
    ]);
    const sessionByAccount = new Map();
    for (const row of sessions.sessions) {
      for (const ref of row.accounts) sessionByAccount.set(ref.replace(' (publish)', ''), row);
    }
    const rows = list.accounts.map(a => {
      const key = `${a.platform}/${a.username}`;
      const s = sessionByAccount.get(key);
      return h('tr', {},
        h('td', {}, h('div', {}, a.display_name ?? a.username), h('div', { class: 'muted mono' }, key)),
        h('td', {}, a.persona ?? '—'),
        h('td', {}, s ? h('span', {}, s.name, ' ', badge(sessionState(s.state), sessionKind(s))) : '—'),
        h('td', {}, a.is_active ? when(a.last_scraped_at) : badge('архів', 'skipped')),
        h('td', {}, fmt(a.posts_in_db), ' / ', fmt(a.signals_in_db)),
        h('td', {}, a.is_active ? h('button', { class: 'small', onclick: () => startScrape({ platform: a.platform, account: a.username }, key) }, 'Зібрати') : null),
      );
    });
    const sessionRows = sessions.sessions.map(s => h('tr', {},
      h('td', { class: 'mono' }, `${s.kind}/${s.name}`),
      h('td', {}, badge(sessionState(s.state), sessionKind(s))),
      h('td', {}, s.accounts.join(', ') || h('span', { class: 'muted' }, 'не використовується')),
    ));
    return [
      card(
        h('h2', {}, `Акаунти (${list.count})`),
        h('p', { class: 'muted' }, 'Список редагується в instance/accounts.json; поле "session" задає логін акаунта.'),
        h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, 'Акаунт'), h('th', {}, 'Персона'), h('th', {}, 'Сесія'), h('th', {}, 'Останній збір'), h('th', {}, 'Пости / сигнали'), h('th', {}, ''))),
          h('tbody', {}, rows))),
      ),
      card(
        h('div', { class: 'row between' }, h('h2', {}, 'Сесії та токени'),
          badge(sessions.encrypted ? (sessions.unlocked ? 'сховище відкрите' : 'сховище закрите') : 'без шифрування', sessions.encrypted ? (sessions.unlocked ? 'ok' : 'stale') : 'error')),
        h('p', { class: 'muted' }, 'Логіни додаються з терміналу: npm run import-cookies -- --session <назва>, npm run login:telegram -- --session <назва>, npm run nyra -- secrets set …'),
        sessionRows.length ? h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, 'Сесія'), h('th', {}, 'Стан'), h('th', {}, 'Акаунти'))),
          h('tbody', {}, sessionRows))) : empty('Немає сесій.'),
      ),
      card(
        h('div', { class: 'row between' }, h('h2', {}, `Персони (${personas.count})`),
          h('button', { class: 'small', onclick: syncContext }, 'Синхронізувати контекст')),
        h('p', { class: 'muted' }, 'Після змін у instance/context/*.yaml (голос, біо, персони, проєкти) натисніть «Синхронізувати контекст».'),
        personas.personas.length ? h('div', { class: 'grid' }, personas.personas.map(p => h('div', { class: 'card stack' },
          h('h3', {}, p.name), p.description && h('p', { class: 'muted preserve' }, p.description),
          h('div', { class: 'mono' }, p.accounts.join(', ')),
        ))) : empty('Персон не знайдено. Створіть instance/context/personas/<slug>.yaml і синхронізуйте контекст.'),
      ),
    ];
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
      selectField('Платформа', [['', 'Усі'], ['twitter', 'X'], ['telegram', 'Telegram'], ['linkedin', 'LinkedIn']], state.platform, v => { state.platform = v; load(); }),
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
        h('thead', {}, h('tr', {}, h('th', {}, 'Створено'), h('th', {}, 'Джерело'), h('th', {}, 'Що'), h('th', {}, 'Стан'), h('th', {}, 'Результат'))),
        h('tbody', {}, jobs.map(job => h('tr', { class: job.result?.run_id ? 'clickable' : '', onclick: job.result?.run_id ? () => showRun(job.result.run_id, true) : null },
          h('td', {}, when(job.created_at)),
          h('td', {}, job.source),
          h('td', { class: 'mono' }, job.accounts?.join(', ') ?? job.platform ?? 'усі акаунти'),
          h('td', {}, badge(job.status)),
          h('td', { class: 'preserve' }, job.error ?? (job.result ? `+${job.result.posts_saved ?? 0} постів, +${job.result.signals_saved ?? 0} сигналів` : '—')),
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
      const draft = await tool('telegram_post_prepare', {
        request_id: `web-${crypto.randomUUID()}`, account: channel.value, text: textarea.value, disable_preview: preview.checked,
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

// ── Content: drafts ───────────────────────────────────────────────────────────

const PLAN = { overdue: 'прострочено', due: 'час публікувати', on_track: 'за планом', no_target: 'без цілі' };
const PLAN_KIND = { overdue: 'error', due: 'stale', on_track: 'ok', no_target: 'skipped' };
const DRAFT = { draft: 'чернетка', approved: 'схвалено', published: 'опубліковано', discarded: 'відхилено' };
const DRAFT_KIND = { draft: 'draft', approved: 'running', published: 'success', discarded: 'skipped' };
const PLATFORM_LABEL = { twitter: 'X', telegram: 'Telegram', linkedin: 'LinkedIn' };
const LIMIT = { twitter: 280, linkedin: 3000, telegram: 4096 };

async function copyText(text, message = 'Скопійовано') {
  try {
    await navigator.clipboard.writeText(text);
    toast(message);
  } catch {
    toast('Не вдалося скопіювати: браузер заборонив доступ до буфера.', 6000);
  }
}

function aiRequest(persona, item) {
  return `Напиши пост для ${item.account}${persona ? ` (персона ${persona.slug})` : ''} через EANyra: ` +
    'context_get, візьми матеріал із signals_get, збережи через draft_create.';
}

/** Official share dialogs with the text filled in; the author presses Post. */
function composeUrl(platform, text) {
  if (platform === 'twitter') return `https://x.com/intent/post?text=${encodeURIComponent(text)}`;
  if (platform === 'linkedin') return `https://www.linkedin.com/feed/?shareActive=true&text=${encodeURIComponent(text)}`;
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
    textView,
    draft.notes && h('div', { class: 'muted preserve' }, draft.notes),
    draft.warning && h('p', { class: 'error' }, `Довше за ${LIMIT[draft.platform]} символів.`),
    draft.telegram?.error && h('p', { class: 'error' }, `Telegram: ${draft.telegram.error}`),
    sending && h('p', { class: 'error' }, 'Стан доставки в Telegram невідомий. Перевірте канал; автоматично ця чернетка повторно не надсилається.'),
    actions.length && h('div', { class: 'draft-actions' }, actions),
  );
  return node;
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
