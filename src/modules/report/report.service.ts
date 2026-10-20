import type { ReportTarget } from "@prisma/client";
import prisma from "../../prisma/client";
import { NotFound } from "../../utils/errors";
import type { Actor } from "../../middlewares/actor.middleware";
import { profileCardSelect, toProfile } from "../profile/profile.view";
import { activeMemberIds, messageInclude, messageView } from "../conversation/conversation.service";
import { emitToProfiles } from "../../realtime/socket";
import { endStream } from "../live/live.service";

async function targetExists(type: ReportTarget, id: string) {
  switch (type) {
    case "PROFILE": return !!(await prisma.profile.findFirst({ where: { profileId: id, deletedAt: null } }));
    case "POST": return !!(await prisma.post.findFirst({ where: { postId: id, deletedAt: null } }));
    case "COMMENT": return !!(await prisma.comment.findFirst({ where: { commentId: id, deletedAt: null } }));
    case "MESSAGE": return !!(await prisma.message.findFirst({ where: { messageId: id, deletedAt: null } }));
    case "LIVE": return !!(await prisma.liveStream.findUnique({ where: { liveStreamId: id } }));
  }
}

/** Moderator action: hide the reported content. Profiles are only flagged (handled in IAM). */
async function takeDown(type: ReportTarget, id: string) {
  const now = new Date();
  if (type === "POST") await prisma.post.update({ where: { postId: id }, data: { deletedAt: now } });
  if (type === "COMMENT") {
    const c = await prisma.comment.update({ where: { commentId: id }, data: { deletedAt: now } });
    await prisma.post.update({ where: { postId: c.postId }, data: { commentCount: { decrement: 1 } } });
  }
  if (type === "MESSAGE") {
    const m = await prisma.message.update({ where: { messageId: id }, data: { text: null, mediaId: null, deletedAt: now }, include: messageInclude });
    emitToProfiles(await activeMemberIds(m.conversationId), "message:updated", messageView(m));
  }
  if (type === "LIVE") {
    const s = await prisma.liveStream.findUnique({ where: { liveStreamId: id } });
    if (s?.status === "LIVE") await endStream(id);
  }
}

class ReportService {
  async create(actor: Actor, targetType: ReportTarget, targetId: string, reason: string) {
    if (!(await targetExists(targetType, targetId))) throw NotFound("Nothing to report there");
    return prisma.report.create({ data: { reporterProfileId: actor.profileId, targetType, targetId, reason } });
  }

  async list(status: "OPEN" | "ACTIONED" | "DISMISSED", offset: number, limit: number) {
    const [items, total] = await Promise.all([
      prisma.report.findMany({ where: { status }, include: { reporter: { select: profileCardSelect } }, orderBy: { createdAt: "asc" }, skip: offset, take: limit }),
      prisma.report.count({ where: { status } }),
    ]);
    return { items: items.map(({ reporter, ...r }) => ({ ...r, reporter: toProfile(reporter) })), total, offset, limit };
  }

  /** ACTIONED takes the content down (and closes other open reports about it). */
  async resolve(userId: string, reportId: string, status: "ACTIONED" | "DISMISSED") {
    const report = await prisma.report.findUnique({ where: { reportId } });
    if (!report) throw NotFound("Report not found");
    if (status === "ACTIONED" && (await targetExists(report.targetType, report.targetId))) await takeDown(report.targetType, report.targetId);
    const where = status === "ACTIONED" ? { targetType: report.targetType, targetId: report.targetId, status: "OPEN" as const } : { reportId };
    await prisma.report.updateMany({ where, data: { status, resolvedByUserId: userId, resolvedAt: new Date() } });
    return prisma.report.findUniqueOrThrow({ where: { reportId } });
  }
}

export default new ReportService();
