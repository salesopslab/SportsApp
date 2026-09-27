import { verifyToken } from "../services/authService.js";
import { pool } from "../db.js";
import { effectiveTier, meetsTier, tierById } from "../services/tierService.js";

// Reads the bearer token if one is present and, if it resolves to a real
// user, loads that user's row and computes their effective tier — but never
// fails the request. An anonymous visitor, an expired token, or a database
// hiccup all just fall through as req.tier = "none", req.userRow = null, so
// public routes (the Board) keep working for everyone while still letting a
// logged-in, paying user get their gated data in the same request.
export async function withTier(req, _res, next) {
  req.tier = "none";
  req.userRow = null;

  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return next();

  try {
    const payload = verifyToken(token);
    req.user = { id: payload.sub, email: payload.email };
  } catch {
    return next(); // expired/invalid token — treat as anonymous, don't 401 a Board request
  }

  try {
    if (pool) {
      const { rows } = await pool.query(
        "SELECT id, email, tier, trial_ends_at, subscription_status FROM users WHERE id = $1",
        [req.user.id]
      );
      if (rows.length) {
        req.userRow = rows[0];
        req.tier = effectiveTier(rows[0]);
      }
    }
  } catch (err) {
    console.error("withTier: failed to load user row:", err.message);
  }

  next();
}

// Hard-gates a route behind a minimum tier. Must run after withTier. Replies
// 402 (Payment Required) rather than 403 — this isn't a permissions problem,
// it's a "this needs a plan" problem, and the frontend can key its upgrade
// prompt off that status code.
export function requireTier(minTierId) {
  return (req, res, next) => {
    if (meetsTier(req.userRow, minTierId)) return next();

    const tierInfo = tierById(minTierId);
    res.status(402).json({
      error: req.user
        ? `This feature requires the ${tierInfo?.name || minTierId} plan.`
        : "Please log in to access this feature.",
      requiredTier: minTierId,
      loggedIn: !!req.user,
    });
  };
}
