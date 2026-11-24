"use client";

import { useTranslations } from "next-intl";
import { ShieldCheck, AlertTriangle } from "lucide-react";
import type { ConversationBindingReview as Review } from "@/lib/xmtp/conversation-binding";

/**
 * Review step shown before the messages hub opens a private conversation.
 *
 * Every value rendered here comes from the trusted review built by
 * `buildConversationBindingReview` (rows fetched for the connected account),
 * never from the URL. `staleReason` explains why a previous confirmation no
 * longer holds, so the user knows they are re-reviewing on purpose.
 */
export type ConversationBindingReviewProps = {
  review: Review;
  staleReason?: "context_changed" | "account_changed" | "selection_changed" | null;
  onConfirm: () => void;
  onCancel: () => void;
};

export default function ConversationBindingReview({
  review,
  staleReason = null,
  onConfirm,
  onCancel,
}: ConversationBindingReviewProps) {
  const t = useTranslations("messagesHub");
  return (
    <section
      aria-labelledby="messages-hub-binding-review-title"
      data-testid="conversation-binding-review"
      data-vs-id={review.vsId}
      className="m-3 rounded-xl border border-pv-emerald/30 bg-pv-surface/80 p-5 sm:m-4 sm:p-6"
    >
      <div className="flex items-start gap-3">
        <ShieldCheck className="mt-0.5 shrink-0 text-pv-emerald" size={18} aria-hidden />
        <div className="min-w-0 flex-1">
          <h3
            id="messages-hub-binding-review-title"
            className="font-display text-xs font-bold uppercase tracking-[0.16em] text-pv-text"
          >
            {t("bindingReviewTitle")}
          </h3>
          <p className="mt-1.5 text-xs leading-relaxed text-pv-muted">
            {t("bindingReviewLead")}
          </p>
        </div>
      </div>

      {staleReason ? (
        <div
          role="alert"
          className="mt-4 flex items-start gap-2 rounded-lg border border-amber-400/35 bg-amber-400/[0.08] px-3 py-2"
        >
          <AlertTriangle className="mt-0.5 shrink-0 text-amber-500" size={14} aria-hidden />
          <p className="text-xs leading-relaxed text-pv-text">
            {t(`bindingStale.${staleReason}`)}
          </p>
        </div>
      ) : null}

      <dl className="mt-4 grid gap-3 text-xs">
        <div>
          <dt className="font-display text-[10px] font-bold uppercase tracking-[0.14em] text-pv-muted">
            {t("bindingMarketLabel")}
          </dt>
          <dd className="mt-1 text-sm font-medium text-pv-text">
            <span className="font-display tabular-nums text-pv-emerald">VS #{review.vsId}</span>
            {" · "}
            <span>{review.question}</span>
          </dd>
        </div>
        <div>
          <dt className="font-display text-[10px] font-bold uppercase tracking-[0.14em] text-pv-muted">
            {t("bindingYouLabel")}
          </dt>
          <dd className="mt-1 break-all font-mono text-[11px] text-pv-text">
            {review.viewerAddress}
          </dd>
        </div>
        <div>
          <dt className="font-display text-[10px] font-bold uppercase tracking-[0.14em] text-pv-muted">
            {t("bindingPeerLabel")}
          </dt>
          <dd className="mt-1 break-all font-mono text-[11px] text-pv-text">
            {review.peerAddress}
          </dd>
        </div>
      </dl>

      <p className="mt-4 text-[11px] leading-relaxed text-pv-muted">
        {t("bindingSourceNote")}
      </p>

      <div className="mt-5 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={onConfirm}
          className="focus-ring inline-flex min-h-[44px] items-center rounded-md bg-pv-emerald px-4 font-display text-[11px] font-bold uppercase tracking-[0.14em] text-white"
        >
          {t("bindingConfirm")}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="focus-ring inline-flex min-h-[44px] items-center rounded-md border border-pv-border/40 px-4 font-display text-[11px] font-bold uppercase tracking-[0.14em] text-pv-muted hover:text-pv-text"
        >
          {t("bindingCancel")}
        </button>
      </div>
    </section>
  );
}
