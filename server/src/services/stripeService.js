import Stripe from "stripe";
import { TIERS } from "./tierService.js";

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// Each subscription tier's Stripe Price ID, set as a Render environment
// variable once the corresponding Product/Price exists in the Stripe
// Dashboard. Left unset, that tier's checkout returns a clear 503 instead of
// a confusing Stripe API error.
const TIER_PRICE_ENV = {
  standard: "STRIPE_PRICE_STANDARD",
  edge: "STRIPE_PRICE_EDGE",
  edge_pro: "STRIPE_PRICE_EDGE_PRO",
};

export const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

export function stripeAvailable() {
  return !!stripe;
}

export function priceIdForTier(tierId) {
  const envVar = TIER_PRICE_ENV[tierId];
  if (!envVar) return null;
  return process.env[envVar] || null;
}

// Reverse lookup used by the subscription webhooks (they only carry the
// Stripe price ID, and need to know which of our tiers that maps to).
export function tierForPriceId(priceId) {
  if (!priceId) return null;
  for (const tierId of Object.keys(TIER_PRICE_ENV)) {
    if (priceIdForTier(tierId) === priceId) return tierId;
  }
  return null;
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

// Subscription Checkout — Standard/Edge/Edge Pro monthly plans.
export async function createCheckoutSession({ customerId, priceId, userId, tierId, successUrl, cancelUrl }) {
  if (!stripe) throw new Error("Billing isn't configured yet.");
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: { betedgeUserId: String(userId), tier: tierId },
    subscription_data: {
      metadata: { betedgeUserId: String(userId), tier: tierId },
    },
  });
  return session;
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

// Sanity-checks which tiers have a live Price ID configured yet — used by
// /api/billing/tiers-ish admin checks and worth keeping in sync with TIERS.
export function configuredTierIds() {
  return TIERS.map((t) => t.id).filter((id) => !!priceIdForTier(id));
}
