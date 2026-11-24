/**
 * Market-context binding review before a private (XMTP) conversation opens.
 *
 * Covers:
 *  - the review is built from trusted rows loaded for the connected account
 *  - a conversation opens only after the user confirms that exact review
 *  - stale state is refused: context changed since review, account switched,
 *    selection changed, rows loaded for another account
 *  - untrusted navigation hints (`?vs=&peer=`) can preselect but never open,
 *    and a hint that disagrees with trusted context is blocked
 *  - the review panel renders market + participant identity (SSR)
 *  - the hub gates `VsXmtpPanel` behind the binding (source contract)
 *
 * Synthetic fixtures only: no XMTP client, no network, no wallet.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";

import type { VSData } from "../../lib/contract";
import { ZERO_ADDRESS } from "../../lib/constants";
import {
  buildConversationBindingReview,
  confirmConversationBinding,
  parseConversationNavigationHint,
  resolveConversationBinding,
  resolveConversationNavigationHint,
  type TrustedConversationContext,
} from "../../lib/xmtp/conversation-binding";
import ConversationBindingReview from "../../components/xmtp/ConversationBindingReview";

const ALICE = "GALICEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const BOB = "GBOBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const CAROL = "GCAROLCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const MALLORY = "GMALLORYMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM";

function vs(overrides: Partial<VSData>): VSData {
  return {
    id: 7,
    creator: ALICE,
    opponent: BOB,
    question: "Will synthetic index X close above 100 on Friday?",
    creator_position: "Yes",
    opponent_position: "No",
    resolution_url: "https://example.invalid/resolution",
    stake_amount: 10,
    deadline: 1_900_000_000,
    state: "accepted",
    winner: ZERO_ADDRESS,
    resolution_summary: "",
    category: "crypto",
    ...overrides,
  };
}

function trusted(address: string | null, items: VSData[]): TrustedConversationContext {
  return { address, items };
}

const ROWS = [vs({ id: 7 }), vs({ id: 8, opponent: CAROL, question: "Other market?" })];

// ── Review built from trusted context ───────────────────────────────────────

test("review shows the selected market and the on-chain counterpart for the viewer", () => {
  const result = buildConversationBindingReview({
    trusted: trusted(ALICE, ROWS),
    address: ALICE,
    vsId: 7,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.review.vsId, 7);
  assert.equal(result.review.question, ROWS[0].question);
  assert.equal(result.review.viewerAddress, ALICE);
  assert.equal(result.review.peerAddress, BOB);
  assert.equal(result.review.marketState, "accepted");

  const fromBob = buildConversationBindingReview({
    trusted: trusted(BOB, ROWS),
    address: BOB,
    vsId: 7,
  });
  assert.equal(fromBob.ok && fromBob.review.peerAddress, ALICE);
});

test("review refuses rows that were loaded for another account (wallet switch window)", () => {
  const result = buildConversationBindingReview({
    trusted: trusted(ALICE, ROWS),
    address: CAROL,
    vsId: 8,
  });
  assert.deepEqual(result, { ok: false, reason: "context_not_loaded" });
  assert.deepEqual(
    buildConversationBindingReview({ trusted: trusted(null, []), address: null, vsId: 7 }),
    { ok: false, reason: "no_account" },
  );
});

test("review refuses unknown, ineligible, and non-participant markets", () => {
  assert.deepEqual(
    buildConversationBindingReview({ trusted: trusted(ALICE, ROWS), address: ALICE, vsId: 99 }),
    { ok: false, reason: "market_not_found" },
  );
  assert.deepEqual(
    buildConversationBindingReview({
      trusted: trusted(ALICE, [vs({ id: 7, state: "open", opponent: ZERO_ADDRESS })]),
      address: ALICE,
      vsId: 7,
    }),
    { ok: false, reason: "not_eligible" },
  );
  assert.deepEqual(
    buildConversationBindingReview({
      trusted: trusted(MALLORY, [vs({ id: 7 })]),
      address: MALLORY,
      vsId: 7,
    }),
    { ok: false, reason: "not_participant" },
  );
});

// ── Confirmation gate ───────────────────────────────────────────────────────

test("conversation stays closed until the review is confirmed, then opens", () => {
  const context = trusted(ALICE, ROWS);
  const before = resolveConversationBinding({
    confirmed: null,
    selectedVsId: 7,
    trusted: context,
    address: ALICE,
  });
  assert.equal(before.open, false);
  assert.equal(!before.open && before.reason, "not_confirmed");
  assert.ok(before.review, "a review is offered while unconfirmed");

  const confirmed = confirmConversationBinding(before.review!, 1_000);
  const after = resolveConversationBinding({
    confirmed,
    selectedVsId: 7,
    trusted: context,
    address: ALICE,
  });
  assert.equal(after.open, true);
  assert.equal(after.review.peerAddress, BOB);
});

test("stale: counterpart changed after review blocks the open and asks for re-review", () => {
  const reviewed = buildConversationBindingReview({
    trusted: trusted(ALICE, ROWS),
    address: ALICE,
    vsId: 7,
  });
  assert.ok(reviewed.ok);
  const confirmed = confirmConversationBinding(reviewed.review, 1_000);

  // Trusted rows refetched; the market now resolves to a different peer.
  const changed = trusted(ALICE, [vs({ id: 7, opponent: CAROL }), ROWS[1]]);
  const state = resolveConversationBinding({
    confirmed,
    selectedVsId: 7,
    trusted: changed,
    address: ALICE,
  });
  assert.equal(state.open, false);
  assert.equal(!state.open && state.reason, "context_changed");
  assert.equal(state.review?.peerAddress, CAROL, "re-review shows the new counterpart");

  // Same for a question edit or a state transition.
  for (const edited of [
    vs({ id: 7, question: "A different question?" }),
    vs({ id: 7, state: "resolved" }),
  ]) {
    const s = resolveConversationBinding({
      confirmed,
      selectedVsId: 7,
      trusted: trusted(ALICE, [edited]),
      address: ALICE,
    });
    assert.equal(s.open, false);
  }
});

test("stale: confirmation for another market or another account never opens", () => {
  const context = trusted(ALICE, ROWS);
  const r7 = buildConversationBindingReview({ trusted: context, address: ALICE, vsId: 7 });
  assert.ok(r7.ok);
  const confirmed7 = confirmConversationBinding(r7.review, 1_000);

  const otherMarket = resolveConversationBinding({
    confirmed: confirmed7,
    selectedVsId: 8,
    trusted: context,
    address: ALICE,
  });
  assert.equal(!otherMarket.open && otherMarket.reason, "selection_changed");

  // Bob is also a participant of #7, but Alice's confirmation is not his.
  const bobContext = trusted(BOB, ROWS);
  const otherAccount = resolveConversationBinding({
    confirmed: confirmed7,
    selectedVsId: 7,
    trusted: bobContext,
    address: BOB,
  });
  assert.equal(!otherAccount.open && otherAccount.reason, "account_changed");
});

// ── Untrusted navigation hints ──────────────────────────────────────────────

test("parse navigation hint: absent, valid, malformed", () => {
  assert.equal(parseConversationNavigationHint(""), null);
  assert.equal(parseConversationNavigationHint("?tab=x"), null);
  assert.deepEqual(parseConversationNavigationHint(`?vs=7&peer=${BOB}`), {
    vsId: 7,
    peerAddress: BOB,
    malformed: false,
  });
  assert.equal(parseConversationNavigationHint("?vs=7abc")?.malformed, true);
  assert.equal(parseConversationNavigationHint("?vs=-1")?.malformed, true);
  assert.equal(parseConversationNavigationHint(`?peer=${BOB}`)?.malformed, true);
  assert.equal(parseConversationNavigationHint("?vs=99999999999999999999")?.malformed, true);
});

test("matching hint preselects for review only; it is not a confirmation", () => {
  const context = trusted(ALICE, ROWS);
  const hint = parseConversationNavigationHint(`?vs=7&peer=${BOB.toLowerCase()}`)!;
  const result = resolveConversationNavigationHint({ hint, trusted: context, address: ALICE });
  assert.equal(result.ok, true);

  const state = resolveConversationBinding({
    confirmed: null,
    selectedVsId: 7,
    trusted: context,
    address: ALICE,
  });
  assert.equal(state.open, false, "a valid link still requires the review step");
});

test("stale hint: peer or market that disagrees with trusted context is blocked", () => {
  const context = trusted(ALICE, ROWS);
  assert.deepEqual(
    resolveConversationNavigationHint({
      hint: parseConversationNavigationHint(`?vs=7&peer=${CAROL}`)!,
      trusted: context,
      address: ALICE,
    }),
    { ok: false, reason: "peer_mismatch" },
  );
  assert.deepEqual(
    resolveConversationNavigationHint({
      hint: parseConversationNavigationHint("?vs=42")!,
      trusted: context,
      address: ALICE,
    }),
    { ok: false, reason: "market_not_found" },
  );
  assert.deepEqual(
    resolveConversationNavigationHint({
      hint: parseConversationNavigationHint("?vs=nope")!,
      trusted: context,
      address: ALICE,
    }),
    { ok: false, reason: "malformed_hint" },
  );
  // Link carried over from a previous wallet: rows still belong to Alice.
  assert.deepEqual(
    resolveConversationNavigationHint({
      hint: parseConversationNavigationHint("?vs=8")!,
      trusted: context,
      address: MALLORY,
    }),
    { ok: false, reason: "context_not_loaded" },
  );
});

// ── Rendered review panel ───────────────────────────────────────────────────

const en = JSON.parse(readFileSync(join(process.cwd(), "messages/en.json"), "utf8")) as {
  messagesHub: Record<string, unknown>;
};

function renderReview(staleReason: "context_changed" | null = null): string {
  const built = buildConversationBindingReview({
    trusted: trusted(ALICE, ROWS),
    address: ALICE,
    vsId: 7,
  });
  assert.ok(built.ok);
  return renderToStaticMarkup(
    React.createElement(NextIntlClientProvider, {
      locale: "en",
      messages: { messagesHub: en.messagesHub },
      timeZone: "UTC",
      children: React.createElement(ConversationBindingReview, {
        review: built.review,
        staleReason,
        onConfirm: () => {},
        onCancel: () => {},
      }),
    }),
  );
}

test("review panel renders market and both participant identities with confirm/cancel", () => {
  const html = renderReview();
  assert.match(html, /data-testid="conversation-binding-review"/);
  assert.match(html, /VS #7/);
  assert.match(html, /Will synthetic index X close above 100 on Friday\?/);
  assert.ok(html.includes(ALICE));
  assert.ok(html.includes(BOB));
  assert.match(html, /Start private chat/);
  assert.match(html, /Cancel/);
  assert.match(html, /not from the link you followed/);
  assert.doesNotMatch(html, /role="alert"/);
});

test("review panel explains a stale confirmation", () => {
  const html = renderReview("context_changed");
  assert.match(html, /role="alert"/);
  assert.match(html, /changed since you reviewed it/);
});

// ── Hub wiring (source contract) ────────────────────────────────────────────

test("the hub gates VsXmtpPanel behind the binding review", () => {
  const hub = readFileSync(join(process.cwd(), "components/xmtp/MessagesHub.tsx"), "utf8");
  assert.match(hub, /resolveConversationBinding\(/);
  assert.match(hub, /resolveConversationNavigationHint\(/);
  assert.match(hub, /<ConversationBindingReview/);
  assert.match(hub, /bindingState == null \|\| bindingState\.open/);
  const hubStrings = en.messagesHub as Record<string, Record<string, string>>;
  for (const reason of [
    "malformed_hint",
    "no_account",
    "context_not_loaded",
    "market_not_found",
    "not_eligible",
    "not_participant",
    "peer_mismatch",
  ]) {
    assert.equal(typeof hubStrings.bindingHintBlocked[reason], "string", reason);
  }
  for (const reason of ["context_changed", "account_changed", "selection_changed"]) {
    assert.equal(typeof hubStrings.bindingStale[reason], "string", reason);
  }
});
