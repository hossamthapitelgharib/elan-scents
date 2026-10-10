# Élan Scents

The Home of Gulf Fragrances

Static storefront + order dashboards. Deployed on Vercel.

## Active frontend (UI)

- `index.html` — main storefront shell (mobile / tablet / desktop)
- `app.js` — UI overrides + loads stable core from pinned release
- `style.css` — active styles (imports `style-3.css` base, then overrides)
- `style-3.css` — base theme
- `texts.js` — AR/EN copy + ART card markup
- `assets/` — hero video, category/occasion cards, growthmark

## Portals (UI)

- `account.html` + `account.js` + `portal.css` / `portal.js`
- `dashboard.html` + `dashboard.js` + `dashboard.css`
- `store-dashboard.html` + `store-dashboard.js`
- `platform-dashboard.html` + `platform-dashboard.js`

## Not touched by UI cleanup

- `api/` — serverless endpoints
- `supabase/` — migrations
- `config.js` — catalog config endpoint
- tests / workflows
