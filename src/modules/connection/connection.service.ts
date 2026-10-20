import prisma from "../../prisma/client";
import { BadRequest, Conflict, NotFound } from "../../utils/errors";
import type { Actor } from "../../middlewares/actor.middleware";
import { profileCardSelect, toProfile } from "../profile/profile.view";
import { notify } from "../notification/notification.service";
import { isBlocked } from "./visibility";

async function target(profileId: string) {
  const p = await prisma.profile.findFirst({ where: { profileId, deletedAt: null }, select: { profileId: true, kind: true } });
  if (!p) throw NotFound("Profile not found");
  return p;
}

const pair = (a: string, b: string) => ({ OR: [{ requesterId: a, addresseeId: b }, { requesterId: b, addresseeId: a }] });

class ConnectionService {
  // ── Friends (personal ↔ personal) ──────────────────────────────────────────

  async requestFriend(actor: Actor, profileId: string) {
    if (actor.profileId === profileId) throw BadRequest("That's you");
    const other = await target(profileId);
    if (actor.kind !== "PERSONAL" || other.kind !== "PERSONAL") throw BadRequest("Friends are between personal profiles — follow a business instead");
    if (await isBlocked(actor.profileId, profileId)) throw NotFound("Profile not found");

    const existing = await prisma.friendship.findFirst({ where: pair(actor.profileId, profileId) });
    if (existing?.status === "ACCEPTED") throw Conflict("You're already friends");
    if (existing && existing.requesterId === actor.profileId) throw Conflict("Request already sent");
    if (existing) return this.accept(actor, profileId); // they asked first → accept

    await prisma.friendship.create({ data: { requesterId: actor.profileId, addresseeId: profileId } });
    await notify(profileId, "FRIEND_REQUEST", actor.profileId);
    return { friendStatus: "REQUEST_SENT" as const };
  }

  async accept(actor: Actor, requesterId: string) {
    const request = await prisma.friendship.findUnique({ where: { requesterId_addresseeId: { requesterId, addresseeId: actor.profileId } } });
    if (!request || request.status !== "PENDING") throw NotFound("No pending request from this profile");
    await prisma.friendship.update({
      where: { requesterId_addresseeId: { requesterId, addresseeId: actor.profileId } },
      data: { status: "ACCEPTED", respondedAt: new Date() },
    });
    await notify(requesterId, "FRIEND_ACCEPTED", actor.profileId);
    return { friendStatus: "FRIENDS" as const };
  }

  /** Decline, cancel or unfriend — all remove the row. */
  async removeFriend(actor: Actor, profileId: string) {
    const { count } = await prisma.friendship.deleteMany({ where: pair(actor.profileId, profileId) });
    if (!count) throw NotFound("No friendship or request with this profile");
    return { friendStatus: "NONE" as const };
  }

  async requests(actor: Actor, direction: "in" | "out") {
    const rows = await prisma.friendship.findMany({
      where: { status: "PENDING", ...(direction === "in" ? { addresseeId: actor.profileId } : { requesterId: actor.profileId }) },
      include: { requester: { select: profileCardSelect }, addressee: { select: profileCardSelect } },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    return rows.map((r) => ({ profile: toProfile(direction === "in" ? r.requester : r.addressee), createdAt: r.createdAt }));
  }

  async friends(profileId: string, offset: number, limit: number) {
    const rows = await prisma.friendship.findMany({
      where: { status: "ACCEPTED", OR: [{ requesterId: profileId }, { addresseeId: profileId }] },
      include: { requester: { select: profileCardSelect }, addressee: { select: profileCardSelect } },
      orderBy: { respondedAt: "desc" },
      skip: offset,
      take: limit,
    });
    return rows.map((r) => toProfile(r.requesterId === profileId ? r.addressee : r.requester));
  }

  // ── Follows (anyone → anyone) ──────────────────────────────────────────────

  async follow(actor: Actor, profileId: string) {
    if (actor.profileId === profileId) throw BadRequest("That's you");
    await target(profileId);
    if (await isBlocked(actor.profileId, profileId)) throw NotFound("Profile not found");
    const created = await prisma.follow
      .create({ data: { followerId: actor.profileId, followeeId: profileId } })
      .then(() => true)
      .catch((err) => (err?.code === "P2002" ? false : Promise.reject(err)));
    if (created) await notify(profileId, "NEW_FOLLOWER", actor.profileId);
    return { following: true };
  }

  async unfollow(actor: Actor, profileId: string) {
    await prisma.follow.deleteMany({ where: { followerId: actor.profileId, followeeId: profileId } });
    return { following: false };
  }

  async followers(profileId: string, offset: number, limit: number) {
    const rows = await prisma.follow.findMany({
      where: { followeeId: profileId },
      include: { follower: { select: profileCardSelect } },
      orderBy: { createdAt: "desc" },
      skip: offset,
      take: limit,
    });
    return rows.map((r) => toProfile(r.follower));
  }

  async following(profileId: string, offset: number, limit: number) {
    const rows = await prisma.follow.findMany({
      where: { followerId: profileId },
      include: { followee: { select: profileCardSelect } },
      orderBy: { createdAt: "desc" },
      skip: offset,
      take: limit,
    });
    return rows.map((r) => toProfile(r.followee));
  }

  // ── Blocks ─────────────────────────────────────────────────────────────────

  /** Blocking also ends friendship and follows in both directions. */
  async block(actor: Actor, profileId: string) {
    if (actor.profileId === profileId) throw BadRequest("That's you");
    await target(profileId);
    await prisma.$transaction([
      prisma.block.upsert({
        where: { blockerId_blockedId: { blockerId: actor.profileId, blockedId: profileId } },
        create: { blockerId: actor.profileId, blockedId: profileId },
        update: {},
      }),
      prisma.friendship.deleteMany({ where: pair(actor.profileId, profileId) }),
      prisma.follow.deleteMany({
        where: { OR: [{ followerId: actor.profileId, followeeId: profileId }, { followerId: profileId, followeeId: actor.profileId }] },
      }),
    ]);
    return { blocked: true };
  }

  async unblock(actor: Actor, profileId: string) {
    await prisma.block.deleteMany({ where: { blockerId: actor.profileId, blockedId: profileId } });
    return { blocked: false };
  }

  async blocks(actor: Actor) {
    const rows = await prisma.block.findMany({
      where: { blockerId: actor.profileId },
      include: { blocked: { select: profileCardSelect } },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((r) => toProfile(r.blocked));
  }
}

export default new ConnectionService();
