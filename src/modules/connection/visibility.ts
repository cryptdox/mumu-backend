import type { Audience, ProfileKind } from "@prisma/client";
import prisma from "../../prisma/client";

/** Either side blocked the other. */
export async function isBlocked(a: string, b: string): Promise<boolean> {
  if (a === b) return false;
  const row = await prisma.block.findFirst({
    where: { OR: [{ blockerId: a, blockedId: b }, { blockerId: b, blockedId: a }] },
    select: { blockerId: true },
  });
  return !!row;
}

export async function areFriends(a: string, b: string): Promise<boolean> {
  const row = await prisma.friendship.findFirst({
    where: { status: "ACCEPTED", OR: [{ requesterId: a, addresseeId: b }, { requesterId: b, addresseeId: a }] },
    select: { requesterId: true },
  });
  return !!row;
}

export async function follows(followerId: string, followeeId: string): Promise<boolean> {
  return !!(await prisma.follow.findUnique({ where: { followerId_followeeId: { followerId, followeeId } }, select: { followerId: true } }));
}

/**
 * May `viewerId` see content by `author` with this audience?
 * CONNECTIONS = friends of a personal profile, followers of a business profile.
 */
export async function canSee(viewerId: string, author: { profileId: string; kind: ProfileKind }, audience: Audience): Promise<boolean> {
  if (viewerId === author.profileId) return true;
  if (audience === "ONLY_ME") return false;
  if (await isBlocked(viewerId, author.profileId)) return false;
  if (audience === "PUBLIC") return true;
  return author.kind === "PERSONAL" ? areFriends(viewerId, author.profileId) : follows(viewerId, author.profileId);
}

/** Profiles whose CONNECTIONS-audience content the viewer may see, plus blocked ids. */
export async function viewerGraph(viewerId: string) {
  const [friendRows, followRows, blockRows] = await Promise.all([
    prisma.friendship.findMany({
      where: { status: "ACCEPTED", OR: [{ requesterId: viewerId }, { addresseeId: viewerId }] },
      select: { requesterId: true, addresseeId: true },
    }),
    prisma.follow.findMany({ where: { followerId: viewerId }, select: { followeeId: true, followee: { select: { kind: true } } } }),
    prisma.block.findMany({ where: { OR: [{ blockerId: viewerId }, { blockedId: viewerId }] }, select: { blockerId: true, blockedId: true } }),
  ]);
  const friends = friendRows.map((f) => (f.requesterId === viewerId ? f.addresseeId : f.requesterId));
  const following = followRows.map((f) => f.followeeId);
  const followedBusinesses = followRows.filter((f) => f.followee.kind === "BUSINESS").map((f) => f.followeeId);
  const blocked = blockRows.map((b) => (b.blockerId === viewerId ? b.blockedId : b.blockerId));
  return { friends, following, connectionAuthors: [...friends, ...followedBusinesses], blocked };
}
