import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { TIERS, FREE_PLAN, TRIAL_DAYS, TIER_RANK, effectiveTier, trialMsRemaining, tierById } from "../services/tierService.js";
import {
  stripeAvailable,
  priceIdForTier,
  tierForPrice,
  intervalForPrice,
  INTERVALS,
  getOrCreateCustomer,
  createCheckoutSession,
  changeSubscriptionPlan,
  cancelSubscriptionAtPeriodEnd,
  resumeSubscription,
  createPortalSession,
  constructWebhookEvent,
} from "../services/stripeService.js";
import { grantReferralRewardIfEligible } from "../services/referralService.js";

const router = Router();
const LIVE_STATUSES = ["active", "trialing", "past_due"];

function normInterval(v) {
  return v === "annual" || v === "year" || v === "yearly" ? "annual" : "monthly";
}

// GET /api/billing/tiers — public. The pricing ladder for the pricing page.
router.get("/tiers", (_req, res) => {
  res.json({ tiers: TIERS, free: FREE_PLAN, trialDays: TRIAL_DAYS, available: stripeAvailable() });
});

// GET /api/billing/status — the logged-in user's current plan/trial state.
router.get("/status", requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT tier, trial_ends_at, subscription_status, billing_interval, cancel_at_period_end, current_period_end FROM users WHERE id = $1",
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
      interval: row.billing_interval || null,
      cancelAtPeriodEnd: !!row.cancel_at_period_end,
      currentPeriodEnd: row.current_period_end || null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load billing status." });
  }
});

function hasLiveSubscription(userRow) {
  return !!userRow.stripe_subscription_id && LIVE_STATUSES.includes(userRow.subscription_status);
}

// Applies a subscription object to our user row (used by plan changes and
// every subscription webhook). The plan comes from the Stripe price itself.
async function applySubscription(sub, { userId } = {}) {
  const item = sub.items?.data?.[0];
  const tier = tierForPrice(item?.price);
  const interval = item?.price ? intervalForPrice(item.price) : null;
  const periodEnd = sub.current_period_end || item?.current_period_end || null;
  const sets = ["subscription_status = $1", "stripe_subscription_id = $2", "cancel_at_period_end = $3", "current_period_end = $4"];
  const params = [sub.status, sub.id, !!sub.cancel_at_period_end, periodEnd ? new Date(periodEnd * 1000) : null];
  if (tier) {
    params.push(tier);
    sets.push(`tier = $${params.length}`);
  } else if (item?.price?.id) {
    console.error(`Stripe subscription ${sub.id} uses price ${item.price.id}, which isn't mapped to a BetEdge plan — tier left unchanged.`);
  }
  if (interval) {
    params.push(interval);
    sets.push(`billing_interval = $${params.length}`);
  }
  let where;
  if (userId) {
    params.push(userId);
    where = `id = $${params.length}`;
  } else {
    params.push(sub.customer);
    where = `stripe_customer_id = $${params.length}`;
  }
  await pool.query(`UPDATE users SET ${sets.join(", ")} WHERE ${where}`, params);
  return { tier, interval };
}

// POST /api/billing/checkout { tier, interval, successUrl, cancelUrl }
// New subscribers get a Stripe Checkout URL. Someone who already has a live
// subscription is switched in place instead (never a second subscription).
router.post("/checkout", requireAuth, async (req, res) => {
  try {
    if (!stripeAvailable()) {
      return res.status(503).json({ error: "Billing isn't configured yet." });
    }
    const { tier, successUrl, cancelUrl } = req.body || {};
    const interval = normInterval(req.body?.interval);
    const tierInfo = tierById(tier);
    if (!tierInfo) return res.status(400).json({ error: "Unknown plan." });

    const priceId = await priceIdForTier(tier, interval);
    if (!priceId) {
      return res.status(503).json({ error: `${tierInfo.name} ${interval} pricing isn't set up in Stripe yet.` });
    }

    const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: "User not found." });
    const userRow = rows[0];

    if (hasLiveSubscription(userRow)) {
      const sub = await changeSubscriptionPlan({ subscriptionId: userRow.stripe_subscription_id, priceId, tierId: tier, interval, userId: userRow.id });
      const applied = await applySubscription(sub, { userId: userRow.id });
      return res.json({ changed: true, tier: applied.tier || tier, interval });
    }

    const customerId = await getOrCreateCustomer(userRow);
    if (!userRow.stripe_customer_id) {
      await pool.query("UPDATE users SET stripe_customer_id = $1 WHERE id = $2", [customerId, userRow.id]);
    }

    // Still inside the free trial? Don't charge until it ends. (Stripe needs
    // a trial end at least 48 hours out; closer than that, billing starts now.)
    const trialLeftMs = trialMsRemaining(userRow);
    const trialEnd = trialLeftMs > 48 * 3600 * 1000 ? Math.floor(new Date(userRow.trial_ends_at).getTime() / 1000) : undefined;

    const session = await createCheckoutSession({
      customerId,
      priceId,
      userId: userRow.id,
      tierId: tier,
      interval,
      trialEnd,
      successUrl: successUrl || "https://www.betedgeai.com/?upgraded=1",
      cancelUrl: cancelUrl || "https://www.betedgeai.com/",
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to start checkout.", detail: err.message });
  }
});

// POST /api/billing/change-plan { tier, interval } — upgrade/downgrade an
// existing subscription (Edge <-> Edge+ <-> Edge Pro, monthly <-> annual).
router.post("/change-plan", requireAuth, async (req, res) => {
  try {
    if (!stripeAvailable()) return res.status(503).json({ error: "Billing isn't configured yet." });
    const tier = req.body?.tier;
    const interval = normInterval(req.body?.interval);
    const tierInfo = tierById(tier);
    if (!tierInfo) return res.status(400).json({ error: "Unknown plan." });
    const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: "User not found." });
    const userRow = rows[0];
    if (!hasLiveSubscription(userRow)) return res.status(400).json({ error: "You don't have an active subscription to change — choose a plan to subscribe." });
    const priceId = await priceIdForTier(tier, interval);
    if (!priceId) return res.status(503).json({ error: `${tierInfo.name} ${interval} pricing isn't set up in Stripe yet.` });
    const direction = TIER_RANK[tier] > TIER_RANK[userRow.tier] ? "upgrade" : TIER_RANK[tier] < TIER_RANK[userRow.tier] ? "downgrade" : "interval";
    const sub = await changeSubscriptionPlan({ subscriptionId: userRow.stripe_subscription_id, priceId, tierId: tier, interval, userId: userRow.id });
    const applied = await applySubscription(sub, { userId: userRow.id });
    res.json({ changed: true, direction, tier: applied.tier || tier, interval });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to change plan.", detail: err.message });
  }
});

// POST /api/billing/cancel — cancels at the end of the paid period (access
// continues until then). POST /api/billing/resume undoes it.
router.post("/cancel", requireAuth, async (req, res) => {
  try {
    if (!stripeAvailable()) return res.status(503).json({ error: "Billing isn't configured yet." });
    const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [req.user.id]);
    if (!rows.length || !hasLiveSubscription(rows[0])) return res.status(400).json({ error: "No active subscription to cancel." });
    const sub = await cancelSubscriptionAtPeriodEnd(rows[0].stripe_subscription_id);
    await applySubscription(sub, { userId: rows[0].id });
    res.json({ canceled: true, cancelAtPeriodEnd: true, currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000) : null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to cancel subscription.", detail: err.message });
  }
});

router.post("/resume", requireAuth, async (req, res) => {
  try {
    if (!stripeAvailable()) return res.status(503).json({ error: "Billing isn't configured yet." });
    const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [req.user.id]);
    if (!rows.length || !rows[0].stripe_subscription_id) return res.status(400).json({ error: "No subscription to resume." });
    const sub = await resumeSubscription(rows[0].stripe_subscription_id);
    await applySubscription(sub, { userId: rows[0].id });
    res.json({ resumed: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to resume subscription.", detail: err.message });
  }
});

// POST /api/billing/portal { returnUrl } — a Stripe Billing Portal session so
// a subscriber can update their card, see invoices, or cancel themselves.
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
      returnUrl: returnUrl || "https://www.betedgeai.com/",
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

        // One-time Hot Picks purchase — separate from the recurring
        // subscription flow below. ON CONFLICT DO NOTHING makes a retried
        // webhook delivery a no-op instead of a duplicate purchase record.
        if (session.mode === "payment") {
          const userId = session.metadata?.betedgeUserId;
          const hotPickDayId = session.metadata?.hotPickDayId;
          if (userId && hotPickDayId) {
            await pool.query(
              `INSERT INTO hot_pick_purchases (user_id, hot_pick_day_id, stripe_payment_intent_id, amount_cents)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT (user_id, hot_pick_day_id) DO NOTHING`,
              [userId, hotPickDayId, session.payment_intent, session.amount_total]
            );
          }
          break;
        }

        if (session.mode !== "subscription") break;
        const userId = session.metadata?.betedgeUserId;
        const tier = session.metadata?.tier;
        if (!userId || !tier) break;
        if (!tierById(tier)) break;
        await pool.query(
          `UPDATE users
             SET tier = $1, stripe_customer_id = $2, stripe_subscription_id = $3,
                 subscription_status = 'active', billing_interval = $4, cancel_at_period_end = false
           WHERE id = $5`,
          [tier, session.customer, session.subscription, normInterval(session.metadata?.interval), userId]
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
        await applySubscription(event.data.object);
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object;
        // Only the subscription that actually ended loses access — a stale
        // "deleted" event for an older subscription mustn't downgrade a user
        // who has since resubscribed.
        await pool.query(
          `UPDATE users SET subscription_status = 'canceled', cancel_at_period_end = false
            WHERE stripe_customer_id = $1 AND (stripe_subscription_id IS NULL OR stripe_subscription_id = $2)`,
          [sub.customer, sub.id]
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
