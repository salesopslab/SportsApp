import { Router } from "express";
import { getOddsForSport } from "../services/oddsService.js";
import { getLineHistory } from "../services/snapshotService.js";

const router = Router();

// GET /api/line-history/:sport/:gameId — opening vs. current line per
// market/side for one game, built from snapshots recorded over time.
router.get("/:sport/:gameId", async (req, res) => {
  const { sport, gameId } = req.params;
  try {
    const games = await getOddsForSport(sport);
    const game = games.find((g) => g.id === gameId);
    if (!game) return res.status(404).json({ error: "Game not found" });

    const history = await getLineHistory(gameId, game.lineTrackingBook);
    res.json(history);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Failed to load line history", detail: err.message });
  }
});

export default router;
