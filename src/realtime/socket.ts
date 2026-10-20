import type { Server as HttpServer } from "http";
import { Server, type Socket } from "socket.io";
import prisma from "../prisma/client";
import { verifyIamToken } from "../middlewares/auth.middleware";
import { CORS_ORIGINS } from "../utils/consts";
import logger from "../utils/logger";

/**
 * Realtime events (socket.io, path /socket.io). Connect with `auth: { token }`
 * (IAM access token). Each socket joins `user:<userId>` and `profile:<id>` for
 * every profile the account can act as, so business inboxes update too.
 *
 * Server → client: message:new, message:updated, conversation:updated, read,
 * typing, presence, call:ring, call:updated, notification, live:updated.
 * Client → server: typing { conversationId, profileId }, live:watch / live:unwatch { liveStreamId }.
 */
let io: Server | null = null;
/** profileId → number of connected sockets (presence). */
const online = new Map<string, number>();

export const isOnline = (profileId: string) => (online.get(profileId) ?? 0) > 0;

/** Viewers of a live stream (sockets that sent "live:watch"). */
export function emitToLive(liveStreamId: string, event: string, payload: unknown) {
  io?.to(`live:${liveStreamId}`).emit(event, payload);
}

export function emitToProfiles(profileIds: Iterable<string>, event: string, payload: unknown) {
  if (!io) return;
  const rooms = [...new Set(profileIds)].map((id) => `profile:${id}`);
  if (rooms.length) io.to(rooms).emit(event, payload);
}

/** A new profile became available to an account (e.g. made admin of a page). */
export function joinProfileRoom(userId: string, profileId: string) {
  io?.in(`user:${userId}`).socketsJoin(`profile:${profileId}`);
}

export function leaveProfileRoom(userId: string, profileId: string) {
  io?.in(`user:${userId}`).socketsLeave(`profile:${profileId}`);
}

async function directPartners(profileIds: string[]) {
  const rows = await prisma.conversationMember.findMany({
    where: { conversation: { type: "DIRECT", members: { some: { profileId: { in: profileIds } } } }, profileId: { notIn: profileIds } },
    select: { profileId: true },
    take: 500,
  });
  return rows.map((r) => r.profileId);
}

async function announcePresence(profileIds: string[], isNowOnline: boolean) {
  const partners = await directPartners(profileIds).catch(() => []);
  for (const profileId of profileIds) emitToProfiles(partners, "presence", { profileId, online: isNowOnline });
}

export function attachRealtime(server: HttpServer) {
  io = new Server(server, { cors: { origin: CORS_ORIGINS }, serveClient: false });

  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    const user = typeof token === "string" ? await verifyIamToken(token).catch(() => null) : null;
    if (!user) return next(new Error("unauthorized"));
    socket.data.userId = user.userId;
    next();
  });

  io.on("connection", async (socket: Socket) => {
    const userId: string = socket.data.userId;
    const memberships = await prisma.profileMember.findMany({ where: { userId }, select: { profileId: true } });
    const profileIds = memberships.map((m) => m.profileId);
    socket.data.profileIds = new Set(profileIds);
    socket.join([`user:${userId}`, ...profileIds.map((id) => `profile:${id}`)]);

    const cameOnline = profileIds.filter((id) => {
      const n = (online.get(id) ?? 0) + 1;
      online.set(id, n);
      return n === 1;
    });
    if (cameOnline.length) void announcePresence(cameOnline, true);

    socket.on("typing", async (msg: { conversationId?: string; profileId?: string }) => {
      const { conversationId, profileId } = msg ?? {};
      if (typeof conversationId !== "string" || typeof profileId !== "string") return;
      if (!socket.data.profileIds.has(profileId)) return;
      const members = await prisma.conversationMember.findMany({ where: { conversationId, leftAt: null }, select: { profileId: true } }).catch(() => [] as { profileId: string }[]);
      if (!members.some((m) => m.profileId === profileId)) return;
      emitToProfiles(members.map((m) => m.profileId).filter((id) => id !== profileId), "typing", { conversationId, profileId });
    });

    // Watching a stream = get its updates (ended, viewer count). Access is checked when joining the media.
    socket.on("live:watch", (msg: { liveStreamId?: string }) => {
      if (typeof msg?.liveStreamId === "string" && msg.liveStreamId.length <= 64) socket.join(`live:${msg.liveStreamId}`);
    });
    socket.on("live:unwatch", (msg: { liveStreamId?: string }) => {
      if (typeof msg?.liveStreamId === "string") socket.leave(`live:${msg.liveStreamId}`);
    });

    socket.on("disconnect", () => {
      const wentOffline = profileIds.filter((id) => {
        const n = (online.get(id) ?? 1) - 1;
        if (n <= 0) online.delete(id);
        else online.set(id, n);
        return n <= 0;
      });
      if (wentOffline.length) void announcePresence(wentOffline, false);
    });
  });

  logger.info("[Realtime] socket.io attached");
  return io;
}

export async function closeRealtime() {
  await io?.close();
  io = null;
  online.clear();
}
