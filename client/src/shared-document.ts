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

interface PendingEdit {
  name: string;
  lockId: string;
  revision: number;
  body: string;
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
  recovery: string | null;
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
};

export function sourceOf(snapshot: SharedSnapshot): string {
  let source = "";

  snapshot.names.forEach((name, index) => {
    source += snapshot.parts[index] + snapshot.functions[name].body;
  });

  return source + snapshot.parts[snapshot.names.length];
}

export async function postJSON<T>(
  path: string,
  body: unknown,
  timeoutMs = 120_000,
): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const token = sessionStorage.getItem("ghostWriterSessionToken");

    if (!token) throw new Error("Your player session is missing.");

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
      objectiveResults?: { id: string; complete: boolean }[];
    };

    if (!response.ok) {
      const objectives = result.objectiveResults?.map(
        (item) => `${item.id}: ${item.complete ? "complete" : "incomplete"}`,
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
  private pending: PendingEdit | null = null;
  private socket: WebSocket | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private editTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  private connected = false;
  private saving = false;
  private acting = false;
  private blocked = false;
  private error: string | null = null;
  private recovery: string | null = null;

  constructor(roomCode: string, notify: (view: LiveView) => void) {
    this.roomCode = roomCode;
    this.notify = notify;
  }

  private emit() {
    if (this.stopped) return;

    let snapshot = this.server;

    if (snapshot && this.pending) {
      const fn = snapshot.functions[this.pending.name];

      if (fn?.lockId === this.pending.lockId) {
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
      blocked: this.blocked,
      error: this.error,
      recovery: this.recovery,
    });
  }

  private accept(snapshot: SharedSnapshot) {
    if (this.stopped) return;

    if (
      this.server &&
      (
        snapshot.matchId !== this.server.matchId ||
        snapshot.revision < this.server.revision
      )
    ) {
      return;
    }

    if (this.pending) {
      const fn = snapshot.functions[this.pending.name];

      if (
        !fn ||
        fn.lockId !== this.pending.lockId ||
        fn.ownerId !== snapshot.playerId
      ) {
        this.recovery = this.pending.body;
        this.pending = null;
        this.blocked = false;
        this.error =
          "Your function lock ended. Any unsent text is preserved below.";
      }
    }

    this.server = snapshot;
    this.emit();
  }

  start() {
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.editTimer) clearTimeout(this.editTimer);
    this.socket?.close();
  }

  private connect() {
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
    const socket = new WebSocket(`${protocol}//${location.host}/rooms/live`);
    this.socket = socket;

    socket.onopen = () => {
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

          if (this.pending && !this.blocked) {
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

      this.retryTimer = setTimeout(() => this.connect(), 1500);
    };
  }

  edit(name: string, body: string) {
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
      this.blocked
    ) {
      return;
    }

    if (!this.pending) {
      this.pending = {
        name,
        lockId: fn.lockId,
        revision: fn.revision,
        body,
      };
    } else {
      this.pending.body = body;
    }

    this.emit();

    if (this.editTimer) clearTimeout(this.editTimer);
    this.editTimer = setTimeout(() => void this.flush(), 120);
  }

  private async request(
    action: string,
    input: Record<string, unknown>,
  ): Promise<DocumentReply> {
    if (!this.server) throw new Error("The document has not loaded.");

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

  private async flush() {
    if (
      this.stopped ||
      this.saving ||
      this.acting ||
      !this.connected ||
      this.blocked ||
      !this.pending
    ) {
      return;
    }

    const sent = { ...this.pending };
    this.saving = true;
    this.emit();

    try {
      const result = await this.request("EDIT", { ...sent });

      if (this.stopped) return;

      if (this.pending?.lockId === sent.lockId) {
        if (this.pending.body === sent.body) {
          this.pending = null;
        } else {
          this.pending.revision =
            result.snapshot.functions[sent.name].revision;
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
    } finally {
      this.saving = false;
      this.emit();

      if (this.pending && !this.blocked && !this.stopped) {
        this.editTimer = setTimeout(() => void this.flush(), 120);
      }
    }
  }

  retry() {
    this.blocked = false;
    this.error = null;
    this.emit();
    void this.flush();
  }

  useServerVersion() {
    if (this.saving || this.acting) return;

    if (this.pending) this.recovery = this.pending.body;

    this.pending = null;
    this.blocked = false;
    this.error = null;
    this.emit();
  }

  async action(action: "ACQUIRE" | "RELEASE", name: string) {
    if (
      !this.server ||
      !this.connected ||
      this.pending ||
      this.saving ||
      this.acting
    ) {
      throw new Error("Wait for your edits to synchronize first.");
    }

    const lockId = action === "ACQUIRE"
      ? crypto.randomUUID()
      : this.server.functions[name]?.lockId;

    if (!lockId) throw new Error("You no longer own this function.");

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
  const [connection, setConnection] = useState<LiveDocument | null>(null);

  useEffect(() => {
    setView(EMPTY);

    const live = new LiveDocument(roomCode, setView);
    setConnection(live);
    live.start();

    return () => live.stop();
  }, [roomCode]);

  return { ...view, connection };
}