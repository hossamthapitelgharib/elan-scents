/* «الرسائل»: every message addressed to the platform (new orders, cancellation requests, new customers…), newest first, with «تمت القراءة» one by one or all at
   once. The alert centre (admin-alerts.js) is what tells the admin a new one arrived; this page is where they are read and kept. Names stay inside this
   function so the page can share the admin panel's global scope. */
const AdminMessages = (() => {
  const PAGE = 30;
  const state = { view: 'all', type: '', rows: [], hasMore: false, busy: false, typesFilled: false, lastUnread: null };

  function chip(text, tone) { return `<span class="chip chip-${escP(tone)}">${escP(text)}</span>`; }

  function rowMarkup(message) {
    const kind = AdminAlerts.kindOf(message.type);
    const toNotice = kind.href === '#first-notices' && message.trackingNumber;
    return `<li class="message tone-${escP(kind.tone)}${message.isRead ? '' : ' is-unread'}" data-message-id="${escP(message.id)}">`
      + `<span class="message-dot" aria-hidden="true"></span>`
      + `<div class="message-body"><div class="message-top"><b>${escP(message.title || kind.label)}</b>${chip(kind.label, kind.tone)}${message.isRead ? '' : '<span class="message-new">جديدة</span>'}</div>`
      + `${message.body ? `<p>${escP(message.body)}</p>` : ''}`
      + `<div class="message-meta"><time>${escP(dateP(message.createdAt))}</time>${message.trackingNumber ? `<span dir="ltr">${escP(message.trackingNumber)}</span>` : ''}</div></div>`
      + `<div class="message-actions">${toNotice ? '<a class="ghost" href="#first-notices">قراءة الإشعار الأول</a>' : ''}${message.isRead ? '' : `<button class="ghost" type="button" data-message-read="${escP(message.id)}">تمت القراءة</button>`}</div></li>`;
  }

  function emptyText() {
    if (state.view === 'unread') return 'قرأت كل الرسائل. الرسالة الجديدة تظهر هنا وأعلى اللوحة فور وصولها.';
    return state.type ? 'لا توجد رسائل من هذا النوع.' : 'لا توجد رسائل بعد. تظهر هنا طلبات المتاجر وطلبات الإلغاء وتسجيل العملاء فور حدوثها.';
  }

  function draw() {
    $('#messagesList').innerHTML = state.rows.map(rowMarkup).join('');
    const empty = $('#messagesEmpty');
    empty.hidden = state.rows.length > 0;
    empty.textContent = emptyText();
    $('#messagesMore').hidden = !state.hasMore;
    $('#messagesTabAll').setAttribute('aria-selected', String(state.view === 'all'));
    $('#messagesTabUnread').setAttribute('aria-selected', String(state.view === 'unread'));
    $('#messagesReadAll').disabled = AdminAlerts.state().unread === 0;
  }

  function showError(error) {
    const box = $('#messagesError');
    if (!box) return;
    box.textContent = errorTextP(error, 'تعذر تحميل الرسائل، حاول مرة أخرى.');
    box.hidden = false;
  }

  function fillTypes() {
    const select = $('#messagesType');
    if (!select || state.typesFilled) return;
    state.typesFilled = true;
    AdminAlerts.kinds().forEach(kind => {
      const option = document.createElement('option');
      option.value = kind.type;
      option.textContent = kind.label;
      select.appendChild(option);
    });
  }

  async function loadMessages(append) {
    if (state.busy) return;
    state.busy = true;
    try {
      const params = new URLSearchParams({ limit: String(PAGE), offset: String(append ? state.rows.length : 0) });
      if (state.view === 'unread') params.set('unread', '1');
      if (state.type) params.set('type', state.type);
      const data = await AdminAlerts.fetchAlerts(params.toString());
      const rows = Array.isArray(data.notifications) ? data.notifications : [];
      state.rows = append ? state.rows.concat(rows) : rows;
      state.hasMore = !!data.hasMore;
      state.lastUnread = Number(data.unread) || 0;
      $('#messagesError').hidden = true;
      draw();
    } finally {
      state.busy = false;
    }
  }

  async function read(target) {
    try {
      await AdminAlerts.markRead(target);
      await loadMessages(false);
    } catch (error) { showError(error); }
  }

  function bind() {
    const list = $('#messagesList');
    if (!list) return;
    list.addEventListener('click', event => {
      const button = event.target.closest('[data-message-read]');
      if (button) read({ id: button.dataset.messageRead });
    });
    $('#messagesReadAll').addEventListener('click', () => read({ all: true }));
    $('#messagesMore').addEventListener('click', () => { loadMessages(true).catch(showError); });
    $('#messagesType').addEventListener('change', event => { state.type = event.target.value; loadMessages(false).catch(showError); });
    document.querySelectorAll('[data-messages-view]').forEach(tab => tab.addEventListener('click', () => {
      state.view = tab.dataset.messagesView === 'unread' ? 'unread' : 'all';
      loadMessages(false).catch(showError);
    }));
    // A message that arrives while this page is open appears in the list without pressing anything.
    AdminAlerts.onChange(snapshot => {
      const page = $('#page-messages');
      if (page && !page.hidden && state.lastUnread !== null && snapshot.unread !== state.lastUnread && !state.busy) loadMessages(false).catch(() => {});
    });
  }

  bind();
  AdminPages.register('messages', {
    load: () => { fillTypes(); return loadMessages(false); },
    onShow: () => { if (state.lastUnread !== null && AdminAlerts.state().unread !== state.lastUnread) loadMessages(false).catch(() => {}); },
    onError: showError
  });
  return { rowMarkup };
})();
