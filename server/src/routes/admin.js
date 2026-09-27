import { Router } from "express";
import { pool } from "../db.js";
import { getLatestUsage, getUsageHistory } from "../services/usageService.js";

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

export default router;
