import "dotenv/config";
import express from "express";
import cors from "cors";
import gamesRouter from "./routes/games.js";
import dossierRouter from "./routes/dossier.js";
import chatRouter from "./routes/chat.js";
import lineHistoryRouter from "./routes/lineHistory.js";

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use("/api/games", gamesRouter);
app.use("/api/dossier", dossierRouter);
app.use("/api/chat", chatRouter);
app.use("/api/line-history", lineHistoryRouter);

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`BetEdge AI backend running on :${port}`);
});
