/**
 * Deterministic message-hub fixtures (issue #937).
 *
 * No SDK, no network and no clock reads: every case pins its inputs so the test
 * file can assert exact transitions for account changes, unavailable transports
 * and expired private conversation context. The message body and draft are
 * deliberately recognisable strings so a public surface that leaks either one
 * fails loudly.
 */

import type {
  MessagesHubConnectionInput,
  MessagesHubConnectionState,
  MessagesHubPrivateContext,
  MessagesHubPrivateContextState,
} from "../../../lib/xmtp/messages-hub-state";

/** Two funded-looking Stellar accounts. Case-sensitive, like real strkeys. */
export const HUB_ACCOUNT_A = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUWDA";
export const HUB_ACCOUNT_B = "GB7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUWDB";

/** Fixed clock: 2023-11-14T22:13:20Z. */
export const HUB_NOW_MS = 1_700_000_000_000;

/** Content that must never be rendered outside the private thread. */
export const PRIVATE_THREAD_BODY =
  "PRIVATE-CONTEXT: the oracle resolution should have been NO";
export const PRIVATE_THREAD_DRAFT = "PRIVATE-DRAFT: my opponent's private answer is";

/** Rows fetched for account A, newest first as the hub stores them. */
export const HUB_THREADS_FOR_ACCOUNT_A = [
  { id: 12, question: "Will BTC close above 100k?" },
  { id: 11, question: "Will ETH close above 5k?" },
] as const;

/**
 * A wallet switch must never render the previous account's rows, including
 * during the fetch that follows the switch.
 */
export const HUB_ACCOUNT_CHANGE_CASES = [
  {
    name: "same account keeps the rows it loaded",
    loaded: { address: HUB_ACCOUNT_A, items: HUB_THREADS_FOR_ACCOUNT_A },
    currentAddress: HUB_ACCOUNT_A,
    expectedIds: [12, 11],
  },
  {
    name: "a different account sees nothing until its own fetch lands",
    loaded: { address: HUB_ACCOUNT_A, items: HUB_THREADS_FOR_ACCOUNT_A },
    currentAddress: HUB_ACCOUNT_B,
    expectedIds: [],
  },
  {
    name: "a disconnect clears the rows",
    loaded: { address: HUB_ACCOUNT_A, items: HUB_THREADS_FOR_ACCOUNT_A },
    currentAddress: null,
    expectedIds: [],
  },
] as const;

/**
 * Every transport outcome the hub can report, including the wallet-signing
 * distinction that must not be confused with a transport outage.
 */
export const HUB_TRANSPORT_CASES: ReadonlyArray<{
  name: string;
  input: MessagesHubConnectionInput;
  expected: MessagesHubConnectionState;
}> = [
  {
    name: "wallet cannot sign messages",
    input: { canSignMessages: false, status: "error", failureKind: "unsupported_wallet" },
    expected: { signingSupported: false, transport: "not_started" },
  },
  {
    name: "user declined the identity signature",
    input: { canSignMessages: true, status: "error", failureKind: "signature_declined" },
    expected: { signingSupported: true, transport: "not_started" },
  },
  {
    name: "derived identity was malformed",
    input: { canSignMessages: true, status: "error", failureKind: "invalid_identity" },
    expected: { signingSupported: true, transport: "not_started" },
  },
  {
    name: "transport is still connecting",
    input: { canSignMessages: true, status: "initializing", failureKind: null },
    expected: { signingSupported: true, transport: "connecting" },
  },
  {
    name: "transport is ready",
    input: { canSignMessages: true, status: "ready", failureKind: null },
    expected: { signingSupported: true, transport: "ready" },
  },
  {
    name: "another tab owns the OPFS lock",
    input: { canSignMessages: true, status: "blocked_by_tab", failureKind: "blocked_by_tab" },
    expected: { signingSupported: true, transport: "unavailable" },
  },
  {
    name: "network outage",
    input: { canSignMessages: true, status: "error", failureKind: "network" },
    expected: { signingSupported: true, transport: "unavailable" },
  },
  {
    name: "feature flag off",
    input: { canSignMessages: true, status: "disabled", failureKind: null },
    expected: { signingSupported: true, transport: "unavailable" },
  },
];

/** Private content loaded for account A, valid for one minute. */
export const HUB_PRIVATE_CONTEXT: MessagesHubPrivateContext = {
  viewerAddress: HUB_ACCOUNT_A,
  expiresAt: HUB_NOW_MS + 60_000,
};

export const HUB_PRIVATE_CONTEXT_CASES: ReadonlyArray<{
  name: string;
  address: string | null;
  context: MessagesHubPrivateContext | null;
  nowMs: number;
  expected: MessagesHubPrivateContextState;
}> = [
  {
    name: "same account before expiry",
    address: HUB_ACCOUNT_A,
    context: HUB_PRIVATE_CONTEXT,
    nowMs: HUB_NOW_MS,
    expected: { visible: true, reason: "visible" },
  },
  {
    name: "account switched while content was mounted",
    address: HUB_ACCOUNT_B,
    context: HUB_PRIVATE_CONTEXT,
    nowMs: HUB_NOW_MS,
    expected: { visible: false, reason: "account_changed" },
  },
  {
    name: "wallet disconnected",
    address: null,
    context: HUB_PRIVATE_CONTEXT,
    nowMs: HUB_NOW_MS,
    expected: { visible: false, reason: "no_account" },
  },
  {
    name: "no private content selected",
    address: HUB_ACCOUNT_A,
    context: null,
    nowMs: HUB_NOW_MS,
    expected: { visible: false, reason: "no_context" },
  },
  {
    name: "expired exactly at its boundary",
    address: HUB_ACCOUNT_A,
    context: HUB_PRIVATE_CONTEXT,
    nowMs: HUB_NOW_MS + 60_000,
    expected: { visible: false, reason: "expired" },
  },
  {
    name: "expired after its boundary",
    address: HUB_ACCOUNT_A,
    context: HUB_PRIVATE_CONTEXT,
    nowMs: HUB_NOW_MS + 60_001,
    expected: { visible: false, reason: "expired" },
  },
];
