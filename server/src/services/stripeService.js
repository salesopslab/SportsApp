// Stripe billing is disabled for now (pending account approval) — this stub
// keeps every import site working with zero external dependency, so nothing
// crashes on boot while there's no "stripe" package installed. Once approval
// comes through, this file can be swapped back for a real integration.

export const stripe = null;

export function stripeAvailable() {
  return false;
}

export function priceIdForTier() {
  return null;
}

export function tierForPriceId() {
  return null;
}

export async function getOrCreateCustomer() {
  throw new Error("Billing isn't configured yet.");
}

export async function createCheckoutSession() {
  throw new Error("Billing isn't configured yet.");
}

// One-time purchase (Hot Picks) rather than a recurring subscription --
// `mode: "payment"` with inline `price_data` (the price is set per day on
// hot_pick_days, not a pre-configured Stripe Price like the tier
// subscriptions above), metadata carrying { betedgeUserId, hotPickDayId } so
// the webhook can record the purchase. Stub matches the others until Stripe
// is approved.
export async function createOneTimeCheckoutSession() {
  throw new Error("Billing isn't configured yet.");
}

export async function createPortalSession() {
  throw new Error("Billing isn't configured yet.");
}

export function constructWebhookEvent() {
  throw new Error("Billing isn't configured yet.");
}
