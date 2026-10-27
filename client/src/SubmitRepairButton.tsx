import { useState } from "react";

interface ObjectiveResult {
  id: string;
  complete: boolean;
}

interface SubmitResponse {
  error?: string;
  compilerOutput?: string;
  objectiveResults?: ObjectiveResult[];
  codeVersion?: number;
}

interface Props {
  roomCode: string;
  matchId: string;
  codeVersion: number;
  source: string;
}

export default function SubmitRepairButton({
  roomCode,
  matchId,
  codeVersion,
  source,
}: Props) {
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [details, setDetails] = useState<string | null>(null);
  const [objectiveResults, setObjectiveResults] = useState<ObjectiveResult[]>([]);

  async function submitRepair() {
    setMessage(null);
    setDetails(null);
    setObjectiveResults([]);

    if (source.trim().length === 0) {
      setMessage("Write some C++ code before submitting.");
      return;
    }

    if (new TextEncoder().encode(source).length > 64 * 1024) {
      setMessage("Your draft exceeds the 64 KiB source limit.");
      return;
    }

    const sessionToken = window.sessionStorage.getItem(
      "ghostWriterSessionToken",
    );

    if (!sessionToken) {
      setMessage("Your session is missing. Return home and rejoin the room.");
      return;
    }

    setSubmitting(true);

    try {
      const response = await fetch(
        `/rooms/${encodeURIComponent(roomCode)}/submit`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${sessionToken}`,
          },
          body: JSON.stringify({
            source,
            matchId,
            baseVersion: codeVersion,
          }),
          cache: "no-store",
        },
      );

      const data = (await response.json()) as SubmitResponse;

      if (data.objectiveResults) {
        setObjectiveResults(data.objectiveResults);
      }

      if (!response.ok) {
        setMessage(data.error ?? "The repair could not be submitted.");

        if (data.compilerOutput) {
          setDetails(data.compilerOutput);
        }

        return;
      }

            setMessage(
        `Repair accepted as version ${data.codeVersion}. Your draft remains open. Use “Load Latest Official Code” when you’re ready to update the editor.`,
      );
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Could not reach the game server.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="gw-submit-repair">
      <button
        className="copy-button gw-run-button"
        type="button"
        onClick={() => void submitRepair()}
        disabled={submitting || source.trim().length === 0}
      >
        {submitting ? "VERIFYING REPAIR…" : "SUBMIT REPAIR"}
      </button>

      {message && (
        <p className="gw-editor-note" role="status">
          {message}
        </p>
      )}

      {details && <pre className="gw-run-output">{details}</pre>}

      {objectiveResults.length > 0 && (
        <ul aria-label="Objective verification results">
          {objectiveResults.map((objective) => (
            <li key={objective.id}>
              {objective.id}: {objective.complete ? "complete" : "needs work"}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}