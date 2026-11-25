import assert from "node:assert/strict";
import test from "node:test";
import {
  SequenceManager,
  SequenceNetworkMismatchError,
  normalizeStellarNetwork,
  reconcileIntents,
  type DurableIntent,
  type SequenceProvider,
  type StellarNetworkInput,
} from "../../lib/agents/sequence-manager";

const ACCOUNT = "GBMGZBFKUNOS7JWPRPF5IMZR27DCR6BEP6SQVFV2I354UPY35FZTIR2Y";
const OTHER = "GDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";

/** A provider that always reports the same ledger sequence. */
function provider(sequence: bigint, onRead?: () => void): SequenceProvider {
  return {
    async read() {
      onRead?.();
      return sequence;
    },
  };
}

test("the first reservation is ledger sequence + 1 and increments monotonically", async () => {
  const manager = new SequenceManager(provider(100n));
  const first = await manager.reserve(ACCOUNT);
  const second = await manager.reserve(ACCOUNT);
  assert.equal(first.sequence, 101n);
  assert.equal(second.sequence, 102n);
  assert.equal(first.state, "reserved");
  assert.deepEqual(manager.pending(ACCOUNT), [101n, 102n]);
});

test("concurrent reservations never duplicate and read the ledger once per address", async () => {
  let reads = 0;
  const manager = new SequenceManager(provider(500n, () => (reads += 1)));
  const reservations = await Promise.all(
    Array.from({ length: 8 }, () => manager.reserve(ACCOUNT)),
  );
  const sequences = reservations.map((reservation) => reservation.sequence);
  assert.deepEqual(sequences, [501n, 502n, 503n, 504n, 505n, 506n, 507n, 508n]);
  assert.equal(new Set(sequences).size, sequences.length);
  assert.equal(reads, 1, "the ledger is read once per address, not once per reservation");
});

test("different addresses keep independent sequence streams", async () => {
  const manager = new SequenceManager({
    async read(address) {
      return address === ACCOUNT ? 10n : 20n;
    },
  });
  const a = await manager.reserve(ACCOUNT);
  const b = await manager.reserve(OTHER);
  assert.equal(a.sequence, 11n);
  assert.equal(b.sequence, 21n);
});

test("submitting consumes the sequence and is idempotent", async () => {
  const manager = new SequenceManager(provider(200n));
  const first = await manager.reserve(ACCOUNT);
  first.submit();
  first.release(); // must be a no-op after submit
  assert.equal(first.state, "submitted");
  const second = await manager.reserve(ACCOUNT);
  assert.equal(second.sequence, 202n);
  assert.deepEqual(manager.pending(ACCOUNT), [202n]);
});

test("releasing the most recent reservation rolls back so no gap is left", async () => {
  const manager = new SequenceManager(provider(300n));
  const keep = await manager.reserve(ACCOUNT);
  const cancelled = await manager.reserve(ACCOUNT);
  cancelled.release();

  const reused = await manager.reserve(ACCOUNT);
  assert.equal(cancelled.state, "released");
  assert.equal(reused.sequence, 302n, "cancelled sequence is handed out again");
  assert.deepEqual(manager.holes(ACCOUNT), []);
  assert.deepEqual(manager.pending(ACCOUNT), [301n, 302n]);
  assert.equal(keep.sequence, 301n);
});

test("releasing an older reservation records a hole that must be filled", async () => {
  const manager = new SequenceManager(provider(400n));
  const older = await manager.reserve(ACCOUNT);
  await manager.reserve(ACCOUNT);
  older.release();

  assert.deepEqual(manager.holes(ACCOUNT), [401n]);
  const next = await manager.reserve(ACCOUNT);
  assert.equal(next.sequence, 403n, "a gap is not silently reused");
});

test("a provider failure rejects the reservation without corrupting state", async () => {
  let attempts = 0;
  const manager = new SequenceManager({
    async read() {
      attempts += 1;
      if (attempts === 1) throw new Error("horizon unavailable");
      return 42n;
    },
  });
  await assert.rejects(() => manager.reserve(ACCOUNT), /horizon unavailable/);
  const retry = await manager.reserve(ACCOUNT);
  assert.equal(retry.sequence, 43n, "the manager re-reads after a dependency failure");
});

test("resync advances past an externally consumed sequence and clears stale holes", async () => {
  let ledger = 100n;
  const manager = new SequenceManager({
    async read() {
      return ledger;
    },
  });
  const older = await manager.reserve(ACCOUNT); // 101
  await manager.reserve(ACCOUNT); // 102
  older.release(); // 101 becomes a hole
  assert.deepEqual(manager.holes(ACCOUNT), [101n]);

  ledger = 102n; // an out-of-band submission moved the account forward
  await manager.resync(ACCOUNT);

  assert.deepEqual(manager.holes(ACCOUNT), []);
  const next = await manager.reserve(ACCOUNT);
  assert.equal(next.sequence, 103n);
});

test("pause stops new reservations and resume restores them", async () => {
  const manager = new SequenceManager(provider(700n));
  manager.pause();
  assert.equal(manager.isPaused(), true);
  await assert.rejects(() => manager.reserve(ACCOUNT), /paused/);
  manager.resume();
  const reservation = await manager.reserve(ACCOUNT);
  assert.equal(reservation.sequence, 701n);
});

test("rejects a blank address", async () => {
  const manager = new SequenceManager(provider(1n));
  await assert.rejects(() => manager.reserve("   "), /non-empty account address/);
});

test("rejects a negative ledger sequence from the provider", async () => {
  const manager = new SequenceManager(provider(-1n));
  await assert.rejects(() => manager.reserve(ACCOUNT), /invalid ledger sequence/);
});

test("rejects reservations once the signed 64-bit sequence ceiling is reached", async () => {
  const max = (1n << 63n) - 1n;
  const manager = new SequenceManager(provider(max - 1n));
  const last = await manager.reserve(ACCOUNT);
  assert.equal(last.sequence, max);
  await assert.rejects(() => manager.reserve(ACCOUNT), /sequence space exhausted/);
});

test("binds reservations to the selected Stellar network and normalizes network identifiers", async () => {
  const manager = new SequenceManager(provider(100n), {
    network: {
      network: "  TESTNET ",
      networkPassphrase: "Test SDF Network ; September 2015",
    },
  });

  assert.deepEqual(manager.network(), {
    network: "testnet",
    networkPassphrase: "Test SDF Network ; September 2015",
    key: "testnet:Test SDF Network ; September 2015",
  });

  const reservation = await manager.reserve(ACCOUNT);
  assert.equal(reservation.network, "testnet");
  assert.equal(reservation.networkPassphrase, "Test SDF Network ; September 2015");
  assert.equal(reservation.networkKey, "testnet:Test SDF Network ; September 2015");
  reservation.submit({
    network: {
      network: "testnet",
      networkPassphrase: "Test SDF Network ; September 2015",
    },
  });
  assert.equal(reservation.state, "submitted");
});

test("rejects reuse of cached sequences and in-flight reservations after a network configuration change", async () => {
  let activeNetwork: StellarNetworkInput = "testnet";
  const manager = new SequenceManager(provider(200n), {
    resolveNetwork: () => activeNetwork,
  });

  const first = await manager.reserve(ACCOUNT);
  const rolledBack = await manager.reserve(ACCOUNT);
  rolledBack.release(); // normally rolls back to 202n for reuse on the same network

  // Simulate a runtime Stellar network configuration change.
  activeNetwork = "public";

  // Submitting the previously minted testnet reservation must be rejected.
  assert.throws(
    () => first.submit(),
    (error: unknown) =>
      error instanceof SequenceNetworkMismatchError &&
      error.expectedNetwork === "testnet" &&
      error.actualNetwork === "public" &&
      error.address === ACCOUNT,
  );
  assert.equal(first.state, "reserved", "rejected submit must not consume the reservation");

  // Reusing cached/rolled-back sequence state for new reservations or resync must be rejected.
  await assert.rejects(
    () => manager.reserve(ACCOUNT),
    (error: unknown) =>
      error instanceof SequenceNetworkMismatchError &&
      error.expectedNetwork === "testnet" &&
      error.actualNetwork === "public",
  );
  await assert.rejects(
    () => manager.resync(ACCOUNT),
    SequenceNetworkMismatchError,
  );

  // Cleanup release remains safe (non-throwing) after a network mismatch.
  first.release();
  assert.equal(first.state, "released");
});

test("rejects reuse when the Stellar network passphrase changes on the same network slug", async () => {
  let activeNetwork: StellarNetworkInput = {
    network: "testnet",
    networkPassphrase: "Test SDF Network ; September 2015",
  };
  const manager = new SequenceManager(provider(300n), {
    resolveNetwork: () => activeNetwork,
  });

  const reservation = await manager.reserve(ACCOUNT);
  assert.equal(reservation.sequence, 301n);

  activeNetwork = {
    network: "testnet",
    networkPassphrase: "Public Global Stellar Network ; September 2015",
  };

  assert.throws(() => reservation.submit(), SequenceNetworkMismatchError);
  await assert.rejects(() => manager.reserve(ACCOUNT), SequenceNetworkMismatchError);
});

test("rejects reuse after environment Stellar network configuration changes", async () => {
  const prevNetwork = process.env.NEXT_PUBLIC_STELLAR_NETWORK;
  const prevPassphrase = process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE;
  try {
    process.env.NEXT_PUBLIC_STELLAR_NETWORK = "testnet";
    delete process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE;

    const manager = new SequenceManager(provider(50n));
    const reservation = await manager.reserve(ACCOUNT);
    assert.equal(reservation.network, "testnet");

    process.env.NEXT_PUBLIC_STELLAR_NETWORK = "public";

    assert.throws(() => reservation.submit(), SequenceNetworkMismatchError);
    await assert.rejects(() => manager.reserve(ACCOUNT), SequenceNetworkMismatchError);
  } finally {
    if (prevNetwork === undefined) delete process.env.NEXT_PUBLIC_STELLAR_NETWORK;
    else process.env.NEXT_PUBLIC_STELLAR_NETWORK = prevNetwork;
    if (prevPassphrase === undefined) delete process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE;
    else process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE = prevPassphrase;
  }
});

test("rejects cross-network reservation reuse across managers and explicit network assertions", async () => {
  const testnetManager = new SequenceManager(provider(10n), { network: "testnet" });
  const publicManager = new SequenceManager(provider(90n), { network: "public" });

  const testnetRes = await testnetManager.reserve(ACCOUNT);
  const publicRes = await publicManager.reserve(ACCOUNT);

  assert.equal(testnetRes.sequence, 11n);
  assert.equal(publicRes.sequence, 91n);

  assert.throws(() => publicManager.assertReservation(testnetRes), SequenceNetworkMismatchError);
  assert.throws(() => testnetRes.submit({ network: "public" }), SequenceNetworkMismatchError);
  await assert.rejects(
    () => testnetManager.reserve(ACCOUNT, { network: "public" }),
    SequenceNetworkMismatchError,
  );

  // Each reservation still submits cleanly on its own bound network.
  testnetRes.submit({ network: "testnet" });
  publicRes.submit({ network: "public" });
  assert.equal(testnetRes.state, "submitted");
  assert.equal(publicRes.state, "submitted");
});

test("preserves independent reservations for different accounts on the selected network", async () => {
  const manager = new SequenceManager(
    {
      async read(address) {
        return address === ACCOUNT ? 100n : 500n;
      },
    },
    { network: "testnet" },
  );

  const [a1, b1, a2, b2] = await Promise.all([
    manager.reserve(ACCOUNT),
    manager.reserve(OTHER),
    manager.reserve(ACCOUNT),
    manager.reserve(OTHER),
  ]);

  assert.equal(a1.network, "testnet");
  assert.equal(b1.network, "testnet");
  assert.deepEqual([a1.sequence, a2.sequence], [101n, 102n]);
  assert.deepEqual([b1.sequence, b2.sequence], [501n, 502n]);

  // Releasing an older reservation for ACCOUNT creates a hole only for ACCOUNT.
  a1.release();
  b2.release(); // rolls back OTHER's tail without creating a hole

  assert.deepEqual(manager.holes(ACCOUNT), [101n]);
  assert.deepEqual(manager.holes(OTHER), []);
  assert.deepEqual(manager.pending(ACCOUNT), [102n]);
  assert.deepEqual(manager.pending(OTHER), [501n]);

  const bNext = await manager.reserve(OTHER);
  const aNext = await manager.reserve(ACCOUNT);
  assert.equal(bNext.sequence, 502n);
  assert.equal(aNext.sequence, 103n);
});

test("reconcileIntents rejects intents bound to a different Stellar network", () => {
  const intents: DurableIntent[] = [
    {
      id: "intent-1",
      address: ACCOUNT,
      sequence: 101n,
      amountUsdc: 25n,
      network: "testnet",
      outcome: "pending",
    },
  ];

  assert.throws(
    () => reconcileIntents(intents, [], 100n, "public"),
    SequenceNetworkMismatchError,
  );

  const reconciled = reconcileIntents(intents, [], 100n, "testnet");
  assert.equal(reconciled.retryable.length, 1);
  assert.equal(reconciled.retryable[0].outcome, "absent");
});

test("rejects blank Stellar network or blank network passphrase", () => {
  assert.throws(() => normalizeStellarNetwork("   "), /non-empty Stellar network/);
  assert.throws(
    () => normalizeStellarNetwork({ network: "testnet", networkPassphrase: "   " }),
    /non-empty Stellar network passphrase/,
  );
  assert.throws(
    () => new SequenceManager(provider(1n), { network: "" }),
    /non-empty Stellar network/,
  );
});
