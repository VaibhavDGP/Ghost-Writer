import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import {
  hashSessionToken,
  isSessionToken,
} from "./services/session-service.js";
import { sharedDocumentStore } from "./stores/shared-document-store.js";
import { heartbeatRoom } from "./stores/presence-store.js";

export function attachSharedRealtime(server: Server): void {
  const sockets = new WebSocketServer({
    server,
    path: "/rooms/live",
    maxPayload: 4096,
    perMessageDeflate: false,
  });

  sockets.on("connection", (socket) => {
    let authenticated = false;
    let code = "";
    let tokenHash = "";
    let matchId = "";
    let previous = "";
    let polling = false;
    let alive = true;

    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;

    const authTimer = setTimeout(() => {
      socket.close(1008, "Authentication required");
    }, 5000);

    async function poll() {
      if (polling || socket.readyState !== WebSocket.OPEN) return;
      polling = true;

      try {
        const result = await sharedDocumentStore(
          code,
          tokenHash,
          "READ",
          matchId ? { matchId } : {},
        );

        if (result.outcome !== "OK" || !result.snapshot) {
          socket.send(JSON.stringify({
            error: result.outcome.toLowerCase().replaceAll("_", " "),
          }));
          socket.close(1008, "Document unavailable");
          return;
        }

        const snapshot = result.snapshot as { matchId: string };
        matchId = snapshot.matchId;

        const message = JSON.stringify({ snapshot });

        if (message !== previous) {
          if (socket.bufferedAmount > 256 * 1024) {
            socket.close(1013, "Reconnect for the latest document");
            return;
          }

          socket.send(message);
          previous = message;
        }
      } catch {
        socket.close(1011, "Document connection interrupted");
      } finally {
        polling = false;
      }
    }

    socket.on("message", async (raw) => {
      if (authenticated) return;

      // Reserve this connection's authentication attempt immediately.
      authenticated = true;

      try {
        const data = JSON.parse(raw.toString()) as {
          code?: unknown;
          sessionToken?: unknown;
        };

        if (
          typeof data.code !== "string" ||
          !/^[0-9A-F]{6}$/i.test(data.code) ||
          !isSessionToken(data.sessionToken)
        ) {
          socket.close(1008, "Invalid authentication");
          return;
        }

        code = data.code.toUpperCase();
        tokenHash = hashSessionToken(data.sessionToken);

        const heartbeat = await heartbeatRoom(code, tokenHash);

        if (heartbeat.outcome !== "OK") {
          socket.close(1008, "Invalid player session");
          return;
        }

        clearTimeout(authTimer);

        if (socket.readyState !== WebSocket.OPEN) return;

        await poll();

        if (socket.readyState !== WebSocket.OPEN) return;

        pollTimer = setInterval(() => void poll(), 250);

        pingTimer = setInterval(() => {
          if (!alive) {
            socket.terminate();
            return;
          }

          alive = false;
          socket.ping();
        }, 20_000);
      } catch {
        socket.close(1008, "Could not authenticate");
      }
    });

    socket.on("pong", () => {
      alive = true;

      if (!tokenHash) return;

      // Browser-level pong responses do not require mouse activity
      // or foreground-tab JavaScript timers.
      void heartbeatRoom(code, tokenHash)
        .then((result) => {
          if (result.outcome !== "OK") {
            socket.close(1008, "Player session ended");
          }
        })
        .catch(() => {
          socket.close(1011, "Presence unavailable");
        });
    });

    socket.on("error", () => {
      socket.terminate();
    });

    socket.on("close", () => {
      clearTimeout(authTimer);
      if (pollTimer) clearInterval(pollTimer);
      if (pingTimer) clearInterval(pingTimer);
    });
  });

  server.on("close", () => {
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
  });
}