import { useEffect, useState } from "react";

interface ClockResponse {
  phase: "LOBBY" | "IN_PROGRESS" | "RESULTS";
  matchId: string | null;
  codingStartsAt: number | null;
  matchEndsAt: number | null;
  serverNowMs: number;
  error?: string;
}

interface Sample {
  clock: ClockResponse;
  receivedAt: number;
  estimatedServerNow: number;
}

function formatTime(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);

  return `${String(minutes).padStart(2, "0")}:${String(
    seconds % 60,
  ).padStart(2, "0")}`;
}

export default function MatchClock({
  roomCode,
}: {
  roomCode: string;
}) {
  const [sample, setSample] = useState<Sample | null>(null);
  const [now, setNow] = useState(performance.now());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setInterval(
      () => setNow(performance.now()),
      250,
    );

    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let inProgress = false;

    async function synchronize() {
      if (inProgress) return;
      inProgress = true;

      const startedAt = performance.now();

      try {
        const token = window.sessionStorage.getItem(
          "ghostWriterSessionToken",
        );

        const response = await fetch(
          `/rooms/${encodeURIComponent(roomCode)}/clock`,
          {
            cache: "no-store",
            signal: controller.signal,
            headers: {
              Authorization: `Bearer ${token ?? ""}`,
            },
          },
        );

        const result = (await response.json()) as ClockResponse;

        if (!response.ok) {
          throw new Error(result.error ?? "Timer synchronization failed.");
        }

        if (!Number.isFinite(result.serverNowMs)) {
          throw new Error("The server returned an invalid clock.");
        }

        const receivedAt = performance.now();

        if (!controller.signal.aborted) {
          setSample({
            clock: result,
            receivedAt,
            estimatedServerNow:
              result.serverNowMs + (receivedAt - startedAt) / 2,
          });
          setError(null);
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(
            cause instanceof Error
              ? cause.message
              : "Timer synchronization failed.",
          );
        }
      } finally {
        inProgress = false;
      }
    }

    void synchronize();

    const poll = window.setInterval(
      () => void synchronize(),
      2000,
    );

    function onVisibilityChange() {
      if (document.visibilityState === "visible") {
        void synchronize();
      }
    }

    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      controller.abort();
      window.clearInterval(poll);
      document.removeEventListener(
        "visibilitychange",
        onVisibilityChange,
      );
    };
  }, [roomCode]);

  const serverNow = sample
    ? sample.estimatedServerNow +
      Math.max(0, now - sample.receivedAt)
    : null;

  const startsAt = sample?.clock.codingStartsAt;
  const endsAt = sample?.clock.matchEndsAt;

  let label = "Synchronizing match timer…";
  let urgent = false;

  if (sample?.clock.phase === "RESULTS") {
    label = "Match finished";
  } else if (
    serverNow !== null &&
    typeof startsAt === "number" &&
    typeof endsAt === "number"
  ) {
    if (serverNow < startsAt) {
      label = `Coding begins in ${formatTime(startsAt - serverNow)}`;
    } else {
      const remaining = Math.max(0, endsAt - serverNow);
      urgent = remaining <= 60_000;

      label =
        remaining > 0
          ? `Time remaining: ${formatTime(remaining)}`
          : "Time is up. Waiting for the official result…";
    }
  } else if (sample) {
    label = "This match has no timer. Start a fresh match.";
  }

  return (
    <section className="gw-info-panel" aria-label="Match timer">
      <p
        role="timer"
        style={{
          fontSize: "1.2rem",
          fontWeight: 700,
          fontVariantNumeric: "tabular-nums",
          color: urgent ? "#c34132" : undefined,
        }}
      >
        {label}
      </p>

      {error && (
        <p className="gw-warning" role="status">
          {error} Reconnecting…
        </p>
      )}
    </section>
  );
}