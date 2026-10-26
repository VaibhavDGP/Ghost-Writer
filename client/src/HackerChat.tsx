import { useEffect, useRef, useState } from "react";

interface Message {
  id: number;
  playerId: string;
  displayName: string;
  text: string;
  sentAt: number;
}

interface Snapshot {
  matchId: string;
  playerId: string;
  serverNowMs: number;
  revision: number;
  members: {
    id: string;
    displayName: string;
  }[];
  messages: Message[];
}

interface Pending {
  matchId: string;
  requestId: string;
  text: string;
}

interface Props {
  roomCode: string;
  matchId: string;
}

export default function HackerChat({
  roomCode,
  matchId,
}: Props) {
  const playerId = sessionStorage.getItem(
    "ghostWriterPlayerId",
  );

  const storageKey =
    `ghostWriterHackerChat:${roomCode}:${matchId}:${playerId}`;

  const [data, setData] = useState<Snapshot | null>(null);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<Pending | null>(() => {
    try {
      const value = JSON.parse(
        sessionStorage.getItem(storageKey) ?? "null",
      ) as Pending | null;

      return value &&
        value.matchId === matchId &&
        typeof value.requestId === "string" &&
        typeof value.text === "string"
        ? value
        : null;
    } catch {
      return null;
    }
  });

  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const denied = useRef(false);
  const sendingRef = useRef(false);

  function accept(next: Snapshot) {
    if (next.matchId !== matchId) return;

    setData((previous) => {
      if (
        previous &&
        (next.revision < previous.revision ||
          next.serverNowMs < previous.serverNowMs)
      ) {
        return previous;
      }

      return next;
    });
  }

  useEffect(() => {
    let stopped = false;
    let inFlight = false;
    let controller: AbortController | null = null;

    denied.current = false;

    async function refresh() {
      if (stopped || inFlight || denied.current) return;
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
          `/rooms/${encodeURIComponent(roomCode)}/hacker-chat` +
            `?matchId=${encodeURIComponent(matchId)}`,
          {
            headers: {
              Authorization: `Bearer ${token ?? ""}`,
            },
            cache: "no-store",
            signal: current.signal,
          },
        );

        const result = await response.json();

        if (stopped) return;

        if ([401, 403, 404, 409].includes(response.status)) {
          denied.current = true;
          setData(null);
          return;
        }

        if (!response.ok) {
          throw new Error(
            result.error ?? "Could not load private chat.",
          );
        }

        accept(result as Snapshot);
      } catch (cause) {
        if (!stopped) {
          setError(
            cause instanceof Error
              ? cause.message
              : "Private chat connection interrupted.",
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
  }, [roomCode, matchId]);

  async function send() {
    if (sendingRef.current || denied.current) return;

    const text = draft.trim();
    if (!pending && !text) return;

    const request: Pending = pending ?? {
      matchId,
      requestId: crypto.randomUUID(),
      text,
    };

    sendingRef.current = true;
    setSending(true);
    setError(null);
    setPending(request);

    const controller = new AbortController();
    const timeout = window.setTimeout(
      () => controller.abort(),
      8000,
    );

    try {
      // Save the request ID before sending so a network retry
      // does not create a duplicate message.
      sessionStorage.setItem(
        storageKey,
        JSON.stringify(request),
      );

      const token = sessionStorage.getItem(
        "ghostWriterSessionToken",
      );

      const response = await fetch(
        `/rooms/${encodeURIComponent(roomCode)}/hacker-chat`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token ?? ""}`,
          },
          body: JSON.stringify(request),
          signal: controller.signal,
        },
      );

      const result = await response.json();

      if (!response.ok) {
        if (response.status < 500 && response.status !== 429) {
          sessionStorage.removeItem(storageKey);
          setPending(null);
        }

        if ([401, 403, 404].includes(response.status)) {
          denied.current = true;
          setData(null);
        }

        throw new Error(
          result.error ?? "The message could not be sent.",
        );
      }

      if (denied.current) return;

      accept(result as Snapshot);
      sessionStorage.removeItem(storageKey);
      setPending(null);
      setDraft("");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Delivery is uncertain. Retry the same message.",
      );
    } finally {
      window.clearTimeout(timeout);
      sendingRef.current = false;
      setSending(false);
    }
  }

  // No private-chat UI is shown until the server authorizes it.
  if (!data) return null;

  const teammates = data.members.filter(
    (member) => member.id !== data.playerId,
  );

  return (
    <section className="gw-info-panel">
      <h2>Private hacker chat</h2>

      <p className="gw-muted">
        Only active hackers can access this chat.
        Your team shares five sabotage tokens and one cooldown.
      </p>

      <p>
        {teammates.length > 0
          ? `Teammate: ${teammates
              .map((member) => member.displayName)
              .join(", ")}`
          : "No other active hacker remains."}
      </p>

      <div
        role="log"
        aria-label="Private hacker messages"
        aria-relevant="additions"
        style={{
          maxHeight: 260,
          overflowY: "auto",
          padding: 12,
          border: "1px solid currentColor",
          borderRadius: 8,
        }}
      >
        {data.messages.length === 0 && (
          <p>No messages yet.</p>
        )}

        {data.messages.map((message) => (
          <p
            key={message.id}
            style={{
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
            }}
          >
            <strong>
              {message.playerId === data.playerId
                ? "You"
                : message.displayName}
              :{" "}
            </strong>
            {message.text}
          </p>
        ))}
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
        style={{ marginTop: 12 }}
      >
        <label>
          Private message
          <textarea
            rows={3}
            maxLength={300}
            value={pending?.text ?? draft}
            disabled={sending || pending !== null}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Coordinate your next sabotage…"
            style={{
              display: "block",
              width: "100%",
              boxSizing: "border-box",
              marginTop: 6,
            }}
          />
        </label>

        <button
          className="copy-button"
          type="submit"
          disabled={
            sending || (!pending && !draft.trim())
          }
          style={{ marginTop: 10 }}
        >
          {sending
            ? "SENDING…"
            : pending
              ? "RETRY MESSAGE"
              : "SEND PRIVATE MESSAGE"}
        </button>
      </form>

      {error && <p role="alert">{error}</p>}
    </section>
  );
}