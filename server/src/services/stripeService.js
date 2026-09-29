import Stripe from "stripe";
import { TIERS, tierById } from "./tierService.js";

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// ---------------------------------------------------------------------------
// Stripe prices.
//
// Current prices (Sept 2026 repricing) are found by LOOKUP KEY, so nobody has
// to copy Price IDs into Render: the admin "Set up Stripe pricing" button
// (setupPricing below) creates them with these keys, and checkout resolves
// them at runtime. An env var still wins if set (STRIPE_PRICE_EDGE_PLUS_ANNUAL
// style names below), as an escape hatch.
//
// LEGACY prices ($19.99 / $29.99 / $49.99, IDs in STRIPE_PRICE_STANDARD /
// STRIPE_PRICE_EDGE / STRIPE_PRICE_EDGE_PRO) stay recognized by the webhook
// forever, so existing subscribers on them keep the right plan.
// ---------------------------------------------------------------------------

export const INTERVALS = ["monthly", "annual"];

export function lookupKeyFor(tierId, interval) {
  return `betedge_${tierId}_${interval}_2026`;
}

const ENV_SLUG = { standard: "EDGE", edge: "EDGE_PLUS", edge_pro: "EDGE_PRO" };
function envOverride(tierId, interval) {
  const slug = ENV_SLUG[tierId];
  return slug ? process.env[`STRIPE_PRICE_V2_${slug}_${interval === "annual" ? "ANNUAL" : "MONTHLY"}`] || null : null;
}

const LEGACY_PRICE_ENV = { standard: "STRIPE_PRICE_STANDARD", edge: "STRIPE_PRICE_EDGE", edge_pro: "STRIPE_PRICE_EDGE_PRO" };
export function legacyPriceIds() {
  const out = {};
  for (const [tier, env] of Object.entries(LEGACY_PRICE_ENV)) if (process.env[env]) out[process.env[env]] = tier;
  return out;
}

export let stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;
// Tests swap in a fake client.
export function __setStripe(client) {
  stripe = client;
  priceCache.clear();
}

export function stripeAvailable() {
  return !!stripe;
}

const priceCache = new Map(); // lookupKey -> { id, at }
const PRICE_CACHE_MS = 10 * 60 * 1000;

// Current Price ID for a plan + billing interval, or null if not set up yet.
export async function priceIdForTier(tierId, interval = "monthly") {
  if (!tierById(tierId) || !INTERVALS.includes(interval)) return null;
  const override = envOverride(tierId, interval);
  if (override) return override;
  if (!stripe) return null;
  const key = lookupKeyFor(tierId, interval);
  const hit = priceCache.get(key);
  if (hit && Date.now() - hit.at < PRICE_CACHE_MS) return hit.id;
  const res = await stripe.prices.list({ lookup_keys: [key], active: true, limit: 1 });
  const id = res.data?.[0]?.id || null;
  if (id) priceCache.set(key, { id, at: Date.now() });
  return id;
}

// Which of our plans a Stripe Price belongs to — used by every subscription
// webhook. Works for new prices (metadata / lookup key) and legacy ones.
export function tierForPrice(price) {
  if (!price) return null;
  const meta = price.metadata?.betedge_tier;
  if (meta && tierById(meta)) return meta;
  const m = /^betedge_(standard|edge|edge_pro)_(monthly|annual)_/.exec(price.lookup_key || "");
  if (m) return m[1];
  const legacy = legacyPriceIds()[price.id];
  if (legacy) return legacy;
  for (const t of TIERS) {
    for (const iv of INTERVALS) if (envOverride(t.id, iv) === price.id) return t.id;
  }
  return null;
}

// Back-compat for callers that only have an ID.
export function tierForPriceId(priceId) {
  return tierForPrice(priceId ? { id: priceId } : null);
}

export function intervalForPrice(price) {
  return price?.recurring?.interval === "year" ? "annual" : "monthly";
}

export async function getOrCreateCustomer(userRow) {
  if (!stripe) throw new Error("Billing isn't configured yet.");
  if (userRow.stripe_customer_id) return userRow.stripe_customer_id;

  const customer = await stripe.customers.create({
    email: userRow.email,
    metadata: { betedgeUserId: String(userRow.id) },
  });
  return customer.id;
}

// Subscription Checkout — Edge / Edge+ / Edge Pro, monthly or annual.
// The 7-day free trial happens in the app at signup (no card needed).
// trialEnd (unix seconds): when someone subscribes during their in-app free
// trial, billing starts when that trial would have ended instead of today.
export async function createCheckoutSession({ customerId, priceId, userId, tierId, interval, successUrl, cancelUrl, trialEnd }) {
  if (!stripe) throw new Error("Billing isn't configured yet.");
  const meta = { betedgeUserId: String(userId), tier: tierId, interval: interval || "monthly" };
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    allow_promotion_codes: true,
    metadata: meta,
    subscription_data: trialEnd ? { metadata: meta, trial_end: trialEnd } : { metadata: meta },
  });
  return session;
}

// Switch an existing subscription to another plan and/or interval. Stripe
// prorates: an upgrade bills the difference, a downgrade leaves a credit for
// the next invoice. The subscription and its renewal date carry on.
export async function changeSubscriptionPlan({ subscriptionId, priceId, tierId, interval, userId }) {
  if (!stripe) throw new Error("Billing isn't configured yet.");
  const sub = await stripe.subscriptions.retrieve(subscriptionId);
  const item = sub.items?.data?.[0];
  if (!item) throw new Error("That subscription has no plan to change.");
  return stripe.subscriptions.update(subscriptionId, {
    items: [{ id: item.id, price: priceId }],
    proration_behavior: "create_prorations",
    cancel_at_period_end: false,
    metadata: { ...(sub.metadata || {}), betedgeUserId: String(userId), tier: tierId, interval },
  });
}

export async function cancelSubscriptionAtPeriodEnd(subscriptionId) {
  if (!stripe) throw new Error("Billing isn't configured yet.");
  return stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true });
}

export async function resumeSubscription(subscriptionId) {
  if (!stripe) throw new Error("Billing isn't configured yet.");
  return stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: false });
}

// One-time Checkout — today's Hot Picks bundle. Priced inline with
// price_data rather than a Dashboard Price, since the amount can change
// day-to-day (see hotPicksService.js's price/cap sync).
export async function createOneTimeCheckoutSession({
  customerEmail,
  customerId,
  priceCents,
  productName,
  userId,
  hotPickDayId,
  successUrl,
  cancelUrl,
}) {
  if (!stripe) throw new Error("Billing isn't configured yet.");
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer: customerId || undefined,
    customer_email: customerId ? undefined : customerEmail,
    line_items: [
      {
        price_data: {
          currency: "usd",
          unit_amount: priceCents,
          product_data: { name: productName },
        },
        quantity: 1,
      },
    ],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: { betedgeUserId: String(userId), hotPickDayId: String(hotPickDayId) },
  });
  return session;
}

export async function createPortalSession({ customerId, returnUrl }) {
  if (!stripe) throw new Error("Billing isn't configured yet.");
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });
  return session;
}

export function constructWebhookEvent(rawBody, signature) {
  if (!stripe) throw new Error("Billing isn't configured yet.");
  if (!STRIPE_WEBHOOK_SECRET) throw new Error("STRIPE_WEBHOOK_SECRET isn't set.");
  return stripe.webhooks.constructEvent(rawBody, signature, STRIPE_WEBHOOK_SECRET);
}

// Which plan/interval combinations currently resolve to a Stripe price.
export async function pricingStatus() {
  const out = [];
  for (const t of TIERS) {
    for (const iv of INTERVALS) {
      let priceId = null;
      let error = null;
      try {
        priceId = await priceIdForTier(t.id, iv);
      } catch (err) {
        error = err.message;
      }
      out.push({ tier: t.id, name: t.name, interval: iv, lookupKey: lookupKeyFor(t.id, iv), priceId, configured: !!priceId, error });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Admin: create the new prices in Stripe (idempotent) and stop selling the
// legacy ones. Archiving a price only blocks NEW purchases — Stripe keeps
// billing every existing subscription on it until that subscription changes.
// ---------------------------------------------------------------------------
export async function setupPricing({ archiveLegacy = true } = {}) {
  if (!stripe) throw new Error("Billing isn't configured yet.");
  const report = { created: [], reused: [], archived: [], products: [] };
  const legacy = legacyPriceIds();

  for (const t of TIERS) {
    // Reuse the product the legacy price belongs to, so a plan's history stays
    // on one product; otherwise find/create one tagged with our tier id.
    let productId = null;
    const legacyId = Object.keys(legacy).find((id) => legacy[id] === t.id);
    if (legacyId) {
      try {
        const lp = await stripe.prices.retrieve(legacyId);
        productId = typeof lp.product === "string" ? lp.product : lp.product?.id;
      } catch (err) {
        console.error(`setupPricing: legacy price ${legacyId} lookup failed:`, err.message);
      }
    }
    if (!productId) {
      const found = await stripe.products.search({ query: `metadata['betedge_tier']:'${t.id}'` }).catch(() => ({ data: [] }));
      productId = found.data?.[0]?.id || null;
    }
    if (!productId) {
      const p = await stripe.products.create({ name: `BetEdge AI ${t.name}`, metadata: { betedge_tier: t.id } });
      productId = p.id;
    } else {
      await stripe.products.update(productId, { name: `BetEdge AI ${t.name}`, metadata: { betedge_tier: t.id } });
    }
    report.products.push({ tier: t.id, name: t.name, productId });

    for (const iv of INTERVALS) {
      const key = lookupKeyFor(t.id, iv);
      const amount = iv === "annual" ? t.annualPriceCents : t.priceCents;
      const existing = await stripe.prices.list({ lookup_keys: [key], active: true, limit: 1 });
      const cur = existing.data?.[0];
      if (cur && cur.unit_amount === amount && cur.recurring?.interval === (iv === "annual" ? "year" : "month")) {
        report.reused.push({ tier: t.id, interval: iv, priceId: cur.id, amount });
        continue;
      }
      const price = await stripe.prices.create({
        product: productId,
        currency: "usd",
        unit_amount: amount,
        recurring: { interval: iv === "annual" ? "year" : "month" },
        lookup_key: key,
        transfer_lookup_key: true,
        nickname: `${t.name} ${iv === "annual" ? "Annual" : "Monthly"} (2026)`,
        metadata: { betedge_tier: t.id, interval: iv },
      });
      report.created.push({ tier: t.id, interval: iv, priceId: price.id, amount });
    }
  }

  if (archiveLegacy) {
    for (const id of Object.keys(legacy)) {
      try {
        const p = await stripe.prices.retrieve(id);
        if (p.active) {
          await stripe.prices.update(id, { active: false });
          report.archived.push({ priceId: id, tier: legacy[id], amount: p.unit_amount });
        }
      } catch (err) {
        report.archived.push({ priceId: id, tier: legacy[id], error: err.message });
      }
    }
  }
  priceCache.clear();
  return report;
}

// ---------------------------------------------------------------------------
// Admin: move subscribers on legacy prices to the new (lower) price for the
// same plan, starting at their NEXT renewal. proration_behavior "none" means
// no mid-cycle charge or credit: the current period stays as paid, and the
// next invoice uses the new price. Status, renewal date and cancellation
// settings are untouched. dryRun lists who would move without changing anything.
// ---------------------------------------------------------------------------
export async function migrateLegacySubscribers({ dryRun = true } = {}) {
  if (!stripe) throw new Error("Billing isn't configured yet.");
  const legacy = legacyPriceIds();
  const report = { dryRun, moved: [], skipped: [], errors: [] };
  if (!Object.keys(legacy).length) return { ...report, note: "No legacy price IDs are set (STRIPE_PRICE_STANDARD / _EDGE / _EDGE_PRO), so there is nothing to migrate." };

  for (const status of ["active", "trialing", "past_due"]) {
    let startingAfter;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const page = await stripe.subscriptions.list({ status, limit: 100, starting_after: startingAfter });
      for (const sub of page.data) {
        const item = sub.items?.data?.[0];
        const tier = item && legacy[item.price?.id];
        if (!tier) continue;
        const interval = intervalForPrice(item.price);
        const newPriceId = await priceIdForTier(tier, interval);
        const row = { subscriptionId: sub.id, customer: sub.customer, tier, interval, from: item.price.unit_amount, fromPriceId: item.price.id, toPriceId: newPriceId };
        if (!newPriceId) {
          report.skipped.push({ ...row, reason: "New price not set up yet — run Set up Stripe pricing first." });
          continue;
        }
        if (dryRun) {
          report.moved.push(row);
          continue;
        }
        try {
          await stripe.subscriptions.update(sub.id, {
            items: [{ id: item.id, price: newPriceId }],
            proration_behavior: "none",
            metadata: { ...(sub.metadata || {}), tier, interval, repriced_2026: "true" },
          });
          report.moved.push(row);
        } catch (err) {
          report.errors.push({ ...row, error: err.message });
        }
      }
      if (!page.has_more) break;
      startingAfter = page.data[page.data.length - 1].id;
    }
  }
  return report;
}
