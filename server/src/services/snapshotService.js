import { pool, ensureSchema } from "../db.js";

/**
 * Persist a snapshot of every book's current line for a batch of games, so we
 * can show real line movement over time (e.g. "opened -3, now -3.5"). This is
 * a no-op if no DATABASE_URL is configured — it never blocks or breaks the
 * odds response either way.
 *
 * Only called when oddsService actually fetches fresh data from the provider
 * (a cache miss), so in practice a snapshot lands roughly every
 * CACHE_TTL_SECONDS while there's real traffic on the app.
 */
export async function recordSnapshot(sportSlug, games) {
  if (!pool) return;
  try {
    await ensureSchema();

    const rows = [];
    for (const game of games) {
      for (const b of game.allBooks || []) {
        for (const o of b.moneyline || []) {
          rows.push([sportSlug, game.id, b.book, "moneyline", o.name, null, o.price]);
        }
        for (const o of b.spread || []) {
          rows.push([sportSlug, game.id, b.book, "spread", o.name, o.point ?? null, o.price]);
        }
        for (const o of b.total || []) {
          rows.push([sportSlug, game.id, b.book, "total", o.name, o.point ?? null, o.price]);
        }
      }
    }
    if (!rows.length) return;

    const values = [];
    const placeholders = rows
      .map((r, i) => {
        const base = i * 7;
        values.push(...r);
        return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7})`;
      })
      .join(",");

    await pool.query(
      `INSERT INTO odds_snapshots (sport, game_id, book, market, side, point, price) VALUES ${placeholders}`,
      values
    );
  } catch (err) {
    // Never let history recording break the actual odds/dossier response.
    console.error("recordSnapshot failed:", err.message);
  }
}

/**
 * Returns line-movement history for one game: per market/side, the earliest
 * ("opening") value we've recorded vs. the most recent ("current") one.
 * Prefers the primary book's own history (apples-to-apples comparison);
 * falls back to whatever book has data if the primary book doesn't yet.
 */
export async function getLineHistory(gameId, primaryBook) {
  if (!pool) {
    return {
      available: false,
      reason:
        "No database connected yet — line-movement tracking needs a DATABASE_URL configured.",
    };
  }

  try {
    await ensureSchema();
    const { rows } = await pool.query(
      `SELECT book, market, side, point, price, captured_at
       FROM odds_snapshots
       WHERE game_id = $1
       ORDER BY captured_at ASC`,
      [gameId]
    );

    if (!rows.length) {
      return {
        available: true,
        hasHistory: false,
        note: "No snapshots recorded for this game yet — check back after the odds refresh a few times.",
      };
    }

    const bookRows = primaryBook ? rows.filter((r) => r.book === primaryBook) : rows;
    const useRows = bookRows.length ? bookRows : rows;
    const bookUsed = bookRows.length ? primaryBook : useRows[0].book;

    const groups = {};
    for (const r of useRows) {
      const key = `${r.market}:${r.side || ""}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(r);
    }

    const summary = Object.entries(groups).map(([key, pts]) => {
      const [market, side] = key.split(":");
      const open = pts[0];
      const current = pts[pts.length - 1];
      const pointNum = (v) => (v === null || v === undefined ? null : Number(v));
      return {
        market,
        side: side || null,
        openPoint: pointNum(open.point),
        openPrice: open.price,
        currentPoint: pointNum(current.point),
        currentPrice: current.price,
        moved: String(open.point) !== String(current.point) || open.price !== current.price,
        firstSeen: open.captured_at,
        lastSeen: current.captured_at,
        dataPoints: pts.length,
      };
    });

    return { available: true, hasHistory: true, book: bookUsed, summary };
  } catch (err) {
    console.error("getLineHistory failed:", err.message);
    return { available: false, reason: "Line history lookup failed." };
  }
}

/**
 * Returns each game's opening spread (the earliest recorded point per side)
 * for a batch of games in one query — used to show "opened -6.5" alongside
 * the current line on the Board, so a move is visible without opening the
 * full breakdown. Keyed by game_id, then by side (team name).
 *
 * This takes the single earliest snapshot per (game, side) regardless of
 * which book recorded it — a reasonable approximation for a compact card;
 * the dossier's full line-movement view is the one that pins everything to
 * one book for an apples-to-apples comparison.
 */
export async function getOpeningSpreads(sportSlug, gameIds) {
  if (!pool || !gameIds || !gameIds.length) return {};
  try {
    await ensureSchema();
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (game_id, side) game_id, side, point, captured_at
       FROM odds_snapshots
       WHERE sport = $1 AND market = 'spread' AND game_id = ANY($2)
       ORDER BY game_id, side, captured_at ASC`,
      [sportSlug, gameIds]
    );
    const byGame = {};
    for (const r of rows) {
      if (!byGame[r.game_id]) byGame[r.game_id] = {};
      byGame[r.game_id][r.side] = r.point === null ? null : Number(r.point);
    }
    return byGame;
  } catch (err) {
    console.error("getOpeningSpreads failed:", err.message);
    return {};
  }
}

/**
 * Finds the games whose lines have moved the most in the last `sinceMinutes`
 * minutes, across every sport. For each (game, market, side, book) we compare
 * the earliest snapshot in that window to the latest snapshot overall, then
 * score the movement so point moves (spread/total) and price moves
 * (moneyline) can be compared on the same scale. This is a simple, tunable
 * heuristic, not a precise model:
 *   score = |point change| * 20 + |price change| / 5
 * A game's overall score is its single biggest single-market move — not a
 * sum across markets/books, so one book's noise doesn't drown out a real move.
 *
 * Returns up to `limit` games, each tagged with the sport/gameId so the
 * caller can look up display info (teams, kickoff time) from live odds.
 */
export async function getTopMovers({ limit = 3, sinceMinutes = 60 } = {}) {
  if (!pool) {
    return {
      available: false,
      reason: "No database connected yet — line-movement tracking needs a DATABASE_URL configured.",
      movers: [],
    };
  }

  try {
    await ensureSchema();
    const { rows } = await pool.query(
      `
      SELECT DISTINCT ON (game_id, market, side, book)
        game_id, sport, market, side, book,
        first_value(point) OVER w AS start_point,
        first_value(price) OVER w AS start_price,
        last_value(point) OVER w AS end_point,
        last_value(price) OVER w AS end_price,
        first_value(captured_at) OVER w AS start_time,
        last_value(captured_at) OVER w AS end_time
      FROM odds_snapshots
      WHERE captured_at >= now() - ($1 * interval '1 minute')
      WINDOW w AS (
        PARTITION BY game_id, market, side, book
        ORDER BY captured_at ASC
        RANGE BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
      )
      `,
      [sinceMinutes]
    );

    const byGame = new Map();
    for (const r of rows) {
      const pointDelta = Math.abs(Number(r.end_point ?? 0) - Number(r.start_point ?? 0));
      const priceDelta = Math.abs(Number(r.end_price ?? 0) - Number(r.start_price ?? 0));
      if (pointDelta === 0 && priceDelta === 0) continue; // no movement, skip

      const score = pointDelta * 20 + priceDelta / 5;
      const existing = byGame.get(r.game_id);
      if (!existing || score > existing.score) {
        byGame.set(r.game_id, {
          gameId: r.game_id,
          sport: r.sport,
          score,
          market: r.market,
          side: r.side,
          book: r.book,
          startPoint: r.start_point === null ? null : Number(r.start_point),
          startPrice: r.start_price,
          endPoint: r.end_point === null ? null : Number(r.end_point),
          endPrice: r.end_price,
          firstSeen: r.start_time,
          lastSeen: r.end_time,
        });
      }
    }

    const movers = [...byGame.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return { available: true, movers };
  } catch (err) {
    console.error("getTopMovers failed:", err.message);
    return { available: false, reason: "Top movers lookup failed.", movers: [] };
  }
}
