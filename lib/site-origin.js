/* The public address of the live site (the Cloudflare Worker). This is only the last-resort default for the editor host:
   the Worker uses the address a visitor reached it on, and EDITOR_SITE_ORIGIN / ELAN_STORE_ORIGIN override it.
   Keep it equal to the Worker's address (wrangler.jsonc "name" + the account's workers.dev subdomain, or the custom domain). */
const DEFAULT_SITE_ORIGIN = 'https://elan-scents.hossamthapitelgharib.workers.dev';

module.exports = { DEFAULT_SITE_ORIGIN };
