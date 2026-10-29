import { useEffect, useState } from "react";

type Phase =
  | "QUEUED"
  | "CHECKING"
  | "COMPLETED"
  | "ACCEPTED"
  | "REJECTED"
  | "FAILED"
  | "CANCELLED"
  | "UNKNOWN";

interface Job {
  id: string;
  matchId: string;
  action: "run" | "submit" | "sabotage";
  phase: Phase;
  position: number;
}

interface Props {
  roomCode: string;
  matchId: string | undefined;
}

const actionLabels: Record<Job["action"], string> = {
  run: "Public tests",
  submit: "Repair submission",
  sabotage: "Sabotage verification",
};

function description(job: Job): string {
  switch (job.phase) {
    case "QUEUED":
      return job.position > 0
        ? `Queue position ${job.position}. Your request will start automatically.`
        : "Waiting for validation to start.";

    case "CHECKING":
      return "Checking your request. You do not need to click again.";

    case "COMPLETED":
      return "Public tests finished. See the test results below.";

    case "ACCEPTED":
      return job.action === "submit"
        ? "Repair accepted."
        : "Sabotage accepted.";

    case "REJECTED":
      return "The request was not accepted. See the action message for details.";

    case "FAILED":
      return "The request could not finish. See the action message before retrying.";

    case "CANCELLED":
      return "The request was cancelled before validation began.";

    case "UNKNOWN":
      return "The connection ended before confirmation. Check the current match state before retrying.";
  }
}

export default function JudgeQueueStatus({
  roomCode,
  matchId,
}: Props) {
  const [job, setJob] = useState<Job | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    setJob(null);
    setUnavailable(false);

    if (!matchId) return;

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function refresh() {
      try {
        const token = window.sessionStorage.getItem(
          "ghostWriterSessionToken",
        );

        if (!token) return;

        const response = await fetch(
          `/rooms/${roomCode}/judge-status?matchId=${encodeURIComponent(matchId!)}`,
          {
            cache: "no-store",
            signal: controller.signal,
            headers: {
              Authorization: `Bearer ${token}`,
            },
          },
        );

        if (!response.ok) {
          throw new Error("Queue status unavailable.");
        }

        const result = await response.json() as {
          job: Job | null;
        };

        if (!controller.signal.aborted) {
          setJob(result.job);
          setUnavailable(false);
        }
      } catch {
        if (!controller.signal.aborted) {
          setUnavailable(true);
        }
      } finally {
        if (!controller.signal.aborted) {
          timer = window.setTimeout(() => void refresh(), 1000);
        }
      }
    }

    void refresh();

    return () => {
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [roomCode, matchId]);

  if (!job && !unavailable) return null;

  if (!job) {
    return (
      <div className="gw-judge-status" role="status">
        Queue status is temporarily unavailable.
      </div>
    );
  }

  const pending = job.phase === "QUEUED" || job.phase === "CHECKING";

  return (
    <section
      className={`gw-judge-status${pending ? " is-pending" : ""}`}
      aria-label="Your validation request"
      role="status"
      aria-live="polite"
    >
      <div className="gw-judge-status-heading">
        <strong>{actionLabels[job.action]}</strong>
        <span>{job.phase.replaceAll("_", " ")}</span>
      </div>

      <p>{description(job)}</p>

      {unavailable && (
        <p className="gw-muted">
          Reconnecting to queue status…
        </p>
      )}
    </section>
  );
}