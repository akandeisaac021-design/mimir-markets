/**
 * Deterministic challenge UX fixtures for late and conflicting observations.
 *
 * Models the market detail (`hooks/useVsDetail.ts`, `lib/vs-detail-state.ts`,
 * `lib/market-expiry.ts`, `lib/challenge-recovery.ts`) and challenge ticket
 * (`components/vs/CreateChallengeTicket.tsx`) flows completely offline:
 *
 *  - Late / out-of-order observations guarded by monotonic fetch generations
 *  - Conflicting observations between lagged read-index snapshots and
 *    authoritative Soroban contract state, plus clock skew and lock windows
 *  - Stale market revisions (claim statement edits, stake edits, wallet
 *    account switches) invalidating captured intent reviews & ticket digests
 *  - Wallet rejections (user-declined / submit-phase / definitive 4xx errors)
 *    that preserve user drafts without blocking retries
 *  - Uncertain submissions (transport timeout / ambiguous receipt with txHash)
 *    that persist across reloads, fail closed against duplicate stakes, and
 *    reconcile within a bounded status-check budget without resubmitting
 *
 * All value accounting uses integer USDC; no live wallets, funded accounts,
 * production credentials, or network transports are required.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildChallengeRevisionKey,
  isChallengeIntentReviewValid,
  type ChallengeIntentReview,
} from "../../hooks/useVsDetail";
import { computeChallengeTicketRevision } from "../../components/vs/CreateChallengeTicket";
import {
  applyChallengeStatusOutcome,
  challengeRecoveryTxHashFromError,
  createChallengeRecoveryRecord,
  hasChallengeStatusBudget,
  isChallengeRecoveryBlocking,
  isChallengeRecoveryExpired,
  type ChallengeRecoveryRecord,
  type ChallengeStatusOutcome,
} from "../../lib/challenge-recovery";
import type { VSData } from "../../lib/contract";
import {
  DEFAULT_CHALLENGE_LOCK_SECONDS,
  evaluateMarketExpiry,
  observationFromFreshness,
  type ExpiryObservation,
  type MarketExpiry,
} from "../../lib/market-expiry";
import { StellarTransactionError } from "../../lib/settlement-retry";
import {
  applyVsDetailFetchOutcome,
  beginVsDetailFetch,
  createVsDetailState,
  resetVsDetailChallengeStake,
  resetVsDetailState,
  setVsDetailChallengeStake,
  type VsDetailState,
} from "../../lib/vs-detail-state";
import type { VSCacheFreshness } from "../../lib/vs-freshness";
import {
  canResubmitPayment,
  createUncertainSubmission,
  isUncertainSubmissionError,
  reconcileUncertainSubmission,
  type ReconciliationProbeResult,
  type UncertainSubmissionState,
} from "../../lib/wallet-submission-recovery";

// ── Deterministic synthetic constants ─────────────────────────────────────────

export const CHALLENGE_UX_BASE_NOW_MS = 1_780_000_000_000;
export const CHALLENGE_UX_CREATOR_WALLET =
  "GB5DLP3MNPUXXJ6P67XGD3OV3ZVIMZN3NZDLVDIYQN6JSC2M7QMMBL4E";
export const CHALLENGE_UX_WALLET_A =
  "GDYJ7GZ4WDGYFE6R3HFBUK2GYMFIFP3JHFYSYAME6XISG5BEKZDJVGHN";
export const CHALLENGE_UX_WALLET_B =
  "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGSNFHEYVXM3XOJMDS674JZ";
export const CHALLENGE_UX_TX_HASH_1 = "a".repeat(64);
export const CHALLENGE_UX_TX_HASH_2 = "b1".repeat(32);

export type FixtureVSData = VSData & {
  claim_statement: string;
  network?: string;
};

export interface MarketObservationSnapshot {
  vs: FixtureVSData;
  cache: VSCacheFreshness | null;
}

export type ScriptedWalletOutcome =
  | { kind: "confirmed"; txHash: string }
  | { kind: "wallet_rejected"; message?: string }
  | { kind: "ledger_rejected"; status: number; message: string }
  | { kind: "uncertain_timeout"; txHash: string; message?: string }
  | { kind: "uncertain_unwrap_error"; txHash: string; message?: string };

export type ChallengeSubmitRefusalReason =
  | "recovery_blocking"
  | "authorization_cleared"
  | "review_missing_or_stale"
  | "ticket_revision_stale"
  | "observation_not_challengeable"
  | "invalid_stake"
  | "no_wallet";

export type ChallengeSubmitResult =
  | { status: "confirmed"; txHash: string; stakeUsdc: number }
  | { status: "refused"; reason: ChallengeSubmitRefusalReason; expiry?: MarketExpiry }
  | {
      status: "wallet_rejected";
      message: string;
      uncertain: false;
      canRetryImmediately: true;
    }
  | {
      status: "uncertain_recorded";
      txHash: string;
      recovery: ChallengeRecoveryRecord;
      submission: UncertainSubmissionState;
    };

// ── Synthetic builders ────────────────────────────────────────────────────────

/**
 * Build a deterministic synthetic market snapshot. All stakes are integer USDC.
 */
export function makeChallengeFixtureVs(
  overrides: Partial<FixtureVSData> = {},
): FixtureVSData {
  const baseDeadlineSec = Math.floor(CHALLENGE_UX_BASE_NOW_MS / 1000) + 3_600;
  const statement =
    overrides.claim_statement ??
    overrides.question ??
    "Will BTC close above $100,000 before the settlement deadline?";
  return {
    id: 42,
    creator: CHALLENGE_UX_CREATOR_WALLET,
    opponent: "",
    question: statement,
    claim_statement: statement,
    creator_position: "Yes",
    opponent_position: "No",
    resolution_url: "https://example.org/resolution/btc",
    stake_amount: 5,
    creator_stake: 5,
    total_challenger_stake: 0,
    reserved_creator_liability: 0,
    available_creator_liability: 5,
    deadline: baseDeadlineSec,
    state: "open",
    winner: "",
    resolution_summary: "",
    category: "crypto",
    market_type: "binary",
    odds_mode: "pool",
    max_challengers: 10,
    challenger_count: 0,
    challengers: [],
    challenger_addresses: [],
    challenger_payout_bps: 0,
    network: "stellar-testnet",
    ...overrides,
  };
}

/** Build a fresh or stale read-index / contract freshness record anchored to `nowMs`. */
export function makeFixtureFreshness(args: {
  source: "index" | "contract";
  status: "live" | "cached" | "stale";
  nowMs: number;
  ageMs?: number;
  serverClockOffsetMs?: number;
  freshnessWindowMs?: number;
}): VSCacheFreshness {
  const ageMs = args.ageMs ?? (args.status === "stale" ? 120_000 : 500);
  const serverNowMs = args.nowMs + (args.serverClockOffsetMs ?? 0);
  const updatedAtMs = Math.max(0, serverNowMs - ageMs);
  return {
    source: args.source,
    status: args.status,
    lastUpdatedAt: new Date(updatedAtMs).toISOString(),
    ageMs,
    freshnessWindowMs: args.freshnessWindowMs ?? 15_000,
    ...(args.source === "index" && args.status === "stale"
      ? { staleReason: "provider_lag" as const }
      : {}),
  };
}

// ── Fake observation & chain status transport ─────────────────────────────────

/**
 * Deterministic offline transport for market observations and transaction
 * status reconciliation. Soroban contract state is stored separately from
 * read-index snapshots so tests can model stale or conflicting index reads.
 */
export class FakeChallengeObservationTransport {
  private authoritativeVs: FixtureVSData;
  private readonly txStatusQueues = new Map<string, ReconciliationProbeResult[]>();
  private readonly landedTxs: Array<{ txHash: string; account: string; stakeUsdc: number }> = [];
  private statusProbeCalls = 0;

  constructor(initialVs: FixtureVSData) {
    this.authoritativeVs = { ...initialVs };
  }

  /** Return the current authoritative Soroban claim snapshot. */
  getAuthoritativeVs(): FixtureVSData {
    return { ...this.authoritativeVs };
  }

  /** Mutate authoritative on-chain market state (e.g. resolved, edited, or staked). */
  setAuthoritativeVs(patch: Partial<FixtureVSData>): FixtureVSData {
    this.authoritativeVs = { ...this.authoritativeVs, ...patch };
    return this.getAuthoritativeVs();
  }

  /** Queue deterministic status probe outcomes for a transaction hash. */
  queueTxStatuses(txHash: string, statuses: readonly ReconciliationProbeResult[]): void {
    const key = txHash.trim().toLowerCase();
    const existing = this.txStatusQueues.get(key) ?? [];
    existing.push(...statuses);
    this.txStatusQueues.set(key, existing);
  }

  /** Probe authoritative chain status for `txHash` once. */
  async probeTransaction(txHash: string): Promise<ReconciliationProbeResult> {
    this.statusProbeCalls += 1;
    const key = txHash.trim().toLowerCase();
    const queue = this.txStatusQueues.get(key);
    if (!queue || queue.length === 0) {
      return "pending";
    }
    if (queue.length === 1) {
      return queue[0]!;
    }
    return queue.shift()!;
  }

  /** Record a confirmed on-chain challenge stake (integer USDC). */
  recordLandedChallenge(entry: { txHash: string; account: string; stakeUsdc: number }): void {
    this.landedTxs.push(entry);
    this.authoritativeVs = {
      ...this.authoritativeVs,
      state: "accepted",
      challenger_count: (this.authoritativeVs.challenger_count ?? 0) + 1,
      total_challenger_stake:
        (this.authoritativeVs.total_challenger_stake ?? 0) + entry.stakeUsdc,
    };
  }

  landedChallenges(): ReadonlyArray<{ txHash: string; account: string; stakeUsdc: number }> {
    return this.landedTxs;
  }

  totalStatusProbeCalls(): number {
    return this.statusProbeCalls;
  }
}

// ── Fake wallet signer (no live keys, no funded accounts) ─────────────────────

/**
 * Scriptable offline wallet signer that models user rejections, definitive
 * ledger errors, uncertain transport timeouts, and confirmed signatures.
 */
export class FakeChallengeWallet {
  private account: string | null;
  private readonly outcomes: ScriptedWalletOutcome[] = [];
  private signAttempts = 0;

  constructor(initialAccount: string | null = CHALLENGE_UX_WALLET_A) {
    this.account = initialAccount;
  }

  getAddress(): string | null {
    return this.account;
  }

  setAddress(nextAccount: string | null): void {
    this.account = nextAccount;
  }

  enqueueOutcome(outcome: ScriptedWalletOutcome): void {
    this.outcomes.push(outcome);
  }

  attempts(): number {
    return this.signAttempts;
  }

  async signAndSubmitChallenge(input: {
    vsId: number;
    stakeUsdc: number;
    revisionKey: string;
  }): Promise<{ txHash: string }> {
    if (!this.account) {
      throw new Error("Wallet not connected");
    }
    if (!Number.isInteger(input.stakeUsdc) || input.stakeUsdc <= 0) {
      throw new Error("Challenge stake must be a positive integer USDC amount");
    }
    this.signAttempts += 1;
    const next = this.outcomes.shift() ?? {
      kind: "confirmed",
      txHash: CHALLENGE_UX_TX_HASH_1,
    };

    switch (next.kind) {
      case "confirmed":
        return { txHash: next.txHash };
      case "wallet_rejected":
        throw new StellarTransactionError(
          next.message ?? "challenge_claim: user rejected wallet signature",
          { phase: "submit" },
        );
      case "ledger_rejected": {
        const err = new Error(next.message) as Error & {
          response?: { status: number };
        };
        err.response = { status: next.status };
        throw err;
      }
      case "uncertain_timeout": {
        const err = new StellarTransactionError(
          next.message ?? "challenge_claim: RPC timed out awaiting ledger receipt",
          { txHash: next.txHash, phase: "confirm" },
        );
        throw err;
      }
      case "uncertain_unwrap_error":
        throw new StellarTransactionError(
          next.message ?? "challenge_claim: result unwrap failed after submit",
          { txHash: next.txHash, phase: "result" },
        );
    }
  }
}

// ── File-backed deterministic recovery store (simulates reloads) ──────────────

class TempDirRecoveryStore {
  private readonly filePath: string;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.filePath = path.join(stateDir, "challenge-recovery.json");
  }

  read(vsId: number, address: string | null, nowMs: number): ChallengeRecoveryRecord | null {
    if (!address || !existsSync(this.filePath)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as ChallengeRecoveryRecord[];
      if (!Array.isArray(parsed)) return null;
      const normalized = address.trim().toLowerCase();
      return (
        parsed.find(
          (item) =>
            item.vsId === vsId &&
            item.address === normalized &&
            !isChallengeRecoveryExpired(item, nowMs),
        ) ?? null
      );
    } catch {
      return null;
    }
  }

  save(record: ChallengeRecoveryRecord, nowMs: number): void {
    let existing: ChallengeRecoveryRecord[] = [];
    if (existsSync(this.filePath)) {
      try {
        const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as ChallengeRecoveryRecord[];
        if (Array.isArray(parsed)) {
          existing = parsed.filter((item) => !isChallengeRecoveryExpired(item, nowMs));
        }
      } catch {
        existing = [];
      }
    }
    const filtered = existing.filter(
      (item) => !(item.vsId === record.vsId && item.address === record.address),
    );
    filtered.unshift(record);
    writeFileSync(this.filePath, JSON.stringify(filtered, null, 2));
  }

  clear(vsId: number, address: string | null, nowMs: number): void {
    if (!address || !existsSync(this.filePath)) return;
    const normalized = address.trim().toLowerCase();
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as ChallengeRecoveryRecord[];
      if (!Array.isArray(parsed)) return;
      const remaining = parsed.filter(
        (item) =>
          !(item.vsId === vsId && item.address === normalized) &&
          !isChallengeRecoveryExpired(item, nowMs),
      );
      writeFileSync(this.filePath, JSON.stringify(remaining, null, 2));
    } catch {
      // Ignore corrupt test store on clear.
    }
  }
}

// ── End-to-end deterministic Challenge UX harness ─────────────────────────────

export interface ChallengeUxHarnessOptions {
  vsId?: number;
  initialVs?: FixtureVSData;
  initialAccount?: string | null;
  nowMs?: number;
  stateDir?: string;
}

/**
 * Deterministic harness combining `useVsDetail` state transitions, expiry
 * observations, `CreateChallengeTicket` revision digests, wallet rejections,
 * and uncertain submission recovery with a fake clock and temp state directory.
 */
export class ChallengeUxFixtureHarness {
  readonly stateDir: string;
  private readonly ownsStateDir: boolean;
  readonly transport: FakeChallengeObservationTransport;
  readonly wallet: FakeChallengeWallet;
  private readonly store: TempDirRecoveryStore;

  private nowMs: number;
  private detailState: VsDetailState;
  private expiryObservation: ExpiryObservation | null = null;
  private intentReview: ChallengeIntentReview | null = null;
  private reviewedTicketRevision: string | null = null;
  private authorizationClearedFor: string | null = null;
  private challengeRecovery: ChallengeRecoveryRecord | null = null;
  private uncertainSubmission: UncertainSubmissionState | null = null;

  constructor(options: ChallengeUxHarnessOptions = {}) {
    const initialVs = options.initialVs ?? makeChallengeFixtureVs({ id: options.vsId ?? 42 });
    const vsId = options.vsId ?? initialVs.id;
    this.nowMs = options.nowMs ?? CHALLENGE_UX_BASE_NOW_MS;
    this.ownsStateDir = !options.stateDir;
    this.stateDir =
      options.stateDir ?? mkdtempSync(path.join(tmpdir(), "mimir-challenge-ux-"));
    this.transport = new FakeChallengeObservationTransport(initialVs);
    this.wallet = new FakeChallengeWallet(
      "initialAccount" in options ? options.initialAccount : CHALLENGE_UX_WALLET_A,
    );
    this.store = new TempDirRecoveryStore(this.stateDir);
    this.detailState = createVsDetailState(vsId);
  }

  getNowMs(): number {
    return this.nowMs;
  }

  advanceClock(deltaMs: number): number {
    this.nowMs += deltaMs;
    return this.nowMs;
  }

  getDetailState(): VsDetailState {
    return this.detailState;
  }

  getRecovery(): ChallengeRecoveryRecord | null {
    return this.challengeRecovery;
  }

  getUncertainSubmission(): UncertainSubmissionState | null {
    return this.uncertainSubmission;
  }

  getIntentReview(): ChallengeIntentReview | null {
    return this.intentReview;
  }

  getAuthorizationClearedFor(): string | null {
    return this.authorizationClearedFor;
  }

  /** Start a fetch and return its generation number for deterministic late delivery. */
  beginFetch(opts: { isManual?: boolean } = {}): number {
    this.detailState = beginVsDetailFetch(this.detailState, opts);
    return this.detailState.generation;
  }

  /**
   * Deliver a market observation for a specific fetch generation.
   * Mirrors `useVsDetail`: superseded generations are silently dropped; fresh
   * generations update `vs`, `cache`, `expiryObservation`, and invalidate any
   * stale `intentReview`.
   */
  deliverObservation(
    generation: number,
    snapshot: MarketObservationSnapshot,
  ): { applied: boolean; state: VsDetailState } {
    const before = this.detailState;
    const next = applyVsDetailFetchOutcome(before, {
      kind: "success",
      generation,
      vs: snapshot.vs,
      cache: snapshot.cache,
    });
    if (next === before) {
      return { applied: false, state: next };
    }
    this.detailState = next;
    this.expiryObservation = observationFromFreshness(snapshot.cache, this.nowMs);
    this.reconcileReviewValidity();
    return { applied: true, state: next };
  }

  /** Deliver a fetch error for a specific generation (dropped if superseded). */
  deliverFetchError(generation: number): { applied: boolean; state: VsDetailState } {
    const before = this.detailState;
    const next = applyVsDetailFetchOutcome(before, {
      kind: "error",
      generation,
    });
    if (next === before) {
      return { applied: false, state: next };
    }
    this.detailState = next;
    return { applied: true, state: next };
  }

  /** Convenience helper: fetch and immediately deliver the authoritative contract state. */
  refreshFromContract(opts: { ageMs?: number; serverClockOffsetMs?: number } = {}): VsDetailState {
    const gen = this.beginFetch({ isManual: true });
    const vs = this.transport.getAuthoritativeVs();
    const cache = makeFixtureFreshness({
      source: "contract",
      status: "live",
      nowMs: this.nowMs,
      ageMs: opts.ageMs ?? 0,
      serverClockOffsetMs: opts.serverClockOffsetMs ?? 0,
    });
    this.deliverObservation(gen, { vs, cache });
    return this.detailState;
  }

  /** User types a custom integer USDC stake (preserved across refreshes & rejections). */
  setStake(stakeUsdc: string): void {
    this.detailState = setVsDetailChallengeStake(this.detailState, stakeUsdc);
    this.reconcileReviewValidity();
  }

  resetStake(): void {
    this.detailState = resetVsDetailChallengeStake(this.detailState);
    this.reconcileReviewValidity();
  }

  /** Switch routes to another market id, resetting all state atomically. */
  switchMarket(nextVsId: number): void {
    this.detailState = resetVsDetailState(nextVsId);
    this.expiryObservation = null;
    this.intentReview = null;
    this.reviewedTicketRevision = null;
    this.challengeRecovery = this.store.read(nextVsId, this.wallet.getAddress(), this.nowMs);
  }

  /**
   * Switch the active wallet account. Mirrors `useVsDetail` #922:
   * clears signed authorization and invalidates review, while preserving the
   * user's typed `challengeStake` draft.
   */
  switchAccount(nextAccount: string | null): void {
    const previous = this.wallet.getAddress();
    this.wallet.setAddress(nextAccount);
    if (previous !== null && previous !== nextAccount) {
      this.authorizationClearedFor = nextAccount;
    }
    this.reconcileReviewValidity();
    const vsId = this.detailState.vs?.id ?? 42;
    this.challengeRecovery = this.store.read(vsId, nextAccount, this.nowMs);
  }

  /** Compute the current integer USDC stake parsed from `challengeStake`. */
  currentStakeUsdc(): number | null {
    const trimmed = this.detailState.challengeStake.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }

  /** Compute the current `CreateChallengeTicket` sha256 revision digest. */
  currentTicketRevision(): string {
    const vs = this.detailState.vs as FixtureVSData | null;
    const stake = this.currentStakeUsdc();
    return computeChallengeTicketRevision({
      account: this.wallet.getAddress(),
      stakeAmount: stake ?? Number.NaN,
      claim: vs?.claim_statement ?? vs?.question ?? "",
    });
  }

  /** Capture both `useVsDetail` intent review and `CreateChallengeTicket` review. */
  captureReview(): { intent: ChallengeIntentReview; ticketRevision: string } | null {
    const vs = this.detailState.vs as FixtureVSData | null;
    const stake = this.currentStakeUsdc();
    if (!vs || stake === null) {
      this.intentReview = null;
      this.reviewedTicketRevision = null;
      return null;
    }
    const account = this.wallet.getAddress();
    const claimStatement = vs.claim_statement ?? vs.question;
    const revisionKey = buildChallengeRevisionKey(claimStatement, account, stake);
    const intent: ChallengeIntentReview = {
      stakeAmount: stake,
      claimStatement,
      network: vs.network ?? null,
      account,
      revisionKey,
    };
    const ticketRevision = this.currentTicketRevision();
    this.intentReview = intent;
    this.reviewedTicketRevision = ticketRevision;
    // Re-reviewing under the new account clears the account-switch re-auth gate.
    this.authorizationClearedFor = null;
    return { intent, ticketRevision };
  }

  isIntentReviewCurrent(): boolean {
    const vs = this.detailState.vs as FixtureVSData | null;
    return isChallengeIntentReviewValid(this.intentReview, {
      claimStatement: vs?.claim_statement ?? vs?.question ?? null,
      account: this.wallet.getAddress(),
      stakeAmount: this.currentStakeUsdc(),
    });
  }

  isTicketRevisionCurrent(): boolean {
    return (
      this.reviewedTicketRevision !== null &&
      this.reviewedTicketRevision === this.currentTicketRevision()
    );
  }

  /** Evaluate market expiry against the observed ledger context. */
  evaluateExpiry(): MarketExpiry {
    const vs = this.detailState.vs;
    return evaluateMarketExpiry({
      deadlineUnix: vs?.deadline ?? null,
      nowMs: this.nowMs,
      observation: this.expiryObservation,
      marketState: vs?.state ?? null,
      challengeLockSeconds: DEFAULT_CHALLENGE_LOCK_SECONDS,
    });
  }

  /**
   * Attempt to sign and submit a challenge stake.
   *
   * Enforces every UX safety gate in order:
   *  1. Connected wallet
   *  2. No blocking uncertain recovery record or un-reconciled submission
   *  3. No uncleared account-switch authorization
   *  4. Valid integer USDC stake
   *  5. Non-stale intent review & ticket revision
   *  6. Fresh, challengeable expiry observation
   */
  async submitChallenge(): Promise<ChallengeSubmitResult> {
    const account = this.wallet.getAddress();
    if (!account) {
      return { status: "refused", reason: "no_wallet" };
    }

    if (
      isChallengeRecoveryBlocking(this.challengeRecovery, this.nowMs) ||
      !canResubmitPayment(this.uncertainSubmission)
    ) {
      return { status: "refused", reason: "recovery_blocking" };
    }

    if (this.authorizationClearedFor !== null && this.authorizationClearedFor === account) {
      return { status: "refused", reason: "authorization_cleared" };
    }

    const stakeUsdc = this.currentStakeUsdc();
    if (stakeUsdc === null) {
      return { status: "refused", reason: "invalid_stake" };
    }

    if (!this.isIntentReviewCurrent()) {
      return { status: "refused", reason: "review_missing_or_stale" };
    }

    if (!this.isTicketRevisionCurrent()) {
      return { status: "refused", reason: "ticket_revision_stale" };
    }

    const expiry = this.evaluateExpiry();
    if (!expiry.challengeable) {
      return { status: "refused", reason: "observation_not_challengeable", expiry };
    }

    const vs = this.detailState.vs as FixtureVSData;
    try {
      const { txHash } = await this.wallet.signAndSubmitChallenge({
        vsId: vs.id,
        stakeUsdc,
        revisionKey: this.intentReview!.revisionKey,
      });
      this.transport.recordLandedChallenge({ txHash, account, stakeUsdc });
      return { status: "confirmed", txHash, stakeUsdc };
    } catch (err) {
      const txHash = challengeRecoveryTxHashFromError(err);
      if (txHash) {
        const recovery = createChallengeRecoveryRecord({
          vsId: vs.id,
          txHash,
          address: account,
          stakeAmount: stakeUsdc,
          now: this.nowMs,
        });
        this.store.save(recovery, this.nowMs);
        this.challengeRecovery = recovery;
        this.uncertainSubmission = createUncertainSubmission({
          hash: txHash,
          action: "challenge_claim",
          maxAttempts: 5,
          now: this.nowMs,
        });
        return {
          status: "uncertain_recorded",
          txHash,
          recovery,
          submission: this.uncertainSubmission,
        };
      }

      const uncertain = isUncertainSubmissionError(err);
      const message = err instanceof Error ? err.message : String(err);
      return {
        status: "wallet_rejected",
        message,
        uncertain: uncertain as false,
        canRetryImmediately: true,
      };
    }
  }

  /**
   * Run one bounded status-check against the fake transport without ever
   * resubmitting the transaction.
   */
  async reconcileRecovery(): Promise<{
    probed: boolean;
    recovery: ChallengeRecoveryRecord | null;
    submission: UncertainSubmissionState | null;
  }> {
    const record = this.challengeRecovery;
    if (!record || record.status !== "unknown") {
      return {
        probed: false,
        recovery: record,
        submission: this.uncertainSubmission,
      };
    }
    if (
      !hasChallengeStatusBudget(record) ||
      !isChallengeRecoveryBlocking(record, this.nowMs)
    ) {
      return {
        probed: false,
        recovery: record,
        submission: this.uncertainSubmission,
      };
    }

    const probe = await this.transport.probeTransaction(record.txHash);
    const outcome: ChallengeStatusOutcome = {
      succeeded: probe === "succeeded",
      failed: probe === "failed",
    };
    const nextRecord = applyChallengeStatusOutcome(record, outcome);
    this.challengeRecovery = nextRecord;
    this.store.save(nextRecord, this.nowMs);

    if (this.uncertainSubmission) {
      this.uncertainSubmission = await reconcileUncertainSubmission(
        this.uncertainSubmission,
        { checkTransaction: async () => probe },
      );
    }

    if (nextRecord.status === "succeeded") {
      this.transport.recordLandedChallenge({
        txHash: nextRecord.txHash,
        account: nextRecord.address,
        stakeUsdc: nextRecord.stakeAmount,
      });
      this.refreshFromContract();
    } else if (nextRecord.status === "failed") {
      this.refreshFromContract();
    }

    return {
      probed: true,
      recovery: nextRecord,
      submission: this.uncertainSubmission,
    };
  }

  /** Dismiss recovery only when no longer blocking (resolved or expired). */
  dismissRecovery(): boolean {
    if (isChallengeRecoveryBlocking(this.challengeRecovery, this.nowMs)) {
      return false;
    }
    if (this.challengeRecovery) {
      this.store.clear(
        this.challengeRecovery.vsId,
        this.wallet.getAddress(),
        this.nowMs,
      );
    }
    this.challengeRecovery = null;
    if (this.uncertainSubmission && this.uncertainSubmission.status !== "uncertain") {
      this.uncertainSubmission = null;
    }
    return true;
  }

  /**
   * Simulate a browser reload: ephemeral in-memory state resets, while
   * persisted recovery records are reloaded from the temporary state directory.
   */
  simulateReload(): void {
    const vsId = this.detailState.vs?.id ?? 42;
    this.detailState = createVsDetailState(vsId);
    this.expiryObservation = null;
    this.intentReview = null;
    this.reviewedTicketRevision = null;
    this.authorizationClearedFor = null;
    this.challengeRecovery = this.store.read(vsId, this.wallet.getAddress(), this.nowMs);
    this.uncertainSubmission = this.challengeRecovery
      ? {
          ...createUncertainSubmission({
            hash: this.challengeRecovery.txHash,
            action: "challenge_claim",
            maxAttempts: 5,
            now: this.challengeRecovery.submittedAtMs,
          }),
          status:
            this.challengeRecovery.status === "succeeded"
              ? "confirmed"
              : this.challengeRecovery.status === "failed"
                ? "failed"
                : "uncertain",
          canResubmit: this.challengeRecovery.status === "failed",
          attempts: this.challengeRecovery.statusChecks,
        }
      : null;
  }

  close(): void {
    if (this.ownsStateDir) {
      rmSync(this.stateDir, { recursive: true, force: true });
    }
  }

  private reconcileReviewValidity(): void {
    if (this.intentReview && !this.isIntentReviewCurrent()) {
      this.intentReview = null;
    }
  }
}
