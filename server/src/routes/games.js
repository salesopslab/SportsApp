import { Router } from "express";
import { getOddsForSport, getScoresForSport, oddsRetrievedAt } from "../services/oddsService.js";
import { getOpeningSpreads } from "../services/snapshotService.js";
import { getTeamRankings, lookupRankLabel, isDivisionGame, getProbablePitchers, lookupPitchers, getLiveGameState, lookupLiveState } from "../services/statsService.js";
import { withTier } from "../middleware/tier.js";
import { meetsTier } from "../services/tierService.js";

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

// GET /api/games/:sport  -> odds board data for the Board screen. The board
// itself (odds, scores, rankings) stays free for everyone, logged in or not —
// withTier just tells us who's asking so we can decide below whether to
// include the Edge-gated opening-line comparison.
router.get("/:sport", withTier, async (req, res) => {
  try {
    const sport = req.params.sport;
    const season = req.query.season || "2026";
    const [games, scores, rankings, pitchers, liveState] = await Promise.all([
      getOddsForSport(sport),
      getScoresForSport(sport).catch(() => ({})), // scores are a nice-to-have, never block the board
      getTeamRankings(sport, season).catch(() => ({})), // same — a ranking miss shouldn't block the board
      getProbablePitchers(sport, season).catch(() => ({})), // MLB only; empty map for every other sport
      getLiveGameState(sport).catch(() => ({})), // quarter/inning/clock for live rows; empty map on any hiccup
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
        lineTrackingBook: null,
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
    // This "opened vs. current" comparison is part of line tracking, which is
    // an Edge+ feature — Standard sees odds/board only, no opening line.
    const upcoming = enriched.filter((g) => g.status === "upcoming");
    const includeOpeningLines = meetsTier(req.userRow, "standard");
    const openingBySide = includeOpeningLines
      ? await getOpeningSpreads(sport, upcoming.map((g) => g.id)).catch(() => ({}))
      : {};
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

    // Division/conference standing (NFL/NBA/MLB) or AP poll rank (CFB/CBB),
    // attached to every game regardless of status — a ranking is a fact about
    // the team, not about this particular game's state.
    const withRanks = [...withOpening, ...nonUpcoming, ...backfilled].map((g) => {
      const pitcherInfo = lookupPitchers(sport, pitchers, g.homeTeam, g.awayTeam, g.commenceTime);
      return {
        ...g,
        homeRank: lookupRankLabel(sport, rankings, g.homeTeam),
        awayRank: lookupRankLabel(sport, rankings, g.awayTeam),
        divisionGame: isDivisionGame(sport, rankings, g.homeTeam, g.awayTeam),
        homePitcher: pitcherInfo?.homePitcher || null,
        awayPitcher: pitcherInfo?.awayPitcher || null,
        // Season W-L and ERA for each starter: { wins, losses, era, season } or null.
        homePitcherStats: pitcherInfo?.homePitcherStats || null,
        awayPitcherStats: pitcherInfo?.awayPitcherStats || null,
        // Quarter/inning, clock, down-distance-or-balls-strikes-outs — only
        // ever populated for status === "live" rows; null otherwise (or when
        // the provider doesn't have this game's live state yet).
        liveState: g.status === "live" ? lookupLiveState(sport, liveState, g.homeTeam, g.awayTeam) : null,
      };
    });

    // When these odds were actually pulled from the provider (they're cached
    // up to ~30 min) — powers the Board's "● Live • Updated 3m ago" pill.
    res.json({ sport, games: withRanks, oddsRetrievedAt: oddsRetrievedAt(sport), servedAt: new Date().toISOString() });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Failed to fetch odds", detail: err.message });
  }
});

export default router;
