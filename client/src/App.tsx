import { useEffect, useState, type FormEvent } from "react";
import "./App.css";

type Theme = "light" | "dark";
type Action = "create" | "join";

interface RoomApiResponse {
  room?: {
    code?: string;
  };
  playerId?: string;
  error?: string;
}

interface Notice {
  kind: "success" | "error";
  text: string;
}

function getSessionToken(): string {
  const existingToken = window.sessionStorage.getItem("ghostWriterSessionToken");

  if (existingToken) {
    return existingToken;
  }

  const bytes = new Uint8Array(32);
  window.crypto.getRandomValues(bytes);

  const token = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

  window.sessionStorage.setItem("ghostWriterSessionToken", token);
  return token;
}

function App() {
  const [theme, setTheme] = useState<Theme>(() => {
    return window.localStorage.getItem("ghostWriterTheme") === "dark"
      ? "dark"
      : "light";
  });
  const [busy, setBusy] = useState<Action | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [roomCode, setRoomCode] = useState<string | null>(null);
  const [roomRole, setRoomRole] = useState<Action | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("ghostWriterTheme", theme);
  }, [theme]);

  async function submitRoom(
    event: FormEvent<HTMLFormElement>,
    action: Action,
  ) {
    event.preventDefault();
    setNotice(null);
    setRoomCode(null);
    setRoomRole(null);
    setCopied(false);
    setBusy(action);

    const formData = new FormData(event.currentTarget);
    const displayName = String(formData.get("displayName") ?? "").trim();
    const sessionToken = getSessionToken();

    if (!displayName) {
      setNotice({ kind: "error", text: "Enter your player name first." });
      setBusy(null);
      return;
    }

    const code = String(formData.get("roomCode") ?? "")
      .trim()
      .toUpperCase();

    if (action === "join" && !/^[0-9A-F]{6}$/.test(code)) {
      setNotice({ kind: "error", text: "Enter the six-character room code." });
      setBusy(null);
      return;
    }

    try {
      const response = await fetch(
        action === "create" ? "/rooms" : `/rooms/${code}/join`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            action === "create"
              ? { displayName, sessionToken }
              : {
                  displayName,
                  sessionToken,
                  requestId: window.crypto.randomUUID(),
                },
          ),
        },
      );

      const result = (await response.json()) as RoomApiResponse;

      if (!response.ok) {
        throw new Error(result.error ?? "The room request failed.");
      }

      if (!result.room?.code || !result.playerId) {
        throw new Error("The server returned an incomplete room response.");
      }

      const joinedCode = result.room.code;

      window.sessionStorage.setItem("ghostWriterRoomCode", joinedCode);
      window.sessionStorage.setItem("ghostWriterPlayerId", result.playerId);

      setRoomRole(action);
      setRoomCode(joinedCode);
    } catch (error) {
      setNotice({
        kind: "error",
        text:
          error instanceof Error
            ? error.message
            : "Could not reach the game server.",
      });
    } finally {
      setBusy(null);
    }
  }

  async function copyRoomCode() {
    if (!roomCode) return;

    try {
      await window.navigator.clipboard.writeText(roomCode);
      setCopied(true);
    } catch {
      setCopied(false);
      setNotice({
        kind: "error",
        text: "Copy failed. Select the room code and copy it manually.",
      });
    }
  }

  function toggleTheme() {
    setTheme(theme === "light" ? "dark" : "light");
  }

  if (roomCode) {
    return (
      <main className="page-shell">
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
              ROOM LOBBY
            </span>
            <button
              className="theme-toggle"
              type="button"
              onClick={toggleTheme}
              aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
            >
              {theme === "light" ? "◐ DARK" : "☼ LIGHT"}
            </button>
          </div>
        </header>

        <section className="intro">
          <div className="intro-copy">
            <p className="eyebrow">ROOM CREATED / CREW ASSEMBLING</p>
            <h1>
              You’re in.
              <br />
              <span>Gather your crew.</span>
            </h1>
            <p className="intro-description">
              {roomRole === "create"
                ? "You’re hosting this room. Share the code so your crew can join."
                : "You’ve joined the room. Share the code with your crew if they still need it."}
            </p>
          </div>

          <aside className="brief-card">
            <div className="brief-topline">
              <span>ROOM STATUS</span>
              <span className="brief-index">OPEN</span>
            </div>
            <div className="brief-rule" />
            <p className="brief-label">NEXT STEP</p>
            <p className="brief-text">
              Share your room code.
              <br />
              Wait for your crew.
            </p>
            <div className="brief-bottom">
              <span className="brief-square" />
              <span>THE ROOM IS READY</span>
            </div>
          </aside>
        </section>

        <section className="room-desk" aria-label="Room lobby">
          <div className="desk-heading">
            <span className="desk-number">02</span>
            <h2>Your room is ready</h2>
            <span className="desk-caption">Invite your crew</span>
          </div>

          <div className="room-code-result">
            <div>
              <p className="result-label">YOUR ROOM CODE</p>
              <p className="result-code">{roomCode}</p>
            </div>
            <button
              className="copy-button"
              type="button"
              onClick={() => void copyRoomCode()}
            >
              {copied ? "COPIED ✓" : "COPY CODE"}
            </button>
          </div>

          <p className="form-note">
            Waiting for players to join. Keep this page open.
          </p>

          {notice && (
            <div
              className={`notice notice-${notice.kind}`}
              role={notice.kind === "error" ? "alert" : "status"}
            >
              <span className="notice-icon" aria-hidden="true">
                {notice.kind === "error" ? "!" : "✓"}
              </span>
              <span>{notice.text}</span>
            </div>
          )}
        </section>

        <footer className="footer">
          <span>GHOST WRITER / BUILD 001</span>
          <span>NO ONE DEBUGS ALONE</span>
        </footer>
      </main>
    );
  }

  return (
    <main className="page-shell">
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
            MULTIPLAYER DEBUGGING
          </span>
          <button
            className="theme-toggle"
            type="button"
            onClick={toggleTheme}
            aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
          >
            {theme === "light" ? "◐ DARK" : "☼ LIGHT"}
          </button>
        </div>
      </header>

      <section className="intro">
        <div className="intro-copy">
          <p className="eyebrow">A game of bugs, teamwork, and betrayal</p>
          <h1>
            Find the bug.
            <br />
            <span>Find the ghost.</span>
          </h1>
          <p className="intro-description">
            Work together to repair the code before time runs out. One player
            has a different plan.
          </p>

          <div className="round-stamp" aria-label="Two to eight players">
            <span>2–8</span>
            <small>PLAYERS</small>
          </div>
        </div>

        <aside className="brief-card">
          <div className="brief-topline">
            <span>ROUND BRIEF</span>
            <span className="brief-index">NO. 001</span>
          </div>
          <div className="brief-rule" />
          <p className="brief-label">YOUR OBJECTIVE</p>
          <p className="brief-text">
            Debug the code.
            <br />
            Trust your crew.
            <br />
            Watch for sabotage.
          </p>
          <div className="brief-bottom">
            <span className="brief-square" />
            <span>THE BUILD IS UNSTABLE</span>
          </div>
        </aside>
      </section>

      <section className="room-desk" aria-label="Room options">
        <div className="desk-heading">
          <span className="desk-number">01</span>
          <h2>Get your crew together</h2>
          <span className="desk-caption">Choose your entry point</span>
        </div>

        <div className="forms-grid">
          <form
            className="room-form create-form"
            onSubmit={(event) => void submitRoom(event, "create")}
          >
            <div className="form-title-row">
              <span className="form-glyph" aria-hidden="true">
                +
              </span>
              <h3>Start a new room</h3>
            </div>
            <label htmlFor="create-name">Player name</label>
            <input
              id="create-name"
              name="displayName"
              type="text"
              maxLength={40}
              placeholder="What should we call you?"
              autoComplete="nickname"
              required
            />
            <button
              className="action-button primary-button"
              type="submit"
              disabled={busy !== null}
            >
              {busy === "create" ? "SETTING UP ROOM…" : "CREATE ROOM"}
              <span aria-hidden="true">↗</span>
            </button>
            <p className="form-note">
              You’ll host the room and invite the rest.
            </p>
          </form>

          <div className="form-divider" aria-hidden="true">
            <span>OR</span>
          </div>

          <form
            className="room-form join-form"
            onSubmit={(event) => void submitRoom(event, "join")}
          >
            <div className="form-title-row">
              <span className="form-glyph join-glyph" aria-hidden="true">
                ↳
              </span>
              <h3>Join your crew</h3>
            </div>
            <label htmlFor="join-name">Player name</label>
            <input
              id="join-name"
              name="displayName"
              type="text"
              maxLength={40}
              placeholder="What should we call you?"
              autoComplete="nickname"
              required
            />
            <label htmlFor="room-code">Room code</label>
            <input
              id="room-code"
              className="room-code-input"
              name="roomCode"
              type="text"
              maxLength={6}
              placeholder="A1B2C3"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                event.currentTarget.value = event.currentTarget.value
                  .toUpperCase()
                  .replace(/[^0-9A-F]/g, "")
                  .slice(0, 6);
              }}
              required
            />
            <button
              className="action-button secondary-button"
              type="submit"
              disabled={busy !== null}
            >
              {busy === "join" ? "JOINING ROOM…" : "JOIN ROOM"}
              <span aria-hidden="true">→</span>
            </button>
          </form>
        </div>

        {notice && (
          <div
            className={`notice notice-${notice.kind}`}
            role={notice.kind === "error" ? "alert" : "status"}
          >
            <span className="notice-icon" aria-hidden="true">
              {notice.kind === "error" ? "!" : "✓"}
            </span>
            <span>{notice.text}</span>
          </div>
        )}
      </section>

      <footer className="footer">
        <span>GHOST WRITER / BUILD 001</span>
        <span>NO ONE DEBUGS ALONE</span>
      </footer>
    </main>
  );
}

export default App;