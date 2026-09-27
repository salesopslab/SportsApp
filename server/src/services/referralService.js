import crypto from "crypto";
import { pool, ensureSchema } from "../db.js";

// Both sides of a completed referral get 30 free days of Edge Pro-level
// access (per BetEdge's "referrer + referee" program), applied on top of
// whatever tier/subscription the account already has via bonus_access_until.
export const REFERRAL_BONUS_DAYS = 30;

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I — easier to read/type

function randomCode(length = 7) {
  let code = "";
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return code;
}

// Every user gets a personal referral code. Existing rows (created before
// this feature shipped) get one lazily the first time they're looked up.
export async function ensureReferralCode(userId) {
  await ensureSchema();
  const { rows } = await pool.query("SELECT referral_code FROM users WHERE id = $1", [userId]);
  if (!rows.length) return null;
  if (rows[0].referral_code) return rows[0].referral_code;

  // Retry on the rare collision — the UNIQUE constraint is the real guard.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode();
    try {
      await pool.query("UPDATE users SET referral_code = $1 WHERE id = $2", [code, userId]);
      return code;
    } catch (err) {
      if (err.code === "23505") continue; // unique_violation — try another code
      throw err;
    }
  }
  throw new Error("Could not generate a unique referral code — please try again.");
}

// Generates a code up front for a brand-new signup row (used inside
// authService.signup, which already has a fresh user id to attach it to).
export async function assignReferralCodeOnSignup(userId) {
  return ensureReferralCode(userId);
}

export async function lookupReferrerByCode(code) {
  if (!code) return null;
  await ensureSchema();
  const normalized = String(code).trim().toUpperCase();
  if (!normalized) return null;
  const { rows } = await pool.query("SELECT id, email FROM users WHERE referral_code = $1", [normalized]);
  return rows[0] || null;
}

// Collapses the common "refer yourself" tricks so two emails that a mail
// provider treats as the same inbox compare equal: strip a +tag (works on
// Gmail, Outlook, Fastmail, iCloud, etc.), and additionally strip dots from
// the local part for Gmail/Google Workspace specifically, since Gmail
// ignores them (a.b.c@gmail.com and abc@gmail.com are the same mailbox).
// Not foolproof (a determined person can still use two real inboxes), but it
// closes the free, no-effort version of the abuse without costing anything.
function normalizeEmailForAbuseCheck(email) {
  const [local, domain] = String(email || "").trim().toLowerCase().split("@");
  if (!domain) return email;
  const noTag = local.split("+")[0];
  const isGmail = domain === "gmail.com" || domain === "googlemail.com";
  return `${isGmail ? noTag.replace(/\./g, "") : noTag}@${domain}`;
}

// Flags a referral as likely self-referral (same person creating a second
// account to farm the bonus) rather than a genuine referred friend.
function isSelfReferral(referrer, referee) {
  if (normalizeEmailForAbuseCheck(referrer.email) === normalizeEmailForAbuseCheck(referee.email)) {
    return "same_email";
  }
  if (referrer.signup_ip && referee.signup_ip && referrer.signup_ip === referee.signup_ip) {
    return "same_signup_ip";
  }
  return null;
}

// Called once a referee's subscription actually goes through (Stripe's
// checkout.session.completed). Grants REFERRAL_BONUS_DAYS of bonus access to
// both the referrer and the referee, exactly once per referee — a re-fired
// webhook or a later plan change is a no-op thanks to the UNIQUE constraint
// on referral_rewards.referee_user_id.
export async function grantReferralRewardIfEligible(refereeUserId) {
  await ensureSchema();
  const { rows } = await pool.query(
    "SELECT id, email, signup_ip, referred_by_user_id FROM users WHERE id = $1",
    [refereeUserId]
  );
  const referee = rows[0];
  if (!referee || !referee.referred_by_user_id) return null;

  const { rows: referrerRows } = await pool.query(
    "SELECT id, email, signup_ip FROM users WHERE id = $1",
    [referee.referred_by_user_id]
  );
  const referrer = referrerRows[0];
  if (!referrer) return null;

  const abuseReason = isSelfReferral(referrer, referee);
  if (abuseReason) {
    console.warn(
      `Referral reward blocked (${abuseReason}): referrer ${referrer.id}, referee ${referee.id}`
    );
    await pool.query(
      `INSERT INTO referral_rewards_blocked (referrer_user_id, referee_user_id, reason)
       VALUES ($1, $2, $3)`,
      [referrer.id, referee.id, abuseReason]
    ).catch((err) => console.error("Failed to log blocked referral reward:", err.message));
    return null;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // INSERT ... ON CONFLICT DO NOTHING against the unique referee_user_id
    // column is the idempotency guard: only the first call for this referee
    // actually inserts a row and goes on to grant bonus days.
    const inserted = await client.query(
      `INSERT INTO referral_rewards (referrer_user_id, referee_user_id, bonus_days)
       VALUES ($1, $2, $3)
       ON CONFLICT (referee_user_id) DO NOTHING
       RETURNING id`,
      [referee.referred_by_user_id, referee.id, REFERRAL_BONUS_DAYS]
    );
    if (!inserted.rows.length) {
      await client.query("ROLLBACK");
      return null; // already rewarded for this referee — nothing to do
    }

    const bonusUntil = new Date(Date.now() + REFERRAL_BONUS_DAYS * 24 * 60 * 60 * 1000);
    // Extend each account's bonus window from whichever is later — its
    // current bonus_access_until (if still running) or now — rather than
    // overwriting a longer bonus already in progress with a shorter one.
    await client.query(
      `UPDATE users
         SET bonus_access_until = GREATEST(COALESCE(bonus_access_until, now()), now()) + ($2::text || ' days')::interval
       WHERE id = ANY($1::bigint[])`,
      [[referee.referred_by_user_id, referee.id], REFERRAL_BONUS_DAYS]
    );
    await client.query("COMMIT");
    return { referrerUserId: referee.referred_by_user_id, refereeUserId: referee.id, bonusUntil };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
