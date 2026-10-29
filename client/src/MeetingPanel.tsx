import { useEffect, useId, useRef, useState } from "react";
import { FullscreenButton } from "./FullscreenControls";
import HackerChat from "./HackerChat";
import "./MeetingPanel.css";

interface Ballot {
  voterId: string;
  voterName: string;
  targetId: string | null;
  targetName: string | null;
  status: "VOTED" | "SKIPPED" | "NO_VOTE";
}

interface VoteResult {
  meetingId: string;
  outcome: "ELIMINATED" | "TIE" | "NO_VOTES";
  playerId: string | null;
  displayName: string | null;
  closedAt: number;
  revealEndsAt: number;
  applied: boolean;
  tally: {
    playerId: string;
    displayName: string;
    votes: number;
  }[];
  ballots: Ballot[];
}

interface Snapshot {
  matchId: string;
  playerId: string;
  serverNowMs: number;
  codingStartsAt: number;
  matchEndsAt: number;
  remainingCalls: number;
  canCall: boolean;
  isSpectator: boolean;
  hasVoted: boolean;
  myVote: string | null;
  voteCount: number;
  eligibleCount: number;
  officialSource: string | null;
  codeVersion: number;

  players: {
    id: string;
    displayName: string;
    eliminated: boolean;
    departed: boolean;
    hasVoted: boolean;
  }[];

  meeting: null | {
    id: string;
    calledByName: string;
    startedAt: number;
    voteEndsAt: number;
    voteClosedAt?: number;
    stage: "VOTING" | "REVEAL" | "FINISHED";
    endsAt: number;
    pausedRemainingMs: number;
  };

  messages: {
    id: string;
    playerId: string;
    displayName: string;
    text: string;
  }[];

  lastVoteResult: VoteResult | null;
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

function playerColor(id: string) {
  const colors = [
    "#e34b56",
    "#428de0",
    "#efbf3f",
    "#ae69db",
    "#4abd91",
    "#ed8a43",
    "#e478b5",
    "#6baabd",
  ];

  let hash = 0;
  for (const character of id) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }

  return colors[hash % colors.length];
}

function Avatar({ id, small = false }: { id: string; small?: boolean }) {
  return (
    <svg
      className={small ? "gm-avatar gm-avatar-small" : "gm-avatar"}
      viewBox="0 0 64 76"
      aria-hidden="true"
    >
      <path
        d="M13 29H8Q3 29 3 35V53Q3 59 10 59H16"
        fill={playerColor(id)}
        stroke="#172334"
        strokeWidth="4"
      />
      <path
        d="M15 30Q15 8 36 8Q57 8 57 31V65Q57 71 49 71H41V58H31V71H22Q15 71 15 64Z"
        fill={playerColor(id)}
        stroke="#172334"
        strokeWidth="4"
        strokeLinejoin="round"
      />
      <path
        d="M29 20Q41 16 54 22V37Q42 42 28 35Q24 27 29 20Z"
        fill="#bfeaf4"
        stroke="#172334"
        strokeWidth="4"
      />
      <path
        d="M33 23Q42 21 49 24"
        fill="none"
        stroke="white"
        strokeWidth="4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function resultText(result: VoteResult) {
  if (result.outcome === "ELIMINATED") {
    return `${result.displayName} was eliminated.`;
  }

  return result.outcome === "TIE"
    ? "The vote tied. Nobody was eliminated."
    : "No player received a vote. Nobody was eliminated.";
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
  const [target, setTarget] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [sending, setSending] = useState(false);

  const busy = useRef(false);
  const mounted = useRef(true);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  const followChat = useRef(true);
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
    mounted.current = true;
    let stopped = false;
    let polling = false;
    let active: AbortController | null = null;

    async function refresh() {
      if (polling || stopped) return;
      polling = true;

      const controller = new AbortController();
      active = controller;
      const timeout = window.setTimeout(() => controller.abort(), 8000);

      try {
        const token = sessionStorage.getItem("ghostWriterSessionToken") ?? "";

        const response = await fetch(`/rooms/${roomCode}/meeting`, {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
          signal: controller.signal,
        });

        const result = await response.json();

        if (!response.ok) {
          // Keep the reveal visible while App moves to match results.
          if (response.status === 409) return;
          throw new Error(result.error ?? "Could not synchronize the meeting.");
        }

        if (!stopped) {
          accept(result as Snapshot);
          setSyncError(null);
        }
      } catch (cause) {
        if (!stopped) {
          setSyncError(
            cause instanceof Error ? cause.message : "Connection interrupted.",
          );
        }
      } finally {
        window.clearTimeout(timeout);
        polling = false;
      }
    }

    void refresh();

    const poll = window.setInterval(() => void refresh(), 750);
    const tick = window.setInterval(() => setNow(performance.now()), 250);

    const visible = () => {
      if (document.visibilityState === "visible") void refresh();
    };

    document.addEventListener("visibilitychange", visible);

    return () => {
      stopped = true;
      mounted.current = false;
      active?.abort();
      window.clearInterval(poll);
      window.clearInterval(tick);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [roomCode]);

  const data = sample?.data;
  const meeting = data?.meeting;
  const spectator = data?.isSpectator === true;
  const revealing = meeting?.stage === "REVEAL";
  const modal = Boolean(meeting || spectator);

  const serverNow = sample
    ? sample.data.serverNowMs + Math.max(0, now - sample.receivedAt)
    : 0;

  const votingOpen = Boolean(
    meeting &&
    !revealing &&
    serverNow < meeting.voteEndsAt,
  );

  const canParticipate =
    votingOpen && !spectator && !syncError && !sending && !pending;

  const canVote = canParticipate && !data?.hasVoted;

  const result = data?.lastVoteResult;
  const revealResult =
    revealing && result?.meetingId === meeting?.id ? result : null;

  const decisionVisible = Boolean(
    revealResult && serverNow >= revealResult.closedAt + 5000,
  );

  const ballots = revealResult?.ballots ?? [];
  const skipped = ballots.filter((ballot) => ballot.status === "SKIPPED");
  const missed = ballots.filter((ballot) => ballot.status === "NO_VOTE");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (modal && !dialog.open) dialog.showModal();
    if (!modal && dialog.open) dialog.close();
  }, [modal]);

  useEffect(() => {
    setDraft("");
    setTarget(null);
    setError(null);
    followChat.current = true;
  }, [meeting?.id]);

  useEffect(() => {
    if (
      pending &&
      pending.action !== "CALL" &&
      (
        pending.meetingId !== meeting?.id ||
        revealing ||
        (pending.action === "VOTE" && data?.hasVoted)
      )
    ) {
      setPending(null);
    }
  }, [pending, meeting?.id, revealing, data?.hasVoted]);

  useEffect(() => {
    const chat = chatRef.current;
    if (chat && followChat.current) chat.scrollTop = chat.scrollHeight;
  }, [data?.messages.length, meeting?.id]);

  async function send(request: Pending) {
    if (busy.current) return;

    busy.current = true;
    setSending(true);
    setPending(request);
    setError(null);

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10_000);

    try {
      const token = sessionStorage.getItem("ghostWriterSessionToken") ?? "";

      const response = await fetch(`/rooms/${roomCode}/meeting`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(request),
      });

      const responseData = await response.json();
      if (!mounted.current) return;

      if (!response.ok) {
        if (response.status < 500) setPending(null);
        throw new Error(responseData.error ?? "Request failed.");
      }

      accept(responseData as Snapshot);
      setPending(null);

      if (request.action === "CHAT") {
        setDraft((current) =>
          current.trim() === request.text ? "" : current,
        );
        followChat.current = true;
      }
    } catch (cause) {
      if (mounted.current) {
        setError(cause instanceof Error ? cause.message : "Request failed.");
      }
    } finally {
      window.clearTimeout(timeout);
      busy.current = false;
      if (mounted.current) setSending(false);
    }
  }

  function action(kind: Pending["action"], extra: Partial<Pending> = {}) {
    if (!data) return;

    void send({
      action: kind,
      matchId: data.matchId,
      requestId: crypto.randomUUID(),
      ...extra,
    });
  }

  const selectedName = target === ""
    ? "Skip"
    : data?.players.find((player) => player.id === target)?.displayName;

  const selectedValid = target === "" || Boolean(
    target &&
    target !== data?.playerId &&
    data?.players.some(
      (player) =>
        player.id === target && !player.eliminated && !player.departed,
    ),
  );

  const feedback = (
    <>
      {syncError && <p className="gm-error" role="status">{syncError} Reconnecting…</p>}
      {(error || roomError) && (
        <p className="gm-error" role="alert">{error ?? roomError}</p>
      )}
      {pending && !sending && (
        <button className="gm-button" onClick={() => void send(pending)}>
          Retry pending request
        </button>
      )}
    </>
  );

  return (
    <section className="gw-info-panel" aria-label="Match timer and meetings">
      <p className="gm-match-clock" role="timer">
        {!data
          ? "Synchronizing match…"
          : meeting
            ? `Coding paused · ${time(meeting.pausedRemainingMs)} remaining`
            : `Time remaining: ${time(data.matchEndsAt - serverNow)}`}
      </p>

      <button
        className="copy-button"
        disabled={!data?.canCall || Boolean(syncError) || sending || Boolean(pending)}
        onClick={() => action("CALL")}
      >
        CALL EMERGENCY MEETING
      </button>

      <p className="gw-muted">
        One call per player · {data?.remainingCalls ?? "…"} meetings left
      </p>

      {!modal && (
        <>
          {result && <p role="status">{resultText(result)}</p>}
          {feedback}
        </>
      )}

      <dialog
        ref={dialogRef}
        className="gm-dialog"
        aria-labelledby={titleId}
        onCancel={(event) => event.preventDefault()}
      >
        <header className="gm-header">
          <div>
            <p className="gm-eyebrow">
              <span className="gm-signal" />
              {meeting ? "Emergency meeting" : "Spectator"}
            </p>
            <h2 id={titleId}>
              {revealing
                ? "Voting results"
                : meeting
                  ? "Who is the hacker?"
                  : "Watch the match"}
            </h2>
            <p className="gm-subtitle">
              {meeting
                ? `Called by ${meeting.calledByName}`
                : "You have been eliminated. You can watch or leave."}
            </p>
          </div>

          <div className="gm-header-right">
            <FullscreenButton />
            {meeting && (
              <div className={`gm-timer ${!revealing && meeting.voteEndsAt - serverNow < 30000 ? "gm-timer-urgent" : ""}`}>
                <small>{revealing ? "Results" : "Discuss & vote"}</small>
                <strong role="timer">
                  {time((revealing ? meeting.endsAt : meeting.voteEndsAt) - serverNow)}
                </strong>
              </div>
            )}
          </div>
        </header>

        {meeting && data ? (
          <div className="gm-main">
            <section className="gm-board" aria-label="Voting board">
              <div className="gm-board-heading">
                <p>
                  {revealing
                    ? "Each name below a player shows who voted for them."
                    : spectator
                      ? "You are watching this meeting."
                      : data.hasVoted
                        ? "Your vote is locked. You can keep chatting."
                        : "Select a player, then confirm your vote."}
                </p>

                {!revealing && (
                  <span className="gm-vote-progress">
                    {data.voteCount}/{data.eligibleCount} voted
                  </span>
                )}
              </div>

              <div className="gm-roster">
                {data.players.map((player) => {
                  const own = player.id === data.playerId;
                  const unavailable = player.eliminated || player.departed;
                  const voters = ballots.filter(
                    (ballot) =>
                      ballot.status === "VOTED" &&
                      ballot.targetId === player.id,
                  );

                  return (
                    <article
                      key={player.id}
                      className={`gm-player ${unavailable ? "gm-player-out" : ""} ${target === player.id && !revealing ? "gm-player-selected" : ""}`}
                    >
                      <button
                        className="gm-player-button"
                        disabled={!canVote || own || unavailable}
                        aria-pressed={target === player.id && !revealing}
                        onClick={() => setTarget(player.id)}
                        aria-label={`${player.displayName}${own ? ", you, cannot vote for yourself" : unavailable ? ", unavailable" : ", select for voting"}`}
                      >
                        <span className="gm-avatar-wrap">
                          <Avatar id={player.id} />
                          {unavailable && <span className="gm-cross" aria-hidden="true">×</span>}
                        </span>

                        <span className="gm-player-details">
                          <strong>{player.displayName}</strong>
                          <small>
                            {player.departed
                              ? "LEFT THE ROOM"
                              : player.eliminated
                                ? "ELIMINATED"
                                : own
                                  ? "YOU"
                                  : "PLAYER"}
                          </small>
                        </span>

                        {!revealing && player.hasVoted && !unavailable && (
                          <span className="gm-voted-stamp">VOTED</span>
                        )}

                        {revealing && !unavailable && (
                          <span className="gm-count">{voters.length}</span>
                        )}
                      </button>

                      {revealing && voters.length > 0 && (
                        <div className="gm-voter-list" aria-label={`Votes for ${player.displayName}`}>
                          {voters.map((ballot) => (
                            <span className="gm-voter" key={ballot.voterId}>
                              <Avatar id={ballot.voterId} small />
                              {ballot.voterName}
                            </span>
                          ))}
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>

              {!revealing ? (
                <div className="gm-vote-controls">
                  <button
                    className={`gm-button gm-skip ${target === "" ? "gm-choice-selected" : ""}`}
                    disabled={!canVote}
                    onClick={() => setTarget("")}
                  >
                    Skip vote
                  </button>

                  {data.hasVoted ? (
                    <p className="gm-vote-recorded" role="status">
                      ✓ Vote recorded: {data.myVote === ""
                        ? "Skip"
                        : data.players.find((player) => player.id === data.myVote)?.displayName ?? "Player"}
                    </p>
                  ) : target !== null && !spectator ? (
                    <div className="gm-confirm">
                      <span>
                        {target === "" ? "Skip this vote?" : `Vote for ${selectedName}?`}
                      </span>
                      <button
                        className="gm-button gm-confirm-yes"
                        disabled={!canVote || !selectedValid}
                        onClick={() => action("VOTE", {
                          meetingId: meeting.id,
                          targetId: target,
                        })}
                      >
                        ✓ Confirm
                      </button>
                      <button
                        className="gm-button gm-confirm-no"
                        disabled={sending}
                        onClick={() => setTarget(null)}
                      >
                        ✕ Cancel
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="gm-reveal-summary">
                  <div>
                    <strong>Skipped</strong>
                    <p>{skipped.map((ballot) => ballot.voterName).join(", ") || "Nobody"}</p>
                  </div>
                  {missed.length > 0 && (
                    <div>
                      <strong>Did not vote</strong>
                      <p>{missed.map((ballot) => ballot.voterName).join(", ")}</p>
                    </div>
                  )}
                </div>
              )}

              {revealing && revealResult && (
                <div className="gm-decision" role="status">
                  {decisionVisible ? (
                    <>
                      {revealResult.outcome === "ELIMINATED" && revealResult.playerId && (
                        <span className="gm-ejected-avatar">
                          <Avatar id={revealResult.playerId} />
                        </span>
                      )}
                      <strong>
                        {revealResult.outcome === "ELIMINATED"
                          ? `${revealResult.displayName} is being eliminated.`
                          : revealResult.outcome === "TIE"
                            ? "Tie. Nobody is eliminated."
                            : "No player votes. Nobody is eliminated."}
                      </strong>
                    </>
                  ) : (
                    <strong>Ballots revealed. Decision follows…</strong>
                  )}
                </div>
              )}

              <p className="gm-rules">
                Highest player vote wins. A tie eliminates nobody.
                Skips do not count toward any player's total.
              </p>

              {feedback}
            </section>

            <aside className="gm-chat-panel">
              <div className="gm-chat-heading">
                <h3>Discussion</h3>
                <span>{revealing ? "Closed" : "Live"}</span>
              </div>

              <div
                ref={chatRef}
                className="gm-chat-log"
                role="log"
                aria-label="Meeting messages"
                aria-relevant="additions"
                onScroll={() => {
                  const element = chatRef.current;
                  if (element) {
                    followChat.current =
                      element.scrollHeight - element.scrollTop - element.clientHeight < 70;
                  }
                }}
              >
                {data.messages.length === 0 && (
                  <p className="gm-chat-empty">
                    Share what you noticed. Discuss and vote before time runs out.
                  </p>
                )}

                {data.messages.map((message) => (
                  <div
                    key={`${meeting.id}:${message.id}`}
                    className={`gm-message ${message.playerId === data.playerId ? "gm-message-own" : ""}`}
                  >
                    <strong>{message.displayName}</strong>
                    <p>{message.text}</p>
                  </div>
                ))}
              </div>

              <form
                className="gm-chat-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (canParticipate && draft.trim()) {
                    action("CHAT", {
                      meetingId: meeting.id,
                      text: draft.trim(),
                    });
                  }
                }}
              >
                <label htmlFor={`${titleId}-message`} className="gm-sr-only">
                  Meeting message
                </label>
                <textarea
                  id={`${titleId}-message`}
                  rows={3}
                  maxLength={300}
                  value={draft}
                  disabled={!votingOpen || spectator}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder={
                    spectator ? "Spectators cannot send messages."
                      : revealing ? "Voting has closed."
                        : "What did you notice?"
                  }
                />
                <div>
                  <small>{draft.length}/300</small>
                  <button
                    className="gm-button gm-send"
                    disabled={!canParticipate || !draft.trim()}
                  >
                    Send
                  </button>
                </div>
              </form>

              {!spectator && (
                <div className="gm-private-chat">
                  <HackerChat
                    key={data.matchId}
                    roomCode={roomCode}
                    matchId={data.matchId}
                  />
                </div>
              )}
            </aside>
          </div>
        ) : spectator ? (
          <div className="gm-spectator">
            {result && <h3>{resultText(result)}</h3>}
            <p role="timer">
              Time remaining: {time((data?.matchEndsAt ?? serverNow) - serverNow)}
            </p>
            <h3>Shared code — revision {data?.codeVersion}</h3>
            <pre>{data?.officialSource}</pre>
            {feedback}
          </div>
        ) : null}

        <footer className="gm-footer">
          <span>
            {revealing
              ? "Coding resumes after the result, unless the match has ended."
              : meeting
                ? "Voting closes when everyone votes or the timer reaches zero."
                : "Spectator mode"}
          </span>
          <button
            className="gm-button gm-leave"
            onClick={onLeave}
            disabled={leaving}
          >
            {leaving ? "Leaving…" : "Leave room"}
          </button>
        </footer>
      </dialog>
    </section>
  );
}