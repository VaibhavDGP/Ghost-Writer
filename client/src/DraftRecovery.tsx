import { useState } from "react";
import type { useSharedDocument } from "./shared-document";

interface Props {
  live: ReturnType<typeof useSharedDocument>;
}

export default function DraftRecovery({ live }: Props) {
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const draft = live.recovery;

  async function copy() {
    if (!draft) return;

    try {
      await navigator.clipboard.writeText(draft.body);
      setCopyMessage("Recovered code copied.");
    } catch {
      setCopyMessage(
        "Clipboard access was unavailable. Select the text below and press Ctrl+C.",
      );
    }
  }

  function download() {
    if (!draft) return;

    const blob = new Blob([draft.body], {
      type: "text/plain;charset=utf-8",
    });

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    const functionName = draft.name.replace(
      /[^a-zA-Z0-9_-]/g,
      "_",
    );

    link.href = url;
    link.download = `ghost-writer-${functionName}-recovery.txt`;

    document.body.appendChild(link);
    link.click();
    link.remove();

    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function discard() {
    if (
      window.confirm(
        "Discard this local backup? Copy or download it first if you want to keep it.",
      )
    ) {
      live.connection?.discardRecovery();
      setCopyMessage(null);
    }
  }

  if (
    !draft &&
    !live.recoveryNotice &&
    !live.storageWarning
  ) {
    return null;
  }

  return (
    <section
      className="gw-recovery-panel"
      aria-label="Local edit recovery"
    >
      {live.storageWarning && (
        <p className="gw-warning" role="status">
          {live.storageWarning}
        </p>
      )}

      {live.recoveryNotice && (
        <div className="gw-recovery-notice">
          <p role="status">{live.recoveryNotice}</p>

          <button
            type="button"
            className="copy-button"
            onClick={() => live.connection?.dismissRecoveryNotice()}
          >
            DISMISS
          </button>
        </div>
      )}

      {draft && (
        <>
          <div className="gw-recovery-heading">
            <div>
              <p className="eyebrow">LOCAL BACKUP</p>
              <h2>Recovered unsent changes</h2>
            </div>

            <span className="gw-recovery-function">
              {draft.name}
            </span>
          </div>

          <p className="gw-muted">
            Saved in this tab at{" "}
            {new Date(draft.savedAt).toLocaleString()}.
            This contains the function body you were editing.
          </p>

          <p>
            {live.canRestoreRecovery
              ? "You still own this function and its server version matches. You can safely restore this draft."
              : "Automatic restoration is unavailable because the connection, ownership, version, or editing state no longer matches. You can still copy or download your text."}
          </p>

          <textarea
            readOnly
            spellCheck={false}
            value={draft.body}
            aria-label="Recovered unsent function body"
            onFocus={(event) => event.currentTarget.select()}
          />

          <div className="gw-recovery-actions">
            <button
              type="button"
              className="copy-button"
              disabled={!live.canRestoreRecovery}
              onClick={() => live.connection?.restoreRecovery()}
            >
              RESTORE DRAFT
            </button>

            <button
              type="button"
              className="copy-button"
              onClick={() => void copy()}
            >
              COPY CODE
            </button>

            <button
              type="button"
              className="copy-button"
              onClick={download}
            >
              DOWNLOAD BACKUP
            </button>

            <button
              type="button"
              className="copy-button"
              onClick={discard}
              disabled={live.saving || live.acting}
            >
              DISCARD BACKUP
            </button>
          </div>

          {copyMessage && (
            <p className="gw-muted" role="status">
              {copyMessage}
            </p>
          )}

          <p className="gw-muted">
            Restore synchronizes your draft with the shared editor.
            It does not submit a repair. Resolve this backup before
            starting another edit.
          </p>
        </>
      )}
    </section>
  );
}