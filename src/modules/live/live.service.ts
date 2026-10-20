import type { Prisma } from "@prisma/client";
import type { Request } from "express";
import prisma from "../../prisma/client";
import { BadRequest, Conflict, Forbidden, NotFound } from "../../utils/errors";
import { Resource } from "../../utils/consts";
import { canModerate } from "../../utils/permissions";
import { issueRtcToken } from "../../utils/rtc";
import logger from "../../utils/logger";
import type { Actor } from "../../middlewares/actor.middleware";
import { emitToLive, emitToProfiles, onLiveAudienceChange } from "../../realtime/socket";
import { AppError } from "../../utils/errors";
import { profileCardSelect, toProfile } from "../profile/profile.view";
import { canSee, viewerGraph } from "../connection/visibility";
import { notify } from "../notification/notification.service";

type Audience = "PUBLIC" | "CONNECTIONS" | "ONLY_ME";
/** One RTC channel per host, reused by each of their streams (keeps the RTC plan's channel count low). */
const channelFor = (hostProfileId: string) => `live_${hostProfileId}`;
const include = { host: { select: profileCardSelect }, post: { select: { postId: true } } } as const;
type LiveRow = Prisma.LiveStreamGetPayload<{ include: typeof include }>;

const view = ({ host, post, rtcChannel: _c, hostDeviceId: _d, ...s }: LiveRow) => ({ ...s, host: toProfile(host), postId: post?.postId ?? null });

/** People who'd want to know: friends of a person, followers of anyone. */
async function audienceOf(hostId: string, audience: Audience) {
  if (audience === "ONLY_ME") return [];
  const [followers, friends] = await Promise.all([
    prisma.follow.findMany({ where: { followeeId: hostId }, select: { followerId: true }, take: 2000 }),
    prisma.friendship.findMany({ where: { status: "ACCEPTED", OR: [{ requesterId: hostId }, { addresseeId: hostId }] }, select: { requesterId: true, addresseeId: true }, take: 2000 }),
  ]);
  return [...new Set([...followers.map((f) => f.followerId), ...friends.map((f) => (f.requesterId === hostId ? f.addresseeId : f.requesterId))])];
}

class LiveService {
  /** Go live as the active profile. Creates a feed post that links to the stream. */
  async start(actor: Actor, title: string, audience: Audience) {
    const running = await prisma.liveStream.findFirst({ where: { hostProfileId: actor.profileId, status: "LIVE" } });
    if (running) throw Conflict("You're already live — end that stream first");
    const rtcChannel = channelFor(actor.profileId);
    const rtc = await issueRtcToken(actor.profileId, rtcChannel, "HOST");
    const stream = await prisma.liveStream.create({
      data: { hostProfileId: actor.profileId, title, audience, rtcChannel, hostDeviceId: actor.deviceId, post: { create: { authorProfileId: actor.profileId, text: title, audience } } },
      include,
    });
    const result = view(stream);
    const fans = await audienceOf(actor.profileId, audience);
    if (fans.length) {
      await notify(fans, "LIVE_STARTED", actor.profileId, stream.liveStreamId);
      emitToProfiles(fans, "live:updated", result);
    }
    return { stream: result, rtc };
  }

  /** Streams live now that you may watch. */
  async list(actor: Actor) {
    const me = actor.profileId;
    const g = await viewerGraph(me);
    const rows = await prisma.liveStream.findMany({
      where: {
        status: "LIVE",
        hostProfileId: { notIn: g.blocked },
        host: { deletedAt: null },
        OR: [{ hostProfileId: me }, { audience: "PUBLIC" }, { audience: "CONNECTIONS", hostProfileId: { in: g.connectionAuthors } }],
      },
      include,
      orderBy: [{ viewerCount: "desc" }, { startedAt: "desc" }],
      take: 50,
    });
    return rows.map(view);
  }

  private async visible(actor: Actor, liveStreamId: string) {
    const s = await prisma.liveStream.findUnique({ where: { liveStreamId }, include });
    if (!s || !(await canSee(actor.profileId, s.host, s.audience))) throw NotFound("Stream not found");
    return s;
  }

  async get(actor: Actor, liveStreamId: string) {
    return view(await this.visible(actor, liveStreamId));
  }

  /**
   * Watch (AUDIENCE: receive only). The host gets a HOST token — but only on the device
   * that's broadcasting. From another device: 409 LIVE_ON_OTHER_DEVICE, unless `takeover`,
   * which moves the live here and tells the old device to step off ("live:takeover").
   */
  async watch(actor: Actor, liveStreamId: string, takeover = false) {
    const s = await this.visible(actor, liveStreamId);
    if (s.status !== "LIVE") throw BadRequest("This stream has ended");
    const isHost = s.hostProfileId === actor.profileId;
    if (isHost && actor.deviceId && s.hostDeviceId && s.hostDeviceId !== actor.deviceId) {
      if (!takeover) throw new AppError(409, "You're live on another device", { code: "LIVE_ON_OTHER_DEVICE" });
      await prisma.liveStream.update({ where: { liveStreamId }, data: { hostDeviceId: actor.deviceId } });
      emitToProfiles([s.hostProfileId], "live:takeover", { liveStreamId, deviceId: actor.deviceId });
    } else if (isHost && actor.deviceId && !s.hostDeviceId) {
      await prisma.liveStream.update({ where: { liveStreamId }, data: { hostDeviceId: actor.deviceId } });
    }
    const rtc = await issueRtcToken(actor.profileId, s.rtcChannel, isHost ? "HOST" : "AUDIENCE");
    // The viewer count comes from live sockets ("live:watch"), not from this call.
    return { stream: view(s), rtc };
  }

  /** Kept for older clients; leaving is detected from the socket. */
  async leave(actor: Actor, liveStreamId: string) {
    return view(await this.visible(actor, liveStreamId));
  }

  async update(actor: Actor, liveStreamId: string, dto: { title?: string; audience?: Audience }) {
    const s = await prisma.liveStream.findUnique({ where: { liveStreamId } });
    if (!s) throw NotFound("Stream not found");
    if (s.hostProfileId !== actor.profileId) throw Forbidden("Only the host can change the stream");
    const updated = await prisma.liveStream.update({
      where: { liveStreamId },
      data: { ...dto, post: { update: { ...(dto.title && { text: dto.title }), ...(dto.audience && { audience: dto.audience }) } } },
      include,
    });
    const result = view(updated);
    emitToLive(liveStreamId, "live:updated", result);
    return result;
  }

  /** The host ends it (or a moderator — MU_LIVE READ_ALL). Viewers get "live:updated" with status ENDED. */
  async end(req: Request, liveStreamId: string) {
    const actor = req.actor!;
    const s = await prisma.liveStream.findUnique({ where: { liveStreamId } });
    if (!s) throw NotFound("Stream not found");
    if (s.hostProfileId !== actor.profileId && !(await canModerate(req, Resource.LIVE))) throw Forbidden("Only the host can end the stream");
    return endStream(liveStreamId);
  }
}

/** Viewer count = distinct accounts watching over sockets, minus the host's own team. */
onLiveAudienceChange(async (liveStreamId, userIds) => {
  try {
    const s = await prisma.liveStream.findUnique({ where: { liveStreamId }, select: { status: true, hostProfileId: true, peakViewers: true } });
    if (!s || s.status !== "LIVE") return;
    const team = await prisma.profileMember.findMany({ where: { profileId: s.hostProfileId }, select: { userId: true } });
    for (const m of team) userIds.delete(m.userId);
    const viewerCount = userIds.size;
    const updated = await prisma.liveStream.update({
      where: { liveStreamId },
      data: { viewerCount, peakViewers: Math.max(s.peakViewers, viewerCount) },
      include,
    });
    const result = view(updated);
    emitToLive(liveStreamId, "live:updated", result);
    emitToProfiles([updated.hostProfileId], "live:updated", result);
  } catch (err: any) {
    logger.warn(`[Live] recount ${liveStreamId}: ${err?.message ?? err}`);
  }
});

export async function endStream(liveStreamId: string) {
  const updated = await prisma.liveStream.update({ where: { liveStreamId }, data: { status: "ENDED", endedAt: new Date(), viewerCount: 0 }, include });
  const result = view(updated);
  emitToLive(liveStreamId, "live:updated", result);
  emitToProfiles([updated.hostProfileId], "live:updated", result);
  return result;
}

/** Streams whose host vanished without ending them close after 12 hours. */
export async function sweepStreams() {
  const stale = await prisma.liveStream.findMany({ where: { status: "LIVE", startedAt: { lt: new Date(Date.now() - 12 * 3600_000) } }, select: { liveStreamId: true } });
  for (const s of stale) await endStream(s.liveStreamId).catch((err) => logger.warn(`[Live] sweep ${s.liveStreamId}: ${err?.message ?? err}`));
}

export default new LiveService();
