import { redis } from "../config/redis.js";
import type { GeneratedChallenge } from "../services/challenge-generator.js";

function serverChallengeKey(code: string): string {
  return `ghost-writer:room:${code}:server-challenge`;
}

export async function findServerChallenge(
  code: string,
): Promise<GeneratedChallenge["serverOnly"] | null> {
  const data = await redis.get(serverChallengeKey(code));

  if (data === null) {
    return null;
  }

  return JSON.parse(data) as GeneratedChallenge["serverOnly"];
}