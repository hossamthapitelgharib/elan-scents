# Frontend browser compatibility check

**Date:** 2026-10-09 (historical baseline)
**Scope:** Main storefront UI, cross-browser normalization, Supabase-authenticated cart synchronization, and customer order listing.

## Historical result

The production site returned the same HTML and static asset references for Chrome on Windows, Safari on macOS, Firefox on Ubuntu, and Googlebot. The measured HTML SHA-256 began `0fa745b7f3997af6...`. The referenced assets were `/style.css`, `/style-3.css`, `/texts.js`, `/app.js`, and `/assets/hero.mp4`.

This is a historical baseline from before the move to Railway. It does not verify the current deployment. Current production checks must use the single public origin configured for the Railway site service; no legacy host aliases are part of the check.

## Browser runtime baseline

A real Chrome runtime loaded the page at a `1280 × 1100` viewport with DPR `1`. The hero measured `1265 × 1100`, the menu `135px` wide, and no browser-console errors were observed. No service worker, Workbox registration, or browser-cache application code was found in the repository.

## Interpretation

There was no server-side User-Agent branching producing different HTML pages. The likely causes of visibly different rendering were viewport-responsive CSS, stale cached assets, hero-video loading state, and browser-specific font/video rendering.

The active host is Railway. A current production verification requires comparing the Railway public origin from the relevant browsers, with browser names and viewport sizes recorded alongside any differing screenshots.

## Repository checks at the time

The test suite and JavaScript syntax validation passed at the time of this baseline. The result is historical and is not evidence that a current Railway deployment completed. Authenticated cart data is synchronized through Supabase `cart_items`; authenticated orders are read through `store_order_requests` under the existing RLS policies.
