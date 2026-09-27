import { Router } from "express";
import { getOddsForSport, getScoresForSport } from "../services/oddsService.js";
import { getOpeningSpreads } from "../services/snapshotService.js";

const router = Router();

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// A live/final game only stays on the board through the rest of its UTC
// calendar day — a flat "hours since kickoff" buffer (the previous approach)
// had to guess at a game's length, and on a high-volume slate like MLB
// (multiple games a day, every day) that guess let finished games linger
// noticeably longer than "today" for anyone watching. "Commenced today"
// is simple, deterministic, and matches what "still showing old games"
// actually means: something that didn't happen today.
function commencedToday(commenceTime, now) {
  const c = new Date(commenceTime);
  const n = new Date(now);
  return (
    c.getUTCFullYear() === n.getUTCFullYear() &&
    c.getUTCMonth() === n.getUTCMonth() &&
    c.getUTCDate() === n.getUTCDate()
  );
}

// GET /api/games/:sport  -> odds board data for the Board screen
router.get("/:sport", async (req, res) => {
  try {
    const sport = req.params.sport;
    const [games, scores] = await Promise.all([
      getOddsForSport(sport),
      getScoresForSport(sport).catch(() => ({})), // scores are a nice-to-have, never block the board
    ]);

    const now = Date.now();
    const enriched = games
      .map((g) => {
        const commence = new Date(g.commenceTime).getTime();
        const started = commence <= now;
        if (!started) {
          // Only show what's coming up in the next 7 days — a book will
          // sometimes post odds on a game weeks out, which isn't useful on
          // a "what's happening soon" board.
          if (commence - now > SEVEN_DAYS_MS) return null;
          return { ...g, status: "upcoming" };
        }

        const score = scores[g.id];
        if (score && score.completed) {
          if (!commencedToday(g.commenceTime, now)) return null; // finished on a previous day
          return {
            ...g,
            status: "final",
            finalScore: { home: score.homeScore, away: score.awayScore },
          };
        }
        if (score && (score.homeScore !== null || score.awayScore !== null)) {
          return {
            ...g,
            status: "live",
            liveScore: { home: score.homeScore, away: score.awayScore },
          };
        }
        // Started, but we have no score data for it (too old for the scores
        // window, or the provider hasn't posted it yet) — the odds we'd show
        // are stale and possibly misleading, so drop it from the board.
        return null;
      })
      .filter(Boolean);

    // Sportsbooks often pull a game from /odds the moment it starts (or
    // shortly after) — very common on a busy college football/basketball
    // slate with 40+ games kicking off at once. That means a lot of finished
    // games never show up above at all, even though /scores has their final
    // result. Fill those back in as score-only "final" entries (still capped
    // to games that commenced today) so the board reflects every game that's
    // actually done, not just the ones a book still has posted.
    const seenIds = new Set(enriched.map((g) => g.id));
    const backfilled = Object.entries(scores)
      .filter(([id, s]) => {
        if (seenIds.has(id) || !s.completed || !s.homeTeam || !s.awayTeam) return false;
        return commencedToday(s.commenceTime, now);
      })
      .map(([id, s]) => ({
        id,
        sport: sport,
        commenceTime: s.commenceTime,
        homeTeam: s.homeTeam,
        awayTeam: s.awayTeam,
        primaryBook: null,
        moneyline: [],
        spread: [],
        total: [],
        allBooks: [],
        status: "final",
        finalScore: { home: s.homeScore, away: s.awayScore },
      }));

    // Attach each upcoming game's opening spread so the Board can show
    // "current vs. opened" without a trip to the full breakdown. Only
    // upcoming games actually display a spread card, so that's all we look up.
    const upcoming = enriched.filter((g) => g.status === "upcoming");
    const openingBySide = await getOpeningSpreads(
      sport,
      upcoming.map((g) => g.id)
    ).catch(() => ({}));
    const withOpening = upcoming.map((g) => {
      const sides = openingBySide[g.id];
      if (!sides) return g;
      return {
        ...g,
        openingSpread: {
          home: sides[g.homeTeam] ?? null,
          away: sides[g.awayTeam] ?? null,
        },
      };
    });
    const nonUpcoming = enriched.filter((g) => g.status !== "upcoming");

    res.json({ sport, games: [...withOpening, ...nonUpcoming, ...backfilled] });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Failed to fetch odds", detail: err.message });
  }
});

export default router;
