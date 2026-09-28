import { Router } from "express";
import { pool, ensureSchema } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { withTier, requireTier } from "../middleware/tier.js";
import { meetsTier } from "../services/tierService.js";
import { getScoresForSport } from "../services/oddsService.js";

const router = Router();
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// Bet tracking itself (add/list/edit/settle/delete) is a Basic/free feature
// -- just needs an account, no subscription. withTier runs after requireAuth
// so every route below also has req.tier/req.userRow available for the
// Edge/Edge Pro analytics gating further down, without hard-blocking the
// basic routes.
router.use(requireAuth);
router.use(withTier);

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
//
// `record` (win/loss/push/pending counts, plus per-bet dollar figures on
// each bet in `bets`) is Basic/free -- a useful tracker has to show your
// record and your own bets' profit/loss without a paywall. `access` tells
// the frontend which Edge/Edge Pro analytics it's allowed to render (Net
// P/L, ROI, performance breakdowns, bankroll, AI insights); those are
// computed by the frontend from the same `bets` array but gated behind
// `access.edge`/`access.edgePro` in the UI, and `bankroll` here is the one
// piece that has to come from the server either way, since it's a stored
// per-user setting.
router.get("/", async (req, res) => {
  try {
    const access = {
      tier: req.tier || "none",
      edge: meetsTier(req.userRow, "edge"),
      edgePro: meetsTier(req.userRow, "edge_pro"),
    };
    if (!pool) return res.json({ bets: [], record: emptyRecord(), access, bankroll: null });
    await ensureSchema();

    const { rows } = await pool.query(
      "SELECT * FROM bets WHERE user_id = $1 ORDER BY created_at DESC",
      [req.user.id]
    );

    const graded = await autoGradePending(rows);
    const record = computeRecord(graded);

    let bankroll = null;
    if (access.edge) {
      const startingBankroll = req.userRow?.starting_bankroll != null ? Number(req.userRow.starting_bankroll) : null;
      bankroll = {
        startingBankroll,
        currentBankroll: startingBankroll != null ? round2(startingBankroll + record.profit) : null,
      };
    }

    res.json({ bets: graded, record, access, bankroll });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load your picks." });
  }
});

// Set (or clear) the starting bankroll bankroll tracking is measured
// against. Edge feature -- Basic tracking works fine without it.
// Body: { startingBankroll: number|null }
router.patch("/bankroll", requireTier("edge"), async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: "Bet tracking isn't available yet." });
    const { startingBankroll } = req.body || {};
    if (startingBankroll !== null && !(Number(startingBankroll) >= 0)) {
      return res.status(400).json({ error: "Enter a starting bankroll of $0 or more." });
    }
    await pool.query("UPDATE users SET starting_bankroll = $1 WHERE id = $2", [
      startingBankroll,
      req.user.id,
    ]);
    res.json({ startingBankroll: startingBankroll === null ? null : Number(startingBankroll) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save your bankroll." });
  }
});

// AI analysis of the user's betting history -- Edge Pro. Grounded the same
// way the matchup chat is (chat.js): only reason over a real, computed
// summary of this user's own bets, say plainly when a category (live vs.
// pregame, CLV) isn't tracked yet rather than guessing, never invent a
// number. Returns the computed summary too, so the UI has real stat
// callouts to show even independent of the AI prose.
router.get("/insights", requireTier("edge_pro"), async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: "Bet tracking isn't available yet." });
    await ensureSchema();

    const { rows } = await pool.query(
      "SELECT * FROM bets WHERE user_id = $1 AND result != 'pending' ORDER BY settled_at ASC",
      [req.user.id]
    );

    if (rows.length < 5) {
      return res.json({
        insights: null,
        summary: null,
        reason: "Settle at least 5 bets to unlock AI analysis of your betting history.",
      });
    }

    const summary = buildInsightsSummary(rows);

    if (!ANTHROPIC_KEY) {
      return res.json({ insights: null, summary, reason: "AI analysis isn't configured yet." });
    }

    const systemPrompt = `You are BetEdge AI's betting-history analyst. Analyze ONLY the BET_HISTORY_SUMMARY JSON provided -- a real, computed summary of this one user's own settled bets. Never invent a number, a sport, or a pattern not present in it.

Voice: professional, concise, specific -- like a short analyst note, not hype. No emojis, no guarantees, no "lock"/"smash" language.

Rules:
- If a category has fewer than 3 settled bets (see each bucket's "count"), don't draw a conclusion from it -- say there's not enough sample size yet.
- The summary's "liveVsPregame" and "clv" fields are always { "available": false } -- BetEdge AI doesn't capture that data yet. If asked about it or if it seems relevant, say plainly it isn't tracked yet. Never estimate it.
- Cite real numbers from the summary (ROI%, profit, record) for every claim.
- 3-5 short bullet points plus one closing takeaway sentence. Reference specific sports/bet-type combos by name, the way a real analyst note would (e.g. "+8.4% ROI on MLB moneylines but -11.2% on parlays").
- End with one concrete, specific suggestion grounded in the data (e.g. reduce volume on a leaking category, or lean into a strong one) -- never generic bankroll-management advice not tied to this user's own numbers.

BET_HISTORY_SUMMARY:
${JSON.stringify(summary, null, 2)}`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 700,
        temperature: 0.3,
        system: systemPrompt,
        messages: [{ role: "user", content: "Analyze my betting history." }],
      }),
    });

    if (!response.ok) {
      throw new Error(`Anthropic API error ${response.status}: ${await response.text()}`);
    }
    const data = await response.json();
    const text = data.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    res.json({ insights: text, summary });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Failed to generate insights", detail: err.message });
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

// --- AI insights (Edge Pro) --------------------------------------------

// Win/loss/push/cashed-out counts plus dollar staked/profit/ROI for one
// bucket of settled bets. Only bets with a real wager_amount count toward
// the dollar figures (same rule as computeRecord) -- a units-only legacy
// pick still counts toward the bucket's win/loss counts, just not its ROI.
function bucketStats(bets) {
  let staked = 0, profit = 0, wins = 0, losses = 0, pushes = 0, cashedOut = 0;
  for (const b of bets) {
    if (b.result === "win") wins++;
    else if (b.result === "loss") losses++;
    else if (b.result === "push") pushes++;
    else if (b.result === "cashed_out") cashedOut++;

    const wager = b.wager_amount != null ? Number(b.wager_amount) : null;
    if (!wager) continue;
    if (b.result === "win") {
      staked += wager;
      profit += americanPayout(wager, b.price).toWin;
    } else if (b.result === "loss") {
      staked += wager;
      profit -= wager;
    } else if (b.result === "cashed_out" && b.cash_out_amount != null) {
      staked += wager;
      profit += Number(b.cash_out_amount) - wager;
    }
  }
  return {
    count: bets.length, wins, losses, pushes, cashedOut,
    staked: round2(staked), profit: round2(profit),
    roi: staked > 0 ? Math.round((profit / staked) * 1000) / 10 : null,
  };
}

function groupBy(bets, keyFn) {
  const groups = {};
  for (const b of bets) {
    const key = keyFn(b);
    if (!key) continue; // bets that don't fit this dimension (e.g. custom bets have no home/away) are left out, not miscounted
    (groups[key] = groups[key] || []).push(b);
  }
  const out = {};
  for (const [k, arr] of Object.entries(groups)) out[k] = bucketStats(arr);
  return out;
}

// Everything the Edge Pro AI-insights prompt reasons over -- a real,
// computed summary of this one user's settled bets, grouped every way the
// product spec's example insights need (by sport, by bet type, the two
// combined, favorite vs. underdog, home vs. away, and streaks). liveVsPregame
// and clv are always { available: false } since BetEdge AI doesn't capture
// that data yet -- included explicitly so the model states that plainly
// instead of guessing, the same grounding discipline chat.js uses.
function buildInsightsSummary(bets) {
  const overall = bucketStats(bets);
  const bySport = groupBy(bets, (b) => (b.sport || "").toLowerCase());
  const byBetType = groupBy(bets, (b) => b.market || "other");
  const bySportAndType = groupBy(bets, (b) => `${(b.sport || "").toLowerCase()}_${b.market || "other"}`);

  const favoriteVsUnderdog = groupBy(bets, (b) => {
    if (b.market === "moneyline") return Number(b.price) < 0 ? "favorite" : "underdog";
    if (b.market === "spread") return Number(b.point) < 0 ? "favorite" : "underdog";
    return null; // totals/custom/props have no favorite/underdog concept
  });

  const homeVsAway = groupBy(bets, (b) => {
    if (!b.home_team || !b.away_team) return null; // custom bets carry no team data
    if (b.side === b.home_team) return "home";
    if (b.side === b.away_team) return "away";
    return null;
  });

  // Streaks only count decided (win/loss) results -- a push or cash-out
  // doesn't break or extend a streak either way, the usual tracker convention.
  const decided = bets.filter((b) => b.result === "win" || b.result === "loss");
  let longestWinStreak = 0, longestLossStreak = 0, curType = null, curLen = 0;
  for (const b of decided) {
    curLen = b.result === curType ? curLen + 1 : 1;
    curType = b.result;
    if (curType === "win") longestWinStreak = Math.max(longestWinStreak, curLen);
    else longestLossStreak = Math.max(longestLossStreak, curLen);
  }
  const currentStreak = decided.length ? { result: curType, length: curLen } : null;

  return {
    overall,
    bySport,
    byBetType,
    bySportAndType,
    favoriteVsUnderdog,
    homeVsAway,
    streaks: { longestWinStreak, longestLossStreak, current: currentStreak },
    liveVsPregame: { available: false },
    clv: { available: false },
  };
}

export default router;
