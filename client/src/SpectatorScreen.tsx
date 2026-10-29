import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { editor } from "monaco-editor";
import Editor from "@monaco-editor/react";
import "./monaco-setup";
import "./SpectatorScreen.css";

interface SpectatorPlayer {
  id: string;
  displayName: string;
  eliminated: boolean;
  departed: boolean;
}

interface Props {
  roomCode: string;
  matchId: string;
  playerId: string;
  players: SpectatorPlayer[];
  source: string;
  revision: number;
  remainingMs: number;
  lastDecision: string | null;
  children?: ReactNode;
}

const playedTransitions = new Set<string>();

function formatTime(milliseconds: number) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));

  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(
    seconds % 60,
  ).padStart(2, "0")}`;
}

function colorFor(id: string) {
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

function Suit({
  id,
  ghost = false,
}: {
  id: string;
  ghost?: boolean;
}) {
  return (
    <svg
      className={`gs-suit ${ghost ? "gs-suit-ghost" : ""}`}
      viewBox="0 0 72 86"
      aria-hidden="true"
    >
      {!ghost && (
        <path
          d="M19 33H10Q5 33 5 40V58Q5 64 12 64H20"
          fill={colorFor(id)}
          stroke="#152437"
          strokeWidth="4"
        />
      )}

      <path
        d={
          ghost
            ? "M17 34Q17 10 39 10Q62 10 62 35V76L52 69L42 78L32 69L17 77Z"
            : "M17 34Q17 10 39 10Q62 10 62 35V73Q62 79 53 79H45V64H33V79H24Q17 79 17 72Z"
        }
        fill={ghost ? "#a4dfed" : colorFor(id)}
        fillOpacity={ghost ? 0.24 : 1}
        stroke={ghost ? "#b9f1fc" : "#152437"}
        strokeWidth="4"
        strokeLinejoin="round"
      />

      <path
        d="M32 24Q45 20 58 26V42Q44 47 31 40Q26 32 32 24Z"
        fill={ghost ? "#d7f7ff" : "#bfeaf4"}
        fillOpacity={ghost ? 0.7 : 1}
        stroke={ghost ? "#83bfce" : "#152437"}
        strokeWidth="4"
      />

      <path
        d="M36 28Q44 25 52 28"
        fill="none"
        stroke="white"
        strokeWidth="4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CrackedVisor() {
  const cracks = [
    "M480 330L370 255L295 267L210 180L80 155L0 70",
    "M370 255L355 165L280 110L250 0",
    "M295 267L265 340L155 365L80 450L0 470",
    "M210 180L145 230L40 215L0 245",
    "M480 330L535 205L620 150L645 65L730 0",
    "M535 205L495 130L510 0",
    "M620 150L735 185L820 115L1000 80",
    "M480 330L640 350L720 295L845 320L1000 260",
    "M720 295L745 230L835 205",
    "M640 350L685 435L795 470L850 570L1000 600",
    "M480 330L460 455L380 515L360 615L280 700",
    "M460 455L555 505L595 615L690 700",
    "M380 515L250 490L160 570L0 620",
    "M555 505L660 535L700 620",
    "M452 310L490 290L515 325L495 360L455 351L452 310",
  ];

  return (
    <svg
      className="gs-cracks"
      viewBox="0 0 1000 700"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {cracks.map((path) => (
        <path key={path} d={path} pathLength={1} />
      ))}
    </svg>
  );
}

function LiveCode({
  source,
  matchId,
}: {
  source: string;
  matchId: string;
}) {
  const instanceRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const latestSource = useRef(source);
  latestSource.current = source;

  useEffect(() => {
    const instance = instanceRef.current;
    const model = instance?.getModel();

    if (!instance || !model || model.getValue() === source) return;

    // Keep the spectator's reading position when live code changes.
    const view = instance.saveViewState();

    model.applyEdits([
      {
        range: model.getFullModelRange(),
        text: source,
      },
    ]);

    if (view) instance.restoreViewState(view);
  }, [source]);

  return (
    <Editor
      height="100%"
      language="cpp"
      theme="ghost-dark"
      path={`file:///ghost-writer/spectator/${matchId}/main.cpp`}
      defaultValue={source}
      onMount={(instance) => {
        instanceRef.current = instance;
        const model = instance.getModel();

        if (model && model.getValue() !== latestSource.current) {
          model.setValue(latestSource.current);
        }
      }}
      loading={<p className="gs-loading">Connecting to the shared code…</p>}
      options={{
        readOnly: true,
        domReadOnly: true,
        automaticLayout: true,
        fontSize: 13,
        lineHeight: 22,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        wordWrap: "on",
        contextmenu: false,
        renderLineHighlight: "none",
        padding: { top: 16, bottom: 16 },
        ariaLabel: "Live shared code, spectator read-only view",
      }}
    />
  );
}

export default function SpectatorScreen({
  roomCode,
  matchId,
  playerId,
  players,
  source,
  revision,
  remainingMs,
  lastDecision,
  children,
}: Props) {
  const transitionKey =
    `ghostWriterSpectatorIntro:${roomCode}:${matchId}:${playerId}`;

  const [entering, setEntering] = useState(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return false;
    }

    if (playedTransitions.has(transitionKey)) return false;

    try {
      return sessionStorage.getItem(transitionKey) !== "seen";
    } catch {
      return true;
    }
  });

  useEffect(() => {
    playedTransitions.add(transitionKey);

    try {
      sessionStorage.setItem(transitionKey, "seen");
    } catch {
      // The in-memory record still prevents replay during this page visit.
    }

    if (!entering) return;

    const timer = window.setTimeout(() => setEntering(false), 2800);

    return () => window.clearTimeout(timer);
  }, [transitionKey, entering]);

  const alive = players.filter(
    (player) => !player.eliminated && !player.departed,
  ).length;

  const ghosts = players.filter(
    (player) => player.eliminated && !player.departed,
  ).length;

  return (
    <section
      className="gs-shell"
      data-entering={entering ? "true" : "false"}
      aria-label="Ghost spectator view"
    >
      <div className="gs-space" aria-hidden="true" />

      <div className="gs-content">
        <header className="gs-status">
          <div className="gs-identity">
            <span className="gs-hero-ghost">
              <Suit id={playerId} ghost />
            </span>

            <div>
              <p className="gs-eyebrow">Connection to crew lost</p>
              <h3>You’re a ghost now.</h3>
              <p className="gs-description">
                Watch the code. Follow the discussion. Your crew is still playing.
              </p>
            </div>
          </div>

          <div className="gs-clock">
            <span>Match remaining</span>
            <strong role="timer">{formatTime(remainingMs)}</strong>
          </div>
        </header>

        <div className="gs-layout">
          <section className="gs-code-panel" aria-label="Live code monitor">
            <div className="gs-code-header">
              <div>
                <span className="gs-live-dot" />
                <strong>Live code feed</strong>
              </div>
              <span className="gs-readonly">READ ONLY</span>
            </div>

            <div className="gs-editor">
              <LiveCode source={source} matchId={matchId} />
            </div>

            <div className="gs-code-footer">
              <span>main.cpp</span>
              <span>Revision {revision}</span>
            </div>
          </section>

          <aside className="gs-sidebar">
            <section className="gs-roster-panel">
              <div className="gs-panel-heading">
                <h4>Crew status</h4>
                <span>{alive} alive · {ghosts} ghosts</span>
              </div>

              <div className="gs-roster">
                {players.map((player) => {
                  const out = player.eliminated || player.departed;
                  const own = player.id === playerId;

                  return (
                    <div
                      key={player.id}
                      className={`gs-player ${out ? "gs-player-out" : ""} ${own ? "gs-player-you" : ""}`}
                    >
                      <span className="gs-player-avatar">
                        <Suit id={player.id} ghost={out} />
                        {out && <span className="gs-player-cross" aria-hidden="true">×</span>}
                      </span>

                      <div>
                        <strong>
                          {player.displayName}{own ? " (you)" : ""}
                        </strong>
                        <small>
                          {player.departed
                            ? "LEFT THE ROOM"
                            : out
                              ? "ELIMINATED"
                              : "STILL PLAYING"}
                        </small>
                      </div>

                      {!out && <span className="gs-alive-indicator" />}
                    </div>
                  );
                })}
              </div>
            </section>

            {lastDecision && (
              <section className="gs-note-panel">
                <p className="gs-eyebrow">Last vote</p>
                <p>{lastDecision}</p>
              </section>
            )}

            <section className="gs-note-panel gs-observer-note">
              <h4>Stay with the crew</h4>
              <p>
                Meetings appear automatically. You can watch the discussion
                and voting, but cannot send messages, vote, or change the code.
              </p>
            </section>

            {children}
          </aside>
        </div>
      </div>

      <CrackedVisor />

      {entering && (
        <div className="gs-elimination-intro" role="status">
          <div className="gs-intro-ghost">
            <Suit id={playerId} ghost />
          </div>
          <p>YOU WERE ELIMINATED</p>
          <span>Entering spectator mode</span>
        </div>
      )}
    </section>
  );
}