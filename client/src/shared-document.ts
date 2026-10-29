import { useEffect, useState } from "react";

export interface SharedFunction {
  body: string;
  revision: number;
  ownerId: string | null;
  lockId: string | null;
  checking: boolean;
  accepted: boolean;
}

export interface SharedSnapshot {
  matchId: string;
  revision: number;
  codeVersion: number;
  playerId: string;
    editable: boolean;
  paused: boolean;
  judgePaused?: boolean;
  parts: string[];
  names: string[];
  functions: Record<string, SharedFunction>;
  players: {
    id: string;
    displayName: string;
    functionName: string | null;
    status: string;
  }[];
  objectives: {
    id: string;
    description: string;
    required: boolean;
  }[];
  completedObjectiveIds: string[];
  publicTests: {
    id: string;
    input: string;
    expectedOutput: string;
    objectives: string[];
  }[];
}

export interface RecoveryDraft {
  version: 1;
  roomCode: string;
  matchId: string;
  playerId: string;
  name: string;
  lockId: string;
  revision: number;
  baseBody: string;
  body: string;
  savedAt: number;
}

interface DocumentReply {
  snapshot: SharedSnapshot;
}

interface LiveView {
  snapshot: SharedSnapshot | null;
  connected: boolean;
  saving: boolean;
  acting: boolean;
  dirty: boolean;
  blocked: boolean;
  error: string | null;
  recovery: RecoveryDraft | null;
  canRestoreRecovery: boolean;
  recoveryNotice: string | null;
  storageWarning: string | null;
}

const EMPTY: LiveView = {
  snapshot: null,
  connected: false,
  saving: false,
  acting: false,
  dirty: false,
  blocked: false,
  error: null,
  recovery: null,
  canRestoreRecovery: false,
  recoveryNotice: null,
  storageWarning: null,
};

function backupKey(roomCode: string, snapshot: SharedSnapshot): string {
  return [
    "ghostWriterUnsentDraft:v1",
    roomCode,
    snapshot.matchId,
    snapshot.playerId,
  ].join(":");
}

function isRecoveryDraft(value: unknown): value is RecoveryDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const draft = value as Record<string, unknown>;

  return (
    draft.version === 1 &&
    typeof draft.roomCode === "string" &&
    typeof draft.matchId === "string" &&
    typeof draft.playerId === "string" &&
    typeof draft.name === "string" &&
    draft.name.length > 0 &&
    typeof draft.lockId === "string" &&
    draft.lockId.length > 0 &&
    typeof draft.revision === "number" &&
    Number.isSafeInteger(draft.revision) &&
    draft.revision >= 0 &&
    typeof draft.baseBody === "string" &&
    draft.baseBody.length <= 65536 &&
    typeof draft.body === "string" &&
    draft.body.length <= 65536 &&
    typeof draft.savedAt === "number" &&
    Number.isSafeInteger(draft.savedAt) &&
    draft.savedAt >= 0 &&
    draft.savedAt <= 8_640_000_000_000_000
  );
}

export function sourceOf(snapshot: SharedSnapshot): string {
  let source = "";

  snapshot.names.forEach((name, index) => {
    source += snapshot.parts[index] + snapshot.functions[name]!.body;
  });

  return source + snapshot.parts[snapshot.names.length];
}

export async function postJSON<T>(
  path: string,
  body: unknown,
  timeoutMs = /\/(?:run|submit)$/.test(path)
    ? 600_000
    : 120_000,
): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(
    () => controller.abort(),
    timeoutMs,
  );

  try {
    const token = sessionStorage.getItem("ghostWriterSessionToken");

    if (!token) {
      throw new Error("Your player session is missing.");
    }

    const response = await fetch(path, {
      method: "POST",
      cache: "no-store",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

    const result = await response.json() as {
      error?: string;
      compilerOutput?: string;
      objectiveResults?: {
        id: string;
        complete: boolean;
      }[];
    };

    if (!response.ok) {
      const objectives = result.objectiveResults?.map(
        (item) =>
          `${item.id}: ${item.complete ? "complete" : "incomplete"}`,
      ).join("\n");

      throw new Error(
        [
          result.error ?? "The request failed.",
          result.compilerOutput,
          objectives,
        ].filter(Boolean).join("\n"),
      );
    }

    return result as T;
  } finally {
    window.clearTimeout(timeout);
  }
}

export class LiveDocument {
  private roomCode: string;
  private notify: (view: LiveView) => void;

  private server: SharedSnapshot | null = null;
  private pending: RecoveryDraft | null = null;
  private recovery: RecoveryDraft | null = null;

  private socket: WebSocket | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private editTimer: ReturnType<typeof setTimeout> | null = null;

  private loadedBackup = false;
  private stopped = false;
  private connected = false;
  private saving = false;
  private acting = false;
  private blocked = false;

  private error: string | null = null;
  private recoveryNotice: string | null = null;
  private storageWarning: string | null = null;

  constructor(roomCode: string, notify: (view: LiveView) => void) {
    this.roomCode = roomCode;
    this.notify = notify;
  }

  private persist(draft: RecoveryDraft): void {
    if (!this.server || this.stopped) return;

    try {
      // Synchronous write before the debounced network request.
      sessionStorage.setItem(
        backupKey(this.roomCode, this.server),
        JSON.stringify(draft),
      );

      this.storageWarning = null;
    } catch {
      this.storageWarning =
        "Local backup is unavailable. Keep this tab open until edits synchronize.";
    }
  }

  private clearBackup(): void {
    if (!this.server || this.stopped) return;

    try {
      sessionStorage.removeItem(
        backupKey(this.roomCode, this.server),
      );

      this.storageWarning = null;
    } catch {
      this.storageWarning =
        "The browser could not clear the local backup. It may appear again after refresh.";
    }
  }

  private loadBackup(): void {
    if (!this.server || this.loadedBackup) return;
    this.loadedBackup = true;

    try {
      const raw = sessionStorage.getItem(
        backupKey(this.roomCode, this.server),
      );

      if (!raw) return;

      const value: unknown = JSON.parse(raw);

      if (
        !isRecoveryDraft(value) ||
        value.roomCode !== this.roomCode ||
        value.matchId !== this.server.matchId ||
        value.playerId !== this.server.playerId
      ) {
        this.storageWarning =
          "A local backup could not be read safely. It was not restored.";
        return;
      }

      const fn = this.server.functions[value.name];

      if (fn?.body === value.body) {
        // The server received the edit before the previous page closed.
        this.clearBackup();
        this.recoveryNotice =
          "Your previous edits were already synchronized.";
        return;
      }

      this.recovery = value;
      this.recoveryNotice = null;
    } catch {
      this.storageWarning =
        "The browser could not read your local edit backup.";
    }
  }

  private canRestore(): boolean {
    const draft = this.recovery;
    const snapshot = this.server;

    if (
      !draft ||
      !snapshot ||
      !this.connected ||
      this.saving ||
      this.acting ||
      this.pending ||
      !snapshot.editable
    ) {
      return false;
    }

    const fn = snapshot.functions[draft.name];

    return Boolean(
      draft.matchId === snapshot.matchId &&
      draft.playerId === snapshot.playerId &&
      fn &&
      fn.ownerId === snapshot.playerId &&
      fn.lockId === draft.lockId &&
      fn.revision === draft.revision &&
      fn.body === draft.baseBody &&
      !fn.checking,
    );
  }

  private preservePending(message: string): void {
    if (!this.pending) return;

    this.recovery = { ...this.pending };
    this.pending = null;
    this.blocked = false;
    this.error = message;

    this.persist(this.recovery);
  }

  private reconcile(): void {
    const snapshot = this.server;
    if (!snapshot) return;

    // A request from the previous page may finish after refresh.
    // If its exact text is now present, no restoration is necessary.
    if (this.recovery) {
      const fn = snapshot.functions[this.recovery.name];

      if (fn?.body === this.recovery.body) {
        this.recovery = null;
        this.clearBackup();
        this.recoveryNotice =
          "Your recovered text is already present in the shared document.";
      }
    }

    const draft = this.pending;
    if (!draft) return;

    const fn = snapshot.functions[draft.name];

    if (
      !fn ||
      fn.lockId !== draft.lockId ||
      fn.ownerId !== snapshot.playerId
    ) {
      this.preservePending(
        "Your function ownership ended. Unsent text is preserved in the recovery panel.",
      );
      return;
    }

    // While an EDIT is in flight, its HTTP response determines which
    // revision the next buffered edit should use.
    if (this.saving) return;

    if (fn.body === draft.body) {
      this.pending = null;
      this.blocked = false;
      this.error = null;
      this.clearBackup();
      return;
    }

    if (
      fn.revision !== draft.revision ||
      fn.body !== draft.baseBody
    ) {
      this.preservePending(
        "The server version changed. Your unsent text was preserved without overwriting it.",
      );
    }
  }

  private emit(): void {
    if (this.stopped) return;

    let snapshot = this.server;

    if (snapshot && this.pending) {
      const fn = snapshot.functions[this.pending.name];

      if (
        fn?.lockId === this.pending.lockId &&
        fn.ownerId === snapshot.playerId
      ) {
        snapshot = {
          ...snapshot,
          functions: {
            ...snapshot.functions,
            [this.pending.name]: {
              ...fn,
              body: this.pending.body,
              accepted: false,
            },
          },
        };
      }
    }

    this.notify({
      snapshot,
      connected: this.connected,
      saving: this.saving,
      acting: this.acting,
      dirty: this.pending !== null,
      // Resolve recovery before starting another edit, so a new
      // draft cannot replace an unresolved local backup.
      blocked: this.blocked || this.recovery !== null,
      error: this.error,
      recovery: this.recovery,
      canRestoreRecovery: this.canRestore(),
      recoveryNotice: this.recoveryNotice,
      storageWarning: this.storageWarning,
    });
  }

  private accept(snapshot: SharedSnapshot): void {
    if (this.stopped) return;

    if (
      this.server &&
      (
        snapshot.matchId !== this.server.matchId ||
        snapshot.playerId !== this.server.playerId ||
        snapshot.revision < this.server.revision
      )
    ) {
      return;
    }

    this.server = snapshot;
    this.loadBackup();
    this.reconcile();
    this.emit();
  }

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;

    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.editTimer) clearTimeout(this.editTimer);

    // Every edit is already backed up synchronously.
    // Do not clear its backup during unmount or refresh.
    this.socket?.close();
  }

  private connect(): void {
    if (this.stopped) return;

    let token: string | null;

    try {
      token = sessionStorage.getItem("ghostWriterSessionToken");
    } catch {
      token = null;
    }

    if (!token) {
      this.error = "Your player session is missing.";
      this.emit();
      return;
    }

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(
      `${protocol}//${location.host}/rooms/live`,
    );

    this.socket = socket;

    socket.onopen = () => {
      if (this.stopped || this.socket !== socket) {
        socket.close();
        return;
      }

      socket.send(JSON.stringify({
        code: this.roomCode,
        sessionToken: token,
      }));
    };

    socket.onmessage = (event) => {
      if (this.stopped || this.socket !== socket) return;

      try {
        const message = JSON.parse(String(event.data)) as {
          snapshot?: SharedSnapshot;
          error?: string;
        };

        if (message.snapshot) {
          this.connected = true;
          this.accept(message.snapshot);

          if (this.pending && !this.blocked && !this.recovery) {
            void this.flush();
          }
        } else if (message.error) {
          this.error = message.error;
          this.emit();
        }
      } catch {
        socket.close();
      }
    };

    socket.onerror = () => socket.close();

    socket.onclose = () => {
      if (this.stopped || this.socket !== socket) return;

      this.connected = false;
      this.emit();

      this.retryTimer = setTimeout(
        () => this.connect(),
        1500,
      );
    };
  }

  edit(name: string, body: string): void {
    const snapshot = this.server;
    const fn = snapshot?.functions[name];

    if (
      !snapshot ||
      !fn?.lockId ||
      fn.ownerId !== snapshot.playerId ||
      fn.checking ||
      !snapshot.editable ||
      !this.connected ||
      this.acting ||
      this.blocked ||
      this.recovery
    ) {
      return;
    }

    if (
      this.pending &&
      (
        this.pending.name !== name ||
        this.pending.lockId !== fn.lockId
      )
    ) {
      return;
    }

    if (!this.pending) {
      if (body === fn.body) return;

      this.pending = {
        version: 1,
        roomCode: this.roomCode,
        matchId: snapshot.matchId,
        playerId: snapshot.playerId,
        name,
        lockId: fn.lockId,
        revision: fn.revision,
        baseBody: fn.body,
        body,
        savedAt: Date.now(),
      };
    } else {
      this.pending.body = body;
      this.pending.savedAt = Date.now();
    }

    this.persist(this.pending);
    this.emit();

    if (this.editTimer) clearTimeout(this.editTimer);

    this.editTimer = setTimeout(
      () => void this.flush(),
      120,
    );
  }

  private async request(
    action: string,
    input: Record<string, unknown>,
  ): Promise<DocumentReply> {
    if (!this.server) {
      throw new Error("The document has not loaded.");
    }

    return postJSON<DocumentReply>(
      `/rooms/${this.roomCode}/document`,
      {
        ...input,
        action,
        matchId: this.server.matchId,
      },
      15_000,
    );
  }

  private async flush(): Promise<void> {
    if (
      this.stopped ||
      this.saving ||
      this.acting ||
      !this.connected ||
      this.blocked ||
      this.recovery ||
      !this.pending
    ) {
      return;
    }

    this.reconcile();

    const draft = this.pending;
    const fn = draft
      ? this.server?.functions[draft.name]
      : undefined;

    if (
      !draft ||
      !fn ||
      !this.server?.editable ||
      fn.checking
    ) {
      this.emit();
      return;
    }

    const sent = { ...draft };
    this.saving = true;
    this.emit();

    try {
      const result = await this.request("EDIT", {
        name: sent.name,
        lockId: sent.lockId,
        revision: sent.revision,
        body: sent.body,
      });

      if (this.stopped) return;

      const saved = result.snapshot.functions[sent.name];

      if (
        !saved ||
        saved.body !== sent.body ||
        saved.lockId !== sent.lockId
      ) {
        throw new Error(
          "The edit could not be confirmed. Your local text is preserved.",
        );
      }

      if (
        this.pending?.name === sent.name &&
        this.pending.lockId === sent.lockId
      ) {
        if (this.pending.body === sent.body) {
          this.pending = null;
          this.clearBackup();
        } else {
          // More typing occurred while this request was running.
          // Preserve it against the newly acknowledged revision.
          this.pending.revision = saved.revision;
          this.pending.baseBody = sent.body;
          this.persist(this.pending);
        }
      }

      this.error = null;
      this.accept(result.snapshot);
    } catch (error) {
      if (this.stopped) return;

      this.blocked = true;
      this.error = error instanceof Error
        ? error.message
        : "Could not synchronize your edit.";

      if (this.pending) this.persist(this.pending);
    } finally {
      this.saving = false;

      if (!this.stopped) {
        this.reconcile();
        this.emit();

        if (this.pending && !this.blocked && !this.recovery) {
          this.editTimer = setTimeout(
            () => void this.flush(),
            120,
          );
        }
      }
    }
  }

  retry(): void {
    if (this.recovery) {
      this.error =
        "Use the recovery panel to restore or save your recovered text first.";
      this.emit();
      return;
    }

    this.blocked = false;
    this.error = null;
    this.reconcile();
    this.emit();
    void this.flush();
  }

  useServerVersion(): void {
    if (this.saving || this.acting) return;

    if (this.pending) {
      this.preservePending(
        "The server version is displayed. Your unsent text remains in the recovery panel.",
      );
    } else {
      this.blocked = false;
      this.error = null;
    }

    this.emit();
  }

  restoreRecovery(): void {
    if (!this.canRestore() || !this.recovery) {
      this.error =
        "This backup cannot be restored safely. Copy or download it instead.";
      this.emit();
      return;
    }

    this.pending = {
      ...this.recovery,
      savedAt: Date.now(),
    };

    this.recovery = null;
    this.blocked = false;
    this.error = null;
    this.recoveryNotice =
      "Recovered changes restored. Check the editor's synchronization status.";

    this.persist(this.pending);
    this.emit();

    // This only synchronizes an edit. It never submits a repair.
    void this.flush();
  }

  discardRecovery(): void {
    if (this.saving || this.acting || !this.recovery) return;

    this.recovery = null;
    this.blocked = false;
    this.error = null;
    this.recoveryNotice = null;
    this.clearBackup();
    this.emit();
  }

  dismissRecoveryNotice(): void {
    this.recoveryNotice = null;
    this.emit();
  }

  async action(
    action: "ACQUIRE" | "RELEASE",
    name: string,
  ): Promise<void> {
    if (
      !this.server ||
      !this.connected ||
      this.pending ||
      this.recovery ||
      this.saving ||
      this.acting ||
      this.blocked
    ) {
      throw new Error(
        "Synchronize or resolve your recovered edits first.",
      );
    }

    const lockId = action === "ACQUIRE"
      ? crypto.randomUUID()
      : this.server.functions[name]?.lockId;

    if (!lockId) {
      throw new Error("You no longer own this function.");
    }

    this.acting = true;
    this.error = null;
    this.emit();

    try {
      const result = await this.request(action, { name, lockId });
      this.accept(result.snapshot);
    } finally {
      this.acting = false;
      this.emit();
    }
  }
}

export function useSharedDocument(roomCode: string) {
  const [view, setView] = useState<LiveView>(EMPTY);
  const [connection, setConnection] =
    useState<LiveDocument | null>(null);

  useEffect(() => {
    setView(EMPTY);

    const live = new LiveDocument(roomCode, setView);
    setConnection(live);
    live.start();

    return () => live.stop();
  }, [roomCode]);

  return { ...view, connection };
}