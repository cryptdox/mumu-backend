import { Prisma } from "@prisma/client";
import type { Request } from "express";
import prisma from "../../prisma/client";
import { BadRequest, Forbidden, NotFound } from "../../utils/errors";
import { MAX_GROUP_MEMBERS, Resource } from "../../utils/consts";
import { canModerate } from "../../utils/permissions";
import type { Actor } from "../../middlewares/actor.middleware";
import { emitToProfiles, isOnline } from "../../realtime/socket";
import { profileCardSelect, toProfile } from "../profile/profile.view";
import { assertOwnMedia } from "../profile/profile.service";
import { isBlocked } from "../connection/visibility";
import { notify } from "../notification/notification.service";
import type { SendMessageDto } from "./conversation.dto";

export const messageInclude = {
  sender: { select: profileCardSelect },
  media: { select: { url: true, width: true, height: true, mime: true } },
  replyTo: { select: { messageId: true, text: true, deletedAt: true, mediaId: true, sender: { select: { profileId: true, displayName: true } } } },
  call: { select: { callId: true, type: true, status: true, startedAt: true, answeredAt: true, endedAt: true } },
} satisfies Prisma.MessageInclude;

type MessageRow = Prisma.MessageGetPayload<{ include: typeof messageInclude }>;

export function messageView(m: MessageRow) {
  const { sender, mediaId: _m, replyTo, callId: _c, replyToId: _r, ...rest } = m;
  return {
    ...rest,
    sender: toProfile(sender),
    replyTo: replyTo && { messageId: replyTo.messageId, text: replyTo.deletedAt ? null : replyTo.text, hasImage: !!replyTo.mediaId, deleted: !!replyTo.deletedAt, sender: replyTo.sender },
  };
}

const memberSelect = { profileId: true, role: true, lastReadAt: true, profile: { select: profileCardSelect } } as const;

export async function activeMemberIds(conversationId: string) {
  const rows = await prisma.conversationMember.findMany({ where: { conversationId, leftAt: null }, select: { profileId: true } });
  return rows.map((r) => r.profileId);
}

/** You must be a current member. Returns your membership + the conversation. */
export async function requireMember(actor: Actor, conversationId: string) {
  const member = await prisma.conversationMember.findUnique({
    where: { conversationId_profileId: { conversationId, profileId: actor.profileId } },
    include: { conversation: true },
  });
  if (!member || member.leftAt) throw NotFound("Chat not found");
  return member;
}

/** Store a message, bump the chat and push it to every member. */
export async function postMessage(conversationId: string, senderProfileId: string, data: Omit<Prisma.MessageUncheckedCreateInput, "conversationId" | "senderProfileId">) {
  const [message] = await prisma.$transaction([
    prisma.message.create({ data: { ...data, conversationId, senderProfileId }, include: messageInclude }),
    prisma.conversation.update({ where: { conversationId }, data: { lastMessageAt: new Date() } }),
  ]);
  const view = messageView(message);
  emitToProfiles(await activeMemberIds(conversationId), "message:new", view);
  return view;
}

class ConversationService {
  /** Your chats, most recent first, with the last message and unread count. */
  async list(actor: Actor, before: Date | undefined, limit: number) {
    const me = actor.profileId;
    const rows = await prisma.conversation.findMany({
      where: { members: { some: { profileId: me, leftAt: null } }, ...(before && { lastMessageAt: { lt: before } }) },
      include: {
        avatar: { select: { url: true } },
        members: { where: { leftAt: null }, select: memberSelect, take: 6, orderBy: { joinedAt: "asc" } },
        messages: { orderBy: { createdAt: "desc" }, take: 1, include: messageInclude },
        _count: { select: { members: { where: { leftAt: null } } } },
      },
      orderBy: { lastMessageAt: "desc" },
      take: limit,
    });
    const unread = await this.unreadCounts(me, rows.map((r) => r.conversationId));
    const mine = await prisma.conversationMember.findMany({
      where: { profileId: me, conversationId: { in: rows.map((r) => r.conversationId) } },
      select: { conversationId: true, mutedUntil: true },
    });
    const muted = new Map(mine.map((m) => [m.conversationId, m.mutedUntil]));
    return rows.map((c) => this.summary(c, me, unread.get(c.conversationId) ?? 0, muted.get(c.conversationId) ?? null));
  }

  private summary(c: any, me: string, unread: number, mutedUntil: Date | null) {
    const others = c.members.filter((m: any) => m.profileId !== me);
    const partner = c.type === "DIRECT" ? others[0]?.profile : null;
    return {
      conversationId: c.conversationId,
      type: c.type,
      title: c.type === "DIRECT" ? partner?.displayName ?? "Deleted profile" : c.title,
      avatarUrl: c.type === "DIRECT" ? partner?.avatar?.url ?? null : c.avatar?.url ?? null,
      partner: partner ? { ...toProfile(partner), online: isOnline(partner.profileId) } : null,
      members: c.members.map((m: any) => ({ ...toProfile(m.profile), role: m.role })),
      memberCount: c._count.members,
      lastMessage: c.messages[0] ? messageView(c.messages[0]) : null,
      lastMessageAt: c.lastMessageAt,
      unread,
      mutedUntil: mutedUntil && mutedUntil > new Date() ? mutedUntil : null,
    };
  }

  private async unreadCounts(profileId: string, ids: string[]) {
    if (!ids.length) return new Map<string, number>();
    const rows = await prisma.$queryRaw<{ conversationId: string; n: bigint }[]>`
      SELECT m."conversationId", COUNT(*) AS n
      FROM "Message" m
      JOIN "ConversationMember" cm ON cm."conversationId" = m."conversationId" AND cm."profileId" = ${profileId}
      WHERE m."conversationId" IN (${Prisma.join(ids)})
        AND m."senderProfileId" <> ${profileId}
        AND m."deletedAt" IS NULL
        AND m."createdAt" > COALESCE(cm."lastReadAt", cm."joinedAt")
      GROUP BY m."conversationId"`;
    return new Map(rows.map((r) => [r.conversationId, Number(r.n)]));
  }

  async get(actor: Actor, conversationId: string) {
    const member = await requireMember(actor, conversationId);
    const c = await prisma.conversation.findUniqueOrThrow({
      where: { conversationId },
      include: {
        avatar: { select: { url: true } },
        members: { where: { leftAt: null }, select: memberSelect, orderBy: { joinedAt: "asc" } },
        messages: { orderBy: { createdAt: "desc" }, take: 1, include: messageInclude },
        _count: { select: { members: { where: { leftAt: null } } } },
      },
    });
    const [unread] = [(await this.unreadCounts(actor.profileId, [conversationId])).get(conversationId) ?? 0];
    const view = this.summary(c, actor.profileId, unread, member.mutedUntil);
    return { ...view, myRole: member.role, members: c.members.map((m) => ({ ...toProfile(m.profile), role: m.role, lastReadAt: m.lastReadAt, online: isOnline(m.profileId) })) };
  }

  /** Find or start a 1:1 chat with any profile (people or businesses). */
  async openDirect(actor: Actor, profileId: string) {
    const me = actor.profileId;
    if (profileId === me) throw BadRequest("That's you");
    const other = await prisma.profile.findFirst({ where: { profileId, deletedAt: null }, select: { profileId: true } });
    if (!other || (await isBlocked(me, profileId))) throw NotFound("Profile not found");
    const directKey = [me, profileId].sort().join(":");
    let conversation = await prisma.conversation.findUnique({ where: { directKey } });
    if (!conversation) {
      try {
        conversation = await prisma.conversation.create({
          data: { type: "DIRECT", directKey, createdById: me, members: { create: [{ profileId: me }, { profileId }] } },
        });
      } catch (err) {
        if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
        conversation = await prisma.conversation.findUniqueOrThrow({ where: { directKey } });
      }
    }
    return this.get(actor, conversation.conversationId);
  }

  private async addable(actor: Actor, ids: string[]) {
    const unique = [...new Set(ids)].filter((id) => id !== actor.profileId);
    const found = await prisma.profile.findMany({ where: { profileId: { in: unique }, deletedAt: null }, select: { profileId: true } });
    if (found.length !== unique.length) throw BadRequest("Some of those profiles don't exist");
    const blocked = await prisma.block.findFirst({
      where: { OR: [{ blockerId: actor.profileId, blockedId: { in: unique } }, { blockedId: actor.profileId, blockerId: { in: unique } }] },
    });
    if (blocked) throw BadRequest("You can't add someone you blocked or who blocked you");
    return unique;
  }

  async createGroup(actor: Actor, title: string, memberIds: string[], avatarMediaId?: string) {
    const ids = await this.addable(actor, memberIds);
    await assertOwnMedia(actor.profileId, avatarMediaId);
    const conversation = await prisma.conversation.create({
      data: {
        type: "GROUP",
        title,
        avatarMediaId,
        createdById: actor.profileId,
        members: { create: [{ profileId: actor.profileId, role: "ADMIN" }, ...ids.map((profileId) => ({ profileId }))] },
      },
    });
    await postMessage(conversation.conversationId, actor.profileId, { kind: "SYSTEM", text: `created the group "${title}"` });
    await notify(ids, "ADDED_TO_GROUP", actor.profileId, conversation.conversationId);
    return this.get(actor, conversation.conversationId);
  }

  private async requireGroupAdmin(actor: Actor, conversationId: string) {
    const member = await requireMember(actor, conversationId);
    if (member.conversation.type !== "GROUP") throw BadRequest("Only group chats have settings");
    if (member.role !== "ADMIN") throw Forbidden("Only group admins can do this");
    return member;
  }

  async updateGroup(actor: Actor, conversationId: string, dto: { title?: string; avatarMediaId?: string | null }) {
    await this.requireGroupAdmin(actor, conversationId);
    await assertOwnMedia(actor.profileId, dto.avatarMediaId);
    await prisma.conversation.update({ where: { conversationId }, data: dto });
    if (dto.title) await postMessage(conversationId, actor.profileId, { kind: "SYSTEM", text: `renamed the group to "${dto.title}"` });
    const view = await this.get(actor, conversationId);
    emitToProfiles(await activeMemberIds(conversationId), "conversation:updated", { conversationId });
    return view;
  }

  async addMembers(actor: Actor, conversationId: string, profileIds: string[]) {
    await this.requireGroupAdmin(actor, conversationId);
    const ids = await this.addable(actor, profileIds);
    const current = await activeMemberIds(conversationId);
    const fresh = ids.filter((id) => !current.includes(id));
    if (current.length + fresh.length > MAX_GROUP_MEMBERS) throw BadRequest(`Groups can have at most ${MAX_GROUP_MEMBERS} members`);
    for (const profileId of fresh) {
      await prisma.conversationMember.upsert({
        where: { conversationId_profileId: { conversationId, profileId } },
        create: { conversationId, profileId },
        update: { leftAt: null, role: "MEMBER", joinedAt: new Date(), lastReadAt: null },
      });
    }
    if (fresh.length) {
      const names = await prisma.profile.findMany({ where: { profileId: { in: fresh } }, select: { displayName: true } });
      await postMessage(conversationId, actor.profileId, { kind: "SYSTEM", text: `added ${names.map((n) => n.displayName).join(", ")}` });
      await notify(fresh, "ADDED_TO_GROUP", actor.profileId, conversationId);
    }
    return this.get(actor, conversationId);
  }

  /** Remove someone (group admin) or leave yourself. The oldest member becomes admin if the last admin leaves. */
  async removeMember(actor: Actor, conversationId: string, profileId: string) {
    const self = profileId === actor.profileId;
    const member = self ? await requireMember(actor, conversationId) : await this.requireGroupAdmin(actor, conversationId);
    if (member.conversation.type !== "GROUP") throw BadRequest("You can't leave a direct chat — block or mute it instead");
    const target = await prisma.conversationMember.findUnique({ where: { conversationId_profileId: { conversationId, profileId } }, include: { profile: { select: { displayName: true } } } });
    if (!target || target.leftAt) throw NotFound("Not a member");

    const before = await activeMemberIds(conversationId);
    await prisma.conversationMember.update({ where: { conversationId_profileId: { conversationId, profileId } }, data: { leftAt: new Date() } });
    const admins = await prisma.conversationMember.count({ where: { conversationId, leftAt: null, role: "ADMIN" } });
    if (!admins) {
      const next = await prisma.conversationMember.findFirst({ where: { conversationId, leftAt: null }, orderBy: { joinedAt: "asc" } });
      if (next) await prisma.conversationMember.update({ where: { conversationId_profileId: { conversationId, profileId: next.profileId } }, data: { role: "ADMIN" } });
    }
    if (before.length > 1) {
      await postMessage(conversationId, actor.profileId, { kind: "SYSTEM", text: self ? "left the group" : `removed ${target.profile.displayName}` });
    }
    emitToProfiles(before, "conversation:updated", { conversationId });
  }

  async messages(actor: Actor, conversationId: string, before: Date | undefined, limit: number) {
    await requireMember(actor, conversationId);
    const rows = await prisma.message.findMany({
      where: { conversationId, ...(before && { createdAt: { lt: before } }) },
      include: messageInclude,
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return rows.map(messageView);
  }

  async send(actor: Actor, conversationId: string, dto: SendMessageDto) {
    const member = await requireMember(actor, conversationId);
    if (member.conversation.type === "DIRECT") {
      const others = (await activeMemberIds(conversationId)).filter((id) => id !== actor.profileId);
      if (others.length && (await isBlocked(actor.profileId, others[0]))) throw Forbidden("You can't message this profile");
    }
    await assertOwnMedia(actor.profileId, dto.mediaId);
    if (dto.replyToId) {
      const replied = await prisma.message.findFirst({ where: { messageId: dto.replyToId, conversationId } });
      if (!replied) throw BadRequest("Replying to a message that isn't in this chat");
    }
    const message = await postMessage(conversationId, actor.profileId, { kind: "TEXT", text: dto.text, mediaId: dto.mediaId, replyToId: dto.replyToId });
    // Sending means you've read everything before it.
    await prisma.conversationMember.update({
      where: { conversationId_profileId: { conversationId, profileId: actor.profileId } },
      data: { lastReadAt: message.createdAt, lastReadMessageId: message.messageId },
    });
    return message;
  }

  private async ownMessage(req: Request, messageId: string, allowModerator: boolean) {
    const actor = req.actor!;
    const message = await prisma.message.findUnique({ where: { messageId } });
    if (!message || message.deletedAt) throw NotFound("Message not found");
    const isSender = message.senderProfileId === actor.profileId;
    if (!isSender && !(allowModerator && (await canModerate(req, Resource.MESSAGE)))) throw Forbidden("Not your message");
    if (isSender) await requireMember(actor, message.conversationId);
    if (message.kind !== "TEXT") throw BadRequest("This message can't be changed");
    return message;
  }

  async edit(req: Request, messageId: string, text: string) {
    const message = await this.ownMessage(req, messageId, false);
    const updated = await prisma.message.update({ where: { messageId }, data: { text, editedAt: new Date() }, include: messageInclude });
    const view = messageView(updated);
    emitToProfiles(await activeMemberIds(message.conversationId), "message:updated", view);
    return view;
  }

  /** "Delete for everyone": the bubble stays as "message deleted". */
  async remove(req: Request, messageId: string) {
    const message = await this.ownMessage(req, messageId, true);
    const updated = await prisma.message.update({ where: { messageId }, data: { text: null, mediaId: null, deletedAt: new Date() }, include: messageInclude });
    emitToProfiles(await activeMemberIds(message.conversationId), "message:updated", messageView(updated));
  }

  /** Mark read up to a message (default: everything). Members see it live ("read" event). */
  async markRead(actor: Actor, conversationId: string, messageId?: string) {
    await requireMember(actor, conversationId);
    const upTo = messageId
      ? await prisma.message.findFirst({ where: { messageId, conversationId }, select: { messageId: true, createdAt: true } })
      : await prisma.message.findFirst({ where: { conversationId }, orderBy: { createdAt: "desc" }, select: { messageId: true, createdAt: true } });
    if (messageId && !upTo) throw BadRequest("That message isn't in this chat");
    const lastReadAt = upTo?.createdAt ?? new Date();
    await prisma.conversationMember.update({
      where: { conversationId_profileId: { conversationId, profileId: actor.profileId } },
      data: { lastReadAt, lastReadMessageId: upTo?.messageId ?? null },
    });
    emitToProfiles(await activeMemberIds(conversationId), "read", { conversationId, profileId: actor.profileId, lastReadAt });
    return { lastReadAt };
  }

  async mute(actor: Actor, conversationId: string, until: Date | null) {
    await requireMember(actor, conversationId);
    await prisma.conversationMember.update({ where: { conversationId_profileId: { conversationId, profileId: actor.profileId } }, data: { mutedUntil: until } });
    return { mutedUntil: until };
  }
}

export default new ConversationService();
