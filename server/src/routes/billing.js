import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { TIERS, TRIAL_DAYS, effectiveTier, trialMsRemaining, tierById } from "../services/tierService.js";
import {
  stripeAvailable,
  priceIdForTier,
  tierForPriceId,
  getOrCreateCustomer,
  createCheckoutSession,
  createPortalSession,
  constructWebhookEvent,
} from "../services/stripeService.js";
import { grantReferralRewardIfEligible } from "../services/referralService.js";

const router = Router();

// GET /api/billing/tiers — public. The pricing ladder for the upgrade UI.
router.get("/tiers", (_req, res) => {
  res.json({ tiers: TIERS, trialDays: TRIAL_DAYS, available: stripeAvailable() });
});

// GET /api/billing/status — the logged-in user's current tier/trial state.
router.get("/status", requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT tier, trial_ends_at, subscription_status FROM users WHERE id = $1",
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: "User not found." });
    const row = rows[0];
    res.json({
      tier: effectiveTier(row),
      rawTier: row.tier,
      trialEndsAt: row.trial_ends_at,
      trialMsRemaining: trialMsRemaining(row),
      subscriptionStatus: row.subscription_status,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load billing status." });
  }
});

// POST /api/billing/checkout { tier, successUrl, cancelUrl } — creates a
// Stripe Checkout session for the requested tier and returns its URL for the
// frontend to redirect to.
router.post("/checkout", requireAuth, async (req, res) => {
  try {
    if (!stripeAvailable()) {
      return res.status(503).json({ error: "Billing isn't configured yet." });
    }
    const { tier, successUrl, cancelUrl } = req.body || {};
    const tierInfo = tierById(tier);
    if (!tierInfo) return res.status(400).json({ error: "Unknown tier." });

    const priceId = priceIdForTier(tier);
    if (!priceId) {
      return res.status(503).json({ error: `No Stripe price configured for ${tierInfo.name} yet.` });
    }

    const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: "User not found." });
    const userRow = rows[0];

    const customerId = await getOrCreateCustomer(userRow);
    if (!userRow.stripe_customer_id) {
      await pool.query("UPDATE users SET stripe_customer_id = $1 WHERE id = $2", [customerId, userRow.id]);
    }

    const session = await createCheckoutSession({
      customerId,
      priceId,
      userId: userRow.id,
      tierId: tier,
      successUrl: successUrl || "https://betedge-ai.com/account?upgraded=1",
      cancelUrl: cancelUrl || "https://betedge-ai.com/account",
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to start checkout.", detail: err.message });
  }
});

// POST /api/billing/portal { returnUrl } — a Stripe Billing Portal session so
// a subscriber can update their card, change plans, or cancel themselves.
router.post("/portal", requireAuth, async (req, res) => {
  try {
    if (!stripeAvailable()) {
      return res.status(503).json({ error: "Billing isn't configured yet." });
    }
    const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [req.user.id]);
    if (!rows.length || !rows[0].stripe_customer_id) {
      return res.status(400).json({ error: "No billing account yet — subscribe first." });
    }
    const { returnUrl } = req.body || {};
    const session = await createPortalSession({
      customerId: rows[0].stripe_customer_id,
      returnUrl: returnUrl || "https://betedge-ai.com/account",
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to open billing portal.", detail: err.message });
  }
});

export default router;

// ---------------------------------------------------------------------------
// Stripe webhook — exported separately (not mounted on `router`) because it
// needs the RAW request body for signature verification, so index.js wires
// it up with express.raw() ahead of the app-wide express.json() middleware,
// rather than through this JSON-parsed router.
// ---------------------------------------------------------------------------
export async function handleStripeWebhook(req, res) {
  if (!stripeAvailable()) return res.status(503).send("Stripe not configured.");

  let event;
  try {
    event = constructWebhookEvent(req.body, req.headers["stripe-signature"]);
  } catch (err) {
    console.error("Stripe webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      // Fired the moment checkout completes — flip the user's tier right
      // away so they get access without waiting on the subscription event.
      case "checkout.session.completed": {
        const session = event.data.object;
        if (session.mode !== "subscription") break;
        const userId = session.metadata?.betedgeUserId;
        const tier = session.metadata?.tier;
        if (!userId || !tier) break;
        await pool.query(
          `UPDATE users
             SET tier = $1, stripe_customer_id = $2, stripe_subscription_id = $3,
                 subscription_status = 'active'
           WHERE id = $4`,
          [tier, session.customer, session.subscription, userId]
        );
        // If this new subscriber signed up with someone else's referral
        // code, this is the moment the referral "counts" — grant both sides
        // their 30 bonus days. Idempotent, and never blocks the tier update
        // above if it fails for any reason.
        try {
          await grantReferralRewardIfEligible(userId);
        } catch (err) {
          console.error(`grantReferralRewardIfEligible failed for user ${userId}:`, err.message);
        }
        break;
      }

      // The canonical source of truth for plan + status going forward
      // (upgrades, downgrades, past_due, renewals all land here too).
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const sub = event.data.object;
        const priceId = sub.items?.data?.[0]?.price?.id;
        const tier = tierForPriceId(priceId);
        const params = [sub.status, sub.id];
        let query = "UPDATE users SET subscription_status = $1, stripe_subscription_id = $2";
        if (tier) {
          query += ", tier = $3 WHERE stripe_customer_id = $4";
          params.push(tier, sub.customer);
        } else {
          query += " WHERE stripe_customer_id = $3";
          params.push(sub.customer);
        }
        await pool.query(query, params);
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object;
        await pool.query(
          "UPDATE users SET subscription_status = 'canceled' WHERE stripe_customer_id = $1",
          [sub.customer]
        );
        break;
      }

      default:
        break; // other events aren't relevant to tier state
    }
    res.json({ received: true });
  } catch (err) {
    console.error("Stripe webhook handler failed:", err.message);
    // 500 tells Stripe to retry — safer than silently dropping a tier update.
    res.status(500).send("Webhook handler error.");
  }
}
