import { Router } from "express";
import { pool } from "../db.js";
import { withTier, requireTier } from "../middleware/tier.js";
import { meetsTier } from "../services/tierService.js";
import { getOrCreateTodaysHotPickDay, loadHotPickDayWithPicks, bundleExpiresAt } from "../services/hotPicksService.js";
import { stripeAvailable, createOneTimeCheckoutSession } from "../services/stripeService.js";

const router = Router();

function pickPublicFields(p, now, owned) {
  const locked = new Date(p.commence_time).getTime() <= now;
  if (!owned) {
    // Teaser: enough to show what's in the bundle without giving away the
    // actual pick -- that's the thing being sold.
    return {
      id: p.id,
      sport: p.sport,
      homeTeam: p.home_team,
      awayTeam: p.away_team,
      market: p.market,
      confidence: p.confidence,
      commenceTime: p.commence_time,
    };
  }
  return {
    id: p.id,
    sport: p.sport,
    homeTeam: p.home_team,
    awayTeam: p.away_team,
    market: p.market,
    side: p.side,
    point: p.point != null ? Number(p.point) : null,
    price: p.price,
    confidence: p.confidence,
    analysis: p.analysis,
    commenceTime: p.commence_time,
    locked,
  };
}

// GET /api/hot-picks/today — public-ish (withTier, not requireAuth): anyone
// can see the teaser (price, pick count, slots left) so it works as an
// upsell for non-Edge-Pro users too; only an Edge Pro purchaser sees the
// actual picks.
router.get("/today", withTier, async (req, res) => {
  try {
    if (!pool) return res.json({ available: false, reason: "Hot Picks isn't configured yet." });

    const day = await getOrCreateTodaysHotPickDay();
    if (!day) return res.json({ available: false, picks: [] });

    const { picks } = await loadHotPickDayWithPicks(day.id);
    const now = Date.now();
    // A pick that's already started isn't worth selling as part of a fresh
    // purchase -- exclude it from what a non-owner is shown/sold, but a
    // purchaser who already owns the day keeps seeing everything they paid for
    // (handled below via `owned`).
    const stillSellable = picks.filter((p) => new Date(p.commence_time).getTime() > now);

    const countRes = await pool.query(
      "SELECT COUNT(*)::int AS n FROM hot_pick_purchases WHERE hot_pick_day_id = $1",
      [day.id]
    );
    const purchased = countRes.rows[0].n;
    const slotsLeft = Math.max(0, day.max_purchasers - purchased);

    let owned = false;
    if (req.user) {
      const own = await pool.query(
        "SELECT 1 FROM hot_pick_purchases WHERE user_id = $1 AND hot_pick_day_id = $2",
        [req.user.id, day.id]
      );
      owned = own.rows.length > 0;
    }

    const visiblePicks = owned ? picks : stillSellable;

    res.json({
      available: true,
      betDate: day.bet_date,
      generatedAt: day.generated_at,
      expiresAt: bundleExpiresAt(day),
      priceCents: day.price_cents,
      maxPurchasers: day.max_purchasers,
      slotsLeft,
      soldOut: slotsLeft <= 0 && !owned,
      pickCount: visiblePicks.length,
      owned,
      // Hot Picks is a paid-plan add-on, not Edge-Pro-only: any subscriber
      // (Standard, Edge, Edge Pro) or trial account can buy in.
      eligible: meetsTier(req.userRow, "standard"),
      loggedIn: !!req.user,
      picks: visiblePicks.map((p) => pickPublicFields(p, now, owned)),
    });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Failed to load Hot Picks.", detail: err.message });
  }
});

// POST /api/hot-picks/purchase { successUrl, cancelUrl } — one-time
// Checkout session for today's bundle. Gated to any active paid plan
// (Standard/Edge/Edge Pro) or an active trial, not just Edge Pro; the
// webhook in billing.js records the purchase once Stripe confirms payment.
router.post("/purchase", withTier, requireTier("standard"), async (req, res) => {
  try {
    if (!stripeAvailable()) return res.status(503).json({ error: "Billing isn't configured yet." });
    if (!pool) return res.status(503).json({ error: "Hot Picks isn't configured yet." });

    const day = await getOrCreateTodaysHotPickDay();
    if (!day) return res.status(404).json({ error: "No Hot Picks available today." });

    const already = await pool.query(
      "SELECT 1 FROM hot_pick_purchases WHERE user_id = $1 AND hot_pick_day_id = $2",
      [req.user.id, day.id]
    );
    if (already.rows.length) return res.status(409).json({ error: "You already own today's Hot Picks." });

    const countRes = await pool.query(
      "SELECT COUNT(*)::int AS n FROM hot_pick_purchases WHERE hot_pick_day_id = $1",
      [day.id]
    );
    if (countRes.rows[0].n >= day.max_purchasers) {
      return res.status(409).json({ error: "Today's Hot Picks are sold out." });
    }

    const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: "User not found." });
    const userRow = rows[0];

    const { successUrl, cancelUrl } = req.body || {};
    const session = await createOneTimeCheckoutSession({
      customerEmail: userRow.email,
      customerId: userRow.stripe_customer_id || null,
      priceCents: day.price_cents,
      productName: `BetEdge AI Hot Picks — ${day.bet_date}`,
      userId: userRow.id,
      hotPickDayId: day.id,
      successUrl: successUrl || "https://betedgeai.com/?hotpicks=purchased",
      cancelUrl: cancelUrl || "https://betedgeai.com/",
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to start checkout.", detail: err.message });
  }
});

export default router;
