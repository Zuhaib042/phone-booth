import { createClient } from "../../../generated/typescript/client/index.js";
import {
  getLiveHealth,
  type LiveHealth,
} from "../../../generated/typescript/index.js";

export const EXPECTED_LIVE_RESPONSE: LiveHealth = { status: "ok" };

export function createProjectBoothClient(baseUrl: string) {
  const client = createClient({ baseUrl });

  return {
    getLiveHealth: () => getLiveHealth({ client }),
  };
}
