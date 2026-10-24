import { useEffect, useRef, useState } from "react";
import "./FullscreenControls.css";

async function setFullscreen(enabled: boolean): Promise<void> {
  if (enabled) {
    if (document.fullscreenElement) return;

    if (
      !document.fullscreenEnabled ||
      typeof document.documentElement.requestFullscreen !== "function"
    ) {
      throw new Error(
        "Fullscreen is unavailable in this browser. You can continue in windowed mode.",
      );
    }

    // Called directly from a click, as required by browsers.
    await document.documentElement.requestFullscreen();
    return;
  }

  if (document.fullscreenElement) {
    await document.exitFullscreen();
  }
}

export function FullscreenButton() {
  const [active, setActive] = useState(
    () => Boolean(document.fullscreenElement),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function synchronize() {
      setActive(Boolean(document.fullscreenElement));
      setError(null);
    }

    document.addEventListener("fullscreenchange", synchronize);
    synchronize();

    return () => {
      document.removeEventListener(
        "fullscreenchange",
        synchronize,
      );
    };
  }, []);

  async function toggle() {
    if (busy) return;

    setBusy(true);
    setError(null);

    try {
      await setFullscreen(!document.fullscreenElement);
      setActive(Boolean(document.fullscreenElement));
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not change fullscreen mode. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="gw-fullscreen-control">
      <button
        className="copy-button"
        type="button"
        onClick={() => void toggle()}
        disabled={busy}
        aria-pressed={active}
        title={
          active
            ? "Leave fullscreen without leaving the match"
            : "Enter fullscreen without restarting the match"
        }
      >
        {busy
          ? "SWITCHING…"
          : active
            ? "EXIT FULLSCREEN"
            : "ENTER FULLSCREEN"}
      </button>

      {error && (
        <p className="gw-fullscreen-message" role="status">
          {error}
        </p>
      )}
    </div>
  );
}

interface SetupProps {
  roomCode: string;
}

export function FullscreenSetup({ roomCode }: SetupProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const choosingRef = useRef(false);
  const [chosen, setChosen] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;

    if (!chosen && dialog && !dialog.open) {
      dialog.showModal();
    }

    return () => {
      if (dialog?.open) {
        dialog.close();
      }
    };
  }, [chosen]);

  async function choose(fullscreen: boolean) {
    if (choosingRef.current) return;
    choosingRef.current = true;

    // Close the dialog before requesting fullscreen on the page.
    dialogRef.current?.close();
    setChosen(true);
    setNote(null);

    try {
      await setFullscreen(fullscreen);
    } catch (cause) {
      setNote(
        cause instanceof Error
          ? cause.message
          : "Fullscreen could not be enabled. Continue in windowed mode.",
      );
    } finally {
      choosingRef.current = false;
    }
  }

  return (
    <section
      className="gw-fullscreen-setup"
      aria-label="Display mode"
    >
      <dialog
        ref={dialogRef}
        className="gw-fullscreen-dialog"
        aria-labelledby="gw-fullscreen-title"
        aria-describedby="gw-fullscreen-description"
        onCancel={(event) => {
          event.preventDefault();
          void choose(false);
        }}
      >
        <p className="eyebrow">ROOM {roomCode}</p>

        <h2 id="gw-fullscreen-title">
          How would you like to play?
        </h2>

        <p id="gw-fullscreen-description">
          Choose your display mode before readying up.
          When the countdown finishes, you’ll enter the
          game automatically.
        </p>

        <div className="gw-fullscreen-options">
          <button
            className="action-button primary-button"
            type="button"
            onClick={() => void choose(true)}
          >
            PLAY IN FULLSCREEN
          </button>

          <button
            className="action-button secondary-button"
            type="button"
            onClick={() => void choose(false)}
          >
            PLAY IN WINDOWED MODE
          </button>
        </div>

        <p className="gw-fullscreen-help">
          You can enter or exit fullscreen anytime during
          the match.
        </p>
      </dialog>

      {chosen && (
        <div className="gw-fullscreen-lobby">
          <FullscreenButton />

          {note && (
            <p className="gw-fullscreen-message" role="status">
              {note}
            </p>
          )}
        </div>
      )}
    </section>
  );
}