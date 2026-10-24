import { useEffect, useState, type FormEvent } from "react";
import "./App.css";
import GameStartSequence from "./GameStartSequence";
import MatchResults, { type MatchSummary } from "./MatchResults";
import { FullscreenSetup } from "./FullscreenControls";
import {
  clearPendingJoin,
  clearStoredRoom,
  getJoinRequestId,
  roomResponseAction,
} from "./room-session";

type Theme = "light" | "dark";
type Action = "create" | "join";

interface Player {
  id: string;
  displayName: string;
  isReady?: boolean;
}

interface Room {
  code: string;
  hostPlayerId: string;
  phase: "LOBBY" | "IN_PROGRESS" | "RESULTS";
  countdownEndsAt?: number;
  players: Player[];
  maxPlayers: number;
  results?: MatchSummary;
}

interface RoomApiResponse {
  room?: Room;
  playerId?: string;
  error?: string;
}

interface Notice {
  kind: "success" | "error";
  text: string;
}

function getSessionToken(): string {
  const existingToken = window.sessionStorage.getItem("ghostWriterSessionToken");

  if (existingToken && /^[0-9a-f]{64}$/.test(existingToken)) {
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
  const [lobbyError, setLobbyError] = useState<string | null>(null);
  const [roomCode, setRoomCode] = useState<string | null>(() =>
    window.sessionStorage.getItem("ghostWriterRoomCode"),
  );
  const [playerId, setPlayerId] = useState<string | null>(() =>
    window.sessionStorage.getItem("ghostWriterPlayerId"),
  );
  const [room, setRoom] = useState<Room | null>(null);
  const [copied, setCopied] = useState(false);
  const [lobbyBusy, setLobbyBusy] = useState<"ready" | "start" | "leave" | null>(
    null,
  );

  function clearLocalRoom() {
    clearStoredRoom(window.sessionStorage);
    setRoomCode(null);
    setPlayerId(null);
    setRoom(null);
    setLobbyError(null);
    setCopied(false);
  }

  function returnToEntry() {
    clearLocalRoom();
    setNotice(null);
  }

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("ghostWriterTheme", theme);
  }, [theme]);

    useEffect(() => {
    if (!roomCode) return;

    const token = window.sessionStorage.getItem(
      "ghostWriterSessionToken",
    );

    if (!token || !/^[0-9a-f]{64}$/.test(token)) {
      clearLocalRoom();
      setNotice({
        kind: "error",
        text: "Your saved player session is missing. Please join again.",
      });
      return;
    }

    let stopped = false;
    let inFlight = false;
    let controller: AbortController | null = null;

    async function refreshRoom() {
      if (stopped || inFlight) return;
      inFlight = true;

      const requestController = new AbortController();
      controller = requestController;

      const timeout = window.setTimeout(() => {
        requestController.abort();
      }, 8000);

      try {
        const response = await fetch(
          `/rooms/${encodeURIComponent(roomCode!)}/presence`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
            },
            cache: "no-store",
            signal: requestController.signal,
          },
        );

        const result = (await response.json()) as RoomApiResponse;

        if (stopped) return;

        if (
          response.status === 401 ||
          roomResponseAction(response.status) === "closed"
        ) {
          stopped = true;
          clearLocalRoom();

          setNotice({
            kind: "error",
            text:
              result.error ??
              "Your room session ended. Please join again.",
          });
          return;
        }

        if (!response.ok) {
          throw new Error(
            result.error ?? "Could not reconnect to the room.",
          );
        }

        if (!result.room || !result.playerId) {
          throw new Error(
            "The server returned incomplete room details.",
          );
        }

        // The server restores the authenticated identity.
        // A refresh never creates a replacement player.
        window.sessionStorage.setItem(
          "ghostWriterPlayerId",
          result.playerId,
        );

        setPlayerId(result.playerId);
        setRoom(result.room);
        setLobbyError(null);
      } catch (error) {
        if (!stopped) {
          const message =
            error instanceof Error &&
            error.name !== "AbortError"
              ? error.message
              : "Could not reach the game server.";

          setLobbyError(
            `${message} Reconnecting… Your slot is held for 60 seconds after the last successful connection.`,
          );
        }
      } finally {
        window.clearTimeout(timeout);
        inFlight = false;

        if (controller === requestController) {
          controller = null;
        }
      }
    }

    function reconnect() {
      if (document.visibilityState === "visible") {
        void refreshRoom();
      }
    }

    void refreshRoom();

    const interval = window.setInterval(() => {
      void refreshRoom();
    }, 2000);

    window.addEventListener("online", reconnect);
    window.addEventListener("focus", reconnect);
    document.addEventListener("visibilitychange", reconnect);

    return () => {
      stopped = true;
      window.clearInterval(interval);
      controller?.abort();

      window.removeEventListener("online", reconnect);
      window.removeEventListener("focus", reconnect);
      document.removeEventListener(
        "visibilitychange",
        reconnect,
      );
    };
  }, [roomCode]);

  async function submitRoom(
    event: FormEvent<HTMLFormElement>,
    action: Action,
  ) {
    event.preventDefault();
    setNotice(null);
    setLobbyError(null);
    setRoom(null);
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
                  requestId: getJoinRequestId(
                    window.sessionStorage, code, displayName, sessionToken,
                  ),
                },
          ),
        },
      );

      const result = (await response.json()) as RoomApiResponse;

      if (!response.ok) {
        // Network/5xx failures may have happened after an accepted join.
        if (action === "join" && response.status >= 400 && response.status < 500) {
          clearPendingJoin(window.sessionStorage);
        }
        throw new Error(result.error ?? "The room request failed.");
      }

      if (!result.room?.code || !result.playerId) {
        throw new Error("The server returned an incomplete room response.");
      }

      clearPendingJoin(window.sessionStorage);
      window.sessionStorage.setItem("ghostWriterRoomCode", result.room.code);
      window.sessionStorage.setItem("ghostWriterPlayerId", result.playerId);

      setRoomCode(result.room.code);
      setPlayerId(result.playerId);
      setRoom(result.room);
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
      setLobbyError(null);
    } catch {
      setCopied(false);
      setLobbyError("Copy failed. Select the room code and copy it manually.");
    }
  }

  async function toggleReady() {
    if (!roomCode || !playerId || !room) return;

    const currentPlayer = room.players.find((player) => player.id === playerId);
    if (!currentPlayer) return;

    setLobbyBusy("ready");
    setLobbyError(null);

    try {
      const response = await fetch(`/rooms/${roomCode}/ready`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${getSessionToken()}`,
        },
        body: JSON.stringify({ isReady: !currentPlayer.isReady }),
      });

      const result = (await response.json()) as RoomApiResponse;

      if (!response.ok) {
        throw new Error(result.error ?? "Could not update your ready status.");
      }

      if (result.room) {
        setRoom(result.room);
      }
    } catch (error) {
      setLobbyError(
        error instanceof Error
          ? error.message
          : "Could not reach the game server.",
      );
    } finally {
      setLobbyBusy(null);
    }
  }

  async function startGame() {
    if (!roomCode) return;

    setLobbyBusy("start");
    setLobbyError(null);

    try {
      const response = await fetch(`/rooms/${roomCode}/start`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${getSessionToken()}`,
        },
      });

      const result = (await response.json()) as RoomApiResponse;

      if (!response.ok) {
        throw new Error(result.error ?? "Could not start the game.");
      }

      if (result.room) {
        setRoom(result.room);
      }
    } catch (error) {
      setLobbyError(
        error instanceof Error
          ? error.message
          : "Could not reach the game server.",
      );
    } finally {
      setLobbyBusy(null);
    }
  }

  async function leaveRoom() {
    if (!roomCode) return;

    setLobbyBusy("leave");
    setLobbyError(null);

    try {
      const response = await fetch(`/rooms/${roomCode}/players/me`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${getSessionToken()}`,
        },
      });

      const result = (await response.json()) as { error?: string };

      if (!response.ok && response.status !== 404 && response.status !== 401) {
        throw new Error(result.error ?? "Could not leave the room.");
      }

      clearLocalRoom();
      setNotice(null);
    } catch (error) {
      setLobbyError(
        error instanceof Error
          ? error.message
          : "Could not reach the game server.",
      );
    } finally {
      setLobbyBusy(null);
    }
  }

  function toggleTheme() {
    setTheme(theme === "light" ? "dark" : "light");
  }

  const isHost = Boolean(room && playerId === room.hostPlayerId);
  const guestPlayers =
    room?.players.filter((player) => player.id !== room.hostPlayerId) ?? [];
  const allGuestsReady =
    guestPlayers.length > 0 && guestPlayers.every((player) => player.isReady);
  const canStart = Boolean(
    room &&
      isHost &&
      room.players.length >= 2 &&
      allGuestsReady &&
      room.phase === "LOBBY",
  );

    if (roomCode && playerId && room?.phase === "RESULTS") {
    if (!room.results) {
      return (
        <main className="page-shell">
          <p role="alert">The server returned incomplete match results.</p>
          <button
            className="copy-button"
            type="button"
            onClick={() => void leaveRoom()}
            disabled={lobbyBusy !== null}
          >
            LEAVE ROOM
          </button>
        </main>
      );
    }

    return (
      <MatchResults
        key={room.results.matchId}
        roomCode={roomCode}
        summary={room.results}
        isHost={isHost}
        onLeave={() => void leaveRoom()}
        leaving={lobbyBusy === "leave"}
        roomError={lobbyError}
      />
    );
  }

  if (roomCode && playerId && room?.phase === "IN_PROGRESS") {
  return (
    <GameStartSequence
      roomCode={roomCode}
      countdownEndsAt={room.countdownEndsAt}
      theme={theme}
      onToggleTheme={toggleTheme}
      onLeave={() => void leaveRoom()}
      onReturnToEntry={returnToEntry}
      leaving={lobbyBusy === "leave"}
      roomError={lobbyError}
    />
  );
}

    if (roomCode && playerId) {
    return (
      <main className="page-shell">
        <FullscreenSetup key={roomCode} roomCode={roomCode} />
        <header className="topbar">
          <a className="brand" href="/" aria-label="Ghost Writer home">
            <span className="brand-mark" aria-hidden="true">GW</span>
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
            <p className="eyebrow">
              {room?.phase === "IN_PROGRESS"
                ? "THE GAME IS STARTING"
                : "ROOM CREATED / CREW ASSEMBLING"}
            </p>
            <h1>
              {room?.phase === "IN_PROGRESS" ? (
                <>
                  Crew ready.
                  <br />
                  <span>Game started.</span>
                </>
              ) : (
                <>
                  You’re in.
                  <br />
                  <span>Gather your crew.</span>
                </>
              )}
            </h1>
            <p className="intro-description">
              {room?.phase === "IN_PROGRESS"
                ? "The next screen will introduce the countdown and player roles."
                : isHost
                  ? "You’re hosting this room. Share the code and start when every guest is ready."
                  : "Mark yourself ready when you’re set. The host will start the game."}
            </p>
          </div>

          <aside className="brief-card">
            <div className="brief-topline">
              <span>ROOM STATUS</span>
              <span className="brief-index">
                {room?.phase === "IN_PROGRESS" ? "STARTED" : "OPEN"}
              </span>
            </div>
            <div className="brief-rule" />
            <p className="brief-label">YOUR ROOM CODE</p>
            <p className="brief-text">{roomCode}</p>
            <div className="brief-bottom">
              <span className="brief-square" />
              <span>{room?.players.length ?? "…"} PLAYERS</span>
            </div>
          </aside>
        </section>

        <section className="room-desk" aria-label="Room lobby">
          <div className="desk-heading">
            <span className="desk-number">02</span>
            <h2>Your crew</h2>
            <span className="desk-caption">
              {room ? `${room.players.length} / ${room.maxPlayers} players` : "Loading room…"}
            </span>
          </div>

          <div className="room-code-result">
            <div>
              <p className="result-label">ROOM CODE</p>
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

          {room && (
            <div className="forms-grid">
              {room.players.map((player) => {
                const playerIsHost = player.id === room.hostPlayerId;
                const isCurrentPlayer = player.id === playerId;

                return (
                  <article className="room-form" key={player.id}>
                    <div className="form-title-row">
                      <span className="form-glyph" aria-hidden="true">
                        {playerIsHost ? "★" : "·"}
                      </span>
                      <h3>
                        {player.displayName}
                        {isCurrentPlayer ? " (you)" : ""}
                      </h3>
                    </div>
                    <p className="form-note">
                      {playerIsHost
                        ? "HOST"
                        : player.isReady
                          ? "READY"
                          : "NOT READY"}
                    </p>
                  </article>
                );
              })}
            </div>
          )}

          {room?.phase === "LOBBY" && (
            <div className="lobby-actions">
              {isHost ? (
                <>
                  <p className="form-note">
                    {room.players.length < 2
                      ? "At least one more player must join before you can start."
                      : allGuestsReady
                        ? "Every guest is ready. You can start the game."
                        : "Waiting for every guest to mark themselves ready."}
                  </p>
                  <button
                    className="action-button primary-button"
                    type="button"
                    onClick={() => void startGame()}
                    disabled={!canStart || lobbyBusy !== null}
                  >
                    {lobbyBusy === "start" ? "STARTING…" : "START GAME"}
                    <span aria-hidden="true">↗</span>
                  </button>
                </>
              ) : (
                <button
                  className="action-button secondary-button"
                  type="button"
                  onClick={() => void toggleReady()}
                  disabled={lobbyBusy !== null || !room}
                >
                  {lobbyBusy === "ready"
                    ? "UPDATING…"
                    : room.players.find((player) => player.id === playerId)
                        ?.isReady
                      ? "I’M READY ✓"
                      : "MARK ME READY"}
                  <span aria-hidden="true">→</span>
                </button>
              )}
            </div>
          )}

          {room?.phase === "IN_PROGRESS" && (
            <p className="form-note">
              The game has started. The countdown and role reveal screen are the next feature.
            </p>
          )}

          {lobbyError && (
            <>
              <div className="notice notice-error" role="alert">
                <span className="notice-icon" aria-hidden="true">!</span>
                <span>{lobbyError}</span>
              </div>
              <button className="copy-button" type="button" onClick={returnToEntry}>
                RETURN TO HOME
              </button>
              <p className="form-note">
                Returning home only clears this device. Use Leave Room to leave on the server.
              </p>
            </>
          )}

          <button
            className="copy-button"
            type="button"
            onClick={() => void leaveRoom()}
            disabled={lobbyBusy !== null}
          >
            {lobbyBusy === "leave" ? "LEAVING…" : "LEAVE ROOM"}
          </button>
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
          <span className="brand-mark" aria-hidden="true">GW</span>
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
              <span className="form-glyph" aria-hidden="true">+</span>
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
              <span className="form-glyph join-glyph" aria-hidden="true">↳</span>
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
