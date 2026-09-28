import { Router } from "express";
import { pool, ensureSchema } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { getScoresForSport } from "../services/oddsService.js";

const router = Router();
router.use(requireAuth);

const VALID_SETTLE_RESULTS = new Set(["win", "loss", "push", "cashed_out"]);

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// Standard American-odds payout math — the one formula used everywhere a
// dollar figure is shown: potential return on a still-pending bet, and
// realized profit on a settled one.
function americanPayout(wagerAmount, price) {
  const wager = Number(wagerAmount);
  const p = Number(price);
  if (!(wager > 0) || !p) return { toWin: 0, totalReturn: 0 };
  const toWin = p > 0 ? wager * (p / 100) : wager * (100 / Math.abs(p));
  return { toWin: round2(toWin), totalReturn: round2(wager + toWin) };
}

function isValidAmericanOdds(price) {
  const p = Number(price);
  return Number.isFinite(p) && Number.isInteger(p) && Math.abs(p) >= 100;
}

// Log a new pick — either a BetEdge pick (tracked off a real game/line we
// show, betSource: "betedge_pick", the default) or a custom bet the person
// placed somewhere else entirely (betSource: "custom"). BetEdge AI never
// accepts or holds the wager itself; this only ever records what the person
// says they bet elsewhere.
//
// Body: { betSource, sport, gameId, homeTeam, awayTeam, market, side, point,
//         price, wagerAmount, stake, commenceTime,
//         eventLabel, betTypeLabel, lineLabel, betDate }
router.post("/", async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: "Bet tracking isn't available yet." });
    await ensureSchema();

    const {
      betSource = "betedge_pick",
      sport, gameId, homeTeam, awayTeam, market, side,
      point = null, price, stake = 1, wagerAmount = null,
      commenceTime = null,
      eventLabel = null, betTypeLabel = null, lineLabel = null, betDate = null,
    } = req.body || {};

    if (!isValidAmericanOdds(price)) {
      return res.status(400).json({ error: "Enter valid American odds (e.g. -110 or +150)." });
    }
    if (wagerAmount !== null && wagerAmount !== undefined && !(Number(wagerAmount) > 0)) {
      return res.status(400).json({ error: "Wager amount must be greater than $0." });
    }

    let finalGameId = gameId || null;
    let finalMarket = market;
    let finalSide = side;

    if (betSource === "custom") {
      if (!sport) return res.status(400).json({ error: "Sport is required." });
      if (!eventLabel && !(homeTeam && awayTeam)) {
        return res.status(400).json({ error: "Enter the event/game." });
      }
      if (!betTypeLabel) return res.status(400).json({ error: "Enter what you bet on." });
      if (!(Number(wagerAmount) > 0)) {
        return res.status(400).json({ error: "Enter a wager amount." });
      }
      // Custom bets aren't tied to a real game we track odds/scores for, so
      // there's nothing to auto-grade against — give it a synthetic id
      // that's guaranteed unique and obviously not a real game.
      finalGameId = `custom-${req.user.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      finalMarket = "custom";
      finalSide = betTypeLabel;
    } else {
      if (!sport || !gameId || !market || !side) {
        return res.status(400).json({ error: "Missing required fields for this pick." });
      }
    }

    const { rows } = await pool.query(
      `INSERT INTO bets (
         user_id, sport, game_id, home_team, away_team, market, side, point, price, stake,
         commence_time, bet_source, wager_amount, event_label, bet_type_label, line_label, bet_date
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING *`,
      [
        req.user.id, sport, finalGameId, homeTeam || null, awayTeam || null,
        finalMarket, finalSide, point, price, stake,
        commenceTime, betSource, wagerAmount, eventLabel, betTypeLabel, lineLabel,
        betDate || null,
      ]
    );
    res.json({ bet: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save that bet." });
  }
});

// List this user's bets, auto-grading any pending BetEdge picks whose games
// have finished, plus a running record/P&L summary.
router.get("/", async (req, res) => {
  try {
    if (!pool) return res.json({ bets: [], record: emptyRecord() });
    await ensureSchema();

    const { rows } = await pool.query(
      "SELECT * FROM bets WHERE user_id = $1 ORDER BY created_at DESC",
      [req.user.id]
    );

    const graded = await autoGradePending(rows);
    const record = computeRecord(graded);
    res.json({ bets: graded, record });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load your picks." });
  }
});

// Edit a not-yet-settled bet: attach/change its dollar wager amount, or
// correct the line/odds to match what the person actually got at their own
// sportsbook (the board's number can move after they tracked it). Also how
// an old units-only pick gets a real dollar wager attached later.
// Body: { wagerAmount, price, point }
router.patch("/:id", async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: "Bet tracking isn't available yet." });
    const { wagerAmount, price, point } = req.body || {};

    const sets = [];
    const values = [];
    let i = 1;

    if (wagerAmount !== undefined) {
      if (wagerAmount !== null && !(Number(wagerAmount) > 0)) {
        return res.status(400).json({ error: "Wager amount must be greater than $0." });
      }
      sets.push(`wager_amount = $${i++}`);
      values.push(wagerAmount);
    }
    if (price !== undefined) {
      if (!isValidAmericanOdds(price)) {
        return res.status(400).json({ error: "Enter valid American odds (e.g. -110 or +150)." });
      }
      sets.push(`price = $${i++}`);
      values.push(price);
    }
    if (point !== undefined) {
      sets.push(`point = $${i++}`);
      values.push(point);
    }
    if (!sets.length) return res.status(400).json({ error: "Nothing to update." });

    values.push(req.params.id, req.user.id);
    const { rows } = await pool.query(
      `UPDATE bets SET ${sets.join(", ")} WHERE id = $${i++} AND user_id = $${i} AND result = 'pending' RETURNING *`,
      values
    );
    if (!rows.length) {
      return res.status(404).json({ error: "Pick not found, or it's already settled." });
    }
    res.json({ bet: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update that pick." });
  }
});

// Settle a bet by hand: Won / Lost / Push / Cashed Out. BetEdge picks tied
// to a real game are usually auto-graded (see autoGradePending below) once
// that game finishes, but this covers custom bets (which have nothing to
// auto-grade against), cash-outs (always manual — we have no way to know
// what a sportsbook actually paid out early), and correcting an auto-grade.
// Body: { result, cashOutAmount }
router.post("/:id/settle", async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: "Bet tracking isn't available yet." });
    const { result, cashOutAmount } = req.body || {};

    if (!VALID_SETTLE_RESULTS.has(result)) {
      return res.status(400).json({ error: "Invalid result." });
    }
    if (result === "cashed_out" && !(Number(cashOutAmount) >= 0)) {
      return res.status(400).json({ error: "Enter the amount you actually got back." });
    }

    const { rows } = await pool.query(
      `UPDATE bets
         SET result = $1, settled_at = now(), cash_out_amount = $2
       WHERE id = $3 AND user_id = $4
       RETURNING *`,
      [result, result === "cashed_out" ? cashOutAmount : null, req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Pick not found." });
    res.json({ bet: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to settle that pick." });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: "Bet tracking isn't available yet." });
    await pool.query("DELETE FROM bets WHERE id = $1 AND user_id = $2", [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to remove that pick." });
  }
});

// --- helpers ---------------------------------------------------------------

function emptyRecord() {
  return {
    wins: 0, losses: 0, pushes: 0, cashedOut: 0, pending: 0,
    staked: 0, profit: 0, roi: null,
    atRisk: 0, potentialReturn: 0,
  };
}

async function autoGradePending(bets) {
  // Custom (off-platform) bets have a synthetic game id and no real odds
  // data behind them — there's nothing to auto-grade, so they're left out
  // of the score lookup entirely and only ever settled by hand.
  const pending = bets.filter((b) => b.result === "pending" && b.bet_source !== "custom");
  if (!pending.length) return bets;

  const sports = [...new Set(pending.map((b) => b.sport))];
  const scoresBySport = {};
  await Promise.all(
    sports.map(async (sport) => {
      try {
        scoresBySport[sport] = await getScoresForSport(sport);
      } catch {
        scoresBySport[sport] = {};
      }
    })
  );

  const toUpdate = [];
  const result = bets.map((bet) => {
    if (bet.result !== "pending" || bet.bet_source === "custom") return bet;
    const score = scoresBySport[bet.sport]?.[bet.game_id];
    if (!score || !score.completed || score.homeScore === null || score.awayScore === null) {
      return bet; // game hasn't finished (or we don't have a final score) yet
    }
    const outcome = gradeBet(bet, score);
    if (outcome) {
      toUpdate.push({ id: bet.id, outcome });
      return { ...bet, result: outcome, settled_at: new Date().toISOString() };
    }
    return bet;
  });

  if (toUpdate.length && pool) {
    await Promise.all(
      toUpdate.map(({ id, outcome }) =>
        pool.query("UPDATE bets SET result = $1, settled_at = now() WHERE id = $2", [outcome, id])
      )
    );
  }
  return result;
}

// Grades one bet against a final score. Returns 'win' | 'loss' | 'push', or
// null if we don't have enough info (e.g. missing home/away team on an old
// bet) to grade it confidently — it's left pending rather than guessed at.
function gradeBet(bet, score) {
  const home = Number(score.homeScore);
  const away = Number(score.awayScore);
  if (Number.isNaN(home) || Number.isNaN(away)) return null;

  if (bet.market === "total") {
    const total = home + away;
    const line = Number(bet.point);
    if (Number.isNaN(line)) return null;
    if (total === line) return "push";
    const overWins = total > line;
    return (bet.side === "Over") === overWins ? "win" : "loss";
  }

  if (!bet.home_team || !bet.away_team) return null;
  const sideIsHome = bet.side === bet.home_team;
  const sideIsAway = bet.side === bet.away_team;
  if (!sideIsHome && !sideIsAway) return null;

  const sideScore = sideIsHome ? home : away;
  const oppScore = sideIsHome ? away : home;

  if (bet.market === "moneyline") {
    if (sideScore === oppScore) return "push";
    return sideScore > oppScore ? "win" : "loss";
  }

  if (bet.market === "spread") {
    const point = Number(bet.point) || 0;
    const adjusted = sideScore + point;
    if (adjusted === oppScore) return "push";
    return adjusted > oppScore ? "win" : "loss";
  }

  return null;
}

// Dollar figures (Net P/L, ROI, at-risk, potential return) only ever
// aggregate bets that actually have a wager_amount attached. A legacy
// units-only pick (wager_amount null) still counts toward the W-L-P record,
// same as always, but is left out of every dollar total rather than being
// guessed at — exactly the "units-only pick" behavior asked for.
function computeRecord(bets) {
  const rec = emptyRecord();
  for (const b of bets) {
    const wager = b.wager_amount != null ? Number(b.wager_amount) : null;

    if (b.result === "pending") {
      rec.pending++;
      if (wager) {
        rec.atRisk += wager;
        rec.potentialReturn += americanPayout(wager, b.price).totalReturn;
      }
      continue;
    }

    if (wager) rec.staked += wager;

    if (b.result === "win") {
      rec.wins++;
      if (wager) rec.profit += americanPayout(wager, b.price).toWin;
    } else if (b.result === "loss") {
      rec.losses++;
      if (wager) rec.profit -= wager;
    } else if (b.result === "push") {
      rec.pushes++;
      // no P/L change — the wager isn't at risk or profit, it just doesn't
      // count toward staked either, since nothing was actually won or lost.
      if (wager) rec.staked -= wager;
    } else if (b.result === "cashed_out") {
      rec.cashedOut++;
      if (wager && b.cash_out_amount != null) {
        rec.profit += Number(b.cash_out_amount) - wager;
      }
    }
  }
  rec.profit = round2(rec.profit);
  rec.staked = round2(rec.staked);
  rec.atRisk = round2(rec.atRisk);
  rec.potentialReturn = round2(rec.potentialReturn);
  rec.roi = rec.staked > 0 ? Math.round((rec.profit / rec.staked) * 1000) / 10 : null;
  return rec;
}

export default router;
