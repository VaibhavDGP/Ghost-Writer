import { useState, type FormEvent } from "react";
import GameArtwork from "./GameArtwork";

interface Props {
  theme: "light" | "dark";
  busy: "create" | "join" | null;
  notice: {
    kind: "success" | "error";
    text: string;
  } | null;
  onToggleTheme: () => void;
  onSubmit: (
    event: FormEvent<HTMLFormElement>,
    action: "create" | "join",
  ) => void;
}

export default function EntryScreen({
  theme,
  busy,
  notice,
  onToggleTheme,
  onSubmit,
}: Props) {
  const [mode, setMode] = useState<"create" | "join">("create");

  return (
    <main className="page-shell game-entry">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            {"</>"}
          </span>
          <span>GHOST WRITER</span>
        </div>

        <button
          className="theme-toggle"
          type="button"
          onClick={onToggleTheme}
          aria-label={`Switch to ${
            theme === "light" ? "dark" : "light"
          } mode`}
        >
          {theme === "light" ? "DARK MODE" : "LIGHT MODE"}
        </button>
      </header>

      <div className="game-entry-layout">
        <section className="game-entry-hero" aria-labelledby="entry-title">
          <p className="game-kicker">
            <span aria-hidden="true" />
            2–8 PLAYERS · SOCIAL DEDUCTION
          </p>

          <h1 id="entry-title">
            GHOST
            <span>WRITER<span className="title-dot">.</span></span>
          </h1>

          <p className="game-tagline">
            Good code. Bad company.
          </p>

          <GameArtwork />

          <div className="game-hero-footer">
            <span className="game-orbit-mark" aria-hidden="true">✦</span>
            <span>TRUST IS THE REAL BUG.</span>
          </div>
        </section>

        <section className="game-boarding" aria-label="Create or join a room">
          <div className="game-boarding-heading">
            <span className="game-section-number" aria-hidden="true">01</span>
            <div>
              <p className="game-kicker">YOUR NEXT MATCH</p>
              <h2>Get your crew together.</h2>
            </div>
          </div>

          <div className="game-mode-switch" aria-label="Room action">
            <button
              type="button"
              className={mode === "create" ? "is-selected" : ""}
              aria-pressed={mode === "create"}
              disabled={busy !== null}
              onClick={() => setMode("create")}
            >
              Create a room
            </button>

            <button
              type="button"
              className={mode === "join" ? "is-selected" : ""}
              aria-pressed={mode === "join"}
              disabled={busy !== null}
              onClick={() => setMode("join")}
            >
              Join a room
            </button>
          </div>

          <form
            className="game-entry-form"
            onSubmit={(event) => onSubmit(event, mode)}
          >
            <label htmlFor="entry-name">What should we call you?</label>
            <input
              id="entry-name"
              name="displayName"
              type="text"
              maxLength={40}
              placeholder="Your player name"
              autoComplete="nickname"
              disabled={busy !== null}
              required
            />

            {mode === "join" ? (
              <>
                <label htmlFor="room-code">Room code</label>
                <input
                  id="room-code"
                  className="room-code-input"
                  name="roomCode"
                  type="text"
                  minLength={6}
                  maxLength={6}
                  placeholder="A1B2C3"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy !== null}
                  onChange={(event) => {
                    event.currentTarget.value = event.currentTarget.value
                      .toUpperCase()
                      .replace(/[^0-9A-F]/g, "")
                      .slice(0, 6);
                  }}
                  required
                />
              </>
            ) : (
              <p className="game-form-hint">
                Create a room, share the code, and bring your friends.
              </p>
            )}

            <button
              className={`action-button ${
                mode === "create" ? "primary-button" : "secondary-button"
              }`}
              type="submit"
              disabled={busy !== null}
            >
              <span>
                {busy
                  ? mode === "create" ? "CREATING…" : "JOINING…"
                  : mode === "create" ? "CREATE ROOM" : "JOIN ROOM"}
              </span>
              <span aria-hidden="true">↗</span>
            </button>
          </form>

          {notice && (
            <div
              className={`notice notice-${notice.kind}`}
              role={notice.kind === "error" ? "alert" : "status"}
            >
              {notice.text}
            </div>
          )}

          <p className="game-boarding-footer">
            <span aria-hidden="true">✦</span>
            Every crew has a story. Yours starts here.
          </p>
        </section>
      </div>
    </main>
  );
}