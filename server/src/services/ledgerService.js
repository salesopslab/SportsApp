// Writes to the public picks ledger, shared by the token-protected API and
// the built-in pickers so both follow exactly the same rules.
import { pool, ensureSchema } from "../db.js";
import { PICKERS, PICKER_ALIASES, CONFIDENCES, SPORTS, impliedProb, validOdds, unitsFor, toPublic } from "./picksService.js";

// Validate one incoming pick. Returns { value } or { error }.
export function cleanPick(p, now = Date.now()) {
  if (!p || typeof p !== "object") return { error: "Pick must be an object." };
  const rawPicker = String(p.picker || "").trim();
  const picker = PICKER_ALIASES[rawPicker] || rawPicker;
  if (!PICKERS.includes(picker)) return { error: `picker must be one of: ${PICKERS.join(", ")}.` };
  const sport = String(p.sport || "").toLowerCase().trim();
  if (!SPORTS.includes(sport)) return { error: `sport must be one of: ${SPORTS.join(", ")}.` };
  const game = String(p.game || "").trim();
  if (!game || game.length > 200) return { error: "game is required (e.g. \"Dallas Cowboys @ Kansas City Chiefs\")." };
  const kickoff = new Date(p.kickoff_at);
  if (!Number.isFinite(kickoff.getTime())) return { error: "kickoff_at must be an ISO date-time." };
  const bet = String(p.bet || "").trim();
  if (!bet || bet.length > 120) return { error: "bet is required (e.g. \"Denver Broncos +3\")." };
  if (!validOdds(p.odds)) return { error: "odds must be whole American odds like -110 or +150." };
  const confidence = String(p.confidence || "").trim();
  if (!CONFIDENCES.includes(confidence)) return { error: "confidence must be Low, Medium or High." };
  const reason = String(p.reason || "").trim();
  if (!reason || reason.length > 2000) return { error: "reason is required." };
  if (now >= kickoff.getTime()) return { error: "Pick rejected: it must be posted before kickoff." };
  const gameId = p.game_id ? String(p.game_id).slice(0, 100) : null;
  return { value: { picker, sport, game, gameId, kickoff: kickoff.toISOString(), bet, odds: Number(p.odds), implied: impliedProb(p.odds), confidence, reason } };
}

// Save one pick. Idempotent on (picker, game, bet, kickoff_at).
// Returns { status: "created" | "duplicate" | "rejected", pick?, error? }.
export async function savePick(raw) {
  const { value: v, error } = cleanPick(raw);
  if (error) return { status: "rejected", error };
  await ensureSchema();
  try {
    const ins = await pool.query(
      `INSERT INTO picks (picker, sport, game, game_id, kickoff_at, bet, odds, implied_prob, confidence, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (picker, game, bet, kickoff_at) DO NOTHING RETURNING *`,
      [v.picker, v.sport, v.game, v.gameId, v.kickoff, v.bet, v.odds, v.implied.toFixed(4), v.confidence, v.reason]
    );
    if (ins.rows.length) return { status: "created", pick: toPublic(ins.rows[0]) };
    const { rows } = await pool.query("SELECT * FROM picks WHERE picker=$1 AND game=$2 AND bet=$3 AND kickoff_at=$4", [v.picker, v.game, v.bet, v.kickoff]);
    return { status: "duplicate", pick: rows[0] ? toPublic(rows[0]) : null };
  } catch (err) {
    // The DB's own before-kickoff check is the last line of defence.
    return { status: "rejected", error: /picks_before_kickoff/.test(err.message) ? "Pick rejected: it must be posted before kickoff." : err.message };
  }
}

// Grade one pending pick. Units are computed here, never trusted from input.
export async function gradePick({ id, result, closing_odds }) {
  id = Number(id);
  result = String(result || "").toLowerCase();
  if (!Number.isInteger(id) || id <= 0) return { status: "rejected", error: "id is required." };
  if (!["win", "loss", "push", "void"].includes(result)) return { id, status: "rejected", error: "result must be win, loss, push or void." };
  if (closing_odds != null && !validOdds(closing_odds)) return { id, status: "rejected", error: "closing_odds must be American odds like -115." };
  await ensureSchema();
  const { rows: cur } = await pool.query("SELECT * FROM picks WHERE id=$1", [id]);
  if (!cur.length) return { id, status: "rejected", error: "No pick with that id." };
  if (cur[0].result !== "pending") return { id, status: "rejected", error: `Pick ${id} is already graded (${cur[0].result}) and can't be changed.` };
  try {
    const { rows } = await pool.query(
      `UPDATE picks SET result=$2, units=$3, closing_odds=$4, graded_at=now() WHERE id=$1 AND result='pending' RETURNING *`,
      [id, result, unitsFor(result, cur[0].odds), closing_odds == null ? null : Number(closing_odds)]
    );
    if (!rows.length) return { id, status: "rejected", error: `Pick ${id} is already graded and can't be changed.` };
    return { id, status: "graded", pick: toPublic(rows[0]) };
  } catch (err) {
    return { id, status: "rejected", error: err.message };
  }
}

// Who can see picks before kickoff: anyone who bought the current Hot
// Picks bundle (bundles last 24 hours from when they were generated).
export async function hasPickAccess(userId) {
  if (!pool || !userId) return false;
  await ensureSchema();
  const { rows } = await pool.query(
    `SELECT 1 FROM hot_pick_purchases hp JOIN hot_pick_days d ON d.id = hp.hot_pick_day_id
     WHERE hp.user_id = $1 AND d.generated_at > now() - interval '24 hours' LIMIT 1`,
    [userId]
  );
  return rows.length > 0;
}

export { CONFIDENCES };
