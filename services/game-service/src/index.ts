import express from "express";

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

// Start accepting requests.
app.listen(PORT, () => {
  console.log(`Game Service running at http://localhost:${PORT}`);
});