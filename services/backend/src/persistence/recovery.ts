import type { UtcTimestamp } from "@project-booth/domain";

import { PostgresMatchRepository } from "./match-repository.js";
import { PostgresScheduledJobRepository } from "./scheduled-jobs.js";
import type { PostgresTransactionRunner } from "./transaction.js";

export class MatchRecoveryService {
  public constructor(
    private readonly transactions: PostgresTransactionRunner,
    private readonly matches = new PostgresMatchRepository(),
    private readonly scheduledJobs = new PostgresScheduledJobRepository(),
  ) {}

  public recoverActiveMatches(now: UtcTimestamp): Promise<number> {
    return this.transactions.run(async (client) => {
      const states = await this.matches.listActive(client);
      for (const state of states) {
        await this.scheduledJobs.synchronizeMatchDeadline(client, state, now);
      }
      return states.length;
    });
  }
}
