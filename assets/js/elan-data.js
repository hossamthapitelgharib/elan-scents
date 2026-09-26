/**
 * Élan Scents — البرومبت الأول حرفياً
 * #4 قاعدة البيانات المركزية + قواعد السعر الأرخص والتوافر الموحد
 *
 * مصادر البيانات:
 * - المتاجر: السعر، التوافر، الكمية، العروض (المصدر الوحيد للسعر)
 * - مواقع البراندات الرسمية: وصف، تركيب، نفحات، فئة، مناسبات فقط
 * - ممنوع عرض أي لينك ويب سايت براند أو متجر للعميل
 * - لا يُعرض عطر إلا إذا كان متاحاً لدى متجر واحد على الأقل على المنصة
 */
const ElanData = (() => {
  let raw = null;
  let phrases = null;

  const base = (typeof location !== 'undefined' && /\/pages\//.test(location.pathname)) ? '..' : '.';
  const DATA_URL = base + '/data/sample-data.json';
  const PHRASES_URL = base + '/data/marketing-phrases.json';

  const OCCASION_LABELS = {
    daytime: 'نهاري', night: 'ليلي', work: 'اجتماع عمل', party: 'سهرات',
    date: 'موعد', gift: 'هدية', daily: 'يومي', evening: 'مسائي',
    special: 'مناسبة خاصة', summer: 'صيفي', winter: 'شتوي'
  };
  const CAT_LABELS = { men: 'رجالي', women: 'نسائي', unisex: 'عطر يجمعنا' };

  async function load() {
    if (raw) return raw;
    const [dataRes, phrasesRes] = await Promise.all([
      fetch(DATA_URL + '?t=' + Date.now()),
      fetch(PHRASES_URL + '?t=' + Date.now()).catch(() => null)
    ]);
    if (!dataRes.ok) throw new Error('تعذر تحميل قاعدة البيانات المركزية');
    raw = await dataRes.json();
    if (phrasesRes && phrasesRes.ok) phrases = await phrasesRes.json();
    return raw;
  }

  function getBrand(id) { return (raw?.brands || []).find(b => b.id === id) || null; }
  function getStore(id) { return (raw?.stores || []).find(s => s.id === id) || null; }
  function getProduct(id) { return (raw?.products || []).find(p => p.id === id) || null; }

  /** §4.5 / §4.7 — هل العرض متاح؟ */
  function isOfferAvailable(sp) {
    if (!sp) return false;
    if (sp.is_available === false || sp.available === false) return false;
    const av = sp.availability;
    if (av === 'out_of_stock' || av === 'unavailable' || av === false) return false;
    const qty = sp.quantity != null ? sp.quantity : sp.stock_quantity;
    if (typeof qty === 'number' && qty <= 0) return false;
    if (av === 'in_stock' || av === 'available' || av === true) return true;
    if (sp.is_available === true || sp.available === true) return true;
    if (sp.price != null && (av == null || av === undefined)) return true;
    return false;
  }

  function getOffers(productId, sizeKey) {
    return (raw?.store_products || [])
      .filter(sp => {
        if (sp.product_id !== productId) return false;
        if (!isOfferAvailable(sp)) return false;
        // §4.8 مقارنة نفس الحجم فقط عند تحديد الحجم
        if (sizeKey != null && sp.size != null && String(sp.size) !== String(sizeKey)) return false;
        const st = getStore(sp.store_id);
        return st && st.is_active !== false;
      })
      .map(sp => ({
        ...sp,
        quantity: sp.quantity != null ? sp.quantity : (sp.stock_quantity != null ? sp.stock_quantity : null),
        availability: 'in_stock',
        is_offer: !!(sp.is_offer || sp.discount_percent || sp.on_sale),
        source: 'store_catalog'
      }));
  }

  /**
   * §4.10 عرض السعر الأرخص
   * §4.13 عند تساوي السعر: أعلى عمولة ثم ترتيب ثابت في قاعدة البيانات
   */
  function getCheapestOffer(productId, sizeKey) {
    const offers = getOffers(productId, sizeKey);
    if (!offers.length) return null;
    const storeOrder = (raw?.stores || []).map(s => s.id);
    offers.sort((a, b) => {
      if (Number(a.price) !== Number(b.price)) return Number(a.price) - Number(b.price);
      const ca = Number(getStore(a.store_id)?.commission_rate) || 0;
      const cb = Number(getStore(b.store_id)?.commission_rate) || 0;
      if (cb !== ca) return cb - ca;
      return storeOrder.indexOf(a.store_id) - storeOrder.indexOf(b.store_id);
    });
    return offers[0];
  }

  /** §4.5 المصدر المركزي الموحد لسجل عطر+حجم */
  function getUnifiedRecord(productId, sizeKey) {
    const product = getProduct(productId);
    if (!product) return null;
    const offers = getOffers(productId, sizeKey);
    if (!offers.length) return null;
    const cheapest = getCheapestOffer(productId, sizeKey);
    const brand = getBrand(product.brand_id);
    const store = getStore(cheapest.store_id);
    const alternatives = offers
      .filter(o => o.store_id !== cheapest.store_id)
      .sort((a, b) => Number(a.price) - Number(b.price))
      .map(o => ({
        store_id: o.store_id,
        store_name: getStore(o.store_id)?.name_ar || '',
        price: o.price,
        quantity: o.quantity,
        availability: o.availability
      }));
    return {
      product_id: product.id,
      name_ar: product.name_ar || product.name || '',
      name_en: product.name_en || '',
      brand_id: product.brand_id,
      brand_name: brand?.name_ar || brand?.name_en || '',
      size: sizeKey || cheapest.size || product.size_ml || product.size || '',
      selected_store_id: cheapest.store_id,
      selected_store_name: store?.name_ar || store?.name_en || '',
      current_price: cheapest.price,
      quantity_available: cheapest.quantity,
      availability: 'in_stock',
      alternative_stores: alternatives,
      last_updated: cheapest.updated_at || null,
      data_source: 'store_catalog',
      currency: cheapest.currency || 'EGP'
    };
  }

  /**
   * §4.31 لا تعرض أي عطر إلا إذا كان متاحاً لدى متجر واحد على الأقل
   * §4.2 كارت موحد
   */
  function toCardView(product) {
    if (!product) return null;
    const offer = getCheapestOffer(product.id);
    if (!offer) return null; // غير متاح على المنصة
    const brand = getBrand(product.brand_id);
    const store = getStore(offer.store_id);
    return {
      id: product.id,
      name_ar: product.name_ar || product.name || '',
      name_en: product.name_en || '',
      image: product.image || '',
      brand_id: product.brand_id,
      brand_name: brand?.name_ar || brand?.name_en || '',
      // بدون لينك ويب سايت للبراند
      store_id: offer.store_id,
      store_name: store?.name_ar || store?.name_en || '',
      // بدون لينك ويب سايت للمتجر
      category: product.category || '',
      category_label: CAT_LABELS[product.category] || product.category || '',
      occasions: product.occasions || [],
      occasion_labels: (product.occasions || []).map(k => OCCASION_LABELS[k] || k),
      description: product.short_description_ar || product.description_ar || product.description || '',
      // نفحات/تركيب من بيانات المنتج إن وُجدت (مصدر براند وصفي)
      notes: product.notes || product.fragrance_notes || null,
      composition: product.composition || product.accords || null,
      offer: {
        store_id: offer.store_id,
        store_name: store?.name_ar || store?.name_en || '',
        price: offer.price,
        quantity: offer.quantity,
        availability: 'in_stock',
        size: offer.size || product.size_ml || product.size || '',
        is_offer: !!offer.is_offer,
        discount_percent: offer.discount_percent || null,
        updated_at: offer.updated_at || null,
        source: 'store_catalog'
      },
      flags: {
        is_new: !!(product.is_new || offer.is_new),
        is_bestseller: !!(product.is_bestseller || offer.is_bestseller),
        is_offer: !!offer.is_offer,
        is_featured: !!(product.is_featured || product.is_elan_pick),
        is_coming_soon: !!product.is_coming_soon,
        is_elan_pick: !!product.is_elan_pick,
        views: product.views || 0,
        rating: product.rating || null
      }
    };
  }

  function getAllAvailableProducts() {
    return (raw?.products || []).map(toCardView).filter(Boolean);
  }

  /** §4.31 صفحة البراند: عطور هذا البراند المتاحة لدى متاجر المنصة فقط */
  function getByBrand(brandId) {
    return getAllAvailableProducts().filter(p => p.brand_id === brandId);
  }

  function getStoreProducts(storeId) {
    const allowedBrands = new Set((raw?.brands || []).map(b => b.id));
    const pids = new Set(
      (raw?.store_products || [])
        .filter(sp => sp.store_id === storeId && isOfferAvailable(sp))
        .map(sp => sp.product_id)
    );
    return (raw?.products || [])
      .filter(p => pids.has(p.id) && allowedBrands.has(p.brand_id))
      .map(p => {
        const storeOffers = getOffers(p.id).filter(o => o.store_id === storeId);
        if (!storeOffers.length) return null;
        storeOffers.sort((a, b) => Number(a.price) - Number(b.price));
        const offer = storeOffers[0];
        const brand = getBrand(p.brand_id);
        const store = getStore(storeId);
        return {
          id: p.id,
          name_ar: p.name_ar || p.name,
          image: p.image,
          brand_id: p.brand_id,
          brand_name: brand?.name_ar || '',
          category: p.category,
          category_label: CAT_LABELS[p.category] || p.category || '',
          occasions: p.occasions || [],
          description: p.short_description_ar || '',
          offer: {
            store_id: storeId,
            store_name: store?.name_ar || '',
            price: offer.price,
            quantity: offer.quantity,
            availability: 'in_stock',
            is_offer: !!offer.is_offer,
            source: 'store_catalog'
          },
          flags: {
            is_new: !!p.is_new,
            is_bestseller: !!p.is_bestseller,
            is_offer: !!offer.is_offer,
            is_featured: !!(p.is_featured || p.is_elan_pick)
          }
        };
      })
      .filter(Boolean);
  }

  /**
   * §4.11 قاعدة الكمية المطلوبة
   * لا تقسّم الطلب بين متاجر. اعرض: المتاح حالياً: [N] فقط
   */
  function checkQuantity(productId, storeId, requestedQty) {
    const offers = getOffers(productId).filter(o => o.store_id === storeId);
    if (!offers.length) {
      return { ok: false, available: 0, message: 'المنتج غير متاح حالياً' };
    }
    const qty = offers[0].quantity;
    if (qty == null) return { ok: true, available: null, message: null };
    if (requestedQty > qty) {
      return {
        ok: false,
        available: qty,
        message: 'المتاح حالياً: ' + qty + ' فقط.'
      };
    }
    return { ok: true, available: qty, message: null };
  }

  function filterProducts(opts = {}) {
    let list = getAllAvailableProducts();
    if (opts.category) list = list.filter(p => p.category === opts.category);
    if (opts.occasion) list = list.filter(p => (p.occasions || []).includes(opts.occasion));
    if (opts.brandId) list = list.filter(p => p.brand_id === opts.brandId);
    if (opts.storeId) list = list.filter(p => p.offer.store_id === opts.storeId);
    if (opts.offersOnly) list = list.filter(p => p.flags.is_offer);
    if (opts.newOnly) list = list.filter(p => p.flags.is_new);
    if (opts.bestOnly) list = list.filter(p => p.flags.is_bestseller);
    if (opts.elanOnly) list = list.filter(p => p.flags.is_elan_pick || p.flags.is_featured || p.flags.is_bestseller || (p.flags.rating && p.flags.rating >= 4));
    if (opts.comingOnly) list = list.filter(p => p.flags.is_coming_soon);
    if (opts.minPrice != null) list = list.filter(p => p.offer.price >= opts.minPrice);
    if (opts.maxPrice != null) list = list.filter(p => p.offer.price <= opts.maxPrice);
    if (opts.q) {
      const s = String(opts.q).toLowerCase();
      list = list.filter(p =>
        (p.name_ar || '').includes(opts.q) ||
        (p.name_en || '').toLowerCase().includes(s) ||
        (p.brand_name || '').includes(opts.q)
      );
    }
    if (opts.sort === 'price-asc') list.sort((a, b) => a.offer.price - b.offer.price);
    if (opts.sort === 'price-desc') list.sort((a, b) => b.offer.price - a.offer.price);
    if (opts.sort === 'newest') list.sort((a, b) => (b.flags.is_new ? 1 : 0) - (a.flags.is_new ? 1 : 0));
    return list;
  }

  function stats() {
    const products = getAllAvailableProducts();
    const brandIds = new Set(products.map(p => p.brand_id));
    const stores = (raw?.stores || []).filter(s => s.is_active !== false);
    return { brands: brandIds.size, stores: stores.length, products: products.length };
  }

  function occasionLabel(k) { return OCCASION_LABELS[k] || k; }
  function categoryLabel(k) { return CAT_LABELS[k] || k; }
  function getPhrases() { return phrases?.library || []; }

  return {
    load,
    get raw() { return raw; },
    getBrand, getStore, getProduct,
    isOfferAvailable, getOffers, getCheapestOffer, getUnifiedRecord,
    toCardView, getAllAvailableProducts, getByBrand, getStoreProducts,
    checkQuantity, filterProducts, stats, occasionLabel, categoryLabel, getPhrases
  };
})();
