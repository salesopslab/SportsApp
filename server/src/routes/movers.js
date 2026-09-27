import { Router } from "express";
import { getTopMovers } from "../services/snapshotService.js";
import { getOddsForSport } from "../services/oddsService.js";

const router = Router();

function marketLabel(m) {
  if (m.market === "moneyline") return `${m.side} moneyline`;
  if (m.market === "total") return `Total (${m.side})`;
  return `${m.side} spread`;
}

function formatPrice(p) {
  if (p === null || p === undefined) return "—";
  return p > 0 ? "+" + p : String(p);
}

function movementSummary(m) {
  if (m.market === "moneyline") {
    return `${formatPrice(m.startPrice)} → ${formatPrice(m.endPrice)}`;
  }
  return `${m.startPoint ?? "—"} (${formatPrice(m.startPrice)}) → ${m.endPoint ?? "—"} (${formatPrice(m.endPrice)})`;
}

// GET /api/movers?limit=3&minutes=60 — the games with the biggest line moves
// in the given window, across every sport, restricted to games that haven't
// started yet (a move on a game already underway isn't actionable).
router.get("/", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 3, 10);
  const minutes = Math.min(Number(req.query.minutes) || 60, 24 * 60);

  try {
    const { available, reason, movers } = await getTopMovers({ limit: limit * 3, sinceMinutes: minutes });
    if (!available) {
      return res.json({ available: false, reason: reason || "Not available yet.", movers: [] });
    }

    // Enrich with team names/kickoff time from live odds, one fetch per
    // distinct sport represented (each call is cheap — cached ~90s already).
    const sportsNeeded = [...new Set(movers.map((m) => m.sport))];
    const gamesBySport = {};
    await Promise.all(
      sportsNeeded.map(async (sport) => {
        gamesBySport[sport] = await getOddsForSport(sport).catch(() => []);
      })
    );

    const now = Date.now();
    const enriched = movers
      .map((m) => {
        const games = gamesBySport[m.sport] || [];
        const game = games.find((g) => g.id === m.gameId);
        if (!game) return null;
        if (new Date(game.commenceTime).getTime() <= now) return null; // already started/finished

        return {
          gameId: m.gameId,
          sport: m.sport,
          homeTeam: game.homeTeam,
          awayTeam: game.awayTeam,
          commenceTime: game.commenceTime,
          book: m.book,
          market: marketLabel(m),
          movement: movementSummary(m),
          score: Math.round(m.score * 10) / 10,
          firstSeen: m.firstSeen,
          lastSeen: m.lastSeen,
        };
      })
      .filter(Boolean)
      .slice(0, limit);

    res.json({ available: true, minutes, movers: enriched });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Failed to load top movers", detail: err.message });
  }
});

export default router;
