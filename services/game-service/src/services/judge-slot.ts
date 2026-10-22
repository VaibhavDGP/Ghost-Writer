let busy = false;

export function acquireJudgeSlot(): (() => void) | null {
  if (busy) {
    return null;
  }

  busy = true;
  let released = false;

  return () => {
    if (!released) {
      released = true;
      busy = false;
    }
  };
}