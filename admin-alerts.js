/* The alert centre of the admin panel: it hears about new messages while the panel is open, so the admin does not have to keep refreshing.
   - It asks /api/platform-alerts every 15 seconds while the tab is in front (every minute in the background) and silently remembers what is
     already there. Only what arrives AFTER that is an alert: a short two-note chime (when sound is on), a card at the top of the panel that stays until
     it is read or hidden, the number on the «الرسائل» bell and in the tab title, and, if the admin allowed it, a browser notification while the tab is hidden.
   - Sound is made with the Web Audio API (no file to load). It is ON by default: the admin never has to press the sound button to get it. A browser
     only lets a page make sound after the person has touched it, so the panel starts the audio itself the moment the page is allowed to (at once where
     the browser permits, otherwise on the first click, tap or key press ANYWHERE on the page, silently) and until then the button says
     «اضغط أي مكان لتشغيل الصوت». The button only turns the sound OFF (and back on); that choice is remembered.
   - The choice (sound, browser notifications) is kept in this browser only. It is a convenience, not data: when storage is blocked the panel works
     and simply asks again next time.
   Other pages add their own alerts by calling AdminAttention.set(...) (the overview lists them); this file only owns the platform's messages. */
const AdminAlerts = (() => {
  const POLL_VISIBLE_MS = 15000;
  const POLL_HIDDEN_MS = 60000;
  const PAGE = 30;
  const MAX_STRIP = 4;
  const SOUND_KEY = 'elan_admin_sound';
  const DESKTOP_KEY = 'elan_admin_desktop';
  const NOTICES_SEEN_KEY = 'elan_admin_notices_seen';

  /* What each kind of message is called, whether it is heard, and where «افتح» goes. A kind we do not know is heard: a new alert should not pass in silence. */
  const KINDS = {
    order_payment_recorded: { label: 'دفع طلب', sound: true, href: '#first-notices', tone: 'good' },
    order_cod_selected: { label: 'طلب بالدفع عند الاستلام', sound: true, href: '#first-notices', tone: 'good' },
    order_initial: { label: 'طلب جديد', sound: true, href: '#messages', tone: 'info' },
    customer_cancel_requested: { label: 'طلب إلغاء', sound: true, href: '#messages', tone: 'warn' },
    /* Stage 1 of the purchase flow: the platform sends each order to the store itself and tells the admin when that fails.
       A failed attempt repeats up to six times ten seconds apart, so it stays silent; the cancellation that follows is what is heard. */
    order_delivery_attempt_failed: { label: 'فشل إرسال طلب للمتجر', sound: false, href: '#messages', tone: 'warn' },
    order_cancelled: { label: 'طلب أُلغي', sound: true, href: '#messages', tone: 'warn' },
    order_cancel_delivery_failed: { label: 'تعذّر إبلاغ المتجر بالإلغاء', sound: true, href: '#messages', tone: 'warn' },
    customer_registered: { label: 'عميل جديد', sound: false, href: '#customers', tone: 'info' }
  };
  const kindOf = type => KINDS[type] || { label: 'رسالة', sound: true, href: '#messages', tone: 'info' };

  const state = {
    primed: false, seen: new Set(), unread: 0, firstNotices: 0, strip: [], failures: 0,
    timer: null, started: false, polling: false, audio: null, soundOn: true, locked: false, gestureAt: 0, desktopOn: false, authHandler: null
  };
  const listeners = [];

  function remember(key, value) { try { localStorage.setItem(key, value); } catch (_) {} }
  function recall(key) { try { return localStorage.getItem(key); } catch (_) { return null; } }
  const appOpen = () => { const app = $('#app'); return !!app && !app.hidden && !!Portal.session(); };

  /* ---- talking to the API ---- */
  async function fetchJson(url, options) {
    const response = await fetch(url, options);
    let data = null;
    try { data = await response.json(); } catch (_) { data = null; }
    if (!response.ok) {
      const error = new Error((data && data.error) || 'request_failed');
      error.status = response.status;
      throw error;
    }
    return data || {};
  }
  const fetchAlerts = query => fetchJson(`/api/platform-alerts${query ? `?${query}` : ''}`, { headers: Portal.auth() });

  /* ---- sound ---- */
  function audioContext(create) {
    if (state.audio || !create) return state.audio;
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return null;
    try { state.audio = new Context(); } catch (_) { state.audio = null; }
    return state.audio;
  }
  function unlock() {
    const context = audioContext(true);
    if (!context) return Promise.resolve(false);
    if (context.state === 'running') return Promise.resolve(true);
    return Promise.resolve(context.resume()).then(() => context.state === 'running').catch(() => false);
  }
  /* Two rising notes for news, three for something that needs a decision. Short and soft: it is heard in an office, not in a street. */
  function chime(tone) {
    const context = state.audio;
    if (!context || context.state !== 'running') return false;
    const notes = tone === 'warn' ? [880, 660, 880] : [660, 880];
    const start = context.currentTime + 0.02;
    notes.forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const at = start + index * 0.22;
      oscillator.type = 'triangle';
      oscillator.frequency.setValueAtTime(frequency, at);
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.2, at + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.5);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(at);
      oscillator.stop(at + 0.55);
    });
    return true;
  }
  /* Must be called from a click or key press (that is what lets the browser start audio). */
  function setSound(on) {
    state.soundOn = !!on;
    remember(SOUND_KEY, on ? '1' : '0');
    if (!on) { state.locked = false; render(); return Promise.resolve(false); }
    return unlock().then(ok => { state.locked = !ok; if (ok) chime('info'); render(); return ok; });
  }
  /* Sound is on unless the admin turned it off, so the first touch anywhere on the page starts the audio, silently. gestureAt lets the sound button tell
     that its own press was that first touch (and play the test chime instead of switching the sound off). */
  const GESTURES = ['pointerdown', 'keydown', 'touchstart'];
  let gestureHandler = null;
  function disarmUnlock() {
    if (!gestureHandler) return;
    GESTURES.forEach(name => document.removeEventListener(name, gestureHandler, true));
    gestureHandler = null;
  }
  function armUnlock() {
    if (gestureHandler) return;
    gestureHandler = () => {
      if (!state.soundOn) return;
      unlock().then(ok => {
        state.locked = !ok;
        if (ok) { state.gestureAt = Date.now(); disarmUnlock(); }
        render();
      });
    };
    GESTURES.forEach(name => document.addEventListener(name, gestureHandler, true));
  }
  /* Where the browser already allows sound (an installed app, a site the person uses a lot) the audio starts without any touch at all. */
  function tryStartNow() {
    if (!(window.AudioContext || window.webkitAudioContext)) return;
    unlock().then(ok => { if (ok) { state.locked = false; disarmUnlock(); render(); } });
  }

  /* ---- browser notifications (only while the tab is hidden: when it is open the card at the top is enough) ---- */
  const desktopSupported = () => typeof Notification !== 'undefined';
  function setDesktop(on) {
    if (!on || !desktopSupported()) { state.desktopOn = false; remember(DESKTOP_KEY, '0'); render(); return Promise.resolve(false); }
    return Promise.resolve(Notification.requestPermission()).then(permission => {
      state.desktopOn = permission === 'granted';
      remember(DESKTOP_KEY, state.desktopOn ? '1' : '0');
      render();
      return state.desktopOn;
    });
  }
  function notifyDesktop(item) {
    if (!state.desktopOn || !desktopSupported() || Notification.permission !== 'granted' || !document.hidden) return;
    try {
      const note = new Notification(item.title, { body: item.body, tag: item.id, lang: 'ar', dir: 'rtl' });
      note.onclick = () => { window.focus(); if (item.href) location.hash = item.href; note.close(); };
    } catch (_) {}
  }

  /* ---- what arrived ---- */
  function itemOf(message) {
    const kind = kindOf(message.type);
    return { id: message.id, type: message.type, title: message.title || kind.label, body: message.body || '', href: kind.href, tone: kind.tone, sound: kind.sound, createdAt: message.createdAt, synthetic: false };
  }

  /* The first poll only records what is already there: opening the panel must not play a chime for yesterday's messages. */
  function ingest(data) {
    const messages = Array.isArray(data.notifications) ? data.notifications : [];
    const total = Number(data.firstNotices) || 0;
    const known = new Map(messages.map(message => [message.id, message]));
    if (!state.primed) {
      messages.forEach(message => state.seen.add(message.id));
      state.primed = true;
    } else {
      const fresh = messages.filter(message => !state.seen.has(message.id) && !message.isRead).reverse();
      messages.forEach(message => state.seen.add(message.id));
      const items = fresh.map(itemOf);
      // A first notice arrived but its message is not among the new ones (it fell outside the page, or was already read): say so once.
      const covered = fresh.some(message => message.type === 'order_payment_recorded' || message.type === 'order_cod_selected');
      if (total > state.firstNotices && !covered) {
        items.push({ id: `first-notice-${total}`, type: 'first_notice', title: 'إشعار أول جديد', body: 'وصل إشعار أول جديد. افتحه لقراءته.', href: '#first-notices', tone: 'good', sound: true, createdAt: data.serverTime, synthetic: true });
      }
      items.forEach(item => { state.strip.unshift(item); notifyDesktop(item); });
      if (items.length) {
        const heard = items.filter(item => item.sound);
        if (heard.length && state.soundOn) chime(heard.some(item => item.tone === 'warn') ? 'warn' : 'info');
      }
    }
    // What was read somewhere else leaves the card (what the admin hid is already in `seen`, so it does not come back).
    state.strip = state.strip.filter(item => item.synthetic || !known.has(item.id) || !known.get(item.id).isRead);
    state.firstNotices = total;
    state.unread = Math.max(0, Number(data.unread) || 0);
    publishAttention();
  }

  function noticesUnseen() {
    const seen = Number(recall(NOTICES_SEEN_KEY));
    const base = Number.isFinite(seen) && seen > 0 ? Math.min(seen, state.firstNotices) : 0;
    return Math.max(0, state.firstNotices - base);
  }
  function publishAttention() {
    AdminAttention.set('messages', { count: state.unread, text: `${numberP(state.unread)} ${state.unread === 1 ? 'رسالة لم تُقرأ' : 'رسائل لم تُقرأ'}`, href: '#messages', tone: 'info', order: 10 });
    const unseen = noticesUnseen();
    AdminAttention.set('notices', { count: unseen, text: `${numberP(unseen)} ${unseen === 1 ? 'إشعار أول لم تفتحه' : 'إشعارات أولى لم تفتحها'}`, href: '#first-notices', tone: 'good', order: 15 });
  }
  /* The first-notices page calls this when the admin opens it: what is listed there counts as seen. */
  function noticesSeen(total) {
    const count = Number.isFinite(Number(total)) ? Number(total) : state.firstNotices;
    remember(NOTICES_SEEN_KEY, String(count));
    state.strip = state.strip.filter(item => item.type !== 'first_notice');
    publishAttention();
    render();
  }

  /* ---- polling ---- */
  async function pollOnce() {
    if (state.polling) return;
    state.polling = true;
    try {
      ingest(await fetchAlerts(`limit=${PAGE}`));
      state.failures = 0;
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        stop();
        if (state.authHandler) state.authHandler(error);
      } else state.failures += 1;
    } finally {
      state.polling = false;
      render();
    }
  }
  function schedule() {
    clearTimeout(state.timer);
    if (!state.started) return;
    state.timer = setTimeout(async () => {
      if (!appOpen()) { stop(); return; }
      await pollOnce();
      schedule();
    }, document.hidden ? POLL_HIDDEN_MS : POLL_VISIBLE_MS);
  }
  /* The first read, also used as the "is this account allowed in" check: it throws with .status 401 or 403 for an account that is not a platform admin. */
  async function probe() {
    const data = await fetchAlerts(`limit=${PAGE}`);
    state.failures = 0;
    ingest(data);
    render();
    return data;
  }
  function start() {
    if (state.started) return;
    state.started = true;
    if (!state.primed) pollOnce();
    schedule();
  }
  function stop() { state.started = false; clearTimeout(state.timer); state.timer = null; }

  /* ---- reading a message ---- */
  async function markRead(target) {
    await fetchJson('/api/platform-alerts', { method: 'PATCH', headers: { ...Portal.auth(), 'Content-Type': 'application/json' }, body: JSON.stringify(target) });
    const ids = target.all ? null : new Set(target.ids || [target.id]);
    state.strip = state.strip.filter(item => (ids ? !ids.has(item.id) : item.synthetic));
    await pollOnce();
  }
  function hideItem(id) { state.strip = state.strip.filter(item => item.id !== id); render(); }

  /* ---- drawing ---- */
  function timeText(value) { return dateP(value); }
  function stripMarkup() {
    const shown = state.strip.slice(0, MAX_STRIP);
    const more = state.strip.length - shown.length;
    return shown.map(item => `<li class="alert-item tone-${escP(item.tone)}" data-alert-id="${escP(item.id)}"><div class="alert-text"><b>${escP(item.title)}</b>${item.body ? `<span>${escP(item.body)}</span>` : ''}<time>${escP(timeText(item.createdAt))}</time></div><div class="alert-actions"><a class="alert-open" href="${escP(item.href)}" data-alert-open="${escP(item.id)}">افتح</a>${item.synthetic ? '' : `<button type="button" data-alert-read="${escP(item.id)}">تمت القراءة</button>`}<button type="button" class="alert-hide" data-alert-hide="${escP(item.id)}" aria-label="إخفاء التنبيه">إخفاء</button></div></li>`).join('')
      + (more > 0 ? `<li class="alert-more"><a href="#messages">و${escP(numberP(more))} ${more === 1 ? 'تنبيه آخر' : 'تنبيهات أخرى'} في الرسائل</a></li>` : '');
  }
  function render() {
    const unread = state.unread;
    const count = unread > 99 ? '٩٩+' : numberP(unread);
    const bell = $('#bellCount');
    if (bell) { bell.hidden = unread <= 0; bell.textContent = count; }
    document.querySelectorAll('[data-count-for="messages"]').forEach(node => { node.hidden = unread <= 0; node.textContent = count; });
    const tab = $('#messagesUnreadCount');
    if (tab) { tab.hidden = unread <= 0; tab.textContent = count; }

    const sound = $('#soundToggle');
    if (sound) {
      const mode = !state.soundOn ? 'off' : state.locked ? 'locked' : 'on';
      sound.dataset.state = mode;
      sound.setAttribute('aria-pressed', String(state.soundOn));
      const label = $('#soundLabel');
      if (label) label.textContent = mode === 'off' ? 'الصوت مغلق' : mode === 'locked' ? 'اضغط أي مكان لتشغيل الصوت' : 'الصوت يعمل';
    }
    const desktop = $('#desktopToggle');
    if (desktop) {
      const blocked = desktopSupported() && Notification.permission === 'denied';
      desktop.disabled = !desktopSupported() || blocked;
      desktop.setAttribute('aria-pressed', String(state.desktopOn));
      desktop.textContent = !desktopSupported() ? 'إشعارات المتصفح: غير مدعومة هنا' : blocked ? 'إشعارات المتصفح: محجوبة من إعدادات المتصفح' : `إشعارات المتصفح: ${state.desktopOn ? 'مفتوحة' : 'مغلقة'}`;
    }
    const health = $('#alertHealth');
    if (health) health.hidden = state.failures < 3;

    const strip = $('#alertStrip');
    const list = $('#alertStripList');
    if (strip && list) { list.innerHTML = stripMarkup(); strip.hidden = state.strip.length === 0; }
    listeners.forEach(callback => { try { callback(publicState()); } catch (_) {} });
  }
  const publicState = () => ({ unread: state.unread, firstNotices: state.firstNotices, soundOn: state.soundOn, locked: state.locked, desktopOn: state.desktopOn });

  /* ---- wiring ---- */
  function bind() {
    state.soundOn = recall(SOUND_KEY) !== '0';   // on unless the admin chose off in this browser
    state.locked = state.soundOn;
    state.desktopOn = recall(DESKTOP_KEY) === '1' && desktopSupported() && Notification.permission === 'granted';
    if (state.soundOn) { armUnlock(); tryStartNow(); }
    const sound = $('#soundToggle');
    if (sound) sound.addEventListener('click', () => {
      if (!state.soundOn) setSound(true);
      else if (state.locked || Date.now() - state.gestureAt < 700) unlock().then(ok => { state.locked = !ok; if (ok) chime('info'); render(); });
      else setSound(false);
    });
    const test = $('#soundTest');
    if (test) test.addEventListener('click', () => { if (!state.soundOn) setSound(true); else unlock().then(ok => { state.locked = !ok; if (ok) chime('info'); render(); }); });
    const desktop = $('#desktopToggle');
    if (desktop) desktop.addEventListener('click', () => setDesktop(!state.desktopOn));
    const list = $('#alertStripList');
    if (list) list.addEventListener('click', event => {
      const read = event.target.closest('[data-alert-read]');
      const hide = event.target.closest('[data-alert-hide]');
      const open = event.target.closest('[data-alert-open]');
      if (read) markRead({ id: read.dataset.alertRead }).catch(() => {});
      else if (hide) hideItem(hide.dataset.alertHide);
      else if (open) {
        const item = state.strip.find(entry => entry.id === open.dataset.alertOpen);
        if (item && !item.synthetic) markRead({ id: item.id }).catch(() => {}); else hideItem(open.dataset.alertOpen);
      }
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && state.started && appOpen()) { pollOnce(); schedule(); } });
    render();
  }

  return {
    kindOf, kinds: () => Object.keys(KINDS).map(type => ({ type, label: KINDS[type].label })),
    probe, start, stop, bind, render, markRead, noticesSeen, setSound, setDesktop, fetchAlerts, pollOnce,
    onAuthProblem(callback) { state.authHandler = callback; },
    onChange(callback) { if (typeof callback === 'function') listeners.push(callback); },
    state: publicState,
    /* for the unit test */
    _ingest: ingest, _strip: () => state.strip.slice(), _chime: chime, _setAudio(context) { state.audio = context; },
    _soundOn(value) { state.soundOn = !!value; },
    _gestureLongAgo() { state.gestureAt = 0; }
  };
})();
