/**
 * Élan Scents – Core Frontend Logic
 * Handles: Cart, Auth UI, Data helpers, Language, Notifications
 * This is a frontend-only prototype layer. Ready to connect to real APIs later.
 */

const Elan = (function () {
  // ---------- State ----------
  let cart = JSON.parse(localStorage.getItem('elan_cart') || '[]');
  let lastAddedId = null;
  let favorites = JSON.parse(localStorage.getItem('elan_favorites') || '[]');
  let user = JSON.parse(localStorage.getItem('elan_user') || 'null');
  let lang = localStorage.getItem('elan_lang') || 'ar';

  // ---------- Helpers ----------
  function saveCart() {
    localStorage.setItem('elan_cart', JSON.stringify(cart));
    updateCartBadge();
  }

  function saveFavorites() {
    localStorage.setItem('elan_favorites', JSON.stringify(favorites));
  }

  function saveUser() {
    localStorage.setItem('elan_user', JSON.stringify(user));
  }

  function formatPrice(price, currency = 'ج.م') {
    return `${Number(price).toLocaleString('ar-EG')} ${currency}`;
  }

  function showToast(message, type = 'success') {
    const existing = document.querySelector('.elan-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = `elan-toast fixed bottom-6 left-1/2 -translate-x-1/2 z-[100] px-6 py-3 rounded-full text-sm font-medium shadow-lg transition-all duration-300 ${
      type === 'success' ? 'bg-elan-charcoal text-white' : 'bg-red-600 text-white'
    }`;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, 2600);
  }

  // ---------- Cart ----------
  function addToCart(product, storeProduct) {
    const existing = cart.find(
      (item) => item.productId === product.id && item.storeProductId === storeProduct.id
    );

    if (existing) {
      existing.quantity += 1;
    } else {
      cart.push({
        productId: product.id,
        storeProductId: storeProduct.id,
        name: product.name_ar || product.name_en,
        brand: product.brand_name || '',
        store: storeProduct.store_name || '',
        price: storeProduct.price,
        currency: storeProduct.currency || 'ج.م',
        image: product.image,
        quantity: 1,
        size_ml: product.size_ml
      });
    }
    lastAddedId = storeProduct.id;
    saveCart();
    pulseCartBadge();
    openCart();
  }

  function removeFromCart(storeProductId) {
    cart = cart.filter((item) => item.storeProductId !== storeProductId);
    saveCart();
    renderCartDrawer();
    showToast('تم الحذف من السلة');
  }

  function updateQuantity(storeProductId, delta) {
    const item = cart.find((i) => i.storeProductId === storeProductId);
    if (!item) return;
    item.quantity += delta;
    if (item.quantity <= 0) {
      removeFromCart(storeProductId);
      return;
    }
    saveCart();
    renderCartDrawer();
  }

  function getCartTotal() {
    return cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
  }

  function getCartCount() {
    return cart.reduce((sum, item) => sum + item.quantity, 0);
  }

  function pulseCartBadge() {
    document.querySelectorAll('[data-cart-badge]').forEach((b) => {
      b.classList.remove('badge-pulse');
      void b.offsetWidth;
      b.classList.add('badge-pulse');
      setTimeout(() => b.classList.remove('badge-pulse'), 500);
    });
  }

  function updateCartBadge() {
    const badges = document.querySelectorAll('[data-cart-badge]');
    const count = getCartCount();
    badges.forEach((b) => {
      b.textContent = count;
      b.classList.toggle('hidden', count === 0);
    });
  }

  // ---------- Favorites ----------
  function toggleFavorite(productId) {
    const idx = favorites.indexOf(productId);
    if (idx > -1) {
      favorites.splice(idx, 1);
      showToast('تمت الإزالة من المفضلة');
    } else {
      favorites.push(productId);
      showToast('تمت الإضافة إلى المفضلة');
    }
    saveFavorites();
    return favorites.includes(productId);
  }

  function isFavorite(productId) {
    return favorites.includes(productId);
  }

  // ---------- Auth (UI only) ----------
  function openAuth(mode = 'login') {
    const modal = document.getElementById('authModal');
    if (!modal) return;
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';

    const loginForm = document.getElementById('loginForm');
    const registerForm = document.getElementById('registerForm');
    if (mode === 'login') {
      loginForm?.classList.remove('hidden');
      registerForm?.classList.add('hidden');
    } else {
      loginForm?.classList.add('hidden');
      registerForm?.classList.remove('hidden');
    }
  }

  function closeAuth() {
    const modal = document.getElementById('authModal');
    if (!modal) return;
    modal.classList.add('hidden');
    document.body.style.overflow = '';
  }

  function handleLogin(email, password) {
    // Demo only
    user = {
      id: 'demo-user',
      email,
      full_name: email.split('@')[0],
      preferred_language: lang
    };
    saveUser();
    closeAuth();
    showToast('مرحباً بك في Élan Scents');
    updateAuthUI();
  }

  function handleRegister(name, email, password) {
    user = {
      id: 'demo-user-' + Date.now(),
      email,
      full_name: name,
      preferred_language: lang
    };
    saveUser();
    closeAuth();
    showToast('تم إنشاء الحساب بنجاح');
    updateAuthUI();
  }

  function logout() {
    user = null;
    localStorage.removeItem('elan_user');
    showToast('تم تسجيل الخروج');
    updateAuthUI();
  }

  function updateAuthUI() {
    const loginBtns = document.querySelectorAll('[data-auth-login]');
    const userAreas = document.querySelectorAll('[data-auth-user]');
    if (user) {
      loginBtns.forEach((el) => el.classList.add('hidden'));
      userAreas.forEach((el) => {
        el.classList.remove('hidden');
        const nameEl = el.querySelector('[data-user-name]');
        if (nameEl) nameEl.textContent = user.full_name || user.email;
      });
    } else {
      loginBtns.forEach((el) => el.classList.remove('hidden'));
      userAreas.forEach((el) => el.classList.add('hidden'));
    }
  }

  // ---------- Cart Drawer ----------
  function openCart() {
    const drawer = document.getElementById('cartDrawer');
    const overlay = document.getElementById('cartOverlay');
    if (!drawer) return;
    renderCartDrawer();
    // force reflow then animate
    overlay?.classList.remove('hidden');
    requestAnimationFrame(() => {
      overlay?.classList.add('is-visible');
      drawer.classList.add('open');
    });
    document.body.style.overflow = 'hidden';
    // focus close for a11y
    setTimeout(() => document.getElementById('closeCartBtn')?.focus(), 380);
  }

  function closeCart() {
    const drawer = document.getElementById('cartDrawer');
    const overlay = document.getElementById('cartOverlay');
    drawer?.classList.remove('open');
    overlay?.classList.remove('is-visible');
    setTimeout(() => {
      overlay?.classList.add('hidden');
    }, 300);
    document.body.style.overflow = '';
    lastAddedId = null;
  }

  function renderCartDrawer() {
    const container = document.getElementById('cartItems');
    const totalEl = document.getElementById('cartTotal');
    const countEl = document.getElementById('cartDrawerCount');
    const footer = document.getElementById('cartDrawerFooter');
    if (!container) return;

    const n = getCartCount();
    if (countEl) {
      countEl.textContent = n === 0 ? 'فارغة' : (n === 1 ? 'منتج واحد' : n + ' منتجات');
    }

    if (cart.length === 0) {
      container.innerHTML = `
        <div class="flex flex-col items-center justify-center py-20 text-center px-4">
          <svg class="w-16 h-16 text-elan-soft mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.2" d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z"/>
          </svg>
          <p class="text-elan-muted text-sm mb-1">سلتك فارغة حالياً</p>
          <p class="text-[11px] text-elan-muted mb-5">أضف عطوراً من الكتالوج لتظهر هنا</p>
          <button type="button" onclick="Elan.closeCart()" class="px-5 py-2.5 rounded-full border border-elan-gold text-elan-gold text-sm hover:bg-elan-gold hover:text-white transition">متابعة التسوق</button>
        </div>
      `;
      if (footer) footer.classList.add('hidden');
    } else {
      if (footer) footer.classList.remove('hidden');
      container.innerHTML = cart
        .map(
          (item, idx) => `
        <div class="cart-item-row flex gap-3 sm:gap-4 py-4 border-b border-elan-soft/60 px-1 ${item.storeProductId === lastAddedId ? 'is-new' : ''}" style="animation-delay:${idx * 40}ms">
          <img src="${item.image}" alt="${item.name}" class="w-20 h-24 sm:w-24 sm:h-28 object-cover rounded-xl bg-elan-cream flex-shrink-0"
            onerror="this.src='https://images.unsplash.com/photo-1594035910387-fea47794241f?w=200&h=250&fit=crop'">
          <div class="flex-1 min-w-0">
            <p class="text-[11px] text-elan-gold">${item.brand || ''}</p>
            <h4 class="text-sm font-medium text-elan-charcoal leading-snug line-clamp-2">${item.name}</h4>
            <p class="text-[11px] text-elan-muted mt-1">${item.store || ''} • ${item.size_ml || 100} مل</p>
            <p class="text-sm font-semibold mt-2">${formatPrice(item.price)}</p>
            <div class="flex items-center gap-2 mt-3">
              <button type="button" onclick="Elan.updateQuantity('${item.storeProductId}', -1)" class="cart-qty-btn w-8 h-8 rounded-full border border-elan-soft flex items-center justify-center text-sm hover:bg-elan-soft" aria-label="إنقاص">−</button>
              <span class="text-sm w-6 text-center font-medium">${item.quantity}</span>
              <button type="button" onclick="Elan.updateQuantity('${item.storeProductId}', 1)" class="cart-qty-btn w-8 h-8 rounded-full border border-elan-soft flex items-center justify-center text-sm hover:bg-elan-soft" aria-label="زيادة">+</button>
              <button type="button" onclick="Elan.removeFromCart('${item.storeProductId}')" class="mr-auto text-[11px] text-red-500/90 hover:text-red-600 px-2">حذف</button>
            </div>
            <p class="text-[11px] text-elan-muted mt-2">المجموع: <span class="font-medium text-elan-charcoal">${formatPrice(item.price * item.quantity)}</span></p>
          </div>
        </div>
      `
        )
        .join('');
    }

    if (totalEl) {
      totalEl.textContent = formatPrice(getCartTotal());
    }
  }

  // ---------- Language ----------
  function setLanguage(newLang) {
    lang = newLang;
    localStorage.setItem('elan_lang', lang);
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    
    document.querySelectorAll('.lang-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.lang === lang);
    });
  }

  // ---------- Init ----------
  function init() {
    updateCartBadge();
    updateAuthUI();
    setLanguage(lang);

    // Global event listeners
    document.getElementById('cartOverlay')?.addEventListener('click', closeCart);
    document.getElementById('closeCartBtn')?.addEventListener('click', closeCart);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const d = document.getElementById('cartDrawer');
        if (d?.classList.contains('open')) closeCart();
      }
    });
    document.querySelectorAll('[data-open-cart]').forEach((el) => {
      el.addEventListener('click', (e) => {
        // Header cart icon → full cart page
        e.preventDefault();
        const base = el.getAttribute('data-cart-page') || '';
        if (base) {
          window.location.href = base;
          return;
        }
        // Detect relative path from current location
        const inPages = location.pathname.includes('/pages/');
        window.location.href = inPages ? 'cart.html' : 'pages/cart.html';
      });
    });

    document.querySelectorAll('[data-open-login]').forEach((el) => {
      el.addEventListener('click', () => openAuth('login'));
    });
    document.querySelectorAll('[data-open-register]').forEach((el) => {
      el.addEventListener('click', () => openAuth('register'));
    });
    document.getElementById('closeAuthBtn')?.addEventListener('click', closeAuth);
    document.getElementById('authOverlay')?.addEventListener('click', closeAuth);

    // Login form
    document.getElementById('loginFormEl')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const email = e.target.email.value;
      const password = e.target.password.value;
      handleLogin(email, password);
    });

    // Register form
    document.getElementById('registerFormEl')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = e.target.name.value;
      const email = e.target.email.value;
      const password = e.target.password.value;
      handleRegister(name, email, password);
    });

    // Switch forms
    document.getElementById('switchToRegister')?.addEventListener('click', () => openAuth('register'));
    document.getElementById('switchToLogin')?.addEventListener('click', () => openAuth('login'));

    // Language buttons
    document.querySelectorAll('.lang-btn').forEach((btn) => {
      btn.addEventListener('click', () => setLanguage(btn.dataset.lang));
    });
  }

  // Public API
  return {
    init,
    addToCart,
    removeFromCart,
    updateQuantity,
    openCart,
    closeCart,
    toggleFavorite,
    isFavorite,
    openAuth,
    closeAuth,
    logout,
    getCartCount,
    formatPrice,
    showToast,
    get cart() {
      return cart;
    },
    get user() {
      return user;
    }
  };
})();

// Auto init (works whether script loads before or after DOM ready)
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => Elan.init());
} else {
  Elan.init();
}
