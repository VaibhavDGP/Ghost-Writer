import { useEffect, useState } from "react";
import "./MatchResults.css";

export interface MatchSummary {
  matchId: string;
  winner: "CODERS" | "HACKER";
  reason:
    | "ALL_REPAIRED"
    | "TIME_EXPIRED"
    | "HACKER_ELIMINATED"
    | "HACKER_LEFT";
  finishedAt: number;
  expiresAt: number;
  durationMs: number;
  acceptedRepairs: number;
  successfulSabotages: number;
  completedObjectives: number;
  totalObjectives: number;
  players: {
    id: string;
    displayName: string;
    role: "CODER" | "HACKER" | "UNKNOWN";
  }[];
}

interface Props {
  roomCode: string;
  summary: MatchSummary;
  isHost: boolean;
  onLeave: () => void;
  leaving: boolean;
  roomError: string | null;
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(
    Math.max(0, milliseconds) / 1000,
  );
  const minutes = Math.floor(seconds / 60);

  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function resultExplanation(
  reason: MatchSummary["reason"],
): string {
  switch (reason) {
    case "HACKER_LEFT":
      return "The hacker left the match or did not reconnect within 60 seconds.";

    case "HACKER_ELIMINATED":
      return "The hacker was eliminated by the vote.";

    case "TIME_EXPIRED":
      return "Time ran out before every required repair was completed.";

    case "ALL_REPAIRED":
      return "Every required repair objective was completed before the deadline.";
  }
}

export default function MatchResults({
  roomCode,
  summary,
  isHost,
  onLeave,
  leaving,
  roomError,
}: Props) {
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [returning, setReturning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 250);

    return () => window.clearInterval(timer);
  }, []);

  const secondsRemaining = Math.max(
    0,
    Math.ceil((summary.expiresAt - now) / 1000),
  );

  async function playAgain() {
    const token = window.sessionStorage.getItem(
      "ghostWriterSessionToken",
    );

    if (!token) {
      setError("Your player session is missing.");
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const response = await fetch(
        `/rooms/${encodeURIComponent(roomCode)}/replay`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            matchId: summary.matchId,
          }),
        },
      );

      const result = (await response.json()) as {
        error?: string;
      };

      if (!response.ok) {
        throw new Error(
          result.error ?? "Could not prepare another match.",
        );
      }

      setReturning(true);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not reach the game server.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page-shell">
      <section
        className="gw-results"
        aria-labelledby="results-title"
      >
        <p className="eyebrow">
          MATCH COMPLETE / ROOM {roomCode}
        </p>

        <h1 id="results-title">
          {summary.winner === "HACKER"
            ? "Hacker wins."
            : "Coders win."}
        </h1>

        <p>{resultExplanation(summary.reason)}</p>

        <dl className="gw-results-stats">
          <div>
            <dt>Match duration</dt>
            <dd>{formatDuration(summary.durationMs)}</dd>
          </div>

          <div>
            <dt>Accepted repairs</dt>
            <dd>{summary.acceptedRepairs}</dd>
          </div>

          <div>
            <dt>Successful sabotages</dt>
            <dd>{summary.successfulSabotages ?? 0}</dd>
          </div>

          <div>
            <dt>Objectives completed</dt>
            <dd>
              {summary.completedObjectives} /{" "}
              {summary.totalObjectives}
            </dd>
          </div>
        </dl>

        <h2>Your crew</h2>

        <ul className="gw-results-players">
          {summary.players.map((player) => (
            <li key={player.id}>
              <span>{player.displayName}</span>
              <strong>{player.role}</strong>
            </li>
          ))}
        </ul>

        <p className="gw-results-countdown">
          {returning
            ? "Returning everyone to the lobby…"
            : secondsRemaining > 0
              ? `Room closes in ${secondsRemaining} seconds unless the host chooses Play Again.`
              : "Results time has ended. Waiting for the room update…"}
        </p>

        {isHost ? (
          <p>
            Play Again keeps this room and its remaining
            players. Everyone must ready up before the next
            match.
          </p>
        ) : (
          <p>
            Waiting for the host to choose Play Again.
            You can leave now if you’re finished.
          </p>
        )}

        <div className="gw-results-actions">
          {isHost && (
            <button
              className="action-button primary-button"
              type="button"
              onClick={() => void playAgain()}
              disabled={
                busy ||
                leaving ||
                returning ||
                secondsRemaining === 0
              }
            >
              {busy || returning
                ? "PREPARING LOBBY…"
                : "PLAY AGAIN"}
            </button>
          )}

          <button
            className="copy-button"
            type="button"
            onClick={onLeave}
            disabled={busy || leaving || returning}
          >
            {leaving ? "LEAVING…" : "LEAVE ROOM"}
          </button>
        </div>

        {(error || roomError) && (
          <p role="alert">{error ?? roomError}</p>
        )}
      </section>
    </main>
  );
}