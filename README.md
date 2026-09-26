# Élan Scents — THE HOME OF GULF FRAGRANCES

منصة Marketplace فاخرة للعطور الخليجية بطابع أوروبي راقٍ.

**نطاق الخدمة: جمهورية مصر العربية فقط — لا شحن ولا بيع خارج مصر.**

> هذه نسخة تجريبية (Frontend Prototype) — الكتالوجات مؤقتة وتُحذف عند الربط الرسمي مع المتاجر.

---

## التشغيل المحلي

```bash
cd elan-scents
python3 -m http.server 8080
# افتح: http://localhost:8080
```

---

## الرفع على GitHub Pages

1. أنشئ Repository باسم مثلاً `elan-scents`
2. ارفع محتويات هذا المجلد إلى جذر الريبو (ليس مجلد فرعي إضافي)
3. **Settings → Pages → Source:** Branch `main` / Folder `/ (root)`
4. بعد دقيقة افتح:
   ```
   https://YOUR_USERNAME.github.io/elan-scents/
   ```

### أوامر سريعة (من جهازك)

```bash
git init
git add .
git commit -m "Élan Scents — initial prototype"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/elan-scents.git
git push -u origin main
```

---

## هيكل المشروع

```
elan-scents/
├── index.html              # الرئيسية
├── 404.html
├── pages/                  # الصفحات الداخلية
│   ├── product.html
│   ├── brand.html
│   ├── store.html
│   ├── filters.html
│   ├── cart.html           # صفحة السلة الكاملة
│   ├── checkout.html
│   ├── account.html
│   ├── orders.html
│   ├── tracking.html
│   ├── policies.html
│   ├── admin.html
│   └── store-dashboard.html
├── assets/
│   ├── css/elan.css
│   ├── js/elan-core.js     # سلة، مصادقة تجريبية، إشعارات
│   ├── js/elan-data.js     # طبقة البيانات
│   └── img/brands/         # شعارات البراندات (محلية)
└── data/
    ├── sample-data.json    # كتالوج مؤقت + متاجر + براندات
    ├── schema.json
    ├── API-ARCHITECTURE.md
    └── TEMPORARY_CATALOGS.md
```

---

## الصفحات

| المسار | الوصف |
|--------|------|
| `/` | الرئيسية |
| `pages/product.html?id=` | تفاصيل العطر |
| `pages/brand.html?id=` | صفحة البراند |
| `pages/store.html?id=` | صفحة المتجر |
| `pages/filters.html` | فلاتر (`?category=` / `?occasion=`) |
| `pages/cart.html` | السلة الكاملة |
| `pages/checkout.html` | إتمام الشراء (مصر فقط) |
| `pages/policies.html` | السياسات والنطاق الجغرافي |
| `pages/admin.html` | لوحة تحكم تجريبية |

---

## قواعد العمل المطبّقة

1. عرض عطور متاجر المنصة فقط  
2. السعر الأرخص لنفس العطر ونفس الحجم  
3. لا روابط لمواقع البراندات الرسمية  
4. براندات البرومبت الأصلي فقط (9 براندات)  
5. كتالوج مؤقت (`is_temporary_catalog`) يُمسح عند الربط الرسمي  
6. الخدمة داخل مصر فقط  

---

## ما بعد الرفع (الخطوة التالية)

- Backend + قاعدة بيانات  
- ربط كتالوج المتاجر الحقيقي  
- بوابة دفع مصرية  
- لوحات متجر وأدمن حقيقية  

---

© 2026 Élan Scents
