/**
 * Élan Scents – Data Layer
 * Loads sample data and provides helpers for dynamic pages.
 * Ready to be replaced by real API calls later.
 */

const ElanData = (function () {
  let data = null;

  // Embedded fallback (in case fetch fails on file://)
  const FALLBACK = {
    meta: { platform: "Élan Scents", version: "1.0.0-demo" },
    brands: [
      { id: "b1", slug: "amouage", name_en: "Amouage", name_ar: "أمواج", logo_text: "A", is_active: true },
      { id: "b2", slug: "armaf", name_en: "Armaf", name_ar: "أرماف", logo_text: "AR", is_active: true },
      { id: "b3", slug: "afnan", name_en: "Afnan", name_ar: "أفنان", logo_text: "AF", is_active: true },
      { id: "b4", slug: "asaf", name_en: "Asaf", name_ar: "عساف", logo_text: "AS", is_active: true },
      { id: "b5", slug: "rasasi", name_en: "Rasasi", name_ar: "رصاصي", logo_text: "R", is_active: true },
      { id: "b6", slug: "french-avenue", name_en: "French Avenue", name_ar: "فرينش أفينيو", logo_text: "FA", is_active: true },
      { id: "b7", slug: "arabiyat", name_en: "Arabiyat", name_ar: "عربيات", logo_text: "AR", is_active: true },
      { id: "b8", slug: "lattafa", name_en: "Lattafa", name_ar: "لطافة", logo_text: "L", is_active: true },
      { id: "b9", slug: "maison-alhambra", name_en: "Maison Alhambra", name_ar: "ميزون الهمبرا", logo_text: "MA", is_active: true }
    ],
    stores: [
      { id: "s1", slug: "afnan-egypt", name_en: "Afnan Egypt", name_ar: "أفنان مصر", description_ar: "المتجر الرسمي لأفنان في مصر", commission_rate: 12, is_active: true, is_elan_boutique: false },
      { id: "s2", slug: "emarati-scents", name_en: "Emarati Scents", name_ar: "إماراتي سينتس", description_ar: "متجر متخصص في العطور العربية الأصلية", commission_rate: 10, is_active: true, is_elan_boutique: false },
      { id: "s3", slug: "elan-boutique", name_en: "Élan Boutique", name_ar: "إيلان بوتيك", description_ar: "متجر المنصة الخاص – قريباً", commission_rate: 0, is_active: false, is_elan_boutique: true }
    ],
    products: [
      { id: "p1", slug: "afnan-9pm", name_en: "9PM", name_ar: "9PM", brand_id: "b3", category: "unisex", size_ml: 100, short_description_ar: "عطر شرقي فاكهي جريء وثابت", occasions: ["evening", "daily"], image: "https://images.unsplash.com/photo-1594035910387-fea47794241f?w=600&h=750&fit=crop", is_elan_pick: true },
      { id: "p2", slug: "afnan-9pm-elixir", name_en: "9PM Elixir", name_ar: "9PM Elixir", brand_id: "b3", category: "unisex", size_ml: 100, short_description_ar: "نسخة مركزة أكثر عمقاً وجاذبية", occasions: ["evening"], image: "https://images.unsplash.com/photo-1541643600914-78b084683601?w=600&h=750&fit=crop" },
      { id: "p3", slug: "afnan-supremacy-not-only-intense", name_en: "Supremacy Not Only Intense", name_ar: "Supremacy Not Only Intense", brand_id: "b3", category: "men", size_ml: 100, short_description_ar: "خشبي جلدي قوي وثابت", occasions: ["evening", "winter"], image: "https://images.unsplash.com/photo-1587017539504-67cfbddac569?w=600&h=750&fit=crop" },
      { id: "p4", slug: "lattafa-khamrah", name_en: "Khamrah", name_ar: "خمرة", brand_id: "b8", category: "unisex", size_ml: 100, short_description_ar: "حلويات شرقية فاخرة ودافئة", occasions: ["evening", "winter"], image: "https://images.unsplash.com/photo-1592945403244-b3fbafd7f539?w=600&h=750&fit=crop", is_elan_pick: true },
      { id: "p5", slug: "lattafa-yara", name_en: "Yara", name_ar: "يارا", brand_id: "b8", category: "women", size_ml: 100, short_description_ar: "ناعم وزهري حلو ومناسب للجميع", occasions: ["daily", "summer"], image: "https://images.unsplash.com/photo-1595425970375-c541ba4ef42c?w=600&h=750&fit=crop" },
      { id: "p6", slug: "armaf-club-de-nuit-intense-man", name_en: "Club de Nuit Intense Man", name_ar: "Club de Nuit Intense Man", brand_id: "b2", category: "men", size_ml: 105, short_description_ar: "كلاسيكي قوي وثابت ومميز", occasions: ["daily", "evening"], image: "https://images.unsplash.com/photo-1615634260167-c8cdede054de?w=600&h=750&fit=crop", is_elan_pick: true },
      { id: "p7", slug: "rasasi-hawas", name_en: "Hawas", name_ar: "هوس", brand_id: "b5", category: "men", size_ml: 100, short_description_ar: "منعش ومائي مع لمسة شرقية", occasions: ["summer", "daily"], image: "https://images.unsplash.com/photo-1590736704728-f4730bb30770?w=600&h=750&fit=crop" },
      { id: "p8", slug: "lattafa-asad", name_en: "Asad", name_ar: "أسد", brand_id: "b8", category: "men", size_ml: 100, short_description_ar: "شرقي حار وجريء", occasions: ["evening", "winter"], image: "https://images.unsplash.com/photo-1588405748880-12d1d2a59db9?w=600&h=750&fit=crop" },
      { id: "p9", slug: "afnan-turathi-blue", name_en: "Turathi Blue", name_ar: "تراثي بلو", brand_id: "b3", category: "men", size_ml: 90, short_description_ar: "منعش خشبي أنيق", occasions: ["summer"], image: "https://images.unsplash.com/photo-1594035910387-fea47794241f?w=600&h=750&fit=crop" },
      { id: "p10", slug: "afnan-modest-une", name_en: "Modest Une", name_ar: "موديست أون", brand_id: "b3", category: "men", size_ml: 100, short_description_ar: "أنيق ومنعش للاستخدام اليومي", occasions: ["daily"], image: "https://images.unsplash.com/photo-1541643600914-78b084683601?w=600&h=750&fit=crop" }
    ],
    store_products: [
      { id: "sp1", store_id: "s1", product_id: "p1", price: 2200, currency: "EGP", is_available: true, stock_quantity: 45 },
      { id: "sp2", store_id: "s1", product_id: "p2", price: 2200, currency: "EGP", is_available: true, stock_quantity: 30 },
      { id: "sp3", store_id: "s1", product_id: "p3", price: 2150, currency: "EGP", is_available: true, stock_quantity: 22 },
      { id: "sp4", store_id: "s2", product_id: "p4", price: 1850, currency: "EGP", is_available: true, stock_quantity: 60 },
      { id: "sp5", store_id: "s2", product_id: "p5", price: 1650, currency: "EGP", is_available: true, stock_quantity: 40 },
      { id: "sp6", store_id: "s2", product_id: "p6", price: 1950, currency: "EGP", is_available: true, stock_quantity: 35 },
      { id: "sp7", store_id: "s2", product_id: "p7", price: 2100, currency: "EGP", is_available: true, stock_quantity: 28 },
      { id: "sp8", store_id: "s2", product_id: "p8", price: 1750, currency: "EGP", is_available: true, stock_quantity: 50 },
      { id: "sp9", store_id: "s1", product_id: "p9", price: 2500, currency: "EGP", is_available: true, stock_quantity: 18 },
      { id: "sp10", store_id: "s1", product_id: "p10", price: 2450, currency: "EGP", is_available: true, stock_quantity: 25 },
      { id: "sp11", store_id: "s2", product_id: "p1", price: 2350, currency: "EGP", is_available: true, stock_quantity: 12 }
    ]
  };

  async function load() {
    if (data) return data;
    try {
      const res = await fetch('../data/sample-data.json');
      if (res.ok) {
        data = await res.json();
        return data;
      }
    } catch (e) {}
    try {
      const res = await fetch('data/sample-data.json');
      if (res.ok) {
        data = await res.json();
        return data;
      }
    } catch (e) {}
    data = FALLBACK;
    return data;
  }

  function getBrand(idOrSlug) {
    if (!data) return null;
    return data.brands.find(b => b.id === idOrSlug || b.slug === idOrSlug);
  }

  function getStore(idOrSlug) {
    if (!data) return null;
    return data.stores.find(s => s.id === idOrSlug || s.slug === idOrSlug);
  }

  function getProduct(idOrSlug) {
    if (!data) return null;
    return data.products.find(p => p.id === idOrSlug || p.slug === idOrSlug);
  }

  // Get cheapest available store_product for a product
  function getCheapestOffer(productId) {
    if (!data) return null;
    const offers = data.store_products
      .filter(sp => sp.product_id === productId && sp.is_available)
      .sort((a, b) => a.price - b.price);
    if (!offers.length) return null;
    const best = offers[0];
    const store = getStore(best.store_id);
    return { ...best, store };
  }

  // All available offers for a product (sorted by price)
  function getAllOffers(productId) {
    if (!data) return [];
    return data.store_products
      .filter(sp => sp.product_id === productId && sp.is_available)
      .map(sp => ({ ...sp, store: getStore(sp.store_id) }))
      .sort((a, b) => a.price - b.price);
  }

  // Products available for a brand (only those with at least one store offer)
  function getBrandProducts(brandId) {
    if (!data) return [];
    return data.products
      .filter(p => p.brand_id === brandId)
      .map(p => {
        const offer = getCheapestOffer(p.id);
        if (!offer) return null;
        const brand = getBrand(p.brand_id);
        return { ...p, brand, offer };
      })
      .filter(Boolean);
  }

  // Products of a specific store
  function getStoreProducts(storeId) {
    if (!data) return [];
    return data.store_products
      .filter(sp => sp.store_id === storeId && sp.is_available)
      .map(sp => {
        const product = getProduct(sp.product_id);
        const brand = product ? getBrand(product.brand_id) : null;
        return { ...sp, product, brand };
      })
      .filter(item => item.product);
  }

  // Enriched product list with cheapest offer
  function getAllAvailableProducts() {
    if (!data) return [];
    return data.products
      .map(p => {
        const offer = getCheapestOffer(p.id);
        if (!offer) return null;
        const brand = getBrand(p.brand_id);
        return { ...p, brand, offer };
      })
      .filter(Boolean);
  }

  function getElanPicks() {
    return getAllAvailableProducts().filter(p => p.is_elan_pick);
  }

  function categoryLabel(cat) {
    const map = { men: 'رجالي', women: 'نسائي', unisex: 'يونيسكس' };
    return map[cat] || cat;
  }

  function occasionLabel(occ) {
    const map = { daily: 'يومي', evening: 'مسائي', summer: 'صيفي', winter: 'شتوي', formal: 'رسمي' };
    return map[occ] || occ;
  }

  return {
    load,
    getBrand,
    getStore,
    getProduct,
    getCheapestOffer,
    getAllOffers,
    getBrandProducts,
    getStoreProducts,
    getAllAvailableProducts,
    getElanPicks,
    categoryLabel,
    occasionLabel,
    get raw() { return data; }
  };
})();
