import { verifyToken } from "../services/authService.js";
import { pool } from "../db.js";

// Requires a valid "Authorization: Bearer <token>" header. On success, attaches
// req.user = { id, email }. On failure, responds 401 and stops the request.
export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Not logged in." });

  try {
    const payload = verifyToken(token);
    req.user = { id: payload.sub, email: payload.email };
  } catch {
    return res.status(401).json({ error: "Session expired — please log in again." });
  }

  // A JWT is valid for 30 days regardless of what happens to the account in
  // the meantime, so an archived account's existing token has to be checked
  // against the DB on every request -- otherwise "archive" wouldn't actually
  // cut anyone off until their token happened to expire on its own.
  if (pool) {
    try {
      const { rows } = await pool.query("SELECT archived_at FROM users WHERE id = $1", [req.user.id]);
      if (rows.length && rows[0].archived_at) {
        return res.status(401).json({ error: "This account has been archived." });
      }
    } catch (err) {
      console.error("requireAuth: failed to check archived status:", err.message);
      // Fail open -- a DB hiccup here shouldn't lock out every logged-in user.
    }
  }
  next();
}
