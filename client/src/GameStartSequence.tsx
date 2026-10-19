import { useEffect, useState } from "react";
import "./GameStartSequence.css";

type GameRole = "CODER" | "HACKER";

interface Props {
  roomCode: string;
  countdownEndsAt?: number;
  theme: "light" | "dark";
  onToggleTheme: () => void;
}

interface RoleResponse {
  role?: GameRole;
  countdownEndsAt?: number;
  error?: string;
}

function GameStartSequence({
  roomCode,
  countdownEndsAt,
  theme,
  onToggleTheme,
}: Props) {
  const [now, setNow] = useState(Date.now());
  const [role, setRole] = useState<GameRole | null>(null);
  const [typedText, setTypedText] = useState("");
  const [revealComplete, setRevealComplete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fullscreenNote, setFullscreenNote] = useState<string | null>(null);

  useEffect(() => {
    const intervalId = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    if (!role) return;

    const message =
      role === "HACKER" ? "You are a Hacker" : "You Are A Coder";
    let characterIndex = 0;
    let holdTimeout = 0;

    setTypedText("");
    setRevealComplete(false);

    const typingInterval = window.setInterval(() => {
      characterIndex += 1;
      setTypedText(message.slice(0, characterIndex));

      if (characterIndex >= message.length) {
        window.clearInterval(typingInterval);
        holdTimeout = window.setTimeout(() => {
          setRevealComplete(true);
        }, 5000);
      }
    }, 75);

    return () => {
      window.clearInterval(typingInterval);
      window.clearTimeout(holdTimeout);
    };
  }, [role]);

  const secondsLeft =
    typeof countdownEndsAt === "number"
      ? Math.max(0, Math.ceil((countdownEndsAt - now) / 1000))
      : null;

  async function enterFullscreenAndReveal() {
    setBusy(true);
    setError(null);
    setFullscreenNote(null);

    if (document.fullscreenEnabled && !document.fullscreenElement) {
      try {
        await document.documentElement.requestFullscreen();
      } catch {
        setFullscreenNote(
          "Fullscreen was declined or unavailable. You can still continue.",
        );
      }
    }

    try {
      const sessionToken = window.sessionStorage.getItem(
        "ghostWriterSessionToken",
      );

      if (!sessionToken) {
        throw new Error("Your player session was not found. Rejoin the room.");
      }

      const remainingMs =
        typeof countdownEndsAt === "number"
          ? Math.max(0, countdownEndsAt - Date.now())
          : 0;

      if (remainingMs > 0) {
        await new Promise((resolve) => window.setTimeout(resolve, remainingMs));
      }

      const response = await fetch(`/rooms/${roomCode}/me/role`, {
        headers: {
          Authorization: `Bearer ${sessionToken}`,
        },
        cache: "no-store",
      });
      const result = (await response.json()) as RoleResponse;

      if (!response.ok) {
        throw new Error(result.error ?? "Could not retrieve your role.");
      }

      if (result.role !== "CODER" && result.role !== "HACKER") {
        throw new Error("The server returned an invalid role.");
      }

      setRole(result.role);
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Could not reach the game server.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (role) {
    return (
      <main
        className={`role-reveal ${
          role === "HACKER" ? "role-hacker" : "role-coder"
        }`}
        aria-live="assertive"
      >
        {!revealComplete ? (
          <p className="role-message">
            {typedText}
            <span className="typing-cursor" aria-hidden="true">
              _
            </span>
          </p>
        ) : (
          <div className="role-finished">
            <p className="role-message">{typedText}</p>
            <p className="role-caption">
              Role revealed. Your game workspace is next.
            </p>
          </div>
        )}
      </main>
    );
  }

  const countdownFinished = secondsLeft === 0;

  return (
    <main className="page-shell start-sequence-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Ghost Writer home">
          <span className="brand-mark" aria-hidden="true">
            GW
          </span>
          <span>GHOST WRITER</span>
        </a>

        <div className="topbar-right">
          <span className="online-mark">
            <span className="online-dot" />
            GAME STARTING
          </span>
          <button
            className="theme-toggle"
            type="button"
            onClick={onToggleTheme}
            aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
          >
            {theme === "light" ? "◐ DARK" : "☼ LIGHT"}
          </button>
        </div>
      </header>

      <section className="intro">
        <div className="intro-copy">
          <p className="eyebrow">
            {countdownFinished ? "COUNTDOWN COMPLETE" : "GET READY"}
          </p>
          <h1>
            {countdownFinished ? (
              <>
                Your role
                <br />
                <span>is waiting.</span>
              </>
            ) : (
              <>
                Game starts in
                <br />
                <span className="countdown-number">
                  {secondsLeft === null ? "…" : secondsLeft}
                </span>
              </>
            )}
          </h1>
          <p className="intro-description">
            {countdownFinished
              ? "Enter fullscreen to reveal your role."
              : "The crew is locked in. Get ready for the reveal."}
          </p>

          {countdownFinished && (
            <button
              className="action-button primary-button sequence-button"
              type="button"
              onClick={() => void enterFullscreenAndReveal()}
              disabled={busy}
            >
              {busy ? "PREPARING YOUR REVEAL…" : "ENTER FULLSCREEN & REVEAL"}
              <span aria-hidden="true">↗</span>
            </button>
          )}

          {fullscreenNote && (
            <p className="form-note" role="status">
              {fullscreenNote}
            </p>
          )}

          {error && (
            <div className="notice notice-error" role="alert">
              <span className="notice-icon" aria-hidden="true">
                !
              </span>
              <span>{error}</span>
            </div>
          )}
        </div>

        <aside className="brief-card">
          <div className="brief-topline">
            <span>ROOM</span>
            <span className="brief-index">{roomCode}</span>
          </div>
          <div className="brief-rule" />
          <p className="brief-label">WHAT HAPPENS NEXT</p>
          <p className="brief-text">
            Fullscreen.
            <br />
            Role reveal.
            <br />
            Then debug.
          </p>
          <div className="brief-bottom">
            <span className="brief-square" />
            <span>TRUST NO ONE</span>
          </div>
        </aside>
      </section>

      <footer className="footer">
        <span>GHOST WRITER / BUILD 001</span>
        <span>NO ONE DEBUGS ALONE</span>
      </footer>
    </main>
  );
}

export default GameStartSequence;