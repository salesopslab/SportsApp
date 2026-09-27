import { pool, ensureSchema } from "../db.js";

/**
 * The Odds API returns your account's usage on every response via headers:
 *   x-requests-remaining, x-requests-used, x-requests-last (credits this call cost)
 * Recording these piggybacks on calls oddsService already makes — it never
 * triggers an extra request of its own, so watching usage costs nothing.
 * A no-op if no DATABASE_URL is configured, same as the rest of the app's
 * optional history features.
 */
export async function recordApiUsage({ remaining, used, last }) {
  if (!pool) return;
  if (remaining === null && used === null && last === null) return;
  try {
    await ensureSchema();
    await pool.query(
      `INSERT INTO odds_api_usage (requests_remaining, requests_used, requests_last) VALUES ($1, $2, $3)`,
      [remaining, used, last]
    );
  } catch (err) {
    console.error("recordApiUsage failed:", err.message);
  }
}

/** The most recent usage snapshot we've recorded, if any. */
export async function getLatestUsage() {
  if (!pool) {
    return { available: false, reason: "No database connected yet." };
  }
  try {
    await ensureSchema();
    const { rows } = await pool.query(
      `SELECT requests_remaining, requests_used, requests_last, recorded_at
       FROM odds_api_usage ORDER BY recorded_at DESC LIMIT 1`
    );
    if (!rows.length) {
      return { available: true, hasData: false };
    }
    return { available: true, hasData: true, latest: rows[0] };
  } catch (err) {
    console.error("getLatestUsage failed:", err.message);
    return { available: false, reason: "Usage lookup failed." };
  }
}

/** Usage snapshots from the last `hours` hours, oldest first — for a burn-rate chart. */
export async function getUsageHistory(hours = 48) {
  if (!pool) {
    return { available: false, reason: "No database connected yet.", history: [] };
  }
  try {
    await ensureSchema();
    const { rows } = await pool.query(
      `SELECT requests_remaining, requests_used, requests_last, recorded_at
       FROM odds_api_usage
       WHERE recorded_at >= now() - ($1 * interval '1 hour')
       ORDER BY recorded_at ASC`,
      [hours]
    );
    return { available: true, history: rows };
  } catch (err) {
    console.error("getUsageHistory failed:", err.message);
    return { available: false, reason: "Usage history lookup failed.", history: [] };
  }
}
