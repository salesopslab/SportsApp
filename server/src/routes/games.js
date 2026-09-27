import { Router } from "express";
import { getOddsForSport, getScoresForSport } from "../services/oddsService.js";
import { getOpeningSpreads } from "../services/snapshotService.js";

const router = Router();

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
// The provider's own "last updated" timestamp turned out not to be a
// reliable stand-in for "when the game ended" — it can stay fresh well after
// a game is actually over, which let old final games linger past their
// 24-hour window. Instead we approximate the end time as kickoff + a
// generous max game length (covers overtime), then give it 24 more hours.
// It's a slightly looser cutoff than a true end-time would give, but it's
// deterministic and never has to guess based on data we can't trust.
const MAX_GAME_LENGTH_MS = 5 * 60 * 60 * 1000; // 5 hours, generous even with OT
const FINAL_WINDOW_MS = 24 * 60 * 60 * 1000 + MAX_GAME_LENGTH_MS;

function pastFinalWindow(commenceTime, now) {
  return now - new Date(commenceTime).getTime() > FINAL_WINDOW_MS;
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
          if (pastFinalWindow(g.commenceTime, now)) return null; // finished too long ago
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
    // to the same 24-hour final window) so the board reflects every game
    // that's actually done, not just the ones a book still has posted.
    const seenIds = new Set(enriched.map((g) => g.id));
    const backfilled = Object.entries(scores)
      .filter(([id, s]) => {
        if (seenIds.has(id) || !s.completed || !s.homeTeam || !s.awayTeam) return false;
        return !pastFinalWindow(s.commenceTime, now);
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
