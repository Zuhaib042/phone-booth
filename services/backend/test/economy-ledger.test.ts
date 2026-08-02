import assert from "node:assert/strict";
import test from "node:test";

import {
  balanceLedgerPostings,
  InvalidLedgerTransactionError,
  type CoinBucket,
  type LedgerPosting,
} from "../src/economy/ledger.js";
import {
  M8_FIXTURE_ECONOMY_CONFIG,
  PostgresEconomyService,
} from "../src/economy/service.js";

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

test("M8.1 every generated ledger transaction balances exactly", () => {
  const random = seededRandom(0x8c01_1ed9);
  const buckets: readonly CoinBucket[] = ["spendable", "reserved", "pending"];

  for (let sequence = 0; sequence < 10_000; sequence += 1) {
    const accountCount = 2 + Math.floor(random() * 7);
    const postings: LedgerPosting[] = [];
    let total = 0n;
    for (let index = 0; index < accountCount - 1; index += 1) {
      const magnitude = BigInt(1 + Math.floor(random() * 1_000_000));
      const amount = random() < 0.5 ? magnitude : -magnitude;
      postings.push({
        accountId: `account-${index}`,
        amount,
        bucket: buckets[Math.floor(random() * buckets.length)] as CoinBucket,
      });
      total += amount;
    }
    if (total === 0n) {
      postings[0] = {
        ...(postings[0] as LedgerPosting),
        amount: (postings[0] as LedgerPosting).amount + 1n,
      };
      total = 1n;
    }
    postings.push({
      accountId: "balancing-account",
      amount: -total,
      bucket: "spendable",
    });

    const transaction = balanceLedgerPostings(postings);
    assert.equal(transaction.total, 0n);
    assert.equal(
      transaction.postings.reduce((sum, posting) => sum + posting.amount, 0n),
      0n,
    );
    assert.equal(Object.isFrozen(transaction.postings), true);
  }
});

test("M8.1 malformed ledger transactions are rejected", () => {
  assert.throws(() => balanceLedgerPostings([]), InvalidLedgerTransactionError);
  assert.throws(
    () =>
      balanceLedgerPostings([
        { accountId: "one", amount: -10n, bucket: "spendable" },
        { accountId: "two", amount: 9n, bucket: "pending" },
      ]),
    /sum to zero/,
  );
  assert.throws(
    () =>
      balanceLedgerPostings([
        { accountId: "one", amount: 0n, bucket: "reserved" },
        { accountId: "two", amount: 1n, bucket: "spendable" },
      ]),
    /zero amount/,
  );
});

test("M8 economy configuration rejects unsafe or inconsistent quantities", () => {
  assert.throws(
    () =>
      new PostgresEconomyService(
        {} as ConstructorParameters<typeof PostgresEconomyService>[0],
        {
          ...M8_FIXTURE_ECONOMY_CONFIG,
          matchOutflowCap: 625,
        },
      ),
    /divisible/,
  );
  assert.throws(
    () =>
      new PostgresEconomyService(
        {} as ConstructorParameters<typeof PostgresEconomyService>[0],
        {
          ...M8_FIXTURE_ECONOMY_CONFIG,
          grants: { bad: -1 },
        },
      ),
    /positive safe integer/,
  );
});
