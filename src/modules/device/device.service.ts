import type { Request } from "express";
import prisma from "../../prisma/client";
import { AppError, NotFound } from "../../utils/errors";
import { emitToUser } from "../../realtime/socket";

/** Most devices an account can be signed in on at once. */
export const MAX_DEVICES = Number(process.env.MAX_DEVICES_PER_ACCOUNT ?? 3);
/** A device unused this long stops counting toward the limit. */
const STALE_MS = 30 * 24 * 3600_000;
const DEVICE_ID = /^[A-Za-z0-9_-]{8,64}$/;

export const deviceIdOf = (req: Request) => {
  const id = req.header("x-device-id")?.trim();
  return id && DEVICE_ID.test(id) ? id : undefined;
};

/** "Chrome on Android", "Safari on iPhone", "Firefox on Windows"… */
export function deviceLabel(ua = "") {
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Android/.test(ua) ? "Android" : /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "device";
  return `${browser} on ${os}`;
}

const activeWhere = (userId: string) => ({ userId, revokedAt: null, lastSeenAt: { gt: new Date(Date.now() - STALE_MS) } });
const view = (d: { deviceId: string; label: string; createdAt: Date; lastSeenAt: Date }, current?: string) => ({
  deviceId: d.deviceId,
  label: d.label,
  signedInAt: d.createdAt,
  lastSeenAt: d.lastSeenAt,
  current: d.deviceId === current,
});

// Recently confirmed (userId:deviceId) — avoids a DB round trip on every request.
const confirmed = new Map<string, number>();
const CONFIRM_MS = 60_000;

/**
 * Admit a request from this device: known & signed in → ok; new → only if the account
 * has fewer than MAX_DEVICES active devices; signed out remotely → only with a token
 * issued after that (i.e. the person signed in again).
 */
export async function admitDevice(userId: string, deviceId: string, tokenIssuedAt: number | undefined, userAgent: string) {
  const key = `${userId}:${deviceId}`;
  if ((confirmed.get(key) ?? 0) > Date.now()) return;

  const device = await prisma.device.findUnique({ where: { userId_deviceId: { userId, deviceId } } });
  const signedInAgain = device?.revokedAt && tokenIssuedAt && tokenIssuedAt * 1000 > device.revokedAt.getTime();
  if (device?.revokedAt && !signedInAgain) {
    throw new AppError(401, "This device was signed out", { code: "DEVICE_SIGNED_OUT" });
  }
  const isActive = device && !device.revokedAt && device.lastSeenAt.getTime() > Date.now() - STALE_MS;
  if (!isActive) {
    const others = await prisma.device.findMany({ where: { ...activeWhere(userId), deviceId: { not: deviceId } }, orderBy: { lastSeenAt: "desc" } });
    if (others.length >= MAX_DEVICES) {
      throw new AppError(403, `You're signed in on ${MAX_DEVICES} devices. Sign out of one to use MuMu here.`, {
        code: "DEVICE_LIMIT",
        max: MAX_DEVICES,
        devices: others.map((d) => view(d)),
      });
    }
  }
  await prisma.device.upsert({
    where: { userId_deviceId: { userId, deviceId } },
    create: { userId, deviceId, label: deviceLabel(userAgent) },
    update: { lastSeenAt: new Date(), revokedAt: null, ...(!isActive && { label: deviceLabel(userAgent), createdAt: new Date() }) },
  });
  confirmed.set(key, Date.now() + CONFIRM_MS);
}

class DeviceService {
  async list(userId: string, current?: string) {
    const rows = await prisma.device.findMany({ where: activeWhere(userId), orderBy: { lastSeenAt: "desc" } });
    return { max: MAX_DEVICES, devices: rows.map((d) => view(d, current)) };
  }

  /** Sign a device out (yourself, or remotely). It's told over its socket and signs out. */
  async signOut(userId: string, deviceId: string) {
    const { count } = await prisma.device.updateMany({ where: { userId, deviceId, revokedAt: null }, data: { revokedAt: new Date() } });
    if (!count) throw NotFound("Device not found");
    confirmed.delete(`${userId}:${deviceId}`);
    emitToUser(userId, "device:signed-out", { deviceId });
  }
}

export default new DeviceService();
