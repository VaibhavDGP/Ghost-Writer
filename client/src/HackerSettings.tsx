import { useEffect, useState } from "react";

interface Snapshot {
  count: 1 | 2;
  maximum: 1 | 2;
  playerCount: number;
  phase: string;
  canEdit: boolean;
  serverNowMs: number;
}

export default function HackerSettings({
  roomCode,
}: {
  roomCode: string;
}) {
  const [data, setData] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function accept(next: Snapshot) {
    setData((previous) =>
      !previous || next.serverNowMs >= previous.serverNowMs
        ? next
        : previous,
    );
  }

  useEffect(() => {
    let stopped = false;
    let inFlight = false;
    let controller: AbortController | null = null;

    async function refresh() {
      if (stopped || inFlight) return;
      inFlight = true;

      const current = new AbortController();
      controller = current;

      const timeout = window.setTimeout(
        () => current.abort(),
        8000,
      );

      try {
        const token = sessionStorage.getItem(
          "ghostWriterSessionToken",
        );

        const response = await fetch(
          `/rooms/${encodeURIComponent(roomCode)}/hacker-settings`,
          {
            headers: {
              Authorization: `Bearer ${token ?? ""}`,
            },
            cache: "no-store",
            signal: current.signal,
          },
        );

        const result = await response.json();

        if (!response.ok) {
          throw new Error(
            result.error ?? "Could not load hacker settings.",
          );
        }

        if (!stopped) {
          accept(result as Snapshot);
        }
      } catch (cause) {
        if (!stopped) {
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not load hacker settings.",
          );
        }
      } finally {
        window.clearTimeout(timeout);
        inFlight = false;
      }
    }

    void refresh();

    const timer = window.setInterval(() => {
      void refresh();
    }, 2000);

    return () => {
      stopped = true;
      controller?.abort();
      window.clearInterval(timer);
    };
  }, [roomCode]);

  async function change(count: 1 | 2) {
    if (busy) return;

    setBusy(true);
    setError(null);
    setNotice(null);

    const controller = new AbortController();
    const timeout = window.setTimeout(
      () => controller.abort(),
      8000,
    );

    try {
      const token = sessionStorage.getItem(
        "ghostWriterSessionToken",
      );

      const response = await fetch(
        `/rooms/${encodeURIComponent(roomCode)}/hacker-settings`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token ?? ""}`,
          },
          body: JSON.stringify({ count }),
          signal: controller.signal,
        },
      );

      const result = await response.json();

      if (!response.ok) {
        throw new Error(
          result.error ?? "Could not update hacker settings.",
        );
      }

      accept(result as Snapshot);
      setNotice("Setting saved. Guests must ready up again.");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not update hacker settings.",
      );
    } finally {
      window.clearTimeout(timeout);
      setBusy(false);
    }
  }

  return (
    <section className="gw-info-panel">
      <h3>Hackers in this match</h3>

      {!data ? (
        <p>Loading match settings…</p>
      ) : (
        <>
          {data.canEdit && data.maximum === 2 ? (
            <label>
              Number of hackers{" "}
              <select
                value={data.count}
                disabled={busy}
                onChange={(event) => {
                  const count =
                    event.target.value === "2" ? 2 : 1;
                  void change(count);
                }}
              >
                <option value="1">1 hacker — 3 tokens</option>
                <option value="2">
                  2 hackers — 5 shared tokens
                </option>
              </select>
            </label>
          ) : (
            <p>
              {data.count === 2
                ? "2 hackers · 5 shared sabotage tokens"
                : "1 hacker · 3 sabotage tokens"}
            </p>
          )}

          <p className="gw-muted">
            {data.maximum === 1
              ? "Two hackers become available with six or more players."
              : data.canEdit
                ? "Changing this setting resets guests’ ready status."
                : "The host chooses the hacker count."}
          </p>
        </>
      )}

      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}