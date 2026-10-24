import { redis } from "../config/redis.js";
import { generateProceduralChallenge } from "./procedural-generator.js";

export async function generateUniqueChallenge(
  playerCount: number,
  reserve: (fingerprint: string) => Promise<boolean> =
    async (fingerprint) =>
      (
        await redis.sAdd(
          "ghost-writer:generated-specifications:v1",
          fingerprint,
        )
      ) === 1,
) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const challenge = generateProceduralChallenge(playerCount);

    const fingerprint =
      challenge.serverOnly.specificationHash!;

    if (await reserve(fingerprint)) {
      return challenge;
    }
  }

  throw new Error(
    "Could not reserve a new challenge specification. Retry the start.",
  );
}