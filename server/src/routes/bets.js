import { Router } from "express";
import { pool, ensureSchema } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { getScoresForSport } from "../services/oddsService.js";

const router = Router();
router.use(requireAuth);

// Log a new pick. Body: { sport, gameId, homeTeam, awayTeam, market, side,
// point, price, stake, commenceTime }
router.post("/", async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: "Bet tracking isn't available yet." });
    await ensureSchema();

    const {
      sport, gameId, homeTeam, awayTeam, market, side,
      point = null, price, stake = 1, commenceTime = null,
    } = req.body || {};

    if (!sport || !gameId || !market || !side || price === undefined) {
      return res.status(400).json({ error: "Missing required fields for this pick." });
    }

    const { rows } = await pool.query(
      `INSERT INTO bets (user_id, sport, game_id, home_team, away_team, market, side, point, price, stake, commence_time)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [req.user.id, sport, gameId, homeTeam || null, awayTeam || null, market, side, point, price, stake, commenceTime]
    );
    res.json({ bet: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save that pick." });
  }
});

// List this user's picks, auto-grading any pending ones whose games have
// finished, plus a running record (W-L-P) and ROI summary.
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
  return { wins: 0, losses: 0, pushes: 0, pending: 0, staked: 0, profit: 0, roi: null };
}

async function autoGradePending(bets) {
  const pending = bets.filter((b) => b.result === "pending");
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
    if (bet.result !== "pending") return bet;
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

function computeRecord(bets) {
  const rec = emptyRecord();
  for (const b of bets) {
    if (b.result === "pending") { rec.pending++; continue; }
    const stake = Number(b.stake) || 0;
    rec.staked += stake;
    if (b.result === "win") {
      rec.wins++;
      const price = Number(b.price);
      const profit = price > 0 ? stake * (price / 100) : stake * (100 / Math.abs(price));
      rec.profit += profit;
    } else if (b.result === "loss") {
      rec.losses++;
      rec.profit -= stake;
    } else if (b.result === "push") {
      rec.pushes++;
    }
  }
  rec.profit = Math.round(rec.profit * 100) / 100;
  rec.roi = rec.staked > 0 ? Math.round((rec.profit / rec.staked) * 1000) / 10 : null;
  return rec;
}

export default router;
