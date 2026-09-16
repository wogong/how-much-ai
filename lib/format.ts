import type { LimitEntry, ProfileData, UsageData } from "./types";

export interface Bar {
  key: string;
  label: string;
  percent: number;
  resetsAt: string | null;
  severity: string;
  isActive: boolean;
}

const KIND_LABELS: Record<string, string> = {
  session: "Current session",
  weekly_all: "Weekly · all models",
  weekly_oauth_apps: "Weekly · connected apps",
};

function prettifyKind(kind: string): string {
  return kind.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

function kindRank(kind: string): number {
  if (kind === "session") return 0;
  if (kind === "weekly_all") return 1;
  return 2;
}

// The `limits` array is the richest source (it carries per-model scoped limits and severity).
// Fall back to the flat buckets for older response shapes.
export function extractBars(usage: UsageData, now = Date.now()): Bar[] {
  if (usage.limits && usage.limits.length > 0) {
    return [...usage.limits]
      .sort((a, b) => kindRank(a.kind) - kindRank(b.kind))
      .map((limit: LimitEntry, i) => {
        const modelName = limit.scope?.model?.display_name;
        const label =
          KIND_LABELS[limit.kind] ??
          (limit.kind === "weekly_scoped" && modelName
            ? `Weekly · ${modelName}`
            : modelName
              ? `${prettifyKind(limit.kind)} · ${modelName}`
              : prettifyKind(limit.kind));
        return {
          key: `${limit.kind}-${modelName ?? i}`,
          label,
          percent: Math.max(0, Math.min(100, limit.percent ?? 0)),
          resetsAt: limit.resets_at ?? null,
          severity: limit.severity ?? "normal",
          isActive: limit.is_active ?? false,
        };
      });
  }

  const bars: Bar[] = [];
  const push = (key: string, label: string, bucket?: { utilization: number | null; resets_at: string | null } | null) => {
    // A saved external snapshot can expire while it is still cached or displayed in a tab.
    if (usage.snapshot?.source === "sub2api" && bucket?.resets_at && Date.parse(bucket.resets_at) <= now) return;
    if (bucket && bucket.utilization != null) {
      bars.push({
        key,
        label,
        percent: Math.max(0, Math.min(100, bucket.utilization)),
        resetsAt: bucket.resets_at,
        severity: "normal",
        isActive: false,
      });
    }
  };
  push("five_hour", "Current session", usage.five_hour);
  push("seven_day", "Weekly · all models", usage.seven_day);
  push("seven_day_opus", "Weekly · Opus", usage.seven_day_opus);
  push("seven_day_sonnet", "Weekly · Sonnet", usage.seven_day_sonnet);
  return bars;
}

export function planLabel(profile?: ProfileData | null): string {
  const tier = profile?.organization?.rate_limit_tier ?? "";
  const match = tier.match(/max_(\d+)x/);
  if (match) return `Max ${match[1]}×`;
  const orgType = profile?.organization?.organization_type ?? "";
  if (orgType.includes("max") || profile?.account?.has_claude_max) return "Max";
  if (orgType.includes("pro") || profile?.account?.has_claude_pro) return "Pro";
  if (orgType.includes("enterprise")) return "Enterprise";
  if (orgType.includes("team")) return "Team";
  return "Claude";
}

export function timeUntil(iso: string | null, now: number = Date.now()): string | null {
  if (!iso) return null;
  const target = Date.parse(iso);
  if (Number.isNaN(target)) return null;
  const diff = target - now;
  // A slightly-past stamp is just clock skew or a bucket Anthropic hasn't rolled yet.
  // Showing "resetting…" next to a still-full bar reads as a contradiction, so once
  // it's meaningfully past we simply drop the countdown until the next poll corrects it.
  if (diff <= 0) return diff > -120_000 ? "resetting…" : null;
  const minutes = Math.floor(diff / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `resets in ${days}d ${hours}h`;
  if (hours > 0) return `resets in ${hours}h ${mins}m`;
  return `resets in ${Math.max(1, mins)}m`;
}

export function severityColor(percent: number, severity: string): string {
  if (severity === "critical" || percent >= 90) return "var(--color-danger)";
  if (severity === "warning" || severity === "elevated" || percent >= 70) return "var(--color-amber)";
  // Normal/low fill follows the card's provider accent (see [data-provider] tokens); coral by default.
  return "var(--accent, var(--color-coral))";
}

export function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// Compact "how long ago" for the stale banner (e.g. "just now", "3m ago", "2h ago").
export function timeAgo(ts: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ts);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
