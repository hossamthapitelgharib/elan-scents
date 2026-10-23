'use strict';
/* Static list of the API handlers for the Cloudflare bundle (the Node server finds them with fs at run time, a bundle cannot).
   Each entry is lazy on purpose: a handler module is evaluated on the first request that needs it, never while the bundle loads.
   tests/cloudflare-worker.test.js fails when a file is added to or removed from api/ without updating this list. */
module.exports = {
  api: {
    'config': () => require('../api/config.js'),
    'customer-activity': () => require('../api/customer-activity.js'),
    'customer-best-sellers': () => require('../api/customer-best-sellers.js'),
    'customer-orders': () => require('../api/customer-orders.js'),
    'customer-product-rankings': () => require('../api/customer-product-rankings.js'),
    'dashboard-orders': () => require('../api/dashboard-orders.js'),
    'editor-data': () => require('../api/editor-data.js'),
    'guest-analytics': () => require('../api/guest-analytics.js'),
    'guest-cart': () => require('../api/guest-cart.js'),
    'notifications': () => require('../api/notifications.js'),
    'platform-customer-detail': () => require('../api/platform-customer-detail.js'),
    'platform-customer-summary': () => require('../api/platform-customer-summary.js'),
    'platform-customers': () => require('../api/platform-customers.js'),
    'platform-order-summary': () => require('../api/platform-order-summary.js'),
    'platform-store-detail': () => require('../api/platform-store-detail.js'),
    'platform-store-unlinked': () => require('../api/platform-store-unlinked.js'),
    'platform-stores': () => require('../api/platform-stores.js'),
    'restore-store-order': () => require('../api/restore-store-order.js'),
    'store-dashboard-orders': () => require('../api/store-dashboard-orders.js'),
    'store-integrations': () => require('../api/store-integrations.js'),
    'store-order-cancelled': () => require('../api/store-order-cancelled.js'),
    'store-order-status': () => require('../api/store-order-status.js'),
    'store-order-update': () => require('../api/store-order-update.js'),
    'store-shipment-update': () => require('../api/store-shipment-update.js'),
    'editor': () => require('../railway/editor.js')
  },
  editorHost: () => require('../railway/editor-host.js')
};
