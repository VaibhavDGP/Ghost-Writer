import express from "express";
import { redis } from "./config/redis.js";
import { roomRouter } from "./routes/room-routes.js";

const app = express();
const PORT = 3001;

app.use(express.json());

app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    service: "game-service",
  });
});

app.use("/rooms", roomRouter);

async function startServer() {
  await redis.connect();
  console.log("Connected to Redis");

  app.listen(PORT, () => {
    console.log(`Game Service running at http://localhost:${PORT}`);
  });
}

startServer().catch((error) => {
  console.error("Failed to start Game Service:", error);
  process.exit(1);
});