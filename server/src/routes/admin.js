import { Router } from "express";
import { runPickers } from "../services/pickerService.js";
import { pool } from "../db.js";
import { getLatestUsage, getUsageHistory } from "../services/usageService.js";
import { TIERS, TIER_RANK, effectiveTier } from "../services/tierService.js";
import { stripe, stripeAvailable, tierForPrice, pricingStatus, setupPricing, migrateLegacySubscribers } from "../services/stripeService.js";
import { REFERRAL_BONUS_DAYS } from "../services/referralService.js";
import { signToken, toPublicUser } from "../services/authService.js";
import { listChatLogs } from "../services/chatLogService.js";

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

// GET /api/admin/chat-logs?days=7&limit=100&offset=0&search=&promptVersion=
// Recent AI chat questions + answers for quality spot-checks.
router.get("/chat-logs", requireAdminKey, async (req, res) => {
  try {
    res.json(await listChatLogs(req.query));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load chat logs", detail: err.message });
  }
});

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

// GET /api/admin/users?limit=100&offset=0&search=foo&status=active|archived|all
// — the signups list, most recent first, with each user's tier/trial/
// subscription/archived state for the admin dashboard. Defaults to hiding
// archived accounts so the normal list stays clean; pass status=archived or
// status=all to see them.
router.get("/users", requireAdminKey, async (req, res) => {
  try {
    if (!pool) return res.json({ available: false, users: [] });
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const search = (req.query.search || "").trim();
    const status = ["active", "archived", "all"].includes(req.query.status) ? req.query.status : "active";

    const params = [];
    const conditions = [];
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      conditions.push(`LOWER(email) LIKE $${params.length}`);
    }
    if (status === "active") conditions.push("archived_at IS NULL");
    if (status === "archived") conditions.push("archived_at IS NOT NULL");
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit, offset);

    const { rows } = await pool.query(
      `SELECT id, email, created_at, tier, trial_ends_at, subscription_status,
              stripe_customer_id, stripe_subscription_id, archived_at
       FROM users ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const countParams = params.slice(0, params.length - 2);
    const { rows: countRows } = await pool.query(`SELECT COUNT(*) FROM users ${where}`, countParams);

    const users = rows.map((r) => ({
      id: r.id,
      email: r.email,
      createdAt: r.created_at,
      rawTier: r.tier,
      tier: effectiveTier(r),
      trialEndsAt: r.trial_ends_at,
      subscriptionStatus: r.subscription_status,
      hasStripeCustomer: !!r.stripe_customer_id,
      archivedAt: r.archived_at,
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
    // Every calendar day in the range (zero-signup days included), counted
    // in the admin's time zone, as "YYYY-MM-DD".
    const tz = process.env.ADMIN_TIMEZONE || "America/Los_Angeles";
    const { rows } = await pool.query(
      `WITH d AS (
         SELECT generate_series((now() AT TIME ZONE $2)::date - ($1::int - 1), (now() AT TIME ZONE $2)::date, interval '1 day')::date AS day
       )
       SELECT to_char(d.day, 'YYYY-MM-DD') AS day, COUNT(u.id) AS signups
       FROM d LEFT JOIN users u ON (u.created_at AT TIME ZONE $2)::date = d.day
       GROUP BY d.day ORDER BY d.day ASC`,
      [days, tz]
    );
    res.json({
      available: true,
      timeZone: tz,
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

// GET /api/admin/users/export.csv?audience=opted_in|all — downloads active
// (non-archived) users' emails as CSV for marketing tools. Default audience is
// opted_in: only people who agreed to marketing emails.
function csvCell(v) {
  if (v === null || v === undefined) return "";
  const str = v instanceof Date ? v.toISOString() : String(v);
  // Quote everything; neutralize spreadsheet formula injection.
  const safe = /^[=+\-@]/.test(str) ? "'" + str : str;
  return '"' + safe.replace(/"/g, '""') + '"';
}

router.get("/users/export.csv", requireAdminKey, async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: "No database configured." });
    const audience = req.query.audience === "all" ? "all" : "opted_in";
    const where = audience === "all" ? "archived_at IS NULL" : "archived_at IS NULL AND marketing_opt_in = true";
    const { rows } = await pool.query(
      `SELECT email, created_at, tier, trial_ends_at, subscription_status, bonus_access_until,
              marketing_opt_in, marketing_opt_in_at
       FROM users WHERE ${where} ORDER BY created_at DESC`
    );
    const header = ["email", "signed_up", "plan", "subscription_status", "marketing_opt_in", "opted_in_at"];
    const lines = [header.join(",")].concat(rows.map((r) => [
      r.email, r.created_at, effectiveTier(r), r.subscription_status, r.marketing_opt_in ? "yes" : "no", r.marketing_opt_in_at,
    ].map(csvCell).join(",")));
    const date = new Date().toISOString().slice(0, 10);
    console.log(`[admin] email export (${audience}): ${rows.length} rows`);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="betedge-emails-${audience}-${date}.csv"`);
    res.send(lines.join("\n") + "\n");
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to export emails.", detail: err.message });
  }
});

// POST /api/admin/users/:id/impersonate — issues a short-lived (2h) session
// token for that user so the owner can see the site exactly as they do,
// without knowing their password. Archived users can't be impersonated.
router.post("/users/:id/impersonate", requireAdminKey, async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: "No database configured." });
    const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "User not found." });
    if (rows[0].archived_at) return res.status(409).json({ error: "User is archived — restore them first." });
    const user = toPublicUser(rows[0]);
    const token = signToken(user, { expiresIn: "2h", impersonated: true });
    console.log(`[admin] impersonation session issued for user ${user.id} (${user.email})`);
    res.json({ user, token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to start impersonation.", detail: err.message });
  }
});

// POST /api/admin/users/:id/archive — soft-delete: blocks the account from
// logging in (and cuts off any already-issued session token — see
// middleware/auth.js and middleware/tier.js) but keeps the row and all
// related data. Reversible via /unarchive. Does NOT touch their Stripe
// subscription — cancel that separately in the Stripe dashboard if needed.
router.post("/users/:id/archive", requireAdminKey, async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: "No database configured." });
    const { rows } = await pool.query(
      "UPDATE users SET archived_at = now() WHERE id = $1 AND archived_at IS NULL RETURNING id, email, archived_at",
      [req.params.id]
    );
    if (!rows.length) {
      const exists = await pool.query("SELECT id FROM users WHERE id = $1", [req.params.id]);
      if (!exists.rows.length) return res.status(404).json({ error: "User not found." });
      return res.status(409).json({ error: "User is already archived." });
    }
    res.json({ user: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to archive user.", detail: err.message });
  }
});

// POST /api/admin/users/:id/unarchive — restores an archived account to
// normal (they can log in again immediately with their existing password).
router.post("/users/:id/unarchive", requireAdminKey, async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: "No database configured." });
    const { rows } = await pool.query(
      "UPDATE users SET archived_at = NULL WHERE id = $1 RETURNING id, email, archived_at",
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "User not found." });
    res.json({ user: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to restore user.", detail: err.message });
  }
});

// DELETE /api/admin/users/:id { confirmEmail } — permanently deletes the user
// row and, via ON DELETE CASCADE, every bet, hot_pick_purchase, and referral
// record tied to it. This cannot be undone, so it requires the caller to
// echo back the user's exact email as a confirmation (the admin dashboard
// makes the admin type it, not just click a button) — a wrong or missing
// confirmEmail is rejected before anything is touched. It does NOT cancel
// their Stripe subscription; do that in the Stripe dashboard first if they
// have an active one, or they'll keep being billed with no account left to
// show for it.
router.delete("/users/:id", requireAdminKey, async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: "No database configured." });
    const { rows: existing } = await pool.query("SELECT id, email FROM users WHERE id = $1", [req.params.id]);
    if (!existing.length) return res.status(404).json({ error: "User not found." });

    const confirmEmail = String(req.body?.confirmEmail || "").trim().toLowerCase();
    if (!confirmEmail || confirmEmail !== existing[0].email.toLowerCase()) {
      return res.status(400).json({ error: "confirmEmail must exactly match the user's email address." });
    }

    // referred_by_user_id has no ON DELETE clause (it's a plain FK added via
    // ALTER TABLE), so deleting a user who referred others would otherwise
    // fail with a foreign-key violation. Detach those referrals first —
    // their referred_by_user_id becomes null, their own row is untouched.
    await pool.query("UPDATE users SET referred_by_user_id = NULL WHERE referred_by_user_id = $1", [
      req.params.id,
    ]);
    await pool.query("DELETE FROM users WHERE id = $1", [req.params.id]);
    res.json({ deleted: true, id: req.params.id, email: existing[0].email });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete user.", detail: err.message });
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
          const tier = tierForPrice(price);
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

// GET /api/admin/billing-health — a quick "is Stripe actually wired up"
// checklist: the secret key, the webhook signing secret, and each
// subscription tier's Price ID. None of these return the actual secret
// values, just whether each is present, so this is safe to expose behind the
// existing admin-key gate.
router.get("/billing-health", requireAdminKey, async (req, res) => {
  try {
    const prices = stripeAvailable() ? await pricingStatus() : [];
    res.json({
      stripeConfigured: stripeAvailable(),
      webhookConfigured: !!process.env.STRIPE_WEBHOOK_SECRET,
      tiers: TIERS.map((t) => ({
        id: t.id,
        name: t.name,
        priceCents: t.priceCents,
        annualPriceCents: t.annualPriceCents,
        monthlyConfigured: prices.some((p) => p.tier === t.id && p.interval === "monthly" && p.configured),
        annualConfigured: prices.some((p) => p.tier === t.id && p.interval === "annual" && p.configured),
        priceConfigured: prices.some((p) => p.tier === t.id && p.configured),
      })),
      prices,
    });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Failed to check Stripe pricing.", detail: err.message });
  }
});

// POST /api/admin/stripe/setup-pricing — creates the 2026 monthly + annual
// prices in Stripe (safe to run again; existing ones are reused) and stops
// the legacy $19.99/$29.99/$49.99 prices from being sold to NEW customers.
// Existing subscriptions on legacy prices keep billing until migrated.
router.post("/stripe/setup-pricing", requireAdminKey, async (req, res) => {
  try {
    if (!stripeAvailable()) return res.status(503).json({ error: "Stripe isn't configured yet." });
    const report = await setupPricing({ archiveLegacy: req.body?.archiveLegacy !== false });
    console.log("[admin] Stripe pricing setup:", JSON.stringify({ created: report.created.length, reused: report.reused.length, archived: report.archived.length }));
    res.json(report);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Stripe pricing setup failed.", detail: err.message });
  }
});

// POST /api/admin/stripe/migrate-subscribers { dryRun } — moves subscribers on
// legacy prices to the new lower price for the same plan from their next
// renewal (no mid-cycle charge or credit). dryRun (default true) only lists them.
router.post("/stripe/migrate-subscribers", requireAdminKey, async (req, res) => {
  try {
    if (!stripeAvailable()) return res.status(503).json({ error: "Stripe isn't configured yet." });
    const dryRun = req.body?.dryRun !== false;
    const report = await migrateLegacySubscribers({ dryRun });
    console.log(`[admin] legacy subscriber migration (${dryRun ? "dry run" : "LIVE"}): ${report.moved.length} moved, ${report.skipped.length} skipped, ${report.errors.length} errors`);
    res.json(report);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Subscriber migration failed.", detail: err.message });
  }
});

// POST /api/admin/picks/run — run the built-in pickers now (same as the
// scheduled run). Body: { dry: true } to preview without saving anything.
router.post("/picks/run", requireAdminKey, async (req, res) => {
  try {
    res.json(await runPickers({ dryRun: !!req.body?.dry, post: req.body?.post !== false, grade: req.body?.grade !== false }));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Picker run failed.", detail: err.message });
  }
});

// GET /api/admin/hotpicks?days=30 — Hot Picks performance: per-day price,
// cap, purchases and revenue, most recent first, plus running totals. Pulled
// from our own DB (purchases are recorded there by the Stripe webhook),
// unlike /revenue which reads live from Stripe.
router.get("/hotpicks", requireAdminKey, async (req, res) => {
  try {
    if (!pool) return res.json({ available: false, days: [] });
    const days = Math.min(Number(req.query.days) || 30, 365);
    const { rows } = await pool.query(
      `SELECT
         d.id, d.bet_date, d.price_cents, d.max_purchasers,
         (SELECT COUNT(*) FROM hot_picks hp WHERE hp.hot_pick_day_id = d.id) AS pick_count,
         COUNT(pu.id) AS purchased,
         COALESCE(SUM(pu.amount_cents), 0) AS revenue_cents
       FROM hot_pick_days d
       LEFT JOIN hot_pick_purchases pu ON pu.hot_pick_day_id = d.id
       WHERE d.bet_date >= (now() - ($1 * interval '1 day'))::date
       GROUP BY d.id
       ORDER BY d.bet_date DESC`,
      [days]
    );
    const mapped = rows.map((r) => ({
      betDate: r.bet_date,
      priceCents: r.price_cents,
      maxPurchasers: r.max_purchasers,
      pickCount: Number(r.pick_count),
      purchased: Number(r.purchased),
      slotsLeft: Math.max(0, r.max_purchasers - Number(r.purchased)),
      revenueCents: Number(r.revenue_cents),
    }));
    const totalRevenueCents = mapped.reduce((sum, d) => sum + d.revenueCents, 0);
    const totalPurchases = mapped.reduce((sum, d) => sum + d.purchased, 0);
    res.json({ available: true, days: mapped, totalRevenueCents, totalPurchases });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load Hot Picks data.", detail: err.message });
  }
});

// GET /api/admin/referrals — how the referral program is performing:
// completed (rewarded) referrals, bonus days each is worth, and how many
// attempts got blocked as likely self-referral abuse.
router.get("/referrals", requireAdminKey, async (req, res) => {
  try {
    if (!pool) return res.json({ available: false });
    const [rewarded, blocked] = await Promise.all([
      pool.query("SELECT COUNT(*)::int AS n FROM referral_rewards"),
      pool.query("SELECT COUNT(*)::int AS n FROM referral_rewards_blocked"),
    ]);
    res.json({
      available: true,
      totalRewarded: rewarded.rows[0].n,
      totalBlocked: blocked.rows[0].n,
      bonusDays: REFERRAL_BONUS_DAYS,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load referral data.", detail: err.message });
  }
});

export default router;
