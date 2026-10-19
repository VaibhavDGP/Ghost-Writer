import { useEffect, useState } from "react";
import Editor from "@monaco-editor/react";
import "./monaco-setup";
import "./GameWorkspace.css";

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

interface DraftProps {
  challenge: Challenge;
  storageKey: string;
  theme: "light" | "dark";
}

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

function DraftEditor({
  challenge,
  storageKey,
  theme,
}: DraftProps) {
  const [initialDraft] = useState(() =>
    readSavedDraft(storageKey, challenge.source),
  );

  const [draft, setDraft] = useState(initialDraft.source);
  const [storageError, setStorageError] = useState<string | null>(
    initialDraft.error,
  );

  const hasChanges = draft !== challenge.source;

  function updateDraft(nextSource: string) {
    setDraft(nextSource);

    try {
      window.sessionStorage.setItem(storageKey, nextSource);
      setStorageError(null);
    } catch {
      setStorageError(
        "Your edits are still in this editor, but could not be saved in this tab. Copy your code before refreshing.",
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

  return (
    <section
      className="gw-editor-panel"
      aria-label="Private C++ draft"
    >
      <div className="gw-editor-toolbar">
        <div>
          <strong>main.cpp</strong>
          <span className="gw-draft-label">PRIVATE DRAFT</span>
        </div>

        <button
          className="copy-button"
          type="button"
          onClick={resetDraft}
          disabled={!hasChanges}
        >
          RESET DRAFT
        </button>
      </div>

      <p className="gw-editor-note">
        Your edits stay in this browser tab. Other players continue
        to see the official code.
      </p>

      <div className="gw-editor-container">
        <Editor
          height="100%"
          language="cpp"
          theme={theme === "dark" ? "vs-dark" : "light"}
          value={draft}
          path={`file:///ghost-writer/${challenge.matchId}/main.cpp`}
          onChange={(value) => {
            if (value !== undefined) {
              updateDraft(value);
            }
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

        <span>
          {storageError ? "Draft not saved" : "Tab autosave enabled"}
        </span>
      </div>

      {storageError && (
        <p className="gw-warning" role="alert">
          {storageError}
        </p>
      )}

      <p className="gw-editor-note">
        Code execution and repair submission will be added next.
        Editing here does not update the shared program.
      </p>
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
          throw new Error(
            result.error ?? "Could not load the challenge.",
          );
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
          !Array.isArray(challenge.objectives) ||
          !Array.isArray(challenge.publicTests)
        ) {
          throw new Error(
            "The room has no valid generated challenge. Try starting a fresh room.",
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

    return () => {
      controller.abort();
    };
  }, [roomCode, attempt]);

  // A draft belongs to one player, match, and official source snapshot.
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
          className={`gw-role-badge ${
            role === "HACKER" ? "gw-role-hacker" : ""
          }`}
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
            storageKey={storageKey}
            challenge={loaded.challenge}
            theme={theme}
          />

          <aside className="gw-challenge-sidebar">
            <section className="gw-info-panel">
              <h2>Repair objectives</h2>

              <p className="gw-muted">
                Read these requirements while investigating the
                program. Completion is not evaluated yet.
              </p>

              <ul className="gw-objective-list">
                {loaded.challenge.objectives.map((objective) => (
                  <li key={objective.id}>
                    <p>{objective.description}</p>
                    <small>
                      {objective.required ? "Required" : "Optional"}
                    </small>
                  </li>
                ))}
              </ul>
            </section>

            <section className="gw-info-panel">
              <h2>Public test examples</h2>

              <p className="gw-muted">
                These are expected results, not results from
                running your draft.
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
            This clears your local room selection. Use Leave Room
            to leave on the server.
          </p>
        </div>
      )}
    </main>
  );
}