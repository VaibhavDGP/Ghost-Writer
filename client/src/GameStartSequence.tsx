import { useEffect, useState } from "react";
import "./GameStartSequence.css";
import GameWorkspace from "./GameWorkspace";
import { FullscreenButton } from "./FullscreenControls";

type GameRole = "CODER" | "HACKER";

interface Props {
  roomCode: string;
  countdownEndsAt?: number;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onLeave: () => void;
  onReturnToEntry: () => void;
  leaving: boolean;
  roomError: string | null;
}

interface ClockResponse {
  phase?: "LOBBY" | "IN_PROGRESS" | "RESULTS";
  codingStartsAt?: number | null;
  serverNowMs?: number;
  error?: string;
}

interface RoleResponse {
  role?: GameRole;
  error?: string;
}

interface ClockAnchor {
  serverNowMs: number;
  receivedAt: number;
  countdownEndsAt: number;
  codingStartsAt: number;
}

export default function GameStartSequence({
  roomCode,
  countdownEndsAt,
  theme,
  onToggleTheme,
  onLeave,
  onReturnToEntry,
  leaving,
  roomError,
}: Props) {
  const [tick, setTick] = useState(() => performance.now());
  const [clock, setClock] = useState<ClockAnchor | null>(null);
  const [role, setRole] = useState<GameRole | null>(null);
  const [typedText, setTypedText] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setTick(performance.now());
    }, 100);

    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!role) return;

    const message =
      role === "HACKER"
        ? "You are a Hacker"
        : "You Are A Coder";

    let characterIndex = 0;
    setTypedText("");

    const timer = window.setInterval(() => {
      characterIndex += 1;
      setTypedText(message.slice(0, characterIndex));

      if (characterIndex >= message.length) {
        window.clearInterval(timer);
      }
    }, 75);

    return () => window.clearInterval(timer);
  }, [role]);

  useEffect(() => {
    let stopped = false;
    let roleLoaded = false;
    let retryTimer: number | undefined;
    let controller: AbortController | null = null;

    setClock(null);
    setRole(null);
    setTypedText("");
    setError(null);

    async function synchronize() {
      if (stopped || roleLoaded) return;

      const requestController = new AbortController();
      controller = requestController;

      const timeout = window.setTimeout(() => {
        requestController.abort();
      }, 8000);

      try {
        const token = window.sessionStorage.getItem(
          "ghostWriterSessionToken",
        );

        if (!token) {
          throw new Error(
            "Your player session is missing. Return home and rejoin.",
          );
        }

        const headers = {
          Authorization: `Bearer ${token}`,
        };

        const clockResponse = await fetch(
          `/rooms/${encodeURIComponent(roomCode)}/clock`,
          {
            headers,
            cache: "no-store",
            signal: requestController.signal,
          },
        );

        const snapshot =
          (await clockResponse.json()) as ClockResponse;

        if (stopped) return;

        if (!clockResponse.ok) {
          throw new Error(
            snapshot.error ??
              "Could not synchronize the countdown.",
          );
        }

        if (snapshot.phase !== "IN_PROGRESS") {
          setError("Waiting for the room to update…");
          return;
        }

        if (
          typeof snapshot.serverNowMs !== "number" ||
          !Number.isFinite(snapshot.serverNowMs) ||
          typeof snapshot.codingStartsAt !== "number" ||
          !Number.isFinite(snapshot.codingStartsAt)
        ) {
          throw new Error(
            "The server returned incomplete countdown information.",
          );
        }

        // Existing backend sequence:
        // 10-second countdown, then a 5-second role reveal.
        const revealStartsAt =
          typeof countdownEndsAt === "number" &&
          Number.isFinite(countdownEndsAt)
            ? countdownEndsAt
            : snapshot.codingStartsAt - 5000;

        setClock({
          serverNowMs: snapshot.serverNowMs,
          receivedAt: performance.now(),
          countdownEndsAt: revealStartsAt,
          codingStartsAt: snapshot.codingStartsAt,
        });

        setError(null);

        if (snapshot.serverNowMs < revealStartsAt) {
          return;
        }

        // Fetch the role automatically after the countdown.
        const roleResponse = await fetch(
          `/rooms/${encodeURIComponent(roomCode)}/me/role`,
          {
            headers,
            cache: "no-store",
            signal: requestController.signal,
          },
        );

        const result =
          (await roleResponse.json()) as RoleResponse;

        if (stopped) return;

        if (roleResponse.status === 409) {
          // The reveal may still be pending on the server.
          // Retry automatically.
          return;
        }

        if (!roleResponse.ok) {
          throw new Error(
            result.error ?? "Could not retrieve your role.",
          );
        }

        if (
          result.role !== "CODER" &&
          result.role !== "HACKER"
        ) {
          throw new Error(
            "The server returned an invalid role.",
          );
        }

        roleLoaded = true;
        setRole(result.role);
        setError(null);
      } catch (cause) {
        if (!stopped) {
          setError(
            cause instanceof Error &&
              cause.name !== "AbortError"
              ? `${cause.message} Retrying automatically…`
              : "Connection interrupted. Retrying automatically…",
          );
        }
      } finally {
        window.clearTimeout(timeout);

        if (controller === requestController) {
          controller = null;
        }

        if (!stopped && !roleLoaded) {
          retryTimer = window.setTimeout(() => {
            void synchronize();
          }, 500);
        }
      }
    }

    void synchronize();

    return () => {
      stopped = true;
      controller?.abort();

      if (retryTimer !== undefined) {
        window.clearTimeout(retryTimer);
      }
    };
  }, [roomCode, countdownEndsAt]);

  const serverNow = clock
    ? clock.serverNowMs +
      Math.max(0, tick - clock.receivedAt)
    : null;

  const secondsLeft =
    clock && serverNow !== null
      ? Math.max(
          0,
          Math.ceil(
            (clock.countdownEndsAt - serverNow) / 1000,
          ),
        )
      : null;

  const revealStarted =
    clock !== null &&
    serverNow !== null &&
    serverNow >= clock.countdownEndsAt;

  const codingStarted =
    clock !== null &&
    serverNow !== null &&
    serverNow >= clock.codingStartsAt;

  const roomActions = (
    <div>
      <div className="gw-start-controls">
        <FullscreenButton />

        <button
          className="copy-button"
          type="button"
          onClick={onLeave}
          disabled={leaving}
        >
          {leaving ? "LEAVING…" : "LEAVE ROOM"}
        </button>
      </div>

      {(error || roomError) && (
        <p role="alert">{error ?? roomError}</p>
      )}

      {roomError && (
        <>
          <button
            className="copy-button"
            type="button"
            onClick={onReturnToEntry}
          >
            RETURN TO HOME
          </button>

          <p>
            Returning home only clears this device;
            it does not leave on the server.
          </p>
        </>
      )}
    </div>
  );

  // Enter automatically when the original reveal period ends.
  // Reconnecting to an ongoing match also enters automatically.
  if (role && codingStarted) {
    return (
      <GameWorkspace
        key={roomCode}
        roomCode={roomCode}
        role={role}
        theme={theme}
        onToggleTheme={onToggleTheme}
        onLeave={onLeave}
        onReturnToEntry={onReturnToEntry}
        leaving={leaving}
        roomError={roomError}
      />
    );
  }

  // Original separate, full-screen typing-animation UI.
  if (revealStarted) {
    return (
      <main
        className={`role-reveal ${
          role === "HACKER" ? "role-hacker" : "role-coder"
        }`}
      >
        <div>
          {role ? (
            <p
              className="role-message"
              aria-label={
                role === "HACKER"
                  ? "You are a Hacker"
                  : "You are a Coder"
              }
            >
              <span aria-hidden="true">{typedText}</span>
              <span
                className="typing-cursor"
                aria-hidden="true"
              >
                _
              </span>
            </p>
          ) : (
            <p className="role-caption" role="status">
              Revealing your role…
            </p>
          )}
        </div>

        {roomActions}
      </main>
    );
  }

  // Original countdown screen: only the first ten seconds.
  return (
    <main className="page-shell start-sequence-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            GW
          </span>
          <span>GHOST WRITER</span>
        </div>

        <div className="topbar-right">
          <span className="online-mark">
            <span className="online-dot" />
            GAME STARTING
          </span>

          <button
            className="theme-toggle"
            type="button"
            onClick={onToggleTheme}
            aria-label={`Switch to ${
              theme === "light" ? "dark" : "light"
            } mode`}
          >
            {theme === "light" ? "◐ DARK" : "☼ LIGHT"}
          </button>
        </div>
      </header>

      <section className="intro">
        <div className="intro-copy">
          <p className="eyebrow">GET READY</p>

          <h1>
            Game starts in
            <br />
            <span className="countdown-number">
              {secondsLeft === null ? "…" : secondsLeft}
            </span>
          </h1>

          <p className="intro-description">
            The crew is locked in. Get ready for the reveal.
          </p>
        </div>

        <aside className="brief-card">
          <div className="brief-topline">
            <span>ROOM</span>
            <span className="brief-index">{roomCode}</span>
          </div>

          <div className="brief-rule" />

          <p className="brief-label">WHAT HAPPENS NEXT</p>

          <p className="brief-text">
            Countdown.
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

      {roomActions}

      <footer className="footer">
        <span>GHOST WRITER / BUILD 001</span>
        <span>NO ONE DEBUGS ALONE</span>
      </footer>
    </main>
  );
}