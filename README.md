# Élan Scents

The Home of Gulf Fragrances

Static storefront and order dashboards. **Railway is the sole hosting platform.**

## Active frontend

- `index.html` — storefront shell for mobile, tablet and desktop
- `app.js` — UI overrides and version-pinned loading of `app-core.js`
- `style.css` and `style-3.css` — active styles and base theme
- `texts.js` — Arabic/English copy and card markup
- `assets/` — hero video, product/category imagery and fonts

## Portals

- `account.html`, `account.js`, `portal.css`, `portal.js` — customer orders and account access
- `dashboard.html`, `dashboard.js`, `dashboard.css` — order operations
- `store-dashboard.html`, `store-dashboard.js` — store portal
- `platform-dashboard.html`, `platform-dashboard.js` — platform administration and customer analytics

## Railway runtime

- `railway/server.js` — dependency-free Node host for static files and `/api/*` routes; owns route aliases, cache policy and byte-range video responses
- `railway/editor.js` and `railway/editor-host.js` — protected site editor and GitHub-backed design updates
- `api/` — request handlers served by the Railway host
- `api/config.js` — Supabase public client configuration for the site
- `package.json` — `npm start` runs Railway; `npm test` runs the regression suite

The editor uses Railway variables such as `RAILWAY_ENVIRONMENT_NAME`, `RAILWAY_PUBLIC_DOMAIN`, `EDITOR_TARGET_BRANCH`, and `EDITOR_SITE_ORIGIN`. Keep `EDITOR_SITE_ORIGIN` set to the public `elan-site` origin when the editor runs as a separate Railway service.

## Data and quality

- `supabase/` — database migrations and rollback scripts
- `tests/` — regression tests and safe SQL test scripts
- `.github/workflows/tests.yml` — runs `npm test` on pushes and pull requests to `main`
