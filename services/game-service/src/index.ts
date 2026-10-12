import express from "express";
import { redis } from "./config/redis.js";


const app = express();
const PORT = 3001;

// Allow the server to read JSON request bodies.
app.use(express.json());

// Check whether the Game Service is running.
app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    service: "game-service",
  });
});

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