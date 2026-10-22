import express from "express";
import { redis } from "./config/redis.js";
import { submitRouter } from "./routes/submit-routes.js";
import { roomRouter } from "./routes/room-routes.js";
import { runRouter } from "./routes/run-routes.js";
import { replayRouter } from "./routes/replay-routes.js";
import { sabotageRouter } from "./routes/sabotage-routes.js";
import { clockRouter } from "./routes/clock-routes.js";

const app = express();
const PORT = 3001;

// Allow the code draft plus JSON escaping overhead.
// The run endpoint separately enforces a 64 KiB source limit.
app.use(express.json({ limit: "512kb" }));

app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    service: "game-service",
  });
});

app.use("/rooms", roomRouter);
app.use("/rooms", runRouter);
app.use("/rooms", submitRouter);
app.use("/rooms", replayRouter);
app.use("/rooms", sabotageRouter);
app.use("/rooms", clockRouter);

async function startServer() {
  await redis.connect();

  console.log("Connected to Redis");

  app.listen(PORT, () => {
    console.log(
      `Game Service running at http://localhost:${PORT}`,
    );
  });
}

startServer().catch((error) => {
  console.error("Failed to start Game Service:", error);
  process.exit(1);
});