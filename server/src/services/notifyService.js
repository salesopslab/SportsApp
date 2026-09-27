import nodemailer from "nodemailer";

// Sends BetEdge AI's own admin alerts (new signups, etc.) from a Gmail
// account via SMTP + an "app password" — free, no third-party service to
// sign up for. Requires two env vars on Render:
//   GMAIL_USER          the Gmail address to send FROM (e.g. your own Gmail)
//   GMAIL_APP_PASSWORD  a 16-character app password (Google Account →
//                        Security → 2-Step Verification → App passwords —
//                        requires 2FA to be turned on; this is NOT your
//                        regular Gmail password)
// Optional:
//   ADMIN_ALERT_EMAIL   where alerts go (defaults to GMAIL_USER itself)
//
// If those aren't set, alerts are silently skipped — this is a nice-to-have,
// never something that should block or fail a signup.
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const ADMIN_ALERT_EMAIL = process.env.ADMIN_ALERT_EMAIL || GMAIL_USER;

let transporter = null;
export function alertsAvailable() {
  return !!(GMAIL_USER && GMAIL_APP_PASSWORD);
}

function getTransporter() {
  if (!alertsAvailable()) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    });
  }
  return transporter;
}

// Fire-and-forget: logs failures but never throws, so a broken/missing mail
// setup can never break the request that triggered the alert (signup, etc).
async function sendAdminAlert(subject, text) {
  const t = getTransporter();
  if (!t) return;
  try {
    await t.sendMail({
      from: `BetEdge AI <${GMAIL_USER}>`,
      to: ADMIN_ALERT_EMAIL,
      subject,
      text,
    });
  } catch (err) {
    console.error("notifyService: failed to send admin alert:", err.message);
  }
}

export function notifyNewSignup(user) {
  const referredNote = user.referredByUserId ? ` (referred by user #${user.referredByUserId})` : "";
  sendAdminAlert(
    "New BetEdge AI signup",
    `New signup: ${user.email}${referredNote}\nUser ID: ${user.id}\nSigned up: ${new Date(user.createdAt).toLocaleString()}`
  );
}
