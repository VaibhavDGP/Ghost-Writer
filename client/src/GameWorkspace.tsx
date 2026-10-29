import { useState } from "react";
import SharedEditor from "./SharedEditor";
import MatchActions from "./MatchActions";
import MeetingPanel from "./MeetingPanel";
import HackerChat from "./HackerChat";
import JudgeOutageBanner from "./JudgeOutageBanner";
import { FullscreenButton } from "./FullscreenControls";
import DraftRecovery from "./DraftRecovery";
import JudgeQueueStatus from "./JudgeQueueStatus";
import {
  postJSON,
  sourceOf,
  useSharedDocument,
} from "./shared-document";
import "./GameWorkspace.css";

interface Props {
  roomCode: string;
  role: "CODER" | "HACKER";
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onLeave: () => void;
  onReturnToEntry: () => void;
  leaving: boolean;
  roomError: string | null;
}

interface RunResult {
  status: string;
  compilerOutput?: string;
  passed?: number;
  total?: number;
  tests?: {
    id: string;
    status: string;
    stdout: string;
    stderr: string;
    expectedOutput: string;
  }[];
}

export default function GameWorkspace({
  roomCode,
  role,
  theme,
  onToggleTheme,
  onLeave,
  onReturnToEntry,
  leaving,
  roomError,
}: Props) {
    const live = useSharedDocument(roomCode);
  const snapshot = live.snapshot;

  const currentPlayer = snapshot?.players.find(
    (player) => player.id === snapshot.playerId,
  );

  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState<"run" | "submit" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<{
    source: string;
    result: RunResult;
  } | null>(null);

  const ownedName = snapshot?.names.find(
    (name) => snapshot.functions[name].ownerId === snapshot.playerId,
  ) ?? null;

  const owned = ownedName ? snapshot?.functions[ownedName] : null;

  const canEdit = Boolean(
    snapshot?.editable &&
    live.connected &&
    !live.blocked &&
    !live.acting &&
    owned &&
    !owned.checking &&
    busy !== "submit",
  );

    const canAct = Boolean(
    snapshot?.editable &&
    !snapshot.judgePaused &&
    live.connected &&
    !live.dirty &&
    !live.saving &&
    !live.acting &&
    !live.blocked &&
    !busy &&
    !owned?.checking,
  );

  const chosen = selected && snapshot?.functions[selected]
    ? selected
    : snapshot?.names.find((name) => !snapshot.functions[name].ownerId) ?? "";

  async function acquire() {
    if (!live.connection || !chosen) return;

    setError(null);
    setNotice(null);

    try {
      await live.connection.action("ACQUIRE", chosen);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not claim function.");
    }
  }

  async function release() {
    if (!live.connection || !ownedName) return;

    setError(null);
    setNotice(null);

    try {
      await live.connection.action("RELEASE", ownedName);

      setNotice(
        role === "HACKER"
          ? "Function released. Its contents were restored to when you claimed it."
          : "Function released. Your shared edits remain available to the team.",
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not release function.");
    }
  }

  async function run() {
    if (!snapshot || !canAct) return;

    const source = sourceOf(snapshot);
    setBusy("run");
    setError(null);
    setNotice(null);

    try {
      const response = await postJSON<{ result: RunResult }>(
        `/rooms/${roomCode}/run`,
        { matchId: snapshot.matchId, source },
      );

      setLastRun({ source, result: response.result });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Public tests failed to run.");
    } finally {
      setBusy(null);
    }
  }

  async function submit() {
    if (!snapshot || !ownedName || !owned?.lockId || !canAct) return;

    setBusy("submit");
    setError(null);
    setNotice(null);

    try {
      await postJSON(
        `/rooms/${roomCode}/submit`,
        {
          matchId: snapshot.matchId,
          name: ownedName,
          lockId: owned.lockId,
        },
      );

      setNotice("Repair accepted. Your function has been released.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Repair could not be submitted.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="page-shell gw-workspace">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">GW</span>
          <span>GHOST WRITER</span>
        </div>

        <div className="gw-header-actions">
          <span className="gw-room-label">ROOM {roomCode}</span>
          <FullscreenButton />

          <button className="theme-toggle" onClick={onToggleTheme}>
            {theme === "light" ? "DARK MODE" : "LIGHT MODE"}
          </button>

          <button
            className="copy-button"
            onClick={onLeave}
            disabled={leaving}
          >
            {leaving ? "LEAVING…" : "LEAVE ROOM"}
          </button>
        </div>
      </header>

      <div className="gw-workspace-heading">
        <div>
                   <p className="eyebrow">CODING WORKSPACE</p>
          <h1>Investigate the code.</h1>

          {currentPlayer && (
            <p className="gw-player-identity">
              <span>PLAYING AS</span>
              <strong>{currentPlayer.displayName}</strong>
            </p>
          )}
        </div>

        <p className={`gw-role-badge ${role === "HACKER" ? "gw-role-hacker" : ""}`}>
          YOUR ROLE: {role}
        </p>
      </div>

      {roomError && <p className="gw-warning">{roomError}</p>}

      <JudgeOutageBanner paused={snapshot?.judgePaused === true} />
                <JudgeQueueStatus
        roomCode={roomCode}
        matchId={snapshot?.matchId}
      />

            <DraftRecovery live={live} />

      {!snapshot ? (
        <section className="gw-load-message">
          <p>{live.error ?? "Connecting to the shared document…"}</p>

          {live.error && (
            <button className="copy-button" onClick={onReturnToEntry}>
              RETURN TO HOME
            </button>
          )}
        </section>
      ) : (
        <div className="gw-workspace-grid">
          <section className="gw-editor-panel" aria-label="Shared C++ document">
            <div className="gw-editor-toolbar">
              <div>
                <strong>main.cpp</strong>
                <span className="gw-draft-label">SHARED DOCUMENT</span>
              </div>

              <div className="gw-draft-actions">
                <button
                  className="copy-button"
                  onClick={() => void run()}
                  disabled={!canAct}
                >
                  {busy === "run" ? "PROCESSING…" : "RUN PUBLIC TESTS"}
                </button>

                {role === "CODER" && (
                  <button
                    className="copy-button"
                    onClick={() => void submit()}
                    disabled={!canAct || !ownedName}
                  >
                    {busy === "submit" || owned?.checking
  ? "PROCESSING…"
  : "SUBMIT REPAIR"}
                  </button>
                )}
              </div>
            </div>

            <div className="gw-function-controls">
              {ownedName ? (
                <>
                  <p>
                    Editing: <strong>{ownedName}</strong>
                  </p>

                  <button
                    className="copy-button"
                    onClick={() => void release()}
                    disabled={!canAct}
                  >
                    RELEASE FUNCTION
                  </button>
                </>
              ) : (
                <>
                  <label htmlFor="gw-function-select">Choose a function</label>

                  <select
                    id="gw-function-select"
                    value={chosen}
                    onChange={(event) => setSelected(event.target.value)}
                    disabled={!canAct}
                  >
                    <option value="">Select a function</option>

                    {snapshot.names.map((name) => {
                      const fn = snapshot.functions[name];
                      const owner = snapshot.players.find(
                        (player) => player.id === fn.ownerId,
                      );

                      return (
                        <option key={name} value={name} disabled={Boolean(owner)}>
                          {name}
                          {owner ? ` — ${owner.displayName}` : ""}
                          {!owner && fn.accepted ? " — accepted" : ""}
                        </option>
                      );
                    })}
                  </select>

                  <button
                    className="copy-button"
                    onClick={() => void acquire()}
                    disabled={!canAct || !chosen || Boolean(snapshot.functions[chosen]?.ownerId)}
                  >
                    START EDITING
                  </button>
                </>
              )}
            </div>

            <p className="gw-editor-note">
              {snapshot.paused
                ? "Editing is paused during the meeting."
                : !snapshot.editable
                  ? "You can watch the shared document."
                  : ownedName
                    ? "Everyone can see your edits. Only you can change your claimed function."
                    : "Everyone sees this document. Claim a function to edit its body."}
            </p>

            {role === "HACKER" && ownedName && (
              <p className="gw-editor-note">
                Releasing your function restores its lock-time contents.
                Token sabotage remains separate.
              </p>
            )}

            {!live.connected && (
              <p className="gw-warning">
                Reconnecting… Editing will resume when the document is synchronized.
              </p>
            )}

            <div className="gw-editor-container">
              <SharedEditor
                snapshot={snapshot}
                theme={theme}
                editable={canEdit}
                onEdit={(name, body) => live.connection?.edit(name, body)}
                onWarning={setError}
              />
            </div>

            <div className="gw-editor-footer">
              <span>
                {live.dirty || live.saving
                  ? "Synchronizing edits…"
                  : "Shared document synchronized"}
              </span>
              <span>Official version {snapshot.codeVersion}</span>
            </div>

            {live.error && (
              <div className="gw-warning">
                <p>{live.error}</p>

                {live.blocked && (
                  <div className="gw-draft-actions">
                    <button
                      className="copy-button"
                      onClick={() => live.connection?.retry()}
                      disabled={!live.connected || live.saving}
                    >
                      RETRY SYNC
                    </button>

                    <button
                      className="copy-button"
                      onClick={() => live.connection?.useServerVersion()}
                      disabled={live.saving || live.acting}
                    >
                      USE SERVER VERSION
                    </button>
                  </div>
                )}
              </div>
            )}

            

            {notice && <p className="gw-editor-note" role="status">{notice}</p>}
            {error && <pre className="gw-warning gw-shared-message">{error}</pre>}

            {lastRun && (
              <section className="gw-run-results">
                <h2>Last public test run</h2>

                {lastRun.source !== sourceOf(snapshot) && (
                  <p className="gw-warning">
                    The shared document changed after this run started.
                  </p>
                )}

                {lastRun.result.status === "COMPILE_ERROR" ? (
                  <pre className="gw-run-output">
                    {lastRun.result.compilerOutput}
                  </pre>
                ) : (
                  <>
                    <p>
                      {lastRun.result.passed} / {lastRun.result.total} public tests passed
                    </p>

                    {lastRun.result.tests?.map((test) => (
                      <details className="gw-run-case" key={test.id}>
                        <summary>{test.id}: {test.status}</summary>
                        <p>Output</p>
                        <pre className="gw-run-output">{test.stdout || "(empty)"}</pre>
                        <p>Expected</p>
                        <pre className="gw-run-output">{test.expectedOutput}</pre>
                        {test.stderr && (
                          <pre className="gw-run-output">{test.stderr}</pre>
                        )}
                      </details>
                    ))}
                  </>
                )}

                <p className="gw-muted">
                  Public tests check a snapshot of the shared document.
                  Submit Repair checks your function against trusted tests.
                </p>
              </section>
            )}
          </section>

          <aside className="gw-challenge-sidebar">
            <section className="gw-info-panel">
              <h2>Player activity</h2>

              <div className="gw-activity-scroll">
                <table className="gw-activity-table">
                  <thead>
                    <tr>
                      <th>Player</th>
                      <th>Function</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.players.map((player) => (
                      <tr key={player.id}>
                        <td>
                          {player.displayName}
                          {player.id === snapshot.playerId ? " (you)" : ""}
                        </td>
                        <td>{player.functionName ?? "—"}</td>
                        <td>{player.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <p className="gw-muted">
                Releasing a function makes it available to another player.
                Accepted repairs release it automatically.
              </p>
            </section>

            <MeetingPanel
              roomCode={roomCode}
              onLeave={onLeave}
              leaving={leaving}
              roomError={roomError}
            />

            <MatchActions
              key={snapshot.matchId}
              roomCode={roomCode}
              matchId={snapshot.matchId}
              codeVersion={snapshot.codeVersion}
              role={role}
            />

            {role === "HACKER" && (
              <HackerChat
                key={snapshot.matchId}
                roomCode={roomCode}
                matchId={snapshot.matchId}
              />
            )}

            <section className="gw-info-panel">
              <h2>Repair objectives</h2>

              <p className="gw-muted">
                Objective completion reflects accepted repairs.
                Unsubmitted edits remain visible in the shared document.
              </p>

              <ul className="gw-objective-list">
                {snapshot.objectives.map((objective) => (
                  <li key={objective.id}>
                    <p>{objective.description}</p>
                    <small>
                      {snapshot.completedObjectiveIds.includes(objective.id)
                        ? "Complete"
                        : objective.required ? "Required" : "Optional"}
                    </small>
                  </li>
                ))}
              </ul>
            </section>

            <section className="gw-info-panel">
              <h2>Public test examples</h2>

              {snapshot.publicTests.map((test) => (
                <details className="gw-test-case" key={test.id}>
                  <summary>{test.id}</summary>
                  <p>Input</p>
                  <pre>{test.input}</pre>
                  <p>Expected output</p>
                  <pre>{test.expectedOutput}</pre>
                </details>
              ))}
            </section>
          </aside>
        </div>
      )}
    </main>
  );
}