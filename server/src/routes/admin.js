import { Router } from "express";
import { pool } from "../db.js";
import { getLatestUsage, getUsageHistory } from "../services/usageService.js";
import { TIERS, TIER_RANK, effectiveTier } from "../services/tierService.js";
import { stripe, stripeAvailable } from "../services/stripeService.js";

const router = Router();

// Owner-only endpoints (usage/cost dashboard) — gated by a shared secret
// rather than full accounts, since this isn't something regular users ever
// need to reach. Set ADMIN_KEY in the environment; without it, these routes
// stay locked (they never fall back to an open default).
function requireAdminKey(req, res, next) {
  const configured = process.env.ADMIN_KEY;
  if (!configured) {
    return res.status(503).json({ error: "Admin dashboard isn't configured yet (set ADMIN_KEY)." });
  }
  const provided = req.get("x-admin-key");
  if (provided !== configured) {
    return res.status(401).json({ error: "Invalid admin key." });
  }
  next();
}

// GET /api/admin/usage — Odds API credit usage (latest + recent history) plus
// basic subscriber/engagement counts, for the cost-vs-users dashboard.
router.get("/usage", requireAdminKey, async (req, res) => {
  try {
    const hours = Math.min(Number(req.query.hours) || 48, 24 * 30);
    const [latest, history] = await Promise.all([getLatestUsage(), getUsageHistory(hours)]);

    let stats = { available: false };
    if (pool) {
      const { rows } = await pool.query(`
        SELECT
          (SELECT COUNT(*) FROM users) AS total_users,
          (SELECT COUNT(*) FROM bets) AS total_bets,
          (SELECT COUNT(*) FROM users WHERE created_at >= now() - interval '7 days') AS new_users_7d
      `);
      const r = rows[0];
      stats = {
        available: true,
        totalUsers: Number(r.total_users),
        totalBets: Number(r.total_bets),
        newUsers7d: Number(r.new_users_7d),
      };
    }

    res.json({ latest, history, stats });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Failed to load usage data", detail: err.message });
  }
});

// GET /api/admin/users?limit=100&offset=0&search=foo — the signups list, most
// recent first, with each user's tier/trial/subscription state for the
// "manage subscription tier per user" admin need.
router.get("/users", requireAdminKey, async (req, res) => {
  try {
    if (!pool) return res.json({ available: false, users: [] });
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const search = (req.query.search || "").trim();

    const params = [];
    let where = "";
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      where = `WHERE LOWER(email) LIKE $${params.length}`;
    }
    params.push(limit, offset);

    const { rows } = await pool.query(
      `SELECT id, email, created_at, tier, trial_ends_at, subscription_status,
              stripe_customer_id, stripe_subscription_id
       FROM users ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*) FROM users ${where}`,
      search ? [params[0]] : []
    );

    const users = rows.map((r) => ({
      id: r.id,
      email: r.email,
      createdAt: r.created_at,
      rawTier: r.tier,
      tier: effectiveTier(r),
      trialEndsAt: r.trial_ends_at,
      subscriptionStatus: r.subscription_status,
      hasStripeCustomer: !!r.stripe_customer_id,
    }));

    res.json({ available: true, total: Number(countRows[0].count), users });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load users.", detail: err.message });
  }
});

// GET /api/admin/growth?days=30 — signups per day, for a growth-over-time chart.
router.get("/growth", requireAdminKey, async (req, res) => {
  try {
    if (!pool) return res.json({ available: false, days: [] });
    const days = Math.min(Number(req.query.days) || 30, 365);
    const { rows } = await pool.query(
      `SELECT date_trunc('day', created_at) AS day, COUNT(*) AS signups
       FROM users
       WHERE created_at >= now() - ($1 * interval '1 day')
       GROUP BY day
       ORDER BY day ASC`,
      [days]
    );
    res.json({
      available: true,
      days: rows.map((r) => ({ date: r.day, signups: Number(r.signups) })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load growth data.", detail: err.message });
  }
});

// POST /api/admin/users/:id/tier { tier }  — manual override, e.g. to comp an
// account or fix a support issue. This sets the DB tier directly; it does
// NOT touch Stripe, so a paying subscriber's plan should normally be changed
// via the Stripe dashboard (or their own Billing Portal) so the two stay in
// sync — use this for accounts with no active Stripe subscription.
router.post("/users/:id/tier", requireAdminKey, async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: "No database configured." });
    const { tier } = req.body || {};
    const validTiers = [...Object.keys(TIER_RANK)];
    if (!validTiers.includes(tier)) {
      return res.status(400).json({ error: `tier must be one of: ${validTiers.join(", ")}` });
    }
    const { rows } = await pool.query(
      "UPDATE users SET tier = $1 WHERE id = $2 RETURNING id, email, tier",
      [tier, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "User not found." });
    res.json({ user: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update tier.", detail: err.message });
  }
});

// GET /api/admin/revenue — monthly recurring revenue, pulled live from
// Stripe's active subscriptions (not our own DB, since Stripe is the source
// of truth for what's actually being billed).
router.get("/revenue", requireAdminKey, async (req, res) => {
  try {
    if (!stripeAvailable()) {
      return res.json({ available: false, reason: "Stripe isn't configured yet." });
    }
    let mrrCents = 0;
    const byTier = {};
    for (const t of TIERS) byTier[t.id] = { count: 0, mrrCents: 0 };

    let startingAfter;
    // Walk every active/trialing subscription, summing monthly-equivalent
    // amounts. Paginated in case the subscriber count grows past 100.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const page = await stripe.subscriptions.list({
        status: "active",
        limit: 100,
        starting_after: startingAfter,
      });
      for (const sub of page.data) {
        for (const item of sub.items.data) {
          const price = item.price;
          if (!price?.unit_amount || !price.recurring) continue;
          const monthlyCents =
            price.recurring.interval === "year"
              ? Math.round((price.unit_amount * (item.quantity || 1)) / 12)
              : price.unit_amount * (item.quantity || 1);
          mrrCents += monthlyCents;
          const tier = TIERS.find((t) => t.priceCents === price.unit_amount)?.id;
          if (tier && byTier[tier]) {
            byTier[tier].count += 1;
            byTier[tier].mrrCents += monthlyCents;
          }
        }
      }
      if (!page.has_more) break;
      startingAfter = page.data[page.data.length - 1].id;
    }

    res.json({ available: true, mrrCents, byTier });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Failed to load revenue from Stripe.", detail: err.message });
  }
});

export default router;
