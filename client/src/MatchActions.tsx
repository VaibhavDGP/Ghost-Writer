import { useEffect, useState } from "react";

interface Choice {
  id: string;
  label: string;
  available: boolean;
  cost: number;
}

interface View {
  matchId: string;
  codeVersion: number;
  tokensRemaining?: number;
  cooldownRemainingMs?: number;
  mutations?: Choice[];
}

interface Pending {
  matchId: string;
  baseVersion: number;
  mutationId: string;
  requestId: string;
}

interface Props {
  roomCode: string;
  matchId: string;
  codeVersion: number;
  role: "CODER" | "HACKER";
}

export default function MatchActions({
  roomCode,
  matchId,
  codeVersion,
  role,
}: Props) {
  const storageKey = `ghostWriterSabotage:${roomCode}:${matchId}`;

  const [view, setView] = useState<View | null>(null);
  const [receivedAt, setReceivedAt] = useState(performance.now());
  const [now, setNow] = useState(performance.now());
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [pending, setPending] = useState<Pending | null>(() => {
    try {
      const raw = window.sessionStorage.getItem(storageKey);
      return raw ? (JSON.parse(raw) as Pending) : null;
    } catch {
      return null;
    }
  });

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

    async function refresh() {
      if (inProgress) return;
      inProgress = true;

      try {
        const token = window.sessionStorage.getItem(
          "ghostWriterSessionToken",
        );

        const response = await fetch(
          role === "HACKER"
            ? `/rooms/${roomCode}/sabotage`
            : `/rooms/${roomCode}`,
          {
            cache: "no-store",
            signal: controller.signal,
            headers: {
              Authorization: `Bearer ${token ?? ""}`,
            },
          },
        );

        const result = await response.json();

        if (!response.ok) {
          throw new Error(result.error ?? "Could not refresh match state.");
        }

        const next: View | undefined =
          role === "HACKER"
            ? result
            : result.room?.challenge;

        if (
          !next ||
          typeof next.matchId !== "string" ||
          typeof next.codeVersion !== "number"
        ) {
          return;
        }

        if (!controller.signal.aborted) {
          setView(next);
          setReceivedAt(performance.now());
          setError(null);
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not refresh match state.",
          );
        }
      } finally {
        inProgress = false;
      }
    }

    void refresh();
    const timer = window.setInterval(() => void refresh(), 2500);

    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [roomCode, role]);

  const stale = Boolean(
    view &&
      (view.matchId !== matchId || view.codeVersion !== codeVersion),
  );

  const cooldownSeconds = Math.max(
    0,
    Math.ceil(
      ((view?.cooldownRemainingMs ?? 0) - (now - receivedAt)) / 1000,
    ),
  );

  async function send(request: Pending) {
    setSending(true);
    setMessage(null);
    setError(null);

    try {
      // Save before sending so an uncertain request can be retried safely.
      window.sessionStorage.setItem(storageKey, JSON.stringify(request));
      setPending(request);

      const token = window.sessionStorage.getItem(
        "ghostWriterSessionToken",
      );

      const response = await fetch(`/rooms/${roomCode}/sabotage`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token ?? ""}`,
        },
        body: JSON.stringify(request),
      });

      const result = await response.json();

      if (!response.ok) {
        // Keep uncertain / retryable requests under the same request ID.
        if (response.status < 500 && response.status !== 429) {
          window.sessionStorage.removeItem(storageKey);
          setPending(null);
        }

        throw new Error(result.error ?? "Sabotage was not accepted.");
      }

      window.sessionStorage.removeItem(storageKey);
      setPending(null);

      setView((previous) => ({
        ...previous,
        matchId,
        codeVersion: result.codeVersion,
        tokensRemaining: result.tokensRemaining,
      }));

      setMessage(
        `Sabotage accepted. ${result.cost} token(s) spent. Load the latest official code.`,
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The request outcome is uncertain. Retry the pending request.",
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="gw-info-panel">
      <h2>Official code</h2>
      <p>
        Your draft is based on version {codeVersion}.
        {view && ` Latest version: ${view.codeVersion}.`}
      </p>

      {stale && (
        <div className="gw-warning" role="status">
          <p>The official code changed. Stale submissions will be rejected.</p>
          <p>Copy any unfinished edits before loading the new version.</p>
          <button
            className="copy-button"
            type="button"
            onClick={() => window.location.reload()}
            disabled={sending}
          >
            LOAD LATEST OFFICIAL CODE
          </button>
        </div>
      )}

      {role === "HACKER" && (
        <>
          <h2>Sabotage</h2>
          <p>Tokens remaining: {view?.tokensRemaining ?? "…"}</p>
          <p>
            {cooldownSeconds > 0
              ? `Cooldown: ${cooldownSeconds}s`
              : "No active sabotage cooldown."}
          </p>

          <p className="gw-muted">
            These actions change the official program, not your private draft.
            Previously repaired objectives cost two tokens.
          </p>

          {view?.mutations?.map((choice) => (
            <div key={choice.id} style={{ marginBottom: 16 }}>
              <button
                className="copy-button"
                type="button"
                disabled={
                  sending ||
                  pending !== null ||
                  stale ||
                  cooldownSeconds > 0 ||
                  !choice.available ||
                  (view.tokensRemaining ?? 0) < choice.cost
                }
                onClick={() =>
                  void send({
                    matchId,
                    baseVersion: codeVersion,
                    mutationId: choice.id,
                    requestId: window.crypto.randomUUID(),
                  })
                }
              >
                {choice.label} — {choice.cost} token(s)
              </button>

              {!choice.available && (
                <p className="gw-muted">
                  This mutation does not match the current function.
                </p>
              )}
            </div>
          ))}

          {pending && (
            <button
              className="copy-button"
              type="button"
              onClick={() => void send(pending)}
              disabled={sending}
            >
              {sending ? "VERIFYING…" : "RETRY PENDING SABOTAGE"}
            </button>
          )}

          {sending && <p role="status">Verifying the approved mutation…</p>}
        </>
      )}

      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}