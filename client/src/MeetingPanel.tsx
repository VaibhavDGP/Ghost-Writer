import { useEffect, useId, useRef, useState } from "react";

interface Snapshot {
  matchId: string;
  serverNowMs: number;
  codingStartsAt: number;
  matchEndsAt: number;
  remainingCalls: number;
  canCall: boolean;

  meeting: null | {
    id: string;
    calledByName: string;
    startedAt: number;
    endsAt: number;
    pausedRemainingMs: number;
  };

  messages: {
    id: string;
    displayName: string;
    text: string;
    sentAt: number;
  }[];
}

interface Pending {
  action: "CALL" | "CHAT";
  matchId: string;
  requestId: string;
  meetingId?: string;
  text?: string;
}

function formatTime(ms: number) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));

  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(
    seconds % 60,
  ).padStart(2, "0")}`;
}

export default function MeetingPanel({
  roomCode,
}: {
  roomCode: string;
}) {
  const [sample, setSample] = useState<{
    data: Snapshot;
    receivedAt: number;
  } | null>(null);

  const [now, setNow] = useState(performance.now());
  const [syncError, setSyncError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [sending, setSending] = useState(false);

  const sendingRef = useRef(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  function accept(data: Snapshot) {
    const receivedAt = performance.now();

    setSample((previous) =>
      !previous || data.serverNowMs >= previous.data.serverNowMs
        ? { data, receivedAt }
        : previous,
    );
  }

  useEffect(() => {
    let stopped = false;
    let busy = false;
    let active: AbortController | null = null;

    async function refresh() {
      if (busy) return;
      busy = true;

      active = new AbortController();

      const timeout = window.setTimeout(
        () => active?.abort(),
        8000,
      );

      try {
        const token =
          sessionStorage.getItem("ghostWriterSessionToken") ?? "";

        const response = await fetch(
          `/rooms/${encodeURIComponent(roomCode)}/meeting`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
            cache: "no-store",
            signal: active.signal,
          },
        );

        const data = await response.json();

        if (!response.ok) {
          if (
            !stopped &&
            [401, 404, 409].includes(response.status)
          ) {
            setSample(null);
          }

          throw new Error(
            data.error ?? "Could not refresh the match.",
          );
        }

        if (!stopped) {
          accept(data as Snapshot);
          setSyncError(null);
        }
      } catch (cause) {
        if (!stopped) {
          setSyncError(
            cause instanceof Error
              ? cause.message
              : "Connection lost.",
          );
        }
      } finally {
        window.clearTimeout(timeout);
        busy = false;
      }
    }

    void refresh();

    const poll = window.setInterval(
      () => void refresh(),
      1000,
    );

    const tick = window.setInterval(
      () => setNow(performance.now()),
      250,
    );

    const visible = () => {
      if (document.visibilityState === "visible") {
        void refresh();
      }
    };

    document.addEventListener("visibilitychange", visible);

    return () => {
      stopped = true;
      active?.abort();

      window.clearInterval(poll);
      window.clearInterval(tick);

      document.removeEventListener(
        "visibilitychange",
        visible,
      );
    };
  }, [roomCode]);

  const data = sample?.data;
  const meeting = data?.meeting;
  const isMeeting = Boolean(meeting);

  const serverNow = sample
    ? sample.data.serverNowMs +
      Math.max(0, now - sample.receivedAt)
    : 0;

  useEffect(() => {
    const dialog = dialogRef.current;

    if (!dialog) return;

    if (isMeeting && !dialog.open) {
      dialog.showModal();
    }

    if (!isMeeting && dialog.open) {
      dialog.close();
    }
  }, [isMeeting]);

  useEffect(() => {
    setDraft("");
    setActionError(null);
  }, [meeting?.id]);

  async function send(request: Pending) {
    if (sendingRef.current) return;

    sendingRef.current = true;
    setSending(true);
    setPending(request);
    setActionError(null);

    const controller = new AbortController();
    const timeout = window.setTimeout(
      () => controller.abort(),
      10000,
    );

    try {
      const token =
        sessionStorage.getItem("ghostWriterSessionToken") ?? "";

      const response = await fetch(
        `/rooms/${encodeURIComponent(roomCode)}/meeting`,
        {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(request),
        },
      );

      const result = await response.json();

      if (!response.ok) {
        if (
          response.status < 500 &&
          response.status !== 429
        ) {
          setPending(null);
        }

        throw new Error(result.error ?? "Request failed.");
      }

      accept(result as Snapshot);
      setPending(null);

      if (request.action === "CHAT") {
        setDraft("");
      }
    } catch (cause) {
      setActionError(
        cause instanceof Error
          ? cause.message
          : "Request failed.",
      );
    } finally {
      window.clearTimeout(timeout);
      sendingRef.current = false;
      setSending(false);
    }
  }

  const feedback = (
    <>
      {syncError && (
        <p role="status">
          Connection: {syncError} Retrying…
        </p>
      )}

      {actionError && <p role="alert">{actionError}</p>}

      {pending && (
        <button
          type="button"
          className="copy-button"
          disabled={sending}
          onClick={() => void send(pending)}
        >
          {sending ? "SENDING…" : "RETRY PENDING REQUEST"}
        </button>
      )}
    </>
  );

  return (
    <section
      className="gw-info-panel"
      aria-label="Match timer and meetings"
    >
      <p
        role="timer"
        style={{
          fontWeight: 700,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {!data
          ? "Synchronizing match…"
          : meeting
            ? `Coding paused: ${formatTime(
                meeting.pausedRemainingMs,
              )} remaining`
            : serverNow < data.codingStartsAt
              ? `Coding begins in ${formatTime(
                  data.codingStartsAt - serverNow,
                )}`
              : `Time remaining: ${formatTime(
                  data.matchEndsAt - serverNow,
                )}`}
      </p>

      <button
        type="button"
        className="copy-button"
        disabled={
          !data?.canCall ||
          Boolean(syncError) ||
          sending ||
          pending !== null
        }
        onClick={() =>
          data &&
          void send({
            action: "CALL",
            matchId: data.matchId,
            requestId: crypto.randomUUID(),
          })
        }
      >
        CALL EMERGENCY MEETING
      </button>

      <p className="gw-muted">
        One call per player. {data?.remainingCalls ?? "…"} meetings
        left this match. Meetings last 3 minutes. Chat is available
        only during meetings.
      </p>

      {!isMeeting && feedback}

      <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        onCancel={(event) => event.preventDefault()}
        style={{
          width: "min(640px, 90vw)",
          maxHeight: "85vh",
          overflowY: "auto",
          padding: 24,
          borderRadius: 12,
          border: "1px solid var(--gw-border)",
          background: "var(--gw-panel)",
          color: "inherit",
        }}
      >
        <h2 id={titleId}>Emergency meeting</h2>

        {meeting && (
          <>
            <p>Called by {meeting.calledByName}.</p>

            <p role="timer">
              Discussion: {formatTime(meeting.endsAt - serverNow)}
            </p>

            <p>
              Coding and sabotage are paused. Your private draft
              is preserved.
            </p>

            <div
              role="log"
              aria-label="Meeting messages"
              aria-relevant="additions"
              style={{
                maxHeight: 250,
                overflowY: "auto",
                border: "1px solid var(--gw-border)",
                padding: 12,
              }}
            >
              {data?.messages.length === 0 && (
                <p>No messages yet.</p>
              )}

              {data?.messages.map((message) => (
                <p
                  key={`${meeting.id}:${message.id}`}
                  style={{
                    whiteSpace: "pre-wrap",
                    overflowWrap: "anywhere",
                  }}
                >
                  <strong>{message.displayName}: </strong>
                  {message.text}
                </p>
              ))}
            </div>

            <form
              onSubmit={(event) => {
                event.preventDefault();

                if (
                  data &&
                  draft.trim() &&
                  !pending &&
                  !sending
                ) {
                  void send({
                    action: "CHAT",
                    matchId: data.matchId,
                    meetingId: meeting.id,
                    requestId: crypto.randomUUID(),
                    text: draft.trim(),
                  });
                }
              }}
            >
              <label
                style={{
                  display: "block",
                  marginTop: 16,
                }}
              >
                Message (up to 300 characters)

                <textarea
                  value={draft}
                  maxLength={300}
                  rows={3}
                  disabled={sending || pending !== null}
                  onChange={(event) =>
                    setDraft(event.target.value)
                  }
                  style={{
                    display: "block",
                    width: "100%",
                    boxSizing: "border-box",
                  }}
                />
              </label>

              <button
                className="copy-button"
                type="submit"
                disabled={
                  !draft.trim() ||
                  sending ||
                  pending !== null ||
                  serverNow >= meeting.endsAt
                }
              >
                SEND MESSAGE
              </button>
            </form>

            {feedback}

            <p className="gw-muted">
              Coding resumes automatically when discussion ends.
            </p>
          </>
        )}
      </dialog>
    </section>
  );
}