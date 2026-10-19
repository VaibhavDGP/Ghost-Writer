import test from "node:test";
import assert from "node:assert/strict";
import {
  clearPendingJoin,
  clearStoredRoom,
  getJoinRequestId,
  roomResponseAction,
} from "../src/room-session.ts";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

test("a retry after an uncertain join reuses its saved request ID", () => {
  const storage = memoryStorage();
  const id = "00000000-0000-4000-8000-000000000001";
  assert.equal(getJoinRequestId(storage, "abc123", " Alice ", "token", () => id), id);
  assert.equal(getJoinRequestId(storage, "ABC123", "Alice", "token", () => {
    throw new Error("A retry must not allocate another ID");
  }), id);
});

test("a changed room, name, or session starts a new join attempt", () => {
  for (const changed of [
    ["DEF456", "Alice", "token"],
    ["ABC123", "Bob", "token"],
    ["ABC123", "Alice", "other-token"],
  ]) {
    const storage = memoryStorage();
    getJoinRequestId(storage, "ABC123", "Alice", "token", () => "00000000-0000-4000-8000-000000000001");
    const next = "00000000-0000-4000-8000-000000000002";
    assert.equal(getJoinRequestId(storage, ...changed, () => next), next);
  }
});

test("confirmed success clears the attempt; malformed saved data is recoverable", () => {
  const storage = memoryStorage();
  storage.setItem("ghostWriterPendingJoin", "not json");
  const id = "00000000-0000-4000-8000-000000000001";
  assert.equal(getJoinRequestId(storage, "ABC123", "Alice", "token", () => id), id);
  clearPendingJoin(storage);
  assert.equal(storage.getItem("ghostWriterPendingJoin"), null);
});

test("a missing room clears local room identity but preserves the session and theme", () => {
  const storage = memoryStorage();
  storage.setItem("ghostWriterRoomCode", "ABC123");
  storage.setItem("ghostWriterPlayerId", "player");
  storage.setItem("ghostWriterSessionToken", "session");
  storage.setItem("ghostWriterTheme", "dark");
  assert.equal(roomResponseAction(404), "closed");
  clearStoredRoom(storage);
  assert.equal(storage.getItem("ghostWriterRoomCode"), null);
  assert.equal(storage.getItem("ghostWriterPlayerId"), null);
  assert.equal(storage.getItem("ghostWriterSessionToken"), "session");
  assert.equal(storage.getItem("ghostWriterTheme"), "dark");
  assert.equal(roomResponseAction(503), "retry");
  assert.equal(roomResponseAction(200), "loaded");
});
