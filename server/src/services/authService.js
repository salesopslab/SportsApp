import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { pool, ensureSchema } from "../db.js";
import { effectiveTier, trialMsRemaining, TRIAL_DAYS } from "./tierService.js";
import { assignReferralCodeOnSignup, lookupReferrerByCode } from "./referralService.js";
import { notifyNewSignup } from "./notifyService.js";

// Falls back to a fixed dev secret if JWT_SECRET isn't set so local dev still
// works, but in production you should always set JWT_SECRET on Render.
const JWT_SECRET = process.env.JWT_SECRET || "betedge-dev-secret-change-me";
const TOKEN_TTL = "30d";

export function accountsAvailable() {
  return !!pool;
}

export function toPublicUser(row) {
  return {
    id: row.id,
    email: row.email,
    createdAt: row.created_at,
    tier: effectiveTier(row),
    rawTier: row.tier,
    trialEndsAt: row.trial_ends_at ?? null,
    trialMsRemaining: trialMsRemaining(row),
    referralCode: row.referral_code ?? null,
    bonusAccessUntil: row.bonus_access_until ?? null,
    marketingOptIn: !!row.marketing_opt_in,
  };
}

export function signToken(user, { expiresIn = TOKEN_TTL, impersonated = false } = {}) {
  const payload = { sub: user.id, email: user.email };
  if (impersonated) payload.imp = true;
  return jwt.sign(payload, JWT_SECRET, { expiresIn });
}

export function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

export async function signup(email, password, referralCode, signupIp, marketingOptIn = false) {
  if (!pool) throw new Error("Accounts aren't available yet — no database configured.");
  if (!email || !password) throw new Error("Email and password are required.");
  if (password.length < 8) throw new Error("Password must be at least 8 characters.");

  await ensureSchema();
  const normalizedEmail = email.trim().toLowerCase();

  const existing = await pool.query("SELECT id FROM users WHERE email = $1", [normalizedEmail]);
  if (existing.rows.length) throw new Error("An account with that email already exists.");

  // A referral code is optional and best-effort: an unknown/mistyped code
  // just means the signup proceeds without a referrer attached, rather than
  // blocking account creation.
  let referrerId = null;
  if (referralCode) {
    const referrer = await lookupReferrerByCode(referralCode);
    if (referrer) referrerId = referrer.id;
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, tier, trial_ends_at, referred_by_user_id, signup_ip, marketing_opt_in, marketing_opt_in_at)
     VALUES ($1, $2, 'trial', $3, $4, $5, $6, CASE WHEN $6 THEN now() ELSE NULL END)
     RETURNING id, email, created_at, tier, trial_ends_at, subscription_status, referred_by_user_id, marketing_opt_in`,
    [normalizedEmail, passwordHash, trialEndsAt, referrerId, signupIp || null, !!marketingOptIn]
  );
  const row = rows[0];
  row.referral_code = await assignReferralCodeOnSignup(row.id);

  const user = toPublicUser(row);
  // Best-effort: notifyNewSignup never throws, so a mail hiccup can never
  // fail the signup response itself.
  notifyNewSignup({ ...user, referredByUserId: row.referred_by_user_id ?? null });
  return { user, token: signToken(user) };
}

export async function login(email, password) {
  if (!pool) throw new Error("Accounts aren't available yet — no database configured.");
  if (!email || !password) throw new Error("Email and password are required.");

  await ensureSchema();
  const normalizedEmail = (email || "").trim().toLowerCase();
  const { rows } = await pool.query("SELECT * FROM users WHERE email = $1", [normalizedEmail]);
  if (!rows.length) throw new Error("Invalid email or password.");

  const row = rows[0];
  const ok = await bcrypt.compare(password, row.password_hash);
  if (!ok) throw new Error("Invalid email or password.");
  if (row.archived_at) throw new Error("This account has been archived. Contact support if this is a mistake.");

  const user = toPublicUser(row);
  return { user, token: signToken(user) };
}

// Changes a logged-in user's password. Requires the current password so a
// stolen session token alone can't lock the real owner out.
export async function changePassword(userId, currentPassword, newPassword) {
  if (!pool) throw new Error("Accounts aren't available yet — no database configured.");
  if (!currentPassword || !newPassword) throw new Error("Current and new password are required.");
  if (newPassword.length < 8) throw new Error("Password must be at least 8 characters.");

  await ensureSchema();
  const { rows } = await pool.query("SELECT password_hash FROM users WHERE id = $1", [userId]);
  if (!rows.length) throw new Error("User not found.");
  const ok = await bcrypt.compare(currentPassword, rows[0].password_hash);
  if (!ok) throw new Error("Current password is incorrect.");

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await pool.query("UPDATE users SET password_hash = $1 WHERE id = $2", [passwordHash, userId]);
}

export async function setMarketingOptIn(userId, optIn) {
  if (!pool) throw new Error("Accounts aren't available yet — no database configured.");
  await ensureSchema();
  await pool.query(
    "UPDATE users SET marketing_opt_in = $1, marketing_opt_in_at = CASE WHEN $1 THEN now() ELSE NULL END WHERE id = $2",
    [!!optIn, userId]
  );
}
