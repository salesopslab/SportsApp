import { pool, ensureSchema } from "../db.js";
import { effectiveTier, limitsFor, nextTierUp, tierById } from "../services/tierService.js";

// Per-plan daily usage caps (AI chat, Fantasy Edge). Must run after withTier.
// A use is only counted when the request succeeds, so an error never costs
// someone one of their questions.

const TZ = "America/Los_Angeles";
const LABELS = { aiChat: "AI questions", fantasy: "Fantasy Edge analyses" };

export async function usageToday(userId, kind) {
  if (!pool) return 0;
  await ensureSchema();
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM feature_usage
      WHERE user_id = $1 AND kind = $2
        AND created_at >= (date_trunc('day', now() AT TIME ZONE '${TZ}') AT TIME ZONE '${TZ}')`,
    [userId, kind]
  );
  return rows[0].n;
}

export function dailyLimit(kind) {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(402).json({
        error: `Log in or create a free account to use ${LABELS[kind] || "this feature"}.`,
        requiredTier: "standard",
        loggedIn: false,
      });
    }
    if (!pool) return next(); // no database (local dev): don't block
    try {
      const limit = limitsFor(req.userRow)[kind] ?? 0;
      const used = await usageToday(req.user.id, kind);
      if (used >= limit) {
        const tier = effectiveTier(req.userRow);
        const up = nextTierUp(tier);
        const upName = up ? tierById(up)?.name : null;
        const planName = ["none", "expired"].includes(tier) ? "the Free plan" : tierById(tier)?.name || "your plan";
        return res.status(402).json({
          error: `You've used all ${limit} ${LABELS[kind] || "uses"} included with ${planName} today.${upName ? ` ${upName} includes ${limitsFor({ tier: up })[kind] ?? "more"} a day.` : " Your limit resets at midnight Pacific."}`,
          requiredTier: up || tier,
          loggedIn: true,
          limitReached: true,
          limit,
          used,
        });
      }
      res.on("finish", () => {
        if (res.statusCode < 400) {
          pool.query("INSERT INTO feature_usage (user_id, kind) VALUES ($1, $2)", [req.user.id, kind]).catch((err) =>
            console.error("feature_usage insert failed:", err.message)
          );
        }
      });
      res.setHeader("X-Usage-Remaining", String(Math.max(0, limit - used - 1)));
      next();
    } catch (err) {
      console.error(`dailyLimit(${kind}) check failed:`, err.message);
      next(); // never block a request because the counter itself failed
    }
  };
}
