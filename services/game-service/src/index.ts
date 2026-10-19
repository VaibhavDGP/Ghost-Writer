import express from "express";
import { redis } from "./config/redis.js";
import { roomRouter } from "./routes/room-routes.js";
import { runRouter } from "./routes/run-routes.js";

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