# Élan Scents

The Home of Gulf Fragrances

Static storefront + order dashboards. Railway is the primary host; the same project remains Vercel-compatible.

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

## Server and deployment

- `railway/server.js` — dependency-free Railway host for static files and `/api/*` routes
- `api/` — serverless/API endpoints shared by Railway and Vercel
- `api/config.js` — shared Supabase config endpoint used by both hosts
- `package.json` — `npm start` runs the Railway host; `npm test` runs the regression suite

## Data and quality

- `supabase/` — migrations
- `tests/` — regression tests and safe SQL test scripts
- `.github/workflows/tests.yml` — runs `npm test` on pushes and pull requests to `main`
