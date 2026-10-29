import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";

// Keep this after App and the existing styles.
import "./GameTheme.css";

// Apply the saved theme before the first React render.
try {
  document.documentElement.dataset.theme =
    localStorage.getItem("ghostWriterTheme") === "dark"
      ? "dark"
      : "light";
} catch {
  document.documentElement.dataset.theme = "light";
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);