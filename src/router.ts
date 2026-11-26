import type {
  FreeProviderSlot,
  HandoffCapsule,
  HarnessId,
  QuotaWindow,
  RouteDecision,
  TaskComplexity,
} from "./protocol.ts";

const HEAVY_RE =
  /\b(architect\w*|security|vulnerab\w*|race\s+condition|deadlock|migrat\w*|redesign|cryptograph\w*|root\s+cause)\b/i;
const LIGHT_RE =
  /\b(triage|typo|lint\w*|format\w*|readme|docs?|changelog|commit\s+message|summar\w*|rename|bump)\b/i;

export interface FreePoolUpsertInput {
  id: string;
  label?: string;
  remainingPct?: number;
  resetsInMinutes?: number;
  rateLimitHeaders?: Record<string, string | undefined>;
  status429?: boolean;
}

export interface SelectProactiveParams {
  prompt: string;
  harnesses: QuotaWindow[];
  complexity?: TaskComplexity;
  preferredHarness?: HarnessId;
  reserveFloorPct?: number;
  harvestWindowMinutes?: number;
  freePool?: ReturnType<typeof createFreePoolManager>;
  contextBlock?: string;
  capsule?: HandoffCapsule;
}

export function classifyTaskComplexity(
  prompt: string,
  explicit?: TaskComplexity,
): TaskComplexity {
  if (explicit === "light" || explicit === "medium" || explicit === "heavy") {
    return explicit;
  }
  const clean = prompt.trim();
  if (clean.length > 420 || HEAVY_RE.test(clean)) return "heavy";
  if (LIGHT_RE.test(clean)) return "light";
  return "medium";
}

function parseResetMinutes(raw: string | undefined): number | undefined {
  const trimmed = raw?.trim().toLowerCase();
  if (!trimmed) return undefined;
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Math.max(1, Math.ceil(Number.parseFloat(trimmed) / 60));
  }
  let totalSeconds = 0;
  let matched = false;
  for (const part of trimmed.matchAll(/(\d+(?:\.\d+)?)\s*(h|m|s|ms)/g)) {
    matched = true;
    const val = Number.parseFloat(part[1] ?? "0");
    const unit = part[2];
    if (unit === "h") totalSeconds += val * 3600;
    else if (unit === "m") totalSeconds += val * 60;
    else if (unit === "s") totalSeconds += val;
    else if (unit === "ms") totalSeconds += val / 1000;
  }
  return matched ? Math.max(1, Math.ceil(totalSeconds / 60)) : undefined;
}

export function createFreePoolManager(initialSlots?: FreeProviderSlot[]) {
  const slots = new Map<string, FreeProviderSlot>();
  const seed =
    initialSlots && initialSlots.length > 0
      ? initialSlots
      : [{ id: "opencode_zen", label: "OpenCode Zen Free", remainingPct: 100 }];
  for (const slot of seed) slots.set(slot.id, { ...slot });

  function upsertSlot(input: FreePoolUpsertInput): FreeProviderSlot {
    const id = input.id.trim() || "opencode_zen";
    const existing = slots.get(id);
    const hdrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(input.rateLimitHeaders ?? {})) {
      if (typeof v === "string") hdrs[k.toLowerCase()] = v.trim();
    }

    const remRaw =
      hdrs["x-ratelimit-remaining-requests"] ?? hdrs["x-ratelimit-remaining"];
    const limRaw =
      hdrs["x-ratelimit-limit-requests"] ?? hdrs["x-ratelimit-limit"];
    let remainingPct = existing?.remainingPct ?? 100;
    if (typeof input.remainingPct === "number") {
      remainingPct = Math.max(0, Math.min(100, Math.round(input.remainingPct)));
    } else if (remRaw !== undefined && limRaw !== undefined) {
      const rem = Number.parseFloat(remRaw);
      const lim = Number.parseFloat(limRaw);
      if (Number.isFinite(rem) && Number.isFinite(lim) && lim > 0) {
        remainingPct = Math.max(
          0,
          Math.min(100, Math.round((rem / lim) * 100)),
        );
      }
    }

    const headerReset = parseResetMinutes(
      hdrs["retry-after"] ?? hdrs["x-ratelimit-reset-requests"],
    );
    const resetsInMinutes =
      typeof input.resetsInMinutes === "number" && input.resetsInMinutes >= 0
        ? Math.round(input.resetsInMinutes)
        : (headerReset ?? existing?.resetsInMinutes);

    const isCapped = Boolean(input.status429) || remainingPct === 0;
    if (isCapped) remainingPct = 0;
    const cooldownUntil = isCapped
      ? new Date(Date.now() + (resetsInMinutes ?? 5) * 60_000).toISOString()
      : undefined;

    const next: FreeProviderSlot = {
      id,
      label: input.label?.trim() || existing?.label || id,
      remainingPct,
      ...(resetsInMinutes !== undefined ? { resetsInMinutes } : {}),
      ...(cooldownUntil ? { cooldownUntil } : {}),
    };
    slots.set(id, next);
    return next;
  }

  function pickHealthySlot(): FreeProviderSlot | undefined {
    const now = Date.now();
    return Array.from(slots.values())
      .filter(
        (s) =>
          s.remainingPct > 0 &&
          (!s.cooldownUntil || Date.parse(s.cooldownUntil) <= now),
      )
      .sort((a, b) => b.remainingPct - a.remainingPct)[0];
  }

  function toQuotaWindow(): QuotaWindow {
    const healthy = pickHealthySlot();
    if (healthy) {
      return {
        harness: "free_pool",
        label: "Free Pool (OpenCode)",
        remainingPct: healthy.remainingPct,
        ...(healthy.resetsInMinutes !== undefined
          ? { resetsInMinutes: healthy.resetsInMinutes }
          : {}),
        tier: "free",
        status: "idle",
      };
    }
    const soonestReset = Array.from(slots.values())
      .map((s) => s.resetsInMinutes)
      .filter((m): m is number => typeof m === "number")
      .sort((a, b) => a - b)[0];
    return {
      harness: "free_pool",
      label: "Free Pool (OpenCode)",
      remainingPct: 0,
      ...(soonestReset !== undefined ? { resetsInMinutes: soonestReset } : {}),
      tier: "free",
      status: "capped",
    };
  }

  return {
    upsertSlot,
    pickHealthySlot,
    listSlots: () => Array.from(slots.values()).map((s) => ({ ...s })),
    toQuotaWindow,
  };
}

const isHealthy = (h: QuotaWindow) =>
  h.remainingPct > 0 && h.status !== "capped";
const byRemainingDesc = (a: QuotaWindow, b: QuotaWindow) =>
  b.remainingPct - a.remainingPct;

export function selectProactiveHarness(
  params: SelectProactiveParams,
): RouteDecision {
  const reserveFloorPct = params.reserveFloorPct ?? 20;
  const harvestWindowMinutes = params.harvestWindowMinutes ?? 30;
  const complexity = classifyTaskComplexity(params.prompt, params.complexity);
  const freePool = params.freePool ?? createFreePoolManager();

  const pool = [...params.harnesses];
  if (
    !pool.some((h) => h.harness === "free_pool" || h.harness === "opencode")
  ) {
    pool.push(freePool.toQuotaWindow());
  }

  const handoffPrompt = params.contextBlock
    ? `${params.contextBlock}\n\n[Task]\n${params.prompt}`
    : params.prompt;
  const healthyPros = pool
    .filter((h) => h.tier === "pro" && isHealthy(h))
    .sort(byRemainingDesc);
  const healthyFrees = pool
    .filter((h) => h.tier === "free" && isHealthy(h))
    .sort(byRemainingDesc);
  const healthyLocals = pool
    .filter((h) => h.tier === "local" && isHealthy(h))
    .sort(byRemainingDesc);
  const hasAnyPro = params.harnesses.some((h) => h.tier === "pro");

  let selectedHarness: HarnessId = "free_pool";
  let reason: RouteDecision["reason"] = "free_pool_default";
  let resetNudge: string | undefined;

  if (params.preferredHarness) {
    const match = pool.find((h) => h.harness === params.preferredHarness);
    if (!match || isHealthy(match)) {
      selectedHarness = params.preferredHarness;
      reason = "preferred_harness";
    } else {
      const fallback =
        healthyPros.find((h) => h.remainingPct > reserveFloorPct) ??
        healthyPros[0] ??
        healthyFrees[0] ??
        healthyLocals[0];
      selectedHarness = fallback?.harness ?? "free_pool";
      reason = "capped_failover";
    }
  } else {
    const harvestCandidate = pool
      .filter(
        (h) =>
          h.tier === "pro" &&
          isHealthy(h) &&
          h.remainingPct >= 25 &&
          typeof h.resetsInMinutes === "number" &&
          h.resetsInMinutes > 0 &&
          h.resetsInMinutes <= harvestWindowMinutes,
      )
      .sort(
        (a, b) =>
          (a.resetsInMinutes ?? 999) - (b.resetsInMinutes ?? 999) ||
          b.remainingPct - a.remainingPct,
      )[0];

    if (harvestCandidate) {
      selectedHarness = harvestCandidate.harness;
      reason = "reset_harvest";
      resetNudge = `${harvestCandidate.label} resets in ${harvestCandidate.resetsInMinutes}m with ${harvestCandidate.remainingPct}% unused — harvesting window before reset`;
    } else if (complexity === "light") {
      const strongFree = healthyFrees.find((h) => h.remainingPct > 10);
      const proAbove = healthyPros.find(
        (h) => h.remainingPct > reserveFloorPct,
      );
      const pick =
        strongFree ??
        proAbove ??
        healthyLocals[0] ??
        healthyFrees[0] ??
        healthyPros[0];
      selectedHarness = pick?.harness ?? "free_pool";
      reason =
        pick?.tier === "pro" && pick === proAbove
          ? "pro_headroom"
          : "free_pool_default";
    } else if (complexity === "medium") {
      const proAbove = healthyPros.find(
        (h) => h.remainingPct > reserveFloorPct,
      );
      const fallbackFree = healthyFrees[0] ?? healthyLocals[0];
      if (proAbove) {
        selectedHarness = proAbove.harness;
        reason = "pro_headroom";
      } else if (fallbackFree) {
        selectedHarness = fallbackFree.harness;
        reason = hasAnyPro ? "reserve_floor_overflow" : "free_pool_default";
      } else if (healthyPros[0]) {
        selectedHarness = healthyPros[0].harness;
        reason = "pro_headroom";
      }
    } else if (healthyPros[0]) {
      selectedHarness = healthyPros[0].harness;
      reason = "pro_headroom";
    } else {
      const fallbackFree = healthyFrees[0] ?? healthyLocals[0];
      if (fallbackFree) {
        selectedHarness = fallbackFree.harness;
        reason = hasAnyPro ? "capped_failover" : "free_pool_default";
      }
    }
  }

  const freeProvider =
    selectedHarness === "free_pool" || selectedHarness === "opencode"
      ? freePool.pickHealthySlot()?.id
      : undefined;

  return {
    selectedHarness,
    complexity,
    reason,
    reserveFloorPct,
    ...(freeProvider ? { freeProvider } : {}),
    handoffPrompt,
    ...(params.capsule ? { capsule: params.capsule } : {}),
    ...(resetNudge ? { resetNudge } : {}),
  };
}
