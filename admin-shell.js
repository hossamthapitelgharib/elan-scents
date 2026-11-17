/* The shell of the admin panel (platform-dashboard.html): sign-in, the list of pages, moving between them, «تحديث» and «خروج».
   The panel is ONE document. A page is a section `<section class="page" data-page="…">`; the address is `#page-name`; opening a page runs the loader its
   script registered (AdminPages.register in admin-common.js) the first time, and «تحديث» runs it again. Several pages can share one loader (the
   overview, settlements, rankings and audit pages are all fed by platform-dashboard.js). Moving between pages never reloads the document, which is what
   keeps the alert centre (admin-alerts.js) running, its sound unlocked and its cards on screen.
   Whether an account may be here is decided by the server: the first call (the alert centre's read) answers 401 for no session and 403 for an account
   that is not a platform admin, and then the sign-in card is shown with the reason instead of an empty panel. */
const AdminShell = (() => {
  const BASE_TITLE = 'Élan Scents';
  const ROUTES = {
    overview: { title: 'الرئيسية', module: 'platform' },
    'first-notices': { title: 'الإشعار الأول', module: 'notices' },
    messages: { title: 'الرسائل', module: 'messages' },
    customers: { title: 'العملاء', module: 'customers' },
    stores: { title: 'المتاجر', module: 'stores' },
    settlements: { title: 'العمولات والتسويات', module: 'platform' },
    rankings: { title: 'ترتيب العطور', module: 'platform' },
    audit: { title: 'سجل العمليات', module: 'platform' }
  };
  const DEFAULT_PAGE = 'overview';
  const loaded = {};
  let current = null;

  /* '#customers' -> 'customers'; anything we do not have opens the overview, so an old or mistyped address never shows a blank panel. */
  function pageFromHash(hash) {
    const key = String(hash || '').replace(/^#/, '').split(/[/?]/)[0];
    return Object.prototype.hasOwnProperty.call(ROUTES, key) ? key : DEFAULT_PAGE;
  }

  function setNav(open) {
    document.body.classList.toggle('nav-open', open);
    const toggle = $('#menuToggle');
    if (toggle) toggle.setAttribute('aria-expanded', String(open));
    const backdrop = $('#navBackdrop');
    if (backdrop) backdrop.hidden = !open;
  }

  function composeTitle() {
    const route = ROUTES[current];
    const unread = AdminAlerts.state().unread;
    document.title = `${unread > 0 ? `(${numberP(unread)}) ` : ''}${route ? route.title : 'لوحة إدارة المنصة'} · ${BASE_TITLE}`;
  }

  function showError(moduleKey, error) {
    const spec = AdminPages.get(moduleKey);
    if (spec && typeof spec.onError === 'function') spec.onError(error);
  }

  function run(moduleKey, force) {
    const spec = AdminPages.get(moduleKey);
    if (!spec) return Promise.resolve();
    if (loaded[moduleKey] && !force) return loaded[moduleKey];
    const task = Promise.resolve().then(() => (force && typeof spec.refresh === 'function' ? spec.refresh() : spec.load()))
      .catch(error => { loaded[moduleKey] = null; showError(moduleKey, error); });
    loaded[moduleKey] = task;
    return task;
  }

  function show(key) {
    current = key;
    document.querySelectorAll('.page').forEach(page => { page.hidden = page.dataset.page !== key; });
    document.querySelectorAll('#adminNav .nav-link').forEach(link => {
      if (link.dataset.page === key) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    });
    const heading = $('#pageTitle');
    if (heading) heading.textContent = ROUTES[key].title;
    composeTitle();
    setNav(false);
    run(ROUTES[key].module, false);
    const spec = AdminPages.get(ROUTES[key].module);
    if (spec && typeof spec.onShow === 'function') { try { spec.onShow(key); } catch (_) {} }
    const main = $('#adminMain');
    if (main) main.scrollTop = 0;
    if (typeof window.scrollTo === 'function') window.scrollTo(0, 0);
  }

  function route() {
    if (!appOpen()) return;
    const key = pageFromHash(location.hash);
    if (location.hash && location.hash !== `#${key}` && !/^#[a-z-]+[/?]/.test(location.hash)) {
      // An unknown address: show the overview and write its address, so the back button does not go to a blank page.
      history.replaceState(null, '', `#${key}`);
    }
    show(key);
  }
  const appOpen = () => { const app = $('#app'); return !!app && !app.hidden; };

  function showLogin(text) {
    const boot = $('#boot'); if (boot) boot.hidden = true;
    $('#app').hidden = true;
    $('#login').hidden = false;
    $('#logout').hidden = true;
    $('#refresh').hidden = true;
    $('#message').textContent = text || '';
    document.title = `دخول إدارة المنصة · ${BASE_TITLE}`;
  }
  function showApp() {
    const boot = $('#boot'); if (boot) boot.hidden = true;
    $('#login').hidden = true;
    $('#app').hidden = false;
    $('#logout').hidden = false;
    $('#refresh').hidden = false;
    $('#message').textContent = '';
    AdminAlerts.start();
    route();
  }

  /* Opens the panel with the stored session: the first read decides whether the account may be here. */
  async function enter() {
    if (!Portal.session()) return showLogin('');
    const boot = $('#boot'); if (boot) boot.hidden = false;
    $('#login').hidden = true;
    try {
      await AdminAlerts.probe();
      showApp();
    } catch (error) {
      if (error.status === 401) { try { localStorage.removeItem('elan_auth_session'); } catch (_) {} }
      showLogin(error.status === 401 || error.status === 403 ? Portal.errorText(error, 'تعذر فتح لوحة المنصة بهذا الحساب.') : Portal.errorText(error, 'تعذر فتح اللوحة الآن، حاول مرة أخرى.'));
    }
  }

  function bind() {
    window.addEventListener('hashchange', route);
    const form = $('#loginForm');
    form.addEventListener('submit', async event => {
      event.preventDefault();
      $('#message').textContent = '';
      const button = form.querySelector('button[type="submit"]');
      if (button) button.disabled = true;
      try { await Portal.login(form); await enter(); }
      catch (error) { showLogin(Portal.errorText(error, 'تعذر تسجيل الدخول، حاول مرة أخرى.')); }
      finally { if (button) button.disabled = false; }
    });
    const refresh = $('#refresh');
    refresh.addEventListener('click', () => {
      if (!current) return;
      run(ROUTES[current].module, true);
      AdminAlerts.pollOnce();
    });
    $('#menuToggle').addEventListener('click', () => setNav(!document.body.classList.contains('nav-open')));
    $('#navBackdrop').addEventListener('click', () => setNav(false));
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && document.body.classList.contains('nav-open')) { setNav(false); $('#menuToggle').focus(); } });
    $('#adminNav').addEventListener('click', event => {
      const link = event.target.closest('a[data-page]');
      // The link to the page that is already open does not change the address, so it would not close the menu on its own.
      if (link) setNav(false);
    });
    AdminAlerts.onChange(composeTitle);
    AdminAlerts.onAuthProblem(error => { if (error.status === 401) { try { localStorage.removeItem('elan_auth_session'); } catch (_) {} } showLogin(Portal.errorText(error, 'انتهت جلسة الدخول، سجّل الدخول من جديد.')); });
    AdminAlerts.bind();
    AdminAttention.onChange(renderAttention);
    renderAttention([]);
  }

  /* The overview's «ينتظرك الآن» list. */
  function renderAttention(items) {
    const list = $('#attentionList');
    const empty = $('#attentionEmpty');
    if (!list) return;
    list.innerHTML = items.map(item => `<li class="attention-item tone-${escP(item.tone)}"><a href="${escP(item.href)}"><span>${escP(item.text)}</span><i aria-hidden="true">فتح</i></a></li>`).join('');
    if (empty) empty.hidden = items.length > 0;
  }

  bind();
  enter();
  return { pageFromHash, routes: () => Object.keys(ROUTES), current: () => current };
})();
