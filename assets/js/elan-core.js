/**
 * Élan Scents — UI core: unified Perfume Card, cart drawer, chrome
 */
const Elan = (() => {
  const CART_KEY = 'elan_cart';
  let cart = [];

  function loadCart() {
    try { cart = JSON.parse(localStorage.getItem(CART_KEY) || '[]'); } catch { cart = []; }
    return cart;
  }
  function saveCart() {
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
    updateCartBadge();
  }
  function updateCartBadge() {
    const n = cart.reduce((s, i) => s + (i.quantity || 1), 0);
    document.querySelectorAll('[data-cart-count]').forEach(el => {
      el.textContent = n > 0 ? String(n) : '';
      el.style.display = n > 0 ? 'flex' : 'none';
    });
  }

  function showToast(msg, type) {
    let t = document.querySelector('.elan-toast');
    if (!t) { t = document.createElement('div'); t.className = 'elan-toast'; document.body.appendChild(t); }
    t.textContent = msg;
    t.classList.toggle('error', type === 'error');
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2800);
  }

  /** Prompt 1 §4.11 quantity rule */
  function addToCart(item, openDrawer = true) {
    loadCart();
    const maxQ = item.max_qty != null && item.max_qty !== '' ? Number(item.max_qty) : 99;
    const existing = cart.find(c => c.id === item.id && c.store_id === item.store_id);
    if (existing) {
      if (existing.quantity >= maxQ) {
        showToast('المتاح حالياً: ' + maxQ + ' فقط', 'error');
        if (openDrawer) openCart();
        return false;
      }
      existing.quantity += 1;
    } else {
      cart.push({
        id: item.id, name: item.name, brand: item.brand,
        store: item.store, store_id: item.store_id,
        price: item.price, image: item.image,
        quantity: 1, max_qty: maxQ
      });
    }
    saveCart();
    showToast('تمت الإضافة إلى السلة');
    if (openDrawer) openCart();
    return true;
  }

  function removeFromCart(id, storeId) {
    loadCart();
    cart = cart.filter(c => !(c.id === id && c.store_id === storeId));
    saveCart();
    renderCartDrawer();
  }

  function setQty(id, storeId, qty) {
    loadCart();
    const item = cart.find(c => c.id === id && c.store_id === storeId);
    if (!item) return;
    const maxQ = item.max_qty != null ? Number(item.max_qty) : 99;
    if (qty > maxQ) { showToast('المتاح حالياً: ' + maxQ + ' فقط', 'error'); item.quantity = maxQ; }
    else if (qty < 1) { removeFromCart(id, storeId); return; }
    else item.quantity = qty;
    saveCart();
    renderCartDrawer();
  }

  function openCart() {
    renderCartDrawer();
    document.getElementById('cartOverlay')?.classList.add('open');
    document.getElementById('cartDrawer')?.classList.add('open');
    document.body.style.overflow = 'hidden';
  }
  function closeCart() {
    document.getElementById('cartOverlay')?.classList.remove('open');
    document.getElementById('cartDrawer')?.classList.remove('open');
    if (!document.getElementById('mobileMenu')?.classList.contains('open')) {
      document.body.style.overflow = '';
    }
  }

  function renderCartDrawer() {
    loadCart();
    const itemsEl = document.getElementById('cartItems');
    const totalEl = document.getElementById('cartTotal');
    const countEl = document.getElementById('cartDrawerCount');
    if (!itemsEl) return;
    if (!cart.length) {
      itemsEl.innerHTML = '<div class="empty-state">سلتك فارغة</div>';
      if (totalEl) totalEl.textContent = '0 ج.م';
      if (countEl) countEl.textContent = '0 منتج';
      return;
    }
    if (countEl) countEl.textContent = cart.length + ' منتج';
    itemsEl.innerHTML = cart.map(item => `
      <div class="cart-line">
        <img src="${item.image || ''}" alt="">
        <div class="cart-line-body">
          <p class="cart-line-name">${item.name || ''}</p>
          <p class="cart-line-meta">${item.brand || ''} · ${item.store || ''}</p>
          <p class="cart-line-price">${(item.price * item.quantity).toLocaleString()} ج.م</p>
          <div class="cart-line-qty">
            <button type="button" data-qty-minus="${item.id}|${item.store_id}">−</button>
            <span>${item.quantity}</span>
            <button type="button" data-qty-plus="${item.id}|${item.store_id}">+</button>
            <button type="button" class="cart-remove" data-remove="${item.id}|${item.store_id}">حذف</button>
          </div>
        </div>
      </div>`).join('');
    if (totalEl) totalEl.textContent = cart.reduce((s, i) => s + i.price * i.quantity, 0).toLocaleString() + ' ج.م';
    itemsEl.querySelectorAll('[data-qty-minus]').forEach(btn => {
      btn.onclick = () => { const [id, sid] = btn.dataset.qtyMinus.split('|'); const it = cart.find(c => c.id === id && c.store_id === sid); if (it) setQty(id, sid, it.quantity - 1); };
    });
    itemsEl.querySelectorAll('[data-qty-plus]').forEach(btn => {
      btn.onclick = () => { const [id, sid] = btn.dataset.qtyPlus.split('|'); const it = cart.find(c => c.id === id && c.store_id === sid); if (it) setQty(id, sid, it.quantity + 1); };
    });
    itemsEl.querySelectorAll('[data-remove]').forEach(btn => {
      btn.onclick = () => { const [id, sid] = btn.dataset.remove.split('|'); removeFromCart(id, sid); };
    });
  }

  /** Unified Perfume Card — Prompt 1 §4.2 */
  function perfumeCardHTML(p, base = '') {
    if (!p || !p.offer) return '';
    const href = base + 'pages/product.html?id=' + encodeURIComponent(p.id);
    const payload = JSON.stringify({
      id: p.id, name: p.name_ar, brand: p.brand_name,
      store: p.offer.store_name, store_id: p.offer.store_id,
      price: p.offer.price, image: p.image, max_qty: p.offer.quantity
    }).replace(/'/g, '&#39;');
    return `<article class="perfume-card elan-3d">
      <a href="${href}" class="img-wrap"><img src="${p.image || ''}" alt="${p.name_ar || ''}" loading="lazy" onerror="this.style.opacity=.35"></a>
      <div class="body">
        <span class="brand">${p.brand_name || ''}</span>
        <a href="${href}" class="name">${p.name_ar || ''}</a>
        <span class="store">${p.offer.store_name || ''}</span>
        ${p.category_label ? `<span class="meta-cat">${p.category_label}</span>` : ''}
        <div class="price">${Number(p.offer.price).toLocaleString()} ج.م</div>
        <div class="card-actions">
          <a class="btn-details" href="${href}">التفاصيل</a>
          <button type="button" class="btn-add" aria-label="إضافة إلى العربة" data-add='${payload}'>
            <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
          </button>
        </div>
      </div>
    </article>`;
  }

  function bindAddButtons(root = document) {
    root.querySelectorAll('[data-add]').forEach(btn => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = '1';
      btn.addEventListener('click', e => {
        e.preventDefault(); e.stopPropagation();
        try { addToCart(JSON.parse(btn.getAttribute('data-add')), true); } catch (err) { console.error(err); }
      });
    });
  }

  function initCarouselBehavior(track, { auto = true, speed = 0.35 } = {}) {
    if (!track || track.dataset.carouselInit) return;
    track.dataset.carouselInit = '1';
    let isDown = false, startX = 0, scrollLeft = 0, paused = false, raf = null;

    const onDown = (e) => {
      isDown = true; paused = true;
      track.classList.add('is-dragging');
      startX = (e.pageX || e.touches?.[0]?.pageX || 0) - track.offsetLeft;
      scrollLeft = track.scrollLeft;
    };
    const onUp = () => {
      isDown = false;
      track.classList.remove('is-dragging');
      setTimeout(() => { paused = false; }, 1200);
    };
    const onMove = (e) => {
      if (!isDown) return;
      e.preventDefault();
      const x = (e.pageX || e.touches?.[0]?.pageX || 0) - track.offsetLeft;
      track.scrollLeft = scrollLeft - (x - startX) * 1.25;
    };
    track.addEventListener('mousedown', onDown);
    track.addEventListener('touchstart', onDown, { passive: true });
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchend', onUp);
    track.addEventListener('mousemove', onMove);
    track.addEventListener('touchmove', onMove, { passive: false });
    track.addEventListener('mouseenter', () => { paused = true; });
    track.addEventListener('mouseleave', () => { if (!isDown) paused = false; });
    track.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        track.scrollLeft += e.deltaY;
        e.preventDefault();
        paused = true;
        clearTimeout(track._wheelT);
        track._wheelT = setTimeout(() => { paused = false; }, 1500);
      }
    }, { passive: false });

    if (auto && track.scrollWidth > track.clientWidth + 20) {
      const tick = () => {
        if (!paused && !isDown) {
          track.scrollLeft += speed;
          // loop seamlessly when near end (content is duplicated)
          if (track.scrollLeft >= track.scrollWidth / 2 - 2) {
            track.scrollLeft = 0;
          }
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }
  }

  function renderCarousel(container, products, { limit = 6, auto = true, base = '', speed = 0.35 } = {}) {
    if (!container) return;
    const list = (products || []).slice(0, limit);
    if (!list.length) {
      container.innerHTML = '<div class="empty-state">لا توجد عناصر متاحة حالياً</div>';
      return;
    }
    const cards = list.map(p => perfumeCardHTML(p, base)).join('');
    // duplicate for seamless loop when auto
    const inner = auto && list.length >= 3 ? cards + cards : cards;
    container.innerHTML = `<div class="carousel-wrap"><div class="carousel-track" data-auto="${auto ? '1' : '0'}">${inner}</div></div>`;
    bindAddButtons(container);
    const track = container.querySelector('.carousel-track');
    initCarouselBehavior(track, { auto: auto && list.length >= 3, speed });
  }

  /** Entity carousels (brands/stores) */
  function bindEntityCarousel(container, { auto = true, speed = 0.3 } = {}) {
    if (!container) return;
    const track = container.querySelector('.carousel-track');
    if (track) initCarouselBehavior(track, { auto, speed });
  }

  function openMenu() {
    document.getElementById('mobileMenu')?.classList.add('open');
    document.getElementById('menuBackdrop')?.classList.add('open');
    document.body.style.overflow = 'hidden';
  }
  function closeMenu() {
    document.getElementById('mobileMenu')?.classList.remove('open');
    document.getElementById('menuBackdrop')?.classList.remove('open');
    if (!document.getElementById('cartDrawer')?.classList.contains('open')) {
      document.body.style.overflow = '';
    }
  }

  function initChrome() {
    loadCart(); updateCartBadge();
    document.getElementById('closeCartBtn')?.addEventListener('click', closeCart);
    document.getElementById('cartOverlay')?.addEventListener('click', closeCart);
    document.querySelectorAll('[data-open-cart]').forEach(el => el.addEventListener('click', e => { e.preventDefault(); openCart(); }));
    document.getElementById('menuOpen')?.addEventListener('click', openMenu);
    document.getElementById('menuClose')?.addEventListener('click', closeMenu);
    document.getElementById('menuBackdrop')?.addEventListener('click', closeMenu);
    document.querySelectorAll('#mobileMenu a').forEach(a => a.addEventListener('click', closeMenu));
    document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeCart(); closeMenu(); } });
  }

  

  function initVisualFX() {
    // Header elevation on scroll
    const header = document.querySelector('.elan-header');
    const onScroll = () => {
      if (!header) return;
      header.classList.toggle('is-scrolled', window.scrollY > 12);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    // Scroll reveal
    const nodes = document.querySelectorAll('.section, .reveal, .gulf-magic, .stats-row');
    nodes.forEach((el, i) => {
      el.classList.add('reveal');
      if (i % 3 === 1) el.classList.add('reveal-delay-1');
      if (i % 3 === 2) el.classList.add('reveal-delay-2');
    });
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver((entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add('is-inview');
            // keep observed so re-entry still feels alive, but once is enough
            io.unobserve(e.target);
          }
        });
      }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
      nodes.forEach((n) => io.observe(n));
    } else {
      nodes.forEach((n) => n.classList.add('is-inview'));
    }

    // Hero orbs (decorative)
    const hero = document.getElementById('heroSection') || document.querySelector('.hero');
    if (hero && !hero.querySelector('.hero-orbs')) {
      const orbs = document.createElement('div');
      orbs.className = 'hero-orbs';
      orbs.setAttribute('aria-hidden', 'true');
      orbs.innerHTML = '<span></span><span></span><span></span>';
      // insert after video/scrim if present
      const scrim = hero.querySelector('.hero-scrim');
      if (scrim) scrim.after(orbs);
      else hero.prepend(orbs);
    }
  }

  const api = {
    get cart() { loadCart(); return cart; },
    loadCart, saveCart, addToCart, removeFromCart, setQty,
    openCart, closeCart, renderCartDrawer, showToast,
    perfumeCardHTML, renderCarousel, bindEntityCarousel, bindAddButtons, initChrome, updateCartBadge, initCarouselBehavior, initVisualFX,
    openMenu, closeMenu
  };
  return api;
})();

document.addEventListener('DOMContentLoaded', () => { Elan.initChrome(); Elan.initVisualFX(); });
