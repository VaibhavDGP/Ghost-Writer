import { useEffect, useId, useRef, useState } from "react";
import { FullscreenButton } from "./FullscreenControls";
import HackerChat from "./HackerChat";
interface Snapshot {
  matchId: string;
  serverNowMs: number;
  codingStartsAt: number;
  matchEndsAt: number;
  remainingCalls: number;
  canCall: boolean;
  isSpectator: boolean;
  hasVoted: boolean;
  myVote: string | null;
  officialSource: string | null;
  codeVersion: number;

  players: {
    id: string;
    displayName: string;
  }[];

  meeting: null | {
    id: string;
    calledByName: string;
    startedAt: number;
    voteStartsAt?: number;
    endsAt: number;
    pausedRemainingMs: number;
  };

  messages: {
    id: string;
    displayName: string;
    text: string;
  }[];

  lastVoteResult: null | {
    meetingId: string;
    outcome: "ELIMINATED" | "TIE" | "NO_VOTES";
    displayName: string | null;
    tally: {
      playerId: string;
      displayName: string;
      votes: number;
    }[];
  };
}

interface Pending {
  action: "CALL" | "CHAT" | "VOTE";
  matchId: string;
  requestId: string;
  meetingId?: string;
  text?: string;
  targetId?: string;
}

interface Props {
  roomCode: string;
  onLeave: () => void;
  leaving: boolean;
  roomError: string | null;
}

function time(ms: number) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));

  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(
    seconds % 60,
  ).padStart(2, "0")}`;
}

export default function MeetingPanel({
  roomCode,
  onLeave,
  leaving,
  roomError,
}: Props) {
  const [sample, setSample] = useState<{
    data: Snapshot;
    receivedAt: number;
  } | null>(null);

  const [now, setNow] = useState(performance.now());
  const [syncError, setSyncError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [target, setTarget] = useState("UNSET");
  const [pending, setPending] = useState<Pending | null>(null);
  const [sending, setSending] = useState(false);

  const busy = useRef(false);
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
    let polling = false;
    let active: AbortController | null = null;

    async function refresh() {
      if (polling) return;
      polling = true;

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
            data.error ?? "Could not synchronize the match.",
          );
        }

        if (!stopped) {
          accept(data);
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
        polling = false;
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
  const spectator = data?.isSpectator === true;

  const serverNow = sample
    ? sample.data.serverNowMs +
      Math.max(0, now - sample.receivedAt)
    : 0;

  const voteStartsAt = meeting
    ? meeting.voteStartsAt ?? meeting.endsAt - 30000
    : 0;

  const voting = Boolean(
    meeting && serverNow >= voteStartsAt,
  );
  const expired = Boolean(
    meeting && serverNow >= meeting.endsAt,
  );
  const modal = Boolean(meeting || spectator);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (modal && !dialog.open) dialog.showModal();
    if (!modal && dialog.open) dialog.close();
  }, [modal]);

  useEffect(() => {
    setDraft("");
    setTarget("UNSET");
    setError(null);
  }, [meeting?.id]);

  async function send(request: Pending) {
    if (busy.current) return;

    busy.current = true;
    setSending(true);
    setPending(request);
    setError(null);

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

      accept(result);
      setPending(null);

      if (request.action === "CHAT") {
        setDraft("");
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Request failed.",
      );
    } finally {
      window.clearTimeout(timeout);
      busy.current = false;
      setSending(false);
    }
  }

  function action(
    kind: Pending["action"],
    extra: Partial<Pending> = {},
  ) {
    if (!data) return;

    void send({
      action: kind,
      matchId: data.matchId,
      requestId: crypto.randomUUID(),
      ...extra,
    });
  }

  const feedback = (
    <>
      {syncError && (
        <p role="status">{syncError} Reconnecting…</p>
      )}

      {(error || roomError) && (
        <p role="alert">{error ?? roomError}</p>
      )}

      {pending && (
        <button
          className="copy-button"
          type="button"
          disabled={sending}
          onClick={() => void send(pending)}
        >
          {sending ? "SENDING…" : "RETRY PENDING REQUEST"}
        </button>
      )}
    </>
  );

  const result = data?.lastVoteResult;

  const resultView = result && (
    <div role="status">
      <p>
        {result.outcome === "ELIMINATED"
          ? `${result.displayName} was eliminated.`
          : result.outcome === "TIE"
            ? "The vote tied. Nobody was eliminated."
            : "No votes for players. Nobody was eliminated."}
      </p>
      <p>
        {result.tally
          .map((row) => `${row.displayName}: ${row.votes}`)
          .join(" · ")}
      </p>
    </div>
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
            ? `Coding paused: ${time(
                meeting.pausedRemainingMs,
              )} remaining`
            : serverNow < data.codingStartsAt
              ? `Coding begins in ${time(
                  data.codingStartsAt - serverNow,
                )}`
              : `Time remaining: ${time(
                  data.matchEndsAt - serverNow,
                )}`}
      </p>

      <button
        className="copy-button"
        type="button"
        disabled={
          !data?.canCall ||
          Boolean(syncError) ||
          sending ||
          pending !== null
        }
        onClick={() => action("CALL")}
      >
        CALL EMERGENCY MEETING
      </button>

      <p className="gw-muted">
        One call per player. {data?.remainingCalls ?? "…"} meetings
        left.
      </p>

      {!modal && (
        <>
          {resultView}
          {feedback}
        </>
      )}

      <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        onCancel={(event) => event.preventDefault()}
        style={{
          width: "min(700px, 90vw)",
          maxHeight: "85vh",
          overflowY: "auto",
          padding: 24,
          borderRadius: 12,
          border: "1px solid var(--gw-border)",
          background: "var(--gw-panel)",
          color: "inherit",
        }}
      >
        <h2 id={titleId}>
          {spectator
            ? "Spectator"
            : voting
              ? "Vote"
              : "Emergency meeting"}
        </h2>

                <FullscreenButton />

                        {modal && !spectator && data && (
          <HackerChat
            key={data.matchId}
            roomCode={roomCode}
            matchId={data.matchId}
          />
        )}

        {spectator && (
          <p>
            You were eliminated. You can watch or leave, but cannot
            affect this match.
          </p>
        )}

        {resultView}

        {meeting ? (
          <>
            <p>Called by {meeting.calledByName}.</p>

            <p role="timer">
              {expired
                ? "Resolving the vote…"
                : voting
                  ? `Voting: ${time(
                      meeting.endsAt - serverNow,
                    )}`
                  : `Discussion: ${time(
                      voteStartsAt - serverNow,
                    )}`}
            </p>

            <div
              role="log"
              aria-label="Meeting messages"
              aria-relevant="additions"
              style={{
                maxHeight: 220,
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

            {!spectator && !voting && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();

                  if (draft.trim() && !pending && !sending) {
                    action("CHAT", {
                      meetingId: meeting.id,
                      text: draft.trim(),
                    });
                  }
                }}
              >
                <label>
                  Message (300 characters maximum)
                  <textarea
                    rows={3}
                    maxLength={300}
                    value={draft}
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
                  disabled={
                    !draft.trim() ||
                    sending ||
                    pending !== null
                  }
                >
                  SEND MESSAGE
                </button>
              </form>
            )}

            {!spectator && voting && (
              <>
                <p>
                  Most votes for a player wins. Skip does not count.
                  Ties eliminate nobody.
                </p>

                {data?.hasVoted ? (
                  <p role="status">
                    Vote recorded:{" "}
                    {data.myVote === ""
                      ? "Skip"
                      : data.players.find(
                          (player) => player.id === data.myVote,
                        )?.displayName ?? "Player"}
                    . Your vote is locked.
                  </p>
                ) : (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();

                      if (
                        target !== "UNSET" &&
                        !expired &&
                        !pending &&
                        !sending
                      ) {
                        action("VOTE", {
                          meetingId: meeting.id,
                          targetId: target,
                        });
                      }
                    }}
                  >
                    <label>
                      Your vote{" "}
                      <select
                        value={target}
                        onChange={(event) =>
                          setTarget(event.target.value)
                        }
                        disabled={
                          sending ||
                          pending !== null ||
                          expired
                        }
                      >
                        <option value="UNSET" disabled>
                          Choose a player or Skip
                        </option>

                        <option value="">Skip</option>

                        {data?.players.map((player) => (
                          <option
                            key={player.id}
                            value={player.id}
                          >
                            {player.displayName}
                          </option>
                        ))}
                      </select>
                    </label>

                    <button
                      className="copy-button"
                      disabled={
                        target === "UNSET" ||
                        sending ||
                        pending !== null ||
                        expired
                      }
                    >
                      CAST VOTE
                    </button>
                  </form>
                )}
              </>
            )}
          </>
        ) : spectator ? (
          <>
            <p role="timer">
              Time remaining:{" "}
              {time((data?.matchEndsAt ?? serverNow) - serverNow)}
            </p>

                        <h3>Shared code — revision {data?.codeVersion}</h3>

            <pre
              style={{
                maxHeight: 400,
                overflow: "auto",
                whiteSpace: "pre-wrap",
              }}
            >
              {data?.officialSource}
            </pre>
          </>
        ) : null}

        {feedback}

        <p>
          <button
            className="copy-button"
            type="button"
            onClick={onLeave}
            disabled={leaving}
          >
            {leaving ? "LEAVING…" : "LEAVE ROOM"}
          </button>
        </p>
      </dialog>
    </section>
  );
}