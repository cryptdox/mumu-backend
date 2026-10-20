import type { Prisma } from "@prisma/client";
import type { Request } from "express";
import prisma from "../../prisma/client";
import { BadRequest, Conflict, Forbidden, NotFound } from "../../utils/errors";
import { Resource } from "../../utils/consts";
import { canModerate } from "../../utils/permissions";
import { issueRtcToken } from "../../utils/rtc";
import logger from "../../utils/logger";
import type { Actor } from "../../middlewares/actor.middleware";
import { emitToLive, emitToProfiles } from "../../realtime/socket";
import { profileCardSelect, toProfile } from "../profile/profile.view";
import { canSee, viewerGraph } from "../connection/visibility";
import { notify } from "../notification/notification.service";

type Audience = "PUBLIC" | "CONNECTIONS" | "ONLY_ME";
/** One RTC channel per host, reused by each of their streams (keeps the RTC plan's channel count low). */
const channelFor = (hostProfileId: string) => `live_${hostProfileId}`;
const include = { host: { select: profileCardSelect }, post: { select: { postId: true } } } as const;
type LiveRow = Prisma.LiveStreamGetPayload<{ include: typeof include }>;

const view = ({ host, post, rtcChannel: _c, ...s }: LiveRow) => ({ ...s, host: toProfile(host), postId: post?.postId ?? null });

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
      data: { hostProfileId: actor.profileId, title, audience, rtcChannel, post: { create: { authorProfileId: actor.profileId, text: title, audience } } },
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

  /** Watch (AUDIENCE: receive only). The host rejoining gets a HOST token. */
  async watch(actor: Actor, liveStreamId: string) {
    const s = await this.visible(actor, liveStreamId);
    if (s.status !== "LIVE") throw BadRequest("This stream has ended");
    const isHost = s.hostProfileId === actor.profileId;
    const rtc = await issueRtcToken(actor.profileId, s.rtcChannel, isHost ? "HOST" : "AUDIENCE");
    if (isHost) return { stream: view(s), rtc };
    const updated = await prisma.liveStream.update({ where: { liveStreamId }, data: { viewerCount: { increment: 1 } }, include });
    if (updated.viewerCount > updated.peakViewers) await prisma.liveStream.update({ where: { liveStreamId }, data: { peakViewers: updated.viewerCount } });
    const result = view(updated);
    emitToLive(liveStreamId, "live:updated", result);
    return { stream: result, rtc };
  }

  async leave(actor: Actor, liveStreamId: string) {
    const s = await this.visible(actor, liveStreamId);
    if (s.hostProfileId === actor.profileId || s.status !== "LIVE") return view(s);
    await prisma.liveStream.updateMany({ where: { liveStreamId, viewerCount: { gt: 0 } }, data: { viewerCount: { decrement: 1 } } });
    const result = view(await prisma.liveStream.findUniqueOrThrow({ where: { liveStreamId }, include }));
    emitToLive(liveStreamId, "live:updated", result);
    return result;
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
