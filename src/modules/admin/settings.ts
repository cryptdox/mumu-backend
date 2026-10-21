import prisma from "../../prisma/client";

/** App-wide settings an admin can change, with their defaults. */
export const SETTING_DEFAULTS = {
  /** Let people switch to their hidden Consumer (personal) profile from Settings. */
  consumerModeEnabled: true,
  /** Allow going live. */
  liveEnabled: true,
  /** Provider profiles one account may own. */
  maxProvidersPerAccount: 10,
};
export type Settings = typeof SETTING_DEFAULTS;

let cache: { at: number; value: Settings } | null = null;

export async function getSettings(): Promise<Settings> {
  if (cache && Date.now() - cache.at < 30_000) return cache.value;
  const rows = await prisma.appSetting.findMany();
  const value = { ...SETTING_DEFAULTS };
  for (const r of rows) if (r.key in value) (value as Record<string, unknown>)[r.key] = r.value;
  cache = { at: Date.now(), value };
  return value;
}

export async function updateSettings(patch: Partial<Settings>, userId: string): Promise<Settings> {
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in SETTING_DEFAULTS) || value === undefined) continue;
    await prisma.appSetting.upsert({ where: { key }, create: { key, value: value as never, updatedBy: userId }, update: { value: value as never, updatedBy: userId } });
  }
  cache = null;
  return getSettings();
}
