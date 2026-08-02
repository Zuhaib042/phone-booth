import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { DEFAULT_RULESET_V1, parseRulesetV1 } from "@project-booth/config";
import type { MatchId, UserId, UtcTimestamp } from "@project-booth/domain";
import {
  applyLobbyCommand,
  applyRoundCommand,
  createMatchState,
  type CompletedRound,
  type MatchState,
} from "@project-booth/game-engine";
import { Pool } from "pg";

import {
  EconomyError,
  type EconomyConfig,
  PostgresEconomyService,
} from "../src/economy/service.js";
import { PostgresCoinLedger } from "../src/economy/ledger.js";
import { PostgresMatchApplication } from "../src/matches/service.js";
import { MatchDeadlineHandler } from "../src/persistence/deadline-handler.js";
import { PostgresMatchCommandExecutor } from "../src/persistence/match-command-executor.js";
import { PostgresMatchRepository } from "../src/persistence/match-repository.js";
import { runMigrations } from "../src/persistence/migrations.js";
import { PostgresTransactionRunner } from "../src/persistence/transaction.js";

const { TEST_DATABASE_URL: DATABASE_URL } = process.env;

const CONFIG: EconomyConfig = {
  cosmetics: { "cosmetic.fixture": 500 },
  grants: { "grant.fixture.seed": 10_000 },
  matchOutflowCap: 5_000,
  minimumOfferIncrement: 50,
};

function negotiationState(
  matchId: MatchId,
  players: readonly UserId[],
): MatchState {
  const ruleset = parseRulesetV1(structuredClone(DEFAULT_RULESET_V1));
  assert.equal(ruleset.ok, true);
  if (!ruleset.ok) {
    throw new Error("Fixture ruleset is invalid");
  }
  const created = createMatchState({
    lobbyDeadline: "2026-07-30T12:01:00.000Z" as UtcTimestamp,
    matchId,
    playerIds: players,
    ruleset: ruleset.value,
  });
  assert.equal(created.ok, true);
  if (!created.ok) {
    throw new Error("Fixture match is invalid");
  }
  let state = created.value;
  for (const playerId of players) {
    if (state.phase !== "lobby") {
      break;
    }
    const ready = applyLobbyCommand(state, {
      type: "contestant_ready",
      playerId,
      occurredAt: "2026-07-30T12:00:00.000Z" as UtcTimestamp,
    });
    assert.equal(ready.ok, true);
    if (!ready.ok) {
      throw new Error("Fixture contestant could not become ready");
    }
    state = ready.value.state;
  }
  assert.equal(state.phase, "negotiation");
  return state;
}

function completedStateWithBallot(
  state: MatchState,
  recipient: UserId,
  target: UserId,
): MatchState {
  const round: CompletedRound = {
    automaticSelfVotes: [],
    eliminatedPlayerId: state.roster[5]?.playerId as UserId,
    normalBallots: [
      {
        revision: 2,
        submittedAt: "2026-07-30T12:02:00.000Z" as UtcTimestamp,
        targetId: target,
        voterId: recipient,
      },
    ],
    normalVoteTotals: [],
    runoffBallots: [],
    runoffPlayerIds: [],
    runoffVoteTotals: [],
    tieResolutionMethod: null,
  };
  return {
    ...state,
    completedRounds: [round],
    phase: "complete",
    phaseDeadline: null,
  };
}

test(
  "M8 ledger, offers, bribes, races, settlement, reversal, and dossier invariants",
  { skip: DATABASE_URL === undefined },
  async () => {
    assert.notEqual(DATABASE_URL, undefined);
    const schema = `m8_economy_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({
      connectionString: DATABASE_URL as string,
      max: 2,
    });
    let pool: Pool | undefined;

    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      pool = new Pool({
        connectionString: DATABASE_URL as string,
        max: 30,
        options: `-c search_path=${schema}`,
      });
      await runMigrations(pool);
      const transactions = new PostgresTransactionRunner(pool, {
        retryBaseDelayMilliseconds: 1,
      });
      const players = Array.from({ length: 6 }, () => randomUUID()) as UserId[];
      const now = new Date("2026-07-30T12:00:30.000Z");
      for (const player of players) {
        await pool.query("INSERT INTO users (id) VALUES ($1)", [player]);
      }
      const matchId = randomUUID() as MatchId;
      const state = negotiationState(matchId, players);
      await transactions.run((client) =>
        new PostgresMatchRepository().create(
          client,
          state,
          now.toISOString() as UtcTimestamp,
        ),
      );
      const service = new PostgresEconomyService(
        transactions,
        CONFIG,
        () => new Date(now),
      );

      for (const sender of players.slice(0, 3)) {
        await service.grantCoins(
          sender as string,
          "grant.fixture.seed",
          "new-account",
          randomUUID(),
        );
      }
      const duplicateGrant = await service.grantCoins(
        players[0] as string,
        "grant.fixture.seed",
        "new-account",
        randomUUID(),
      );
      assert.equal(duplicateGrant.replayed, true);
      assert.equal(
        (await service.wallet(players[0] as string)).spendable,
        10_000,
      );

      const playerZeroAccount = await pool.query<{ id: string }>(
        "SELECT id FROM coin_accounts WHERE owner_user_id = $1",
        [players[0]],
      );
      const playerZeroAccountId = playerZeroAccount.rows[0]?.id;
      assert.notEqual(playerZeroAccountId, undefined);
      const ledger = new PostgresCoinLedger();
      await transactions.run((client) =>
        ledger.post(client, {
          createdAt: now.toISOString(),
          kind: "bucket_reserve",
          postings: [
            {
              accountId: playerZeroAccountId as string,
              amount: -100n,
              bucket: "spendable",
            },
            {
              accountId: playerZeroAccountId as string,
              amount: 100n,
              bucket: "reserved",
            },
          ],
          sourceKey: "reserve-fixture",
          sourceOperation: "bucket.reserve",
          transactionId: randomUUID(),
        }),
      );
      assert.equal((await service.wallet(players[0] as string)).reserved, 100);
      await assert.rejects(
        transactions.run((client) =>
          ledger.post(client, {
            createdAt: now.toISOString(),
            kind: "bucket_reserve",
            postings: [
              {
                accountId: playerZeroAccountId as string,
                amount: -20_000n,
                bucket: "spendable",
              },
              {
                accountId: playerZeroAccountId as string,
                amount: 20_000n,
                bucket: "reserved",
              },
            ],
            sourceKey: "reserve-too-much",
            sourceOperation: "bucket.reserve",
            transactionId: randomUUID(),
          }),
        ),
      );
      assert.deepEqual(
        {
          reserved: (await service.wallet(players[0] as string)).reserved,
          spendable: (await service.wallet(players[0] as string)).spendable,
        },
        { reserved: 100, spendable: 9_900 },
      );
      await transactions.run((client) =>
        ledger.post(client, {
          createdAt: now.toISOString(),
          kind: "bucket_release",
          postings: [
            {
              accountId: playerZeroAccountId as string,
              amount: -100n,
              bucket: "reserved",
            },
            {
              accountId: playerZeroAccountId as string,
              amount: 100n,
              bucket: "spendable",
            },
          ],
          sourceKey: "release-fixture",
          sourceOperation: "bucket.release",
          transactionId: randomUUID(),
        }),
      );

      const purchase = await service.purchaseCosmetic(
        players[0] as string,
        "cosmetic.fixture",
        randomUUID(),
      );
      const duplicatePurchase = await service.purchaseCosmetic(
        players[0] as string,
        "cosmetic.fixture",
        randomUUID(),
      );
      assert.equal(
        purchase.value.purchaseId,
        duplicatePurchase.value.purchaseId,
      );
      assert.equal(duplicatePurchase.replayed, true);
      assert.equal(
        (await service.wallet(players[0] as string)).spendable,
        9_500,
      );

      assert.throws(
        () =>
          service.createBribeOffer(
            players[0] as string,
            matchId,
            randomUUID(),
            {
              amount: 25,
              recipientUserId: players[2] as string,
              requestedTargetUserId: players[3] as string,
            },
          ),
        (error: unknown) =>
          error instanceof EconomyError && error.code === "invalid_amount",
      );
      assert.throws(
        () =>
          service.createBribeOffer(
            players[0] as string,
            matchId,
            randomUUID(),
            {
              amount: 50,
              message: "Find me at example dot com",
              recipientUserId: players[2] as string,
              requestedTargetUserId: players[3] as string,
            },
          ),
        (error: unknown) =>
          error instanceof EconomyError && error.code === "invalid_offer",
      );
      assert.throws(
        () =>
          service.createBribeOffer(
            players[0] as string,
            matchId,
            randomUUID(),
            {
              amount: 50,
              recipientUserId: players[0] as string,
              requestedTargetUserId: players[3] as string,
            },
          ),
        (error: unknown) =>
          error instanceof EconomyError && error.code === "invalid_offer",
      );
      await assert.rejects(
        service.createBribeOffer(players[0] as string, matchId, randomUUID(), {
          amount: 50,
          recipientUserId: players[2] as string,
          requestedTargetUserId: randomUUID(),
        }),
        (error: unknown) =>
          error instanceof EconomyError && error.code === "invalid_offer",
      );

      const replaced = await service.createBribeOffer(
        players[0] as string,
        matchId,
        randomUUID(),
        {
          amount: 100,
          recipientUserId: players[2] as string,
          requestedTargetUserId: players[3] as string,
        },
      );
      const honored = await service.createBribeOffer(
        players[0] as string,
        matchId,
        randomUUID(),
        {
          amount: 200,
          message: "Vote with me",
          recipientUserId: players[2] as string,
          requestedTargetUserId: players[3] as string,
        },
      );
      const replacedOffers = await service.listBribeOffers(
        players[0] as string,
        matchId,
      );
      assert.equal(
        replacedOffers.find(({ offerId }) => offerId === replaced.value.offerId)
          ?.state,
        "expired",
      );
      const betrayed = await service.createBribeOffer(
        players[1] as string,
        matchId,
        randomUUID(),
        {
          amount: 150,
          recipientUserId: players[2] as string,
          requestedTargetUserId: players[4] as string,
        },
      );
      const declined = await service.createBribeOffer(
        players[2] as string,
        matchId,
        randomUUID(),
        {
          amount: 50,
          recipientUserId: players[4] as string,
          requestedTargetUserId: players[5] as string,
        },
      );
      assert.equal(
        (
          await service.declineBribeOffer(
            players[4] as string,
            declined.value.offerId,
            randomUUID(),
          )
        ).value.state,
        "declined",
      );
      const simultaneous = await Promise.all([
        service.acceptBribeOffer(
          players[2] as string,
          honored.value.offerId,
          randomUUID(),
        ),
        service.acceptBribeOffer(
          players[2] as string,
          honored.value.offerId,
          randomUUID(),
        ),
      ]);
      assert.equal(
        simultaneous.every(({ value }) => value.state === "accepted"),
        true,
      );
      assert.equal(
        (
          await pool.query<{ count: string }>(
            `
              SELECT count(*)
              FROM ledger_transactions
              WHERE source_operation = 'bribe.accept' AND source_key = $1
            `,
            [honored.value.offerId],
          )
        ).rows[0]?.count,
        "1",
      );
      await service.acceptBribeOffer(
        players[2] as string,
        betrayed.value.offerId,
        randomUUID(),
      );
      assert.deepEqual(await service.wallet(players[2] as string), {
        pending: 350,
        reserved: 0,
        restricted: false,
        spendable: 10_000,
      });
      assert.deepEqual(
        (await service.wallet(players[0] as string, matchId)).matchAllowance,
        { acceptedOutflow: 200, cap: 5_000, remaining: 4_800 },
      );

      const settled = await service.settleIncomingAfterBallot(
        matchId,
        players[2] as string,
        1,
      );
      assert.equal(settled, 350);
      assert.deepEqual(await service.wallet(players[2] as string), {
        pending: 0,
        reserved: 0,
        restricted: false,
        spendable: 10_350,
      });
      assert.equal(
        await service.settleIncomingAfterBallot(
          matchId,
          players[2] as string,
          1,
        ),
        0,
      );

      const reversedOffer = await service.createBribeOffer(
        players[0] as string,
        matchId,
        randomUUID(),
        {
          amount: 300,
          recipientUserId: players[3] as string,
          requestedTargetUserId: players[4] as string,
        },
      );
      await service.acceptBribeOffer(
        players[3] as string,
        reversedOffer.value.offerId,
        randomUUID(),
      );
      const senderBeforeReverse = await service.wallet(
        players[0] as string,
        matchId,
      );
      assert.equal(senderBeforeReverse.matchAllowance?.acceptedOutflow, 500);
      assert.equal(
        await service.reverseIncomingAfterMissedBallot(
          matchId,
          players[3] as string,
          1,
        ),
        300,
      );
      const senderAfterReverse = await service.wallet(
        players[0] as string,
        matchId,
      );
      assert.equal(senderAfterReverse.spendable, 9_300);
      assert.equal(senderAfterReverse.matchAllowance?.acceptedOutflow, 200);

      const deals = await service.dossierDeals(
        matchId,
        completedStateWithBallot(
          state,
          players[2] as UserId,
          players[3] as UserId,
        ),
      );
      assert.equal(
        deals.find(({ offerId }) => offerId === honored.value.offerId)?.outcome,
        "honored",
      );
      assert.equal(
        deals.find(({ offerId }) => offerId === betrayed.value.offerId)
          ?.outcome,
        "betrayed",
      );
      assert.equal(
        deals.find(({ offerId }) => offerId === reversedOffer.value.offerId)
          ?.outcome,
        "reversed",
      );

      const expiryMatchId = randomUUID() as MatchId;
      const expiryState = negotiationState(expiryMatchId, players);
      await transactions.run((client) =>
        new PostgresMatchRepository().create(
          client,
          expiryState,
          now.toISOString() as UtcTimestamp,
        ),
      );
      const expiring = await service.createBribeOffer(
        players[2] as string,
        expiryMatchId,
        randomUUID(),
        {
          amount: 50,
          recipientUserId: players[5] as string,
          requestedTargetUserId: players[4] as string,
        },
      );
      await transactions.run((client) =>
        service.expirePendingWithinTransaction(
          client,
          expiryMatchId,
          1,
          expiryState.phaseDeadline as UtcTimestamp,
        ),
      );
      assert.equal(
        (
          await service.listBribeOffers(players[2] as string, expiryMatchId)
        ).find(({ offerId }) => offerId === expiring.value.offerId)?.state,
        "expired",
      );
      await assert.rejects(
        service.acceptBribeOffer(
          players[5] as string,
          expiring.value.offerId,
          randomUUID(),
        ),
        (error: unknown) =>
          error instanceof EconomyError && error.code === "offer_closed",
      );

      const ballotMatchId = randomUUID() as MatchId;
      const ballotNegotiation = negotiationState(ballotMatchId, players);
      await transactions.run((client) =>
        new PostgresMatchRepository().create(
          client,
          ballotNegotiation,
          now.toISOString() as UtcTimestamp,
        ),
      );
      const ballotOffer = await service.createBribeOffer(
        players[0] as string,
        ballotMatchId,
        randomUUID(),
        {
          amount: 100,
          recipientUserId: players[2] as string,
          requestedTargetUserId: players[3] as string,
        },
      );
      await service.acceptBribeOffer(
        players[2] as string,
        ballotOffer.value.offerId,
        randomUUID(),
      );
      const voting = applyRoundCommand(ballotNegotiation, {
        type: "negotiation_timed_out",
        occurredAt: ballotNegotiation.phaseDeadline as UtcTimestamp,
      });
      assert.equal(voting.ok, true);
      if (!voting.ok) {
        throw new Error("Ballot fixture did not enter voting");
      }
      await transactions.run((client) =>
        new PostgresMatchRepository().save(
          client,
          ballotNegotiation.version,
          voting.value.state,
          ballotNegotiation.phaseDeadline as UtcTimestamp,
        ),
      );
      await assert.rejects(
        service.createBribeOffer(
          players[0] as string,
          ballotMatchId,
          randomUUID(),
          {
            amount: 50,
            recipientUserId: players[3] as string,
            requestedTargetUserId: players[4] as string,
          },
        ),
        (error: unknown) =>
          error instanceof EconomyError && error.code === "wrong_phase",
      );
      const recipientBeforeBallot = await service.wallet(players[2] as string);
      const ballotAt = new Date(
        Date.parse(voting.value.state.phaseDeadline as string) - 1_000,
      );
      const matchApplication = new PostgresMatchApplication(
        new PostgresMatchCommandExecutor(transactions),
        () => ballotAt,
        service,
      );
      await matchApplication.submitNormalBallot(
        players[2] as string,
        ballotMatchId,
        players[4] as string,
        randomUUID(),
      );
      const recipientAfterBallot = await service.wallet(players[2] as string);
      assert.equal(
        recipientAfterBallot.spendable - recipientBeforeBallot.spendable,
        100,
      );
      assert.equal(
        recipientBeforeBallot.pending - recipientAfterBallot.pending,
        100,
      );

      const deadlineMatchId = randomUUID() as MatchId;
      const deadlineNegotiation = negotiationState(deadlineMatchId, players);
      await transactions.run((client) =>
        new PostgresMatchRepository().create(
          client,
          deadlineNegotiation,
          now.toISOString() as UtcTimestamp,
        ),
      );
      const deadlineOffer = await service.createBribeOffer(
        players[1] as string,
        deadlineMatchId,
        randomUUID(),
        {
          amount: 100,
          recipientUserId: players[3] as string,
          requestedTargetUserId: players[4] as string,
        },
      );
      await service.acceptBribeOffer(
        players[3] as string,
        deadlineOffer.value.offerId,
        randomUUID(),
      );
      const deadlineVoting = applyRoundCommand(deadlineNegotiation, {
        type: "negotiation_timed_out",
        occurredAt: deadlineNegotiation.phaseDeadline as UtcTimestamp,
      });
      assert.equal(deadlineVoting.ok, true);
      if (!deadlineVoting.ok) {
        throw new Error("Deadline fixture did not enter voting");
      }
      await transactions.run((client) =>
        new PostgresMatchRepository().save(
          client,
          deadlineNegotiation.version,
          deadlineVoting.value.state,
          deadlineNegotiation.phaseDeadline as UtcTimestamp,
        ),
      );
      const deadline = deadlineVoting.value.state.phaseDeadline as UtcTimestamp;
      const handler = new MatchDeadlineHandler(
        undefined,
        undefined,
        undefined,
        undefined,
        service,
      );
      await transactions.run((client) =>
        handler.handle(
          client,
          {
            attemptCount: 1,
            claimToken: randomUUID(),
            deduplicationKey: `test:${deadlineMatchId}`,
            jobId: randomUUID(),
            kind: "match.deadline",
            maxAttempts: 1,
            payload: {
              expectedDeadline: deadline,
              expectedPhase: deadlineVoting.value.state.phase,
              expectedVersion: deadlineVoting.value.state.version,
              matchId: deadlineMatchId,
            },
            runAt: deadline,
          },
          deadline,
        ),
      );
      assert.equal(
        (
          await service.listBribeOffers(players[1] as string, deadlineMatchId)
        ).find(({ offerId }) => offerId === deadlineOffer.value.offerId)?.state,
        "reversed",
      );
      assert.equal(
        (await service.wallet(players[1] as string, deadlineMatchId))
          .matchAllowance?.acceptedOutflow,
        0,
      );

      const raceOutcomes = { reversed: 0, settled: 0 };
      for (let race = 0; race < 6; race += 1) {
        const raceMatchId = randomUUID() as MatchId;
        const raceNegotiation = negotiationState(raceMatchId, players);
        await transactions.run((client) =>
          new PostgresMatchRepository().create(
            client,
            raceNegotiation,
            now.toISOString() as UtcTimestamp,
          ),
        );
        const raceOffer = await service.createBribeOffer(
          players[0] as string,
          raceMatchId,
          randomUUID(),
          {
            amount: 50,
            recipientUserId: players[2] as string,
            requestedTargetUserId: players[3] as string,
          },
        );
        await service.acceptBribeOffer(
          players[2] as string,
          raceOffer.value.offerId,
          randomUUID(),
        );
        const raceVoting = applyRoundCommand(raceNegotiation, {
          type: "negotiation_timed_out",
          occurredAt: raceNegotiation.phaseDeadline as UtcTimestamp,
        });
        assert.equal(raceVoting.ok, true);
        if (!raceVoting.ok) {
          throw new Error("Race fixture did not enter voting");
        }
        await transactions.run((client) =>
          new PostgresMatchRepository().save(
            client,
            raceNegotiation.version,
            raceVoting.value.state,
            raceNegotiation.phaseDeadline as UtcTimestamp,
          ),
        );
        const raceDeadline = raceVoting.value.state
          .phaseDeadline as UtcTimestamp;
        const raceApplication = new PostgresMatchApplication(
          new PostgresMatchCommandExecutor(transactions),
          () => new Date(Date.parse(raceDeadline) - 1),
          service,
        );
        const raceHandler = new MatchDeadlineHandler(
          undefined,
          undefined,
          undefined,
          undefined,
          service,
        );
        await Promise.allSettled([
          raceApplication.submitNormalBallot(
            players[2] as string,
            raceMatchId,
            players[4] as string,
            randomUUID(),
          ),
          transactions.run((client) =>
            raceHandler.handle(
              client,
              {
                attemptCount: 1,
                claimToken: randomUUID(),
                deduplicationKey: `race:${raceMatchId}`,
                jobId: randomUUID(),
                kind: "match.deadline",
                maxAttempts: 1,
                payload: {
                  expectedDeadline: raceDeadline,
                  expectedPhase: raceVoting.value.state.phase,
                  expectedVersion: raceVoting.value.state.version,
                  matchId: raceMatchId,
                },
                runAt: raceDeadline,
              },
              raceDeadline,
            ),
          ),
        ]);
        const finalOffer = (
          await service.listBribeOffers(players[0] as string, raceMatchId)
        ).find(({ offerId }) => offerId === raceOffer.value.offerId);
        assert.equal(
          finalOffer?.state === "settled" || finalOffer?.state === "reversed",
          true,
        );
        raceOutcomes[finalOffer?.state as "reversed" | "settled"] += 1;
        assert.equal(
          (await service.wallet(players[0] as string, raceMatchId))
            .matchAllowance?.acceptedOutflow,
          finalOffer?.state === "settled" ? 50 : 0,
        );
      }
      assert.equal(raceOutcomes.reversed + raceOutcomes.settled, 6);

      for (let index = 0; index < 40; index += 1) {
        const sender = players[index % 2] as UserId;
        const recipient = players[4 + (index % 2)] as UserId;
        const target = players[2 + (index % 2)] as UserId;
        const offer = await service.createBribeOffer(
          sender,
          matchId,
          randomUUID(),
          {
            amount: 50,
            recipientUserId: recipient,
            requestedTargetUserId: target,
          },
        );
        await service.acceptBribeOffer(
          recipient,
          offer.value.offerId,
          randomUUID(),
        );
        if (index % 3 === 0) {
          await service.reverseIncomingAfterMissedBallot(matchId, recipient, 1);
        } else {
          await service.settleIncomingAfterBallot(matchId, recipient, 1);
        }
      }

      const ledgerSums = await pool.query<{
        entry_count: string;
        total: string;
      }>(
        `
          SELECT
            transaction_id,
            count(*) AS entry_count,
            sum(amount)::text AS total
          FROM ledger_entries
          GROUP BY transaction_id
          ORDER BY transaction_id
        `,
      );
      assert.equal(ledgerSums.rows.length > 0, true);
      assert.equal(
        ledgerSums.rows.every(
          ({ entry_count, total }) => Number(entry_count) >= 2 && total === "0",
        ),
        true,
      );
      const cacheDivergence = await pool.query<{ count: string }>(
        `
          SELECT count(*)
          FROM coin_accounts AS account
          LEFT JOIN (
            SELECT
              coin_account_id,
              COALESCE(sum(amount) FILTER (WHERE bucket = 'spendable'), 0) AS spendable,
              COALESCE(sum(amount) FILTER (WHERE bucket = 'reserved'), 0) AS reserved,
              COALESCE(sum(amount) FILTER (WHERE bucket = 'pending'), 0) AS pending
            FROM ledger_entries
            GROUP BY coin_account_id
          ) AS ledger ON ledger.coin_account_id = account.id
          WHERE account.spendable_balance <> COALESCE(ledger.spendable, 0)
             OR account.reserved_balance <> COALESCE(ledger.reserved, 0)
             OR account.pending_balance <> COALESCE(ledger.pending, 0)
        `,
      );
      assert.equal(cacheDivergence.rows[0]?.count, "0");
      assert.equal(
        (
          await pool.query<{ count: string }>(
            `
              SELECT count(*)
              FROM coin_accounts
              WHERE account_kind = 'player'
                AND (
                  spendable_balance < 0
                  OR reserved_balance < 0
                  OR pending_balance < 0
                )
            `,
          )
        ).rows[0]?.count,
        "0",
      );
      await assert.rejects(
        pool.query(
          `
            UPDATE ledger_entries
            SET amount = amount
            WHERE transaction_id = (
              SELECT id FROM ledger_transactions ORDER BY created_at LIMIT 1
            )
          `,
        ),
        /immutable/,
      );
      await assert.rejects(
        pool.query(
          `
            UPDATE coin_accounts
            SET spendable_balance = spendable_balance + 1
            WHERE owner_user_id = $1
          `,
          [players[0]],
        ),
        /diverged from ledger/,
      );
    } finally {
      await pool?.end().catch(() => undefined);
      await admin
        .query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
        .catch(() => undefined);
      await admin.end();
    }
  },
);
