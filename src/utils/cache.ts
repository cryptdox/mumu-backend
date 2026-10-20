// Centralized realm secret cache with TTL support

interface CachedSecret {
  value: string;
  expiresAt: number;
}

const realmSecretCache = new Map<string, CachedSecret>();
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

export const getCachedSecret = (realmId: string): string | null => {
  const cached = realmSecretCache.get(realmId);
  if (!cached) return null;

  if (cached.expiresAt < Date.now()) {
    realmSecretCache.delete(realmId);
    return null;
  }

  return cached.value;
};

export const setCachedSecret = (realmId: string, secret: string, ttlMs = DEFAULT_TTL_MS) => {
  realmSecretCache.set(realmId, {
    value: secret,
    expiresAt: Date.now() + ttlMs,
  });
};

// Optional: invalidate manually (on secret rotation)
export const invalidateSecret = (realmId: string) => {
  realmSecretCache.delete(realmId);
};