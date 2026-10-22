import { createHmac, timingSafeEqual } from "node:crypto";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getMessaging, type Messaging } from "firebase-admin/messaging";
import prisma from "../prisma/client";
import logger from "./logger";
import { CALL_RING_SECONDS, FIREBASE_SERVICE_ACCOUNT, PUBLIC_API_URL, PUSH_ACTION_SECRET } from "./consts";

/**
 * Push to the Android app (Firebase Cloud Messaging), so calls ring on the phone even when the
 * app is closed. Data-only, high-priority messages; the app draws its own call notification.
 * Off (no-op) when FIREBASE_SERVICE_ACCOUNT isn't set.
 */
let messaging: Messaging | null | undefined;
function fcm() {
  if (messaging !== undefined) return messaging;
  messaging = null;
  if (!FIREBASE_SERVICE_ACCOUNT) {
    logger.info("[Push] FIREBASE_SERVICE_ACCOUNT not set — phone push is off");
    return messaging;
  }
  try {
    const raw = FIREBASE_SERVICE_ACCOUNT.trim().startsWith("{") ? FIREBASE_SERVICE_ACCOUNT : Buffer.from(FIREBASE_SERVICE_ACCOUNT, "base64").toString("utf8");
    const app = getApps()[0] ?? initializeApp({ credential: cert(JSON.parse(raw)) });
    messaging = getMessaging(app);
  } catch (err: any) {
    logger.error(`[Push] bad FIREBASE_SERVICE_ACCOUNT: ${err?.message ?? err}`);
  }
  return messaging;
}

/** Signs "decline this call as this profile" for the notification's Decline button. */
export const declineSig = (callId: string, profileId: string) => createHmac("sha256", PUSH_ACTION_SECRET).update(`decline:${callId}:${profileId}`).digest("base64url");
export function verifyDeclineSig(callId: string, profileId: string, sig: string) {
  const want = Buffer.from(declineSig(callId, profileId));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}

/** Push tokens of every signed-in device of the people who run these profiles. */
async function tokensFor(profileIds: string[]) {
  const members = await prisma.profileMember.findMany({ where: { profileId: { in: profileIds } }, select: { profileId: true, userId: true } });
  const users = [...new Set(members.map((m) => m.userId))];
  if (!users.length) return [];
  const devices = await prisma.device.findMany({ where: { userId: { in: users }, revokedAt: null, pushToken: { not: null } }, select: { userId: true, pushToken: true } });
  return devices.map((d) => ({ token: d.pushToken!, profiles: members.filter((m) => m.userId === d.userId).map((m) => m.profileId) }));
}

async function send(tokens: string[], data: Record<string, string>, ttlMs: number) {
  const m = fcm();
  if (!m || !tokens.length) return;
  try {
    const res = await m.sendEachForMulticast({ tokens, data, android: { priority: "high", ttl: ttlMs } });
    // Forget tokens of uninstalled apps.
    const dead = res.responses.flatMap((r, i) => (r.error?.code === "messaging/registration-token-not-registered" || r.error?.code === "messaging/invalid-argument" ? [tokens[i]] : []));
    if (dead.length) await prisma.device.updateMany({ where: { pushToken: { in: dead } }, data: { pushToken: null } });
  } catch (err: any) {
    logger.warn(`[Push] send failed: ${err?.message ?? err}`);
  }
}

type RingingCall = {
  callId: string;
  type: "AUDIO" | "VIDEO";
  startedBy: { displayName: string; avatarUrl?: string | null };
  conversation: { type: string; title?: string | null } | null;
};

/** Ring the callee profiles' phones. Never throws. */
export async function pushIncomingCall(call: RingingCall, calleeProfileIds: string[]) {
  if (!fcm() || !calleeProfileIds.length) return;
  const group = call.conversation?.type === "GROUP";
  const title = group ? call.conversation?.title || "Group call" : call.startedBy.displayName;
  const body = `Incoming ${call.type === "VIDEO" ? "video" : "voice"} call${group ? ` · ${call.startedBy.displayName}` : ""}`;
  const devices = await tokensFor(calleeProfileIds).catch(() => []);
  // One message per (device, profile) pair, so Decline / Answer act as the right profile.
  const byProfile = new Map<string, string[]>();
  for (const d of devices) for (const p of d.profiles) if (calleeProfileIds.includes(p)) byProfile.set(p, [...(byProfile.get(p) ?? []), d.token]);
  const expiresAt = String(Date.now() + CALL_RING_SECONDS * 1000);
  await Promise.all(
    [...byProfile].map(([profileId, tokens]) =>
      send(
        tokens,
        {
          kind: "call",
          callId: call.callId,
          profileId,
          title,
          body,
          video: call.type === "VIDEO" ? "1" : "0",
          avatarUrl: call.startedBy.avatarUrl ?? "",
          declineUrl: `${PUBLIC_API_URL}/api/calls/${call.callId}/push-decline`,
          sig: declineSig(call.callId, profileId),
          expiresAt,
        },
        CALL_RING_SECONDS * 1000,
      ),
    ),
  );
}

/** Stop the ringing notification (answered somewhere, declined, ended, missed). Never throws. */
export async function pushCallStopped(callId: string, profileIds: string[]) {
  if (!fcm() || !profileIds.length) return;
  const devices = await tokensFor(profileIds).catch(() => []);
  await send([...new Set(devices.map((d) => d.token))], { kind: "call-stop", callId }, 60_000);
}

type NewMessage = {
  messageId: string;
  conversationId: string;
  kind: string;
  text?: string | null;
  media?: unknown;
  sender: { profileId: string; displayName: string; avatarUrl?: string | null };
};

/** A chat message to the phones of the other members (not muted ones). Never throws. */
export async function pushNewMessage(m: NewMessage) {
  if (!fcm() || m.kind === "CALL" || m.kind === "SYSTEM") return;
  try {
    const convo = await prisma.conversation.findUnique({
      where: { conversationId: m.conversationId },
      select: { type: true, title: true, members: { where: { leftAt: null }, select: { profileId: true, mutedUntil: true } } },
    });
    if (!convo) return;
    const now = Date.now();
    const recipients = convo.members.filter((x) => x.profileId !== m.sender.profileId && !(x.mutedUntil && x.mutedUntil.getTime() > now)).map((x) => x.profileId);
    if (!recipients.length) return;
    const group = convo.type === "GROUP";
    const preview = m.text?.trim() || (m.media ? "📷 Photo" : "New message");
    const devices = await tokensFor(recipients);
    const byProfile = new Map<string, string[]>();
    for (const d of devices) for (const p of d.profiles) if (recipients.includes(p)) byProfile.set(p, [...(byProfile.get(p) ?? []), d.token]);
    await Promise.all(
      [...byProfile].map(([profileId, tokens]) =>
        send(
          tokens,
          {
            kind: "message",
            messageId: m.messageId,
            conversationId: m.conversationId,
            profileId,
            title: group ? convo.title || "Group" : m.sender.displayName,
            sender: m.sender.displayName,
            body: (group ? `${m.sender.displayName}: ` : "") + preview.slice(0, 200),
            avatarUrl: m.sender.avatarUrl ?? "",
          },
          24 * 3600_000,
        ),
      ),
    );
  } catch (err: any) {
    logger.warn(`[Push] message push failed: ${err?.message ?? err}`);
  }
}
