import type { FastifyRequest } from "fastify";

type FixedWindowEntry = {
  windowStartedAtMs: number;
  count: number;
};

type ConcurrentEntry = {
  count: number;
};

const fixedWindowCounters = new Map<string, FixedWindowEntry>();
const cooldownDeadlines = new Map<string, number>();
const concurrentCounters = new Map<string, ConcurrentEntry>();

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value?.split(",")[0]?.trim();
}

function buildScopedKey(scope: string, key: string) {
  return `${scope}:${key}`;
}

export function resolveRequestIp(request: FastifyRequest): string {
  const forwardedFor = firstHeader(request.headers["x-forwarded-for"]);
  if (forwardedFor) {
    return forwardedFor;
  }

  return request.ip || "unknown";
}

export function takeFixedWindowToken(params: {
  scope: string;
  key: string;
  max: number;
  windowMs: number;
}) {
  const scopedKey = buildScopedKey(params.scope, params.key);
  const now = Date.now();
  const existing = fixedWindowCounters.get(scopedKey);

  if (!existing || now - existing.windowStartedAtMs >= params.windowMs) {
    fixedWindowCounters.set(scopedKey, {
      windowStartedAtMs: now,
      count: 1
    });
    return {
      allowed: true as const,
      retryAfterSeconds: 0
    };
  }

  if (existing.count >= params.max) {
    return {
      allowed: false as const,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((existing.windowStartedAtMs + params.windowMs - now) / 1000)
      )
    };
  }

  existing.count += 1;
  fixedWindowCounters.set(scopedKey, existing);

  return {
    allowed: true as const,
    retryAfterSeconds: 0
  };
}

export function getCooldownRemainingSeconds(params: {
  scope: string;
  key: string;
}) {
  const scopedKey = buildScopedKey(params.scope, params.key);
  const deadline = cooldownDeadlines.get(scopedKey);
  if (!deadline) {
    return 0;
  }

  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    cooldownDeadlines.delete(scopedKey);
    return 0;
  }

  return Math.max(1, Math.ceil(remainingMs / 1000));
}

export function setCooldown(params: {
  scope: string;
  key: string;
  cooldownMs: number;
}) {
  cooldownDeadlines.set(buildScopedKey(params.scope, params.key), Date.now() + params.cooldownMs);
}

export function acquireConcurrentSlot(params: {
  scope: string;
  key: string;
  max: number;
}) {
  const scopedKey = buildScopedKey(params.scope, params.key);
  const existing = concurrentCounters.get(scopedKey);
  const currentCount = existing?.count ?? 0;

  if (currentCount >= params.max) {
    return null;
  }

  concurrentCounters.set(scopedKey, {
    count: currentCount + 1
  });

  let released = false;
  return {
    release() {
      if (released) {
        return;
      }

      released = true;
      const current = concurrentCounters.get(scopedKey);
      if (!current || current.count <= 1) {
        concurrentCounters.delete(scopedKey);
        return;
      }

      concurrentCounters.set(scopedKey, {
        count: current.count - 1
      });
    }
  };
}
