# Élan Scents — Architecture (Prompts 1 & 2)

## Status
Frontend prototype rebuilt per Prompt 1 (data rules) + Prompt 2 (visual/sections).
Store API integration: **pending keys** (structure ready).

## Central price engine (`elan-data.js`)
- Source of price & availability: **store catalogs only**
- Brand sites: descriptive notes only (never price)
- One card per product (cheapest available store)
- Tie-break: higher commission_rate → stable store id
- Quantity rule: do not auto-split across stores; message `المتاح حالياً: N فقط`

## Modules prepared (UI / localStorage stubs)
- Users (account page)
- Cart & checkout (local)
- Orders (localStorage)
- Contact messages (localStorage)
- Admin / store dashboard (shell pages)
- Commissions field on stores

## Visual
- White canvas body
- Dark header + footer
- Construction marquee
- Unified perfume card
- Slow horizontal carousels (max ~6 featured)

## Region
Egypt only (documented in policies / meta)

## Next
1. User review → approve
2. Push to GitHub
3. Real store connectors + payment gateway
