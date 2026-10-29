import type { FormEvent } from "react";

interface Props {
  theme: "light" | "dark";
  busy: "create" | "join" | null;
  notice: {
    kind: "success" | "error";
    text: string;
  } | null;
  onToggleTheme: () => void;
  onSubmit: (
    event: FormEvent<HTMLFormElement>,
    action: "create" | "join",
  ) => void;
}

function GhostEmblem() {
  return (
    <svg
      className="entry-emblem"
      viewBox="0 0 180 180"
      aria-hidden="true"
    >
      <circle
        cx="90"
        cy="90"
        r="76"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.16"
        strokeWidth="2"
      />
      <circle
        cx="90"
        cy="90"
        r="62"
        fill="currentColor"
        fillOpacity="0.05"
      />
      <path
        d="M56 82Q56 38 94 38Q133 38 133 82V142L115 131L97 145L78 131L56 143Z"
        fill="currentColor"
        fillOpacity="0.13"
        stroke="currentColor"
        strokeWidth="5"
        strokeLinejoin="round"
      />
      <path
        d="M82 61Q104 54 126 65V91Q104 100 80 88Q73 73 82 61Z"
        fill="currentColor"
        fillOpacity="0.35"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        d="M89 67Q103 63 116 68"
        fill="none"
        stroke="currentColor"
        strokeWidth="5"
        strokeLinecap="round"
      />
      <path
        d="M26 48V60M20 54H32M148 119V131M142 125H154"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        opacity="0.55"
      />
    </svg>
  );
}

export default function EntryScreen({
  theme,
  busy,
  notice,
  onToggleTheme,
  onSubmit,
}: Props) {
  return (
    <main className="page-shell entry-screen">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">GW</span>
          <span>GHOST WRITER</span>
        </div>

        <button
          className="theme-toggle"
          type="button"
          onClick={onToggleTheme}
          aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
        >
          {theme === "light" ? "DARK MODE" : "LIGHT MODE"}
        </button>
      </header>

      <section className="entry-hero" aria-labelledby="entry-title">
        <div>
          <span className="entry-player-count">2–8 PLAYERS</span>
          <h1 id="entry-title">
            GHOST
            <span>WRITER</span>
          </h1>
        </div>
        <GhostEmblem />
      </section>

      <section className="entry-forms" aria-label="Create or join a room">
        <form
          className="entry-form"
          onSubmit={(event) => onSubmit(event, "create")}
        >
          <div className="entry-form-heading">
            <span className="entry-form-icon" aria-hidden="true">+</span>
            <h2>Create a room</h2>
          </div>

          <label htmlFor="create-name">Player name</label>
          <input
            id="create-name"
            name="displayName"
            type="text"
            maxLength={40}
            placeholder="Enter your name"
            autoComplete="nickname"
            required
          />

          <button
            className="action-button primary-button"
            type="submit"
            disabled={busy !== null}
          >
            {busy === "create" ? "CREATING…" : "CREATE ROOM"}
            <span aria-hidden="true">→</span>
          </button>
        </form>

        <form
          className="entry-form"
          onSubmit={(event) => onSubmit(event, "join")}
        >
          <div className="entry-form-heading">
            <span className="entry-form-icon" aria-hidden="true">↳</span>
            <h2>Join a room</h2>
          </div>

          <label htmlFor="join-name">Player name</label>
          <input
            id="join-name"
            name="displayName"
            type="text"
            maxLength={40}
            placeholder="Enter your name"
            autoComplete="nickname"
            required
          />

          <label htmlFor="room-code">Room code</label>
          <input
            id="room-code"
            className="room-code-input"
            name="roomCode"
            type="text"
            minLength={6}
            maxLength={6}
            placeholder="A1B2C3"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              event.currentTarget.value = event.currentTarget.value
                .toUpperCase()
                .replace(/[^0-9A-F]/g, "")
                .slice(0, 6);
            }}
            required
          />

          <button
            className="action-button secondary-button"
            type="submit"
            disabled={busy !== null}
          >
            {busy === "join" ? "JOINING…" : "JOIN ROOM"}
            <span aria-hidden="true">→</span>
          </button>
        </form>
      </section>

      {notice && (
        <div
          className={`notice notice-${notice.kind} entry-notice`}
          role={notice.kind === "error" ? "alert" : "status"}
        >
          {notice.text}
        </div>
      )}
    </main>
  );
}