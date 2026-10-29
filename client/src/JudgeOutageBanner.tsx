interface Props {
  paused: boolean;
}

export default function JudgeOutageBanner({ paused }: Props) {
  if (!paused) return null;

  return (
    <div className="gw-judge-outage" role="status" aria-live="polite">
      <strong>Code validation temporarily unavailable</strong>

      <p>
        The coding timer and sabotage cooldowns are paused.
        You can continue editing. Meetings and voting remain available.
      </p>

      <p>
        The server is checking for recovery automatically.
        Retry failed validation requests once this message disappears.
      </p>
    </div>
  );
}