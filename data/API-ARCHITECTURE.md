# Élan Scents — API Architecture (Ready for Integration)

## Principles
- Store catalogs are the **only** source of price & availability
- Brand official sites may enrich notes/description/logo only
- Never invent missing data
- Commission calculated on completed paid orders only

## Suggested Endpoints (Backend to implement)

### Catalog Sync
- `POST /api/v1/stores/{storeId}/catalog/sync` — ingest official catalog
- `GET /api/v1/products` — list available products (cheapest offer)
- `GET /api/v1/products/{id}` — product + all store offers sorted by price
- `GET /api/v1/brands/{id}/products` — brand products available on platform only
- `GET /api/v1/stores/{id}/products` — single store catalog

### Pricing Engine
- Input: product_id + size_ml
- Output: cheapest available store_product
- Fallback chain when stock depletes
- Equal price priority: Élan Boutique > higher commission rate

### Orders & Commissions
- `POST /api/v1/orders`
- `GET /api/v1/orders/{id}/tracking`
- `POST /api/v1/orders/{id}/commission/settle`

### Auth
- JWT for users
- Separate partner tokens for store dashboards

## Security Checklist
- [ ] HTTPS only
- [ ] Rate limiting
- [ ] Input validation
- [ ] Partner API keys rotated
- [ ] No public brand website scraping in production without permission
- [ ] PCI-compliant payment provider (Paymob / Stripe / etc.)

## Current Frontend Status
Demo data in `sample-data.json` + `elan-data.js` simulates the pricing engine client-side.
Replace with real API calls when backend is live.
