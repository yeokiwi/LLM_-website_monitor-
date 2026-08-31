/**
 * Plan catalog — the single source of truth for pricing tiers and entitlements.
 *
 * These definitions live in version control (not only in the database) so a
 * deploy can change limits without a manual SQL edit. On boot, `seedPlans()`
 * upserts every entry below into the `plans` table by slug.
 *
 * Entitlement keys are consumed by services/entitlements.js:
 *   max_websites            number | null (null = unlimited)
 *   max_scans_per_month     number | null
 *   schedules               string[] of allowed frequencies ([] = manual only)
 *   engines                 string[] of allowed scraper engines
 *   pdf_export              boolean
 *   excel_import_export     boolean
 *   db_backup               boolean
 *   email_alerts            boolean
 *   history_retention_days  number | null (null = keep forever)
 */

const PLANS = [
  {
    slug: 'free',
    name: 'Free',
    price_cents: 0,
    currency: 'usd',
    interval: 'month',
    sort_order: 0,
    stripe_price_env: null,
    paypal_plan_env: null,
    entitlements: {
      max_websites: 3,
      max_scans_per_month: 10,
      schedules: [],
      engines: ['direct'],
      pdf_export: false,
      excel_import_export: false,
      db_backup: false,
      email_alerts: false,
      history_retention_days: 30,
    },
  },
  {
    slug: 'pro',
    name: 'Pro',
    price_cents: 2900,
    currency: 'usd',
    interval: 'month',
    sort_order: 1,
    stripe_price_env: 'STRIPE_PRICE_PRO',
    paypal_plan_env: 'PAYPAL_PLAN_PRO',
    entitlements: {
      max_websites: 25,
      max_scans_per_month: 300,
      schedules: ['weekly', 'daily'],
      engines: ['direct', 'firecrawl', 'brave', 'serper'],
      pdf_export: true,
      excel_import_export: false,
      db_backup: false,
      email_alerts: true,
      history_retention_days: 365,
    },
  },
  {
    slug: 'business',
    name: 'Business',
    price_cents: 9900,
    currency: 'usd',
    interval: 'month',
    sort_order: 2,
    stripe_price_env: 'STRIPE_PRICE_BUSINESS',
    paypal_plan_env: 'PAYPAL_PLAN_BUSINESS',
    entitlements: {
      max_websites: 200,
      max_scans_per_month: 2000,
      schedules: ['weekly', 'daily', 'hourly'],
      engines: ['direct', 'firecrawl', 'brave', 'serper'],
      pdf_export: true,
      excel_import_export: true,
      db_backup: true,
      email_alerts: true,
      history_retention_days: null,
    },
  },
];

/** The plan every user falls back to with no active paid subscription. */
const DEFAULT_PLAN_SLUG = 'free';

/** Plan definition by slug, or undefined. */
function getPlanDefinition(slug) {
  return PLANS.find((p) => p.slug === slug);
}

module.exports = { PLANS, DEFAULT_PLAN_SLUG, getPlanDefinition };
