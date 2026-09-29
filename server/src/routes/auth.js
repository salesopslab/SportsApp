import { Router } from "express";
import { signup, login, changePassword, setMarketingOptIn, accountsAvailable, toPublicUser } from "../services/authService.js";
import { requireAuth } from "../middleware/auth.js";
import { pool } from "../db.js";
import { ensureReferralCode } from "../services/referralService.js";

const router = Router();

router.get("/status", (_req, res) => {
  res.json({ available: accountsAvailable() });
});

router.post("/signup", async (req, res) => {
  try {
    const { email, password, referralCode, marketingOptIn } = req.body || {};
    const { user, token } = await signup(email, password, referralCode, req.ip, marketingOptIn === true);
    res.json({ user, token });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const { user, token } = await login(email, password);
    res.json({ user, token });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

router.get("/me", requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, email, created_at, tier, trial_ends_at, subscription_status, referral_code, bonus_access_until, marketing_opt_in FROM users WHERE id = $1",
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: "User not found." });
    const row = rows[0];
    // Backfills a referral code for any account created before this feature
    // shipped, the first time it asks for its own account details.
    if (!row.referral_code) row.referral_code = await ensureReferralCode(row.id);
    res.json({ user: toPublicUser(row) });
  } catch (err) {
    res.status(500).json({ error: "Failed to load account." });
  }
});

router.post("/change-password", requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    await changePassword(req.user.id, currentPassword, newPassword);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/auth/marketing — logged-in user turns marketing emails on/off.
router.post("/marketing", requireAuth, async (req, res) => {
  try {
    await setMarketingOptIn(req.user.id, req.body?.optIn === true);
    res.json({ ok: true, marketingOptIn: req.body?.optIn === true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
