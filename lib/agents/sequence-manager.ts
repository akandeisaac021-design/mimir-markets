/**
 * Safe account-sequence management for Mimir worker wallets.
 *
 * Every state-changing transaction a worker submits must carry the account's
 * *next* ledger sequence number. Horizon hands out the current sequence, and
 * Stellar rejects a transaction whose sequence is not exactly `current + 1`
 * (`tx_bad_seq`). That makes concurrent submissions from the same worker wallet
 * fragile in three concrete ways:
 *
 *  1. **Duplicate** — two jobs read the same Horizon sequence and both build a
 *     transaction with `current + 1`; the second is rejected after the first
 *     lands, and the wallet loses a slot.
 *  2. **Gap** — a job reserves `current + 1`, then aborts (cancelled job, failed
 *     simulation, crashed process) while a later job submits `current + 2`.
 *     Stellar refuses `current + 2` because the account is still at `current`,
 *     so the wallet is wedged until the hole is filled.
 *  3. **Stale base** — the cached sequence drifts after an out-of-band
 *     submission, leaving every subsequent transaction one behind.
 *
 * `SequenceManager` makes those cases explicit and recoverable:
 *
 *  - Reservations are serialised per address, so a sequence is never handed out
 *    twice, no matter how many jobs call `reserve()` concurrently.
 *  - Reservations are bound to the selected Stellar network (network name and
 *    optional network passphrase); reuse after a network configuration change is
 *    rejected with {@link SequenceNetworkMismatchError} while independent
 *    accounts on the selected network keep isolated reservation streams.
 *  - Releasing an unsubmitted reservation rolls the counter back when nothing
 *    higher was issued (no gap); otherwise it records a hole that must be
 *    filled before a higher sequence is usable.
 *  - `resync()` re-reads the ledger after a `tx_bad_seq`, clearing holes that
 *    are now behind it.
 *  - `pause()` / `resume()` let an incident kill-switch stop new allocations
 *    without discarding in-flight reservations.
 *  - Reservations coordinate with the bounded trader decision journal (see
 *    `agents/traders/policy.ts`) to track sequence allocations across decisions.
 *
 * The manager is deliberately dependency-free and takes a {@link SequenceProvider}
 * so it can be unit-tested without Horizon or a live ledger.
 */

/** Stellar sequences are signed 64-bit integers; keep a hard ceiling. */
const MAX_SEQUENCE = (1n << 63n) - 1n;

export interface SequenceProvider {
  /** Current on-ledger sequence for the account (Horizon `account.sequence`). */
  read(address: string): Promise<bigint>;
}

/**
 * Selected Stellar network configuration for binding sequence reservations.
 */
export interface StellarNetworkConfig {
  /** Selected Stellar network name (e.g. `"testnet"`, `"public"`, `"futurenet"`). */
  readonly network: string;
  /** Optional Stellar network passphrase (exact, case-sensitive when provided). */
  readonly networkPassphrase?: string;
}

export type StellarNetworkInput = string | StellarNetworkConfig;

/**
 * Normalized, immutable Stellar network identity bound to a {@link SequenceManager}
 * and every {@link SequenceReservation} it issues.
 */
export interface StellarNetworkBinding {
  readonly network: string;
  readonly networkPassphrase?: string;
  /** Canonical comparison key (`network` or `network:networkPassphrase`). */
  readonly key: string;
}

export interface SequenceManagerOptions {
  /**
   * Selected Stellar network to bind reservations to.
   * Defaults to `NEXT_PUBLIC_STELLAR_NETWORK` / `STELLAR_NETWORK` (falling back
   * to `"testnet"`) plus `NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE` /
   * `STELLAR_NETWORK_PASSPHRASE` when set.
   */
  readonly network?: StellarNetworkInput;
  /**
   * Optional dynamic resolver returning the currently active Stellar network
   * configuration. Checked before reserving, resyncing, or submitting so
   * runtime network configuration changes reject reuse immediately.
   */
  readonly resolveNetwork?: () => StellarNetworkInput;
}

export interface ReservationOperationOptions {
  /** Optional Stellar network to verify against the bound network. */
  readonly network?: StellarNetworkInput;
}

/**
 * Raised when a caller attempts to reserve, resync, reconcile, or submit a
 * sequence reservation after the selected Stellar network configuration changed
 * or against a different Stellar network than the reservation was bound to.
 */
export class SequenceNetworkMismatchError extends Error {
  readonly expectedNetwork: string;
  readonly actualNetwork: string;
  readonly address?: string;

  constructor(expectedNetwork: string, actualNetwork: string, address?: string) {
    const target = address ? ` for ${address}` : "";
    super(
      `sequence reservation network mismatch${target}: bound to "${expectedNetwork}", active network is "${actualNetwork}"`,
    );
    this.name = "SequenceNetworkMismatchError";
    this.expectedNetwork = expectedNetwork;
    this.actualNetwork = actualNetwork;
    this.address = address;
  }
}

export type ReservationState = "reserved" | "submitted" | "released";

export interface SequenceReservation {
  readonly address: string;
  readonly sequence: bigint;
  /** Normalized Stellar network this reservation is bound to (e.g. `"testnet"`). */
  readonly network: string;
  /** Optional Stellar network passphrase this reservation is bound to. */
  readonly networkPassphrase?: string;
  /** Canonical network binding key (`network` or `network:networkPassphrase`). */
  readonly networkKey: string;
  readonly state: ReservationState;
  /**
   * The transaction was accepted on-chain: the sequence is consumed.
   * Throws {@link SequenceNetworkMismatchError} if the active or supplied
   * network no longer matches the reservation's bound network.
   */
  submit(options?: ReservationOperationOptions): void;
  /** The transaction will never be submitted: recover the gap where possible. */
  release(): void;
}

interface AddressState {
  /** Next sequence to hand out, or `null` until the first successful read. */
  next: bigint | null;
  /** Reserved and not yet settled. */
  outstanding: Set<bigint>;
  /** Released out of order; these must be filled before higher sequences. */
  holes: Set<bigint>;
  /** Serialises allocation for this address. */
  tail: Promise<void>;
}

/**
 * Reconcile durable trader intents against observed chain positions after a
 * restart. Intents whose outcome is uncertain are preserved and never re-issued
 * automatically; only intents confirmed absent on chain may be retried.
 */
export type IntentOutcome = "pending" | "confirmed" | "absent" | "uncertain";

export interface DurableIntent {
  readonly id: string;
  readonly address: string;
  readonly sequence: bigint;
  readonly amountUsdc: bigint;
  /** Optional Stellar network binding recorded when the intent was reserved. */
  readonly network?: string;
  /** Optional Stellar network passphrase recorded when the intent was reserved. */
  readonly networkPassphrase?: string;
  outcome: IntentOutcome;
}

export interface ObservedPosition {
  readonly intentId: string;
  readonly sequence: bigint;
}

export interface ReconciliationResult {
  readonly confirmed: DurableIntent[];
  readonly retryable: DurableIntent[];
  readonly uncertain: DurableIntent[];
}

/**
 * Normalize a Stellar network selector into a canonical {@link StellarNetworkBinding}.
 */
export function normalizeStellarNetwork(input: StellarNetworkInput): StellarNetworkBinding {
  if (typeof input === "string") {
    const network = input.trim().toLowerCase();
    if (!network) {
      throw new Error("sequence manager requires a non-empty Stellar network");
    }
    return { network, key: network };
  }
  const network = typeof input?.network === "string" ? input.network.trim().toLowerCase() : "";
  if (!network) {
    throw new Error("sequence manager requires a non-empty Stellar network");
  }
  if (input.networkPassphrase !== undefined) {
    const networkPassphrase = input.networkPassphrase.trim();
    if (!networkPassphrase) {
      throw new Error("sequence manager requires a non-empty Stellar network passphrase");
    }
    return {
      network,
      networkPassphrase,
      key: `${network}:${networkPassphrase}`,
    };
  }
  return { network, key: network };
}

function readEnvStellarNetwork(): StellarNetworkConfig {
  const network =
    process.env.NEXT_PUBLIC_STELLAR_NETWORK?.trim() ||
    process.env.STELLAR_NETWORK?.trim() ||
    "testnet";
  const networkPassphrase =
    process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE?.trim() ||
    process.env.STELLAR_NETWORK_PASSPHRASE?.trim() ||
    undefined;
  return networkPassphrase ? { network, networkPassphrase } : { network };
}

/**
 * Compare durable intents with observed chain positions. An intent is confirmed
 * when a matching position exists; an intent with no observed position and a
 * sequence already consumed on-ledger is treated as absent (retryable); anything
 * else stays uncertain so it is never double-submitted.
 *
 * When `activeNetwork` is supplied, any intent carrying a different Stellar
 * network binding is rejected with {@link SequenceNetworkMismatchError}.
 */
export function reconcileIntents(
  intents: readonly DurableIntent[],
  observed: readonly ObservedPosition[],
  ledgerSequence: bigint,
  activeNetwork?: StellarNetworkInput,
): ReconciliationResult {
  const expected =
    activeNetwork !== undefined ? normalizeStellarNetwork(activeNetwork) : null;
  const observedIds = new Set(observed.map((position) => position.intentId));
  const confirmed: DurableIntent[] = [];
  const retryable: DurableIntent[] = [];
  const uncertain: DurableIntent[] = [];
  for (const intent of intents) {
    if (expected && (intent.network !== undefined || intent.networkPassphrase !== undefined)) {
      const intentBinding = normalizeStellarNetwork(
        intent.networkPassphrase !== undefined
          ? { network: intent.network ?? "", networkPassphrase: intent.networkPassphrase }
          : (intent.network ?? ""),
      );
      if (intentBinding.key !== expected.key) {
        throw new SequenceNetworkMismatchError(intentBinding.key, expected.key, intent.address);
      }
    }
    if (observedIds.has(intent.id)) {
      intent.outcome = "confirmed";
      confirmed.push(intent);
    } else if (intent.sequence <= ledgerSequence) {
      // The sequence was consumed on-chain but no matching position was observed:
      // the stake may have landed under another path, so keep it uncertain.
      intent.outcome = "uncertain";
      uncertain.push(intent);
    } else {
      intent.outcome = "absent";
      retryable.push(intent);
    }
  }
  return { confirmed, retryable, uncertain };
}

function normalizeAddress(address: string): string {
  const scope = address.trim();
  if (!scope) throw new Error("sequence manager requires a non-empty account address");
  return scope;
}

function assertSequence(value: bigint, address: string): bigint {
  if (typeof value !== "bigint" || value < 0n) {
    throw new Error(`sequence provider returned an invalid ledger sequence for ${address}`);
  }
  return value;
}

function compareSequences(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export class SequenceManager {
  private readonly provider: SequenceProvider;
  private readonly boundNetwork: StellarNetworkBinding;
  private readonly resolveCurrentNetwork: () => StellarNetworkBinding;
  private readonly states = new Map<string, AddressState>();
  private paused = false;

  constructor(provider: SequenceProvider, options?: SequenceManagerOptions) {
    this.provider = provider;
    const initialNetwork =
      options?.network !== undefined
        ? options.network
        : options?.resolveNetwork !== undefined
          ? options.resolveNetwork()
          : readEnvStellarNetwork();
    this.boundNetwork = normalizeStellarNetwork(initialNetwork);
    this.resolveCurrentNetwork =
      options?.resolveNetwork !== undefined
        ? () => normalizeStellarNetwork(options.resolveNetwork!())
        : options?.network !== undefined
          ? () => this.boundNetwork
          : () => normalizeStellarNetwork(readEnvStellarNetwork());
  }

  /** Return the Stellar network identity this manager is bound to. */
  network(): StellarNetworkBinding {
    return this.boundNetwork;
  }

  /**
   * Verify that the active Stellar network configuration (and optional
   * caller-supplied `expected` network) still matches this manager's bound
   * network. Throws {@link SequenceNetworkMismatchError} on any drift.
   */
  assertNetwork(expected?: StellarNetworkInput, address?: string): StellarNetworkBinding {
    const active = this.resolveCurrentNetwork();
    if (active.key !== this.boundNetwork.key) {
      throw new SequenceNetworkMismatchError(this.boundNetwork.key, active.key, address);
    }
    if (expected !== undefined) {
      const requested = normalizeStellarNetwork(expected);
      if (requested.key !== this.boundNetwork.key) {
        throw new SequenceNetworkMismatchError(this.boundNetwork.key, requested.key, address);
      }
    }
    return this.boundNetwork;
  }

  /**
   * Verify that a previously minted {@link SequenceReservation} belongs to this
   * manager's bound Stellar network and that the active network has not changed.
   */
  assertReservation(
    reservation: Pick<SequenceReservation, "address" | "networkKey">,
    expected?: StellarNetworkInput,
  ): void {
    const bound = this.assertNetwork(expected, reservation.address);
    if (reservation.networkKey !== bound.key) {
      throw new SequenceNetworkMismatchError(
        reservation.networkKey,
        bound.key,
        reservation.address,
      );
    }
  }

  private stateKey(address: string): string {
    return `${this.boundNetwork.key}::${address}`;
  }

  private state(address: string): AddressState {
    const key = this.stateKey(address);
    let state = this.states.get(key);
    if (!state) {
      state = { next: null, outstanding: new Set(), holes: new Set(), tail: Promise.resolve() };
      this.states.set(key, state);
    }
    return state;
  }

  /** Run `task` after every previously queued task for `address` has settled. */
  private runExclusive<T>(address: string, task: () => Promise<T>): Promise<T> {
    const state = this.state(address);
    const run = state.tail.then(task, task);
    state.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async loadNext(address: string): Promise<bigint> {
    const ledger = assertSequence(await this.provider.read(address), address);
    return ledger + 1n;
  }

  /**
   * Reserve the next sequence for `address`.
   *
   * Concurrent callers for the same address are serialised, so every reservation
   * is unique and monotonically increasing. Rejects with
   * {@link SequenceNetworkMismatchError} if the selected Stellar network
   * configuration has changed.
   */
  async reserve(
    address: string,
    options?: ReservationOperationOptions,
  ): Promise<SequenceReservation> {
    const scope = normalizeAddress(address);
    return this.runExclusive(scope, async () => {
      this.assertNetwork(options?.network, scope);
      if (this.paused) {
        throw new Error(`worker wallet sequence manager is paused for ${scope}`);
      }
      const state = this.state(scope);
      if (state.next === null) {
        state.next = await this.loadNext(scope);
      }
      if (state.next > MAX_SEQUENCE) {
        throw new Error(`sequence space exhausted for ${scope}`);
      }
      const sequence = state.next;
      state.next = sequence + 1n;
      state.outstanding.add(sequence);
      return this.mint(scope, sequence);
    });
  }

  private mint(address: string, sequence: bigint): SequenceReservation {
    const state = this.state(address);
    const binding = this.boundNetwork;
    let status: ReservationState = "reserved";
    const settle = (next: ReservationState, rollback: boolean) => {
      if (status !== "reserved") return;
      status = next;
      state.outstanding.delete(sequence);
      if (!rollback) return;
      let networkMatches = false;
      try {
        networkMatches = this.resolveCurrentNetwork().key === binding.key;
      } catch {
        networkMatches = false;
      }
      if (!networkMatches) return;
      if (state.next === sequence + 1n) {
        // Nothing higher was issued, so the number can be safely reused.
        state.next = sequence;
      } else {
        // A higher reservation exists; this number must be filled first.
        state.holes.add(sequence);
      }
    };
    return {
      address,
      sequence,
      network: binding.network,
      ...(binding.networkPassphrase !== undefined
        ? { networkPassphrase: binding.networkPassphrase }
        : {}),
      networkKey: binding.key,
      get state() {
        return status;
      },
      submit: (options?: ReservationOperationOptions) => {
        this.assertNetwork(options?.network, address);
        settle("submitted", false);
      },
      release: () => {
        settle("released", true);
      },
    };
  }

  /** Sequences reserved but not yet submitted or released. */
  pending(address: string): bigint[] {
    return [...this.state(normalizeAddress(address)).outstanding].sort(compareSequences);
  }

  /** Released out-of-order sequences that must be filled before higher ones. */
  holes(address: string): bigint[] {
    return [...this.state(normalizeAddress(address)).holes].sort(compareSequences);
  }

  /**
   * Re-read the ledger sequence and reconcile local state, e.g. after a
   * `tx_bad_seq` rejection or an out-of-band submission. Rejects with
   * {@link SequenceNetworkMismatchError} if the selected Stellar network
   * configuration has changed.
   */
  async resync(address: string, options?: ReservationOperationOptions): Promise<void> {
    const scope = normalizeAddress(address);
    return this.runExclusive(scope, async () => {
      this.assertNetwork(options?.network, scope);
      const state = this.state(scope);
      const ledger = assertSequence(await this.provider.read(scope), scope);
      const floor = ledger + 1n;
      if (state.next === null || state.next < floor) {
        state.next = floor;
      }
      for (const value of state.holes) {
        if (value < floor) state.holes.delete(value);
      }
      for (const value of state.outstanding) {
        if (value < floor) state.outstanding.delete(value);
      }
    });
  }

  /** Stop handing out new sequences (in-flight reservations stay valid). */
  pause(): void {
    this.paused = true;
  }

  /** Resume allocations after a pause. */
  resume(): void {
    this.paused = false;
  }

  isPaused(): boolean {
    return this.paused;
  }
}
