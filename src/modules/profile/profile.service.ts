import crypto from "crypto";
import { Prisma } from "@prisma/client";
import prisma from "../../prisma/client";
import { Conflict, Forbidden, NotFound, BadRequest } from "../../utils/errors";
import type { Actor } from "../../middlewares/actor.middleware";
import { profileCardSelect, profileSelect, toProfile } from "./profile.view";
import { areFriends, follows, isBlocked } from "../connection/visibility";
import { isOnline, joinProfileRoom, leaveProfileRoom } from "../../realtime/socket";
import type { CreateBusinessDto, UpdateProfileDto } from "./profile.dto";
import { getSettings } from "../admin/settings";
import { storage } from "../../utils/storage";
import logger from "../../utils/logger";

/** "Abir.Hosen+x@mail.com" → "abir.hosen_x" (valid handle base). */
function handleBase(email: string) {
  const local = (email.split("@")[0] ?? "user").toLowerCase().replace(/[^a-z0-9_.]/g, "_").replace(/^[^a-z0-9]+/, "");
  return (local || "user").slice(0, 24).padEnd(3, "0");
}

function nameFromEmail(email: string) {
  const local = email.split("@")[0] ?? "User";
  return local.split(/[._+-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ").slice(0, 60) || "User";
}

/** Each account gets one personal profile, created the first time it signs in. */
export async function ensurePersonalProfile(userId: string, email: string) {
  const existing = await prisma.profile.findFirst({
    where: { kind: "PERSONAL", members: { some: { userId, role: "OWNER" } } },
    select: { profileId: true },
  });
  if (existing) return existing;

  const base = handleBase(email ?? "user");
  for (let attempt = 0; attempt < 6; attempt++) {
    const handle = attempt === 0 ? base : `${base.slice(0, 24)}${crypto.randomInt(100, 99999)}`;
    try {
      return await prisma.$transaction(async (tx) => {
        // Re-check inside the transaction: two first requests may race.
        const raced = await tx.profile.findFirst({ where: { kind: "PERSONAL", members: { some: { userId, role: "OWNER" } } }, select: { profileId: true } });
        if (raced) return raced;
        return tx.profile.create({
          data: { kind: "PERSONAL", handle, displayName: nameFromEmail(email ?? ""), members: { create: { userId, role: "OWNER" } } },
          select: { profileId: true },
        });
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") continue; // handle taken
      throw err;
    }
  }
  throw Conflict("Couldn't pick a unique handle — try again");
}

async function assertCategory(categoryId: string | null | undefined) {
  if (!categoryId) return;
  const c = await prisma.category.findFirst({ where: { categoryId, isActive: true } });
  if (!c) throw BadRequest("Pick a category from the list");
}

async function assertOwnMedia(actorProfileId: string, mediaId: string | null | undefined) {
  if (!mediaId) return;
  const media = await prisma.media.findUnique({ where: { mediaId }, select: { ownerProfileId: true } });
  if (!media || media.ownerProfileId !== actorProfileId) throw BadRequest("Unknown image");
}

class ProfileService {
  /**
   * Your account and every profile you can switch to. `needsSetup`: no Provider profile yet
   * (the app shows its setup screen). `isAdmin`: may open the admin panel.
   */
  async me(userId: string, email: string, isAdmin = false) {
    await ensurePersonalProfile(userId, email);
    const memberships = await prisma.profileMember.findMany({
      where: { userId, profile: { deletedAt: null } },
      include: { profile: { select: profileSelect } },
      orderBy: { createdAt: "asc" },
    });
    const profiles = memberships
      .map((m) => ({ ...toProfile(m.profile), role: m.role }))
      .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "PERSONAL" ? -1 : 1));
    const settings = await getSettings();
    return {
      userId,
      email,
      profiles,
      needsSetup: !profiles.some((p) => p.kind === "BUSINESS"),
      isAdmin,
      settings: { consumerModeEnabled: settings.consumerModeEnabled, liveEnabled: settings.liveEnabled },
    };
  }

  async createBusiness(actor: Actor, dto: CreateBusinessDto) {
    const owned = await prisma.profileMember.count({ where: { userId: actor.userId, role: "OWNER", profile: { kind: "BUSINESS", deletedAt: null } } });
    const { maxProvidersPerAccount } = await getSettings();
    if (owned >= maxProvidersPerAccount) throw Conflict(`You can own at most ${maxProvidersPerAccount} provider profiles`);
    await assertCategory(dto.categoryId);
    const profile = await prisma.profile.create({
      data: { kind: "BUSINESS", ...dto, members: { create: { userId: actor.userId, role: "OWNER" } } },
      select: profileSelect,
    });
    joinProfileRoom(actor.userId, profile.profileId);
    return { ...toProfile(profile), role: "OWNER" as const };
  }

  private async findLive(idOrHandle: string) {
    const where = /^[0-9a-f-]{36}$/i.test(idOrHandle) ? { profileId: idOrHandle } : { handle: idOrHandle.toLowerCase().replace(/^@/, "") };
    const profile = await prisma.profile.findFirst({ where: { ...where, deletedAt: null, suspendedAt: null }, select: profileSelect });
    if (!profile) throw NotFound("Profile not found");
    return profile;
  }

  /** Public profile plus counts and how the viewer relates to it. */
  async get(viewer: Actor, idOrHandle: string) {
    const profile = await this.findLive(idOrHandle);
    const id = profile.profileId;
    if (id !== viewer.profileId && (await prisma.block.findUnique({ where: { blockerId_blockedId: { blockerId: id, blockedId: viewer.profileId } } }))) {
      throw NotFound("Profile not found");
    }
    const [followers, following, friends, posts, friendship, iFollow, iBlocked] = await Promise.all([
      prisma.follow.count({ where: { followeeId: id } }),
      prisma.follow.count({ where: { followerId: id } }),
      prisma.friendship.count({ where: { status: "ACCEPTED", OR: [{ requesterId: id }, { addresseeId: id }] } }),
      prisma.post.count({ where: { authorProfileId: id, deletedAt: null } }),
      prisma.friendship.findFirst({
        where: { OR: [{ requesterId: viewer.profileId, addresseeId: id }, { requesterId: id, addresseeId: viewer.profileId }] },
      }),
      follows(viewer.profileId, id),
      prisma.block.findUnique({ where: { blockerId_blockedId: { blockerId: viewer.profileId, blockedId: id } } }),
    ]);
    let friendStatus: "NONE" | "FRIENDS" | "REQUEST_SENT" | "REQUEST_RECEIVED" = "NONE";
    if (friendship?.status === "ACCEPTED") friendStatus = "FRIENDS";
    else if (friendship) friendStatus = friendship.requesterId === viewer.profileId ? "REQUEST_SENT" : "REQUEST_RECEIVED";
    return {
      ...toProfile(profile),
      counts: { followers, following, friends, posts },
      online: isOnline(id),
      relationship: { isSelf: id === viewer.profileId, friendStatus, following: iFollow, blocked: !!iBlocked },
    };
  }

  async search(viewer: Actor, q: string, kind: "PERSONAL" | "BUSINESS" | undefined, limit: number) {
    const term = q.replace(/^@/, "");
    const rows = await prisma.profile.findMany({
      where: {
        deletedAt: null,
        suspendedAt: null,
        ...(kind && { kind }),
        OR: [{ handle: { startsWith: term.toLowerCase() } }, { displayName: { contains: term, mode: "insensitive" } }],
        NOT: { blocking: { some: { blockedId: viewer.profileId } } },
      },
      select: profileCardSelect,
      orderBy: [{ isVerified: "desc" }, { handle: "asc" }],
      take: limit,
    });
    return rows.map(toProfile);
  }

  private async requireManager(actor: Actor, profileId: string, roles: ("OWNER" | "ADMIN")[] = ["OWNER", "ADMIN"]) {
    const member = await prisma.profileMember.findUnique({ where: { profileId_userId: { profileId, userId: actor.userId } } });
    if (!member || !roles.includes(member.role as "OWNER" | "ADMIN")) throw Forbidden("Only the profile's owner or admins can do this");
    return member;
  }

  async update(actor: Actor, profileId: string, dto: UpdateProfileDto) {
    await this.requireManager(actor, profileId);
    await assertOwnMedia(profileId, dto.avatarMediaId);
    await assertOwnMedia(profileId, dto.coverMediaId);
    await assertCategory(dto.categoryId);
    const profile = await prisma.profile.update({ where: { profileId }, data: dto, select: profileSelect });
    return toProfile(profile);
  }

  /** Only business profiles can be deleted (your personal profile is your account). */
  async remove(actor: Actor, profileId: string) {
    await this.requireManager(actor, profileId, ["OWNER"]);
    const profile = await prisma.profile.findUniqueOrThrow({ where: { profileId }, select: { kind: true, handle: true } });
    if (profile.kind !== "BUSINESS") throw BadRequest("Your personal profile can't be deleted here");
    // Free the handle; keep rows so old messages still render.
    await prisma.profile.update({ where: { profileId }, data: { deletedAt: new Date(), handle: `deleted_${profileId}` } });
    const members = await prisma.profileMember.findMany({ where: { profileId }, select: { userId: true } });
    for (const m of members) leaveProfileRoom(m.userId, profileId);
  }

  /**
   * Delete your MuMu account: every profile you OWN (consumer + providers) goes with all its
   * content (posts, comments, reactions, messages, calls, lives, images, connections —
   * cascades); you're removed from profiles you only help run; your devices are forgotten.
   * Your Cryptdox (IAM) sign-in is shared with other apps and is not touched here.
   */
  async deleteAccount(userId: string) {
    const owned = await prisma.profileMember.findMany({ where: { userId, role: "OWNER" }, select: { profileId: true } });
    const ids = owned.map((o) => o.profileId);
    const media = await prisma.media.findMany({ where: { ownerProfileId: { in: ids } }, select: { path: true } });
    // Other people's posts they commented on / reacted to — recount those after.
    const touched = [
      ...new Set([
        ...(await prisma.comment.findMany({ where: { authorProfileId: { in: ids } }, select: { postId: true } })).map((c) => c.postId),
        ...(await prisma.reaction.findMany({ where: { profileId: { in: ids } }, select: { postId: true } })).map((r) => r.postId),
      ]),
    ];
    await prisma.$transaction([
      prisma.profile.deleteMany({ where: { profileId: { in: ids } } }),
      prisma.profileMember.deleteMany({ where: { userId } }),
      prisma.device.deleteMany({ where: { userId } }),
    ]);
    for (const postId of touched) {
      const [commentCount, reactionCount] = await Promise.all([
        prisma.comment.count({ where: { postId, deletedAt: null } }),
        prisma.reaction.count({ where: { postId } }),
      ]);
      await prisma.post.updateMany({ where: { postId }, data: { commentCount, reactionCount } });
    }
    for (const m of media) await storage.remove(m.path).catch(() => undefined);
    for (const id of ids) leaveProfileRoom(userId, id);
    logger.info(`[Account] deleted MuMu data of ${userId}: ${ids.length} profile(s), ${media.length} image(s)`);
    return { deletedProfiles: ids.length };
  }

  async members(actor: Actor, profileId: string) {
    await this.requireManager(actor, profileId);
    const rows = await prisma.profileMember.findMany({ where: { profileId }, orderBy: { createdAt: "asc" } });
    const personal = await prisma.profile.findMany({
      where: { kind: "PERSONAL", members: { some: { userId: { in: rows.map((r) => r.userId) }, role: "OWNER" } } },
      select: { ...profileCardSelect, members: { where: { role: "OWNER" }, select: { userId: true } } },
    });
    const byUser = new Map(personal.map(({ members, ...p }) => [members[0]?.userId, toProfile(p)]));
    return rows.map((r) => ({ userId: r.userId, role: r.role, since: r.createdAt, profile: byUser.get(r.userId) ?? null }));
  }

  async addMember(actor: Actor, profileId: string, handle: string, role: "ADMIN" | "EDITOR") {
    await this.requireManager(actor, profileId);
    const target = await prisma.profile.findFirst({
      where: { handle, kind: "PERSONAL", deletedAt: null },
      select: { members: { where: { role: "OWNER" }, select: { userId: true } } },
    });
    const userId = target?.members[0]?.userId;
    if (!userId) throw NotFound("No person with that handle");
    const page = await prisma.profile.findUniqueOrThrow({ where: { profileId }, select: { kind: true } });
    if (page.kind !== "BUSINESS") throw BadRequest("Only business profiles have members");
    const existing = await prisma.profileMember.findUnique({ where: { profileId_userId: { profileId, userId } } });
    if (existing?.role === "OWNER") throw Conflict("That person is the owner");
    await prisma.profileMember.upsert({
      where: { profileId_userId: { profileId, userId } },
      create: { profileId, userId, role },
      update: { role },
    });
    joinProfileRoom(userId, profileId);
  }

  async removeMember(actor: Actor, profileId: string, userId: string) {
    // Members may remove themselves; otherwise owner/admin.
    if (userId !== actor.userId) await this.requireManager(actor, profileId);
    const member = await prisma.profileMember.findUnique({ where: { profileId_userId: { profileId, userId } } });
    if (!member) throw NotFound("Not a member");
    if (member.role === "OWNER") throw BadRequest("The owner can't be removed");
    await prisma.profileMember.delete({ where: { profileId_userId: { profileId, userId } } });
    leaveProfileRoom(userId, profileId);
  }
}

export { assertOwnMedia, isBlocked, areFriends };
export default new ProfileService();
