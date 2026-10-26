import { useEffect, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import "./monaco-setup";
import "./GameWorkspace.css";
import SubmitRepairButton from "./SubmitRepairButton";
import MatchActions from "./MatchActions";
import MatchClock from "./MeetingPanel";
import { FullscreenButton } from "./FullscreenControls";
import HackerChat from "./HackerChat";
interface Objective {
  id: string;
  description: string;
  required: boolean;
}

interface PublicTest {
  id: string;
  input: string;
  expectedOutput: string;
  objectives: string[];
}

interface Challenge {
  matchId: string;
  templateId: string;
  language: "cpp";
  source: string;
  sourceHash: string;
  codeVersion: number;
  completedObjectiveIds: string[];
  objectives: Objective[];
  publicTests: PublicTest[];
}

interface RoomResponse {
  room?: {
    code: string;
    phase: "LOBBY" | "IN_PROGRESS";
    challenge?: Challenge;
  };
  error?: string;
}

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

interface LoadedChallenge {
  challenge: Challenge;
  playerId: string;
}

type TestStatus =
  | "PASSED"
  | "WRONG_ANSWER"
  | "RUNTIME_ERROR"
  | "TIME_OR_RESOURCE_LIMIT"
  | "OUTPUT_LIMIT";

interface TestResult {
  id: string;
  status: TestStatus;
  stdout: string;
  stderr: string;
  expectedOutput: string;
}

type JudgeResult =
  | {
      status: "COMPILE_ERROR";
      message: string;
      compilerOutput: string;
      tests: [];
    }
  | {
      status: "COMPLETED";
      passed: number;
      total: number;
      tests: TestResult[];
    };

interface RunResponse {
  matchId?: string;
  result?: JudgeResult;
  error?: string;
}

interface CompletedRun {
  source: string;
  result: JudgeResult;
}

interface DraftProps {
  roomCode: string;
  challenge: Challenge;
  storageKey: string;
  theme: "light" | "dark";
  role: "CODER" | "HACKER";
}

const STATUS_LABELS: Record<TestStatus, string> = {
  PASSED: "Passed",
  WRONG_ANSWER: "Wrong answer",
  RUNTIME_ERROR: "Runtime error",
  TIME_OR_RESOURCE_LIMIT: "Time or resource limit",
  OUTPUT_LIMIT: "Output limit",
};

function readSavedDraft(storageKey: string, fallback: string) {
  try {
    return {
      source: window.sessionStorage.getItem(storageKey) ?? fallback,
      error: null,
    };
  } catch {
    return {
      source: fallback,
      error:
        "Browser storage is unavailable. Keep this tab open to preserve your draft.",
    };
  }
}

function RunResults({
  run,
  currentDraft,
}: {
  run: CompletedRun;
  currentDraft: string;
}) {
  const result = run.result;
  const outdated = run.source !== currentDraft;

  return (
    <section className="gw-run-results" aria-label="Public test results">
      <h2>Last completed run</h2>

      {outdated && (
        <p className="gw-warning" role="status">
          Your draft has changed. These results belong to the code you sent
          earlier. Run again to check the current draft.
        </p>
      )}

      {result.status === "COMPILE_ERROR" ? (
        <>
          <p className="gw-result-summary gw-result-failed">
            Compilation failed
          </p>
          <p>{result.message}</p>
          <pre className="gw-run-output">
            {result.compilerOutput || "No compiler diagnostics were returned."}
          </pre>
        </>
      ) : (
        <>
          <p
            className={`gw-result-summary ${
              result.passed === result.total
                ? "gw-result-passed"
                : "gw-result-failed"
            }`}
          >
            {result.passed} / {result.total} public tests passed
          </p>

          {result.tests.map((test) => (
            <details className="gw-run-case" key={test.id}>
              <summary>
                <span>{test.id}</span>
                <span
                  className={
                    test.status === "PASSED"
                      ? "gw-result-passed"
                      : "gw-result-failed"
                  }
                >
                  {STATUS_LABELS[test.status] ?? test.status}
                </span>
              </summary>

              <p className="gw-output-label">Your output</p>
              <pre className="gw-run-output">
                {test.stdout || "(no output)"}
              </pre>

              <p className="gw-output-label">Expected output</p>
              <pre className="gw-run-output">
                {test.expectedOutput || "(empty output)"}
              </pre>

              {test.stderr && (
                <>
                  <p className="gw-output-label">Error output</p>
                  <pre className="gw-run-output">{test.stderr}</pre>
                </>
              )}
            </details>
          ))}
        </>
      )}

      <p className="gw-muted">
        Public tests are a preview. Passing them does not verify all objectives
        or submit a repair. The official program is unchanged until a repair is
        accepted.
      </p>
    </section>
  );
}

function DraftEditor({
  roomCode,
  challenge,
  storageKey,
  theme,
  role,
}: DraftProps) {
  const [initialDraft] = useState(() =>
    readSavedDraft(storageKey, challenge.source),
  );

  const [draft, setDraft] = useState(initialDraft.source);
  const [storageError, setStorageError] = useState<string | null>(
    initialDraft.error,
  );
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<CompletedRun | null>(null);

  const activeRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      activeRequest.current?.abort();
      activeRequest.current = null;
    };
  }, []);

  const hasChanges = draft !== challenge.source;

  function updateDraft(nextSource: string) {
    setDraft(nextSource);

    try {
      window.sessionStorage.setItem(storageKey, nextSource);
      setStorageError(null);
    } catch {
      setStorageError(
        "Your edits are still in the editor but could not be saved. Copy your code before refreshing.",
      );
    }
  }

  function resetDraft() {
    if (
      hasChanges &&
      !window.confirm(
        "Discard your private changes and restore the official code?",
      )
    ) {
      return;
    }

    updateDraft(challenge.source);
  }

  async function runDraft() {
    if (activeRequest.current) return;

    setRunError(null);
    setLastRun(null);

    if (draft.trim().length === 0) {
      setRunError("Write some C++ code before running.");
      return;
    }

    if (new TextEncoder().encode(draft).length > 64 * 1024) {
      setRunError("Your draft exceeds the 64 KiB source limit.");
      return;
    }

    const submittedSource = draft;
    const controller = new AbortController();

    activeRequest.current = controller;
    setRunning(true);

    let timedOut = false;

    const timeoutId = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 120_000);

    try {
      const sessionToken = window.sessionStorage.getItem(
        "ghostWriterSessionToken",
      );

      if (!sessionToken) {
        throw new Error(
          "Your session is missing. Return home and rejoin the room.",
        );
      }

      const response = await fetch(
        `/rooms/${encodeURIComponent(roomCode)}/run`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${sessionToken}`,
          },
          body: JSON.stringify({
            source: submittedSource,
            matchId: challenge.matchId,
          }),
          cache: "no-store",
          signal: controller.signal,
        },
      );

      const data = (await response.json()) as RunResponse;

      if (!response.ok) {
        const retryAfter = response.headers.get("Retry-After");
        const retryMessage =
          response.status === 429 && retryAfter
            ? ` Retry after about ${retryAfter} seconds.`
            : "";

        throw new Error(
          (data.error ?? "The run request failed.") + retryMessage,
        );
      }

      if (
        data.matchId !== challenge.matchId ||
        !data.result ||
        (data.result.status !== "COMPLETED" &&
          data.result.status !== "COMPILE_ERROR")
      ) {
        throw new Error("The server returned an invalid run result.");
      }

      if (activeRequest.current === controller) {
        setLastRun({
          source: submittedSource,
          result: data.result,
        });
      }
    } catch (error) {
      if (activeRequest.current !== controller) return;

      setRunError(
        timedOut
          ? "The run request timed out. The server may still be finishing cleanup. Wait briefly before retrying."
          : error instanceof Error
            ? error.message
            : "Could not reach the code judge.",
      );
    } finally {
      window.clearTimeout(timeoutId);

      if (activeRequest.current === controller) {
        activeRequest.current = null;
        setRunning(false);
      }
    }
  }

  return (
    <section className="gw-editor-panel" aria-label="Private C++ draft">
      <div className="gw-editor-toolbar">
        <div>
          <strong>main.cpp</strong>
          <span className="gw-draft-label">PRIVATE DRAFT</span>
        </div>

        <div className="gw-draft-actions">
          <button
            className="copy-button"
            type="button"
            onClick={resetDraft}
            disabled={!hasChanges}
          >
            RESET DRAFT
          </button>

          <button
            className="copy-button gw-run-button"
            type="button"
            onClick={() => void runDraft()}
            disabled={running || draft.trim().length === 0}
          >
            {running ? "RUNNING…" : "RUN PUBLIC TESTS"}
          </button>

          {role === "CODER" && (
            <SubmitRepairButton
              roomCode={roomCode}
              matchId={challenge.matchId}
              codeVersion={challenge.codeVersion}
              source={draft}
            />
          )}
        </div>
      </div>

      <p className="gw-editor-note">
        Run checks a private draft. Submit Repair checks trusted tests and
        updates the official code if it advances the repair objectives.
      </p>

      <div className="gw-editor-container">
        <Editor
          height="100%"
          language="cpp"
          theme={theme === "dark" ? "vs-dark" : "light"}
          value={draft}
          path={`file:///ghost-writer/${challenge.matchId}/main.cpp`}
          onChange={(value) => {
            if (value !== undefined) updateDraft(value);
          }}
          loading={
            <p className="gw-loading" role="status">
              Loading code editor…
            </p>
          }
          options={{
            automaticLayout: true,
            fontSize: 14,
            lineHeight: 22,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            tabSize: 4,
            insertSpaces: true,
            wordWrap: "on",
            padding: { top: 16, bottom: 16 },
            ariaLabel: "Private C++ code editor",
          }}
        />
      </div>

      <div className="gw-editor-footer">
        <span>
          {hasChanges
            ? "Draft differs from official code"
            : "Draft matches official code"}
        </span>
        <span>{storageError ? "Draft not saved" : "Tab autosave enabled"}</span>
      </div>

      {storageError && (
        <p className="gw-warning" role="alert">
          {storageError}
        </p>
      )}

      {running && (
        <p className="gw-editor-note" role="status">
          Compiling and running public tests. You can continue editing.
        </p>
      )}

      {runError && (
        <p className="gw-warning" role="alert">
          {runError}
        </p>
      )}

      {lastRun && <RunResults run={lastRun} currentDraft={draft} />}
    </section>
  );
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
  const [loaded, setLoaded] = useState<LoadedChallenge | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();

    setLoaded(null);
    setLoadError(null);

    async function loadChallenge() {
      try {
        const playerId = window.sessionStorage.getItem(
          "ghostWriterPlayerId",
        );

        if (!playerId) {
          throw new Error(
            "Your player identity is missing. Return home and rejoin the room.",
          );
        }

        const response = await fetch(
          `/rooms/${encodeURIComponent(roomCode)}`,
          {
            cache: "no-store",
            signal: controller.signal,
          },
        );

        const result = (await response.json()) as RoomResponse;

        if (!response.ok) {
          throw new Error(result.error ?? "Could not load the challenge.");
        }

        if (
          !result.room ||
          result.room.code !== roomCode ||
          result.room.phase !== "IN_PROGRESS"
        ) {
          throw new Error("This room does not have an active match.");
        }

        const challenge = result.room.challenge;

        if (
          !challenge ||
          challenge.language !== "cpp" ||
          typeof challenge.matchId !== "string" ||
          typeof challenge.source !== "string" ||
          typeof challenge.sourceHash !== "string" ||
          typeof challenge.codeVersion !== "number" ||
          !Array.isArray(challenge.completedObjectiveIds) ||
          !Array.isArray(challenge.objectives) ||
          !Array.isArray(challenge.publicTests)
        ) {
          throw new Error(
            "The room has no valid generated challenge. Start a fresh match.",
          );
        }

        if (!controller.signal.aborted) {
          setLoaded({ challenge, playerId });
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setLoadError(
            error instanceof Error
              ? error.message
              : "Could not reach the game server.",
          );
        }
      }
    }

    void loadChallenge();

    return () => controller.abort();
  }, [roomCode, attempt]);

  const storageKey = loaded
    ? [
        "ghostWriterDraft",
        roomCode,
        loaded.challenge.matchId,
        loaded.playerId,
        loaded.challenge.sourceHash,
      ].join(":")
    : "";

  return (
    <main className="page-shell gw-workspace">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            GW
          </span>
          <span>GHOST WRITER</span>
        </div>

                <div className="gw-header-actions">
          <span className="gw-room-label">ROOM {roomCode}</span>

          <FullscreenButton />

          <button
            className="theme-toggle"
            type="button"
            onClick={onToggleTheme}
          >
            {theme === "light" ? "DARK MODE" : "LIGHT MODE"}
          </button>

          <button
            className="copy-button"
            type="button"
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
        </div>

        <p
          className={`gw-role-badge ${role === "HACKER" ? "gw-role-hacker" : ""}`}
        >
          YOUR ROLE: {role}
        </p>
      </div>

      {roomError && (
        <div className="gw-warning" role="alert">
          {roomError}
        </div>
      )}

      {loadError ? (
        <section className="gw-load-message">
          <p role="alert">{loadError}</p>
          <button
            className="copy-button"
            type="button"
            onClick={() => setAttempt((current) => current + 1)}
          >
            RETRY LOADING
          </button>
        </section>
      ) : !loaded ? (
        <p className="gw-loading" role="status">
          Loading your room’s challenge…
        </p>
      ) : (
        <div className="gw-workspace-grid">
          <DraftEditor
            key={storageKey}
            roomCode={roomCode}
            storageKey={storageKey}
            challenge={loaded.challenge}
            theme={theme}
            role={role}
          />

          <aside className="gw-challenge-sidebar">
                        <MatchClock
  roomCode={roomCode}
  onLeave={onLeave}
  leaving={leaving}
  roomError={roomError}
/>
                        <MatchActions
              key={loaded.challenge.matchId}
              roomCode={roomCode}
              matchId={loaded.challenge.matchId}
              codeVersion={loaded.challenge.codeVersion}
              role={role}
            />
                        {role === "HACKER" && (
              <HackerChat
                key={loaded.challenge.matchId}
                roomCode={roomCode}
                matchId={loaded.challenge.matchId}
              />
            )}
            <section className="gw-info-panel">
              <h2>Repair objectives</h2>
              <p className="gw-muted">
                Submit a repair to check objectives against trusted tests.
                Completed objectives are saved with the official code.
              </p>

              <ul className="gw-objective-list">
                {loaded.challenge.objectives.map((objective) => {
                  const complete =
                    loaded.challenge.completedObjectiveIds.includes(
                      objective.id,
                    );

                  return (
                    <li key={objective.id}>
                      <p>{objective.description}</p>
                      <small>
                        {complete ? "Complete" : objective.required ? "Required" : "Optional"}
                      </small>
                    </li>
                  );
                })}
              </ul>
            </section>

            <section className="gw-info-panel">
              <h2>Public test examples</h2>
              <p className="gw-muted">
                Expected inputs and outputs. Run results appear below the
                editor.
              </p>

              {loaded.challenge.publicTests.map((testCase) => (
                <details className="gw-test-case" key={testCase.id}>
                  <summary>{testCase.id}</summary>
                  <p>Input</p>
                  <pre>{testCase.input}</pre>
                  <p>Expected output</p>
                  <pre>{testCase.expectedOutput}</pre>
                </details>
              ))}
            </section>
          </aside>
        </div>
      )}

      {(loadError || roomError) && (
        <div className="gw-recovery">
          <button
            className="copy-button"
            type="button"
            onClick={onReturnToEntry}
          >
            RETURN TO HOME
          </button>
          <p className="gw-muted">
            This clears your local room selection. Use Leave Room to leave on
            the server.
          </p>
        </div>
      )}
    </main>
  );
}