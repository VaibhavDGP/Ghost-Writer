interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface PendingJoin {
  code: string;
  displayName: string;
  sessionToken: string;
  requestId: string;
}

const PENDING_JOIN_KEY = "ghostWriterPendingJoin";

export function getJoinRequestId(
  storage: StorageLike,
  code: string,
  displayName: string,
  sessionToken: string,
  newId: () => string = () => globalThis.crypto.randomUUID(),
): string {
  const normalizedCode = code.trim().toUpperCase();
  const normalizedName = displayName.trim();
  try {
    const pending = JSON.parse(storage.getItem(PENDING_JOIN_KEY) ?? "null") as PendingJoin | null;
    if (
      pending?.code === normalizedCode &&
      pending.displayName === normalizedName &&
      pending.sessionToken === sessionToken &&
      typeof pending.requestId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(pending.requestId)
    ) {
      return pending.requestId;
    }
  } catch {
    // An invalid saved attempt must not prevent a fresh join.
  }

  const requestId = newId();
  storage.setItem(PENDING_JOIN_KEY, JSON.stringify({
    code: normalizedCode,
    displayName: normalizedName,
    sessionToken,
    requestId,
  }));
  return requestId;
}

export function clearPendingJoin(storage: StorageLike): void {
  storage.removeItem(PENDING_JOIN_KEY);
}

export function clearStoredRoom(storage: StorageLike): void {
  storage.removeItem("ghostWriterRoomCode");
  storage.removeItem("ghostWriterPlayerId");
  clearPendingJoin(storage);
}

export function roomResponseAction(status: number): "loaded" | "closed" | "retry" {
  if (status === 404) return "closed";
  if (status >= 200 && status < 300) return "loaded";
  return "retry";
}
