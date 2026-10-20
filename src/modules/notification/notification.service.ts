import type { NotificationType } from "@prisma/client";
import prisma from "../../prisma/client";
import { emitToProfiles } from "../../realtime/socket";
import { profileCardSelect, toProfile } from "../profile/profile.view";
import logger from "../../utils/logger";

const include = { actor: { select: profileCardSelect } } as const;

function view<T extends { actor: any }>(n: T) {
  return { ...n, actor: n.actor ? toProfile(n.actor) : null };
}

/** Store a notification and push it live. Never notifies you about yourself; never throws. */
export async function notify(recipientIds: string | string[], type: NotificationType, actorId: string | null, entityId?: string) {
  const recipients = [...new Set(Array.isArray(recipientIds) ? recipientIds : [recipientIds])].filter((id) => id !== actorId);
  if (!recipients.length) return;
  try {
    if (recipients.length === 1) {
      const n = await prisma.notification.create({
        data: { recipientProfileId: recipients[0], type, actorProfileId: actorId, entityId },
        include,
      });
      emitToProfiles(recipients, "notification", view(n));
      return;
    }
    await prisma.notification.createMany({
      data: recipients.map((recipientProfileId) => ({ recipientProfileId, type, actorProfileId: actorId, entityId })),
    });
    const actor = actorId ? await prisma.profile.findUnique({ where: { profileId: actorId }, select: profileCardSelect }) : null;
    emitToProfiles(recipients, "notification", { type, entityId, actor: actor ? toProfile(actor) : null, createdAt: new Date() });
  } catch (err: any) {
    logger.warn(`[Notify] ${type} failed: ${err?.message ?? err}`);
  }
}

class NotificationService {
  async list(profileId: string, before: Date | undefined, limit: number) {
    const rows = await prisma.notification.findMany({
      where: { recipientProfileId: profileId, ...(before && { createdAt: { lt: before } }) },
      include,
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    const unread = await prisma.notification.count({ where: { recipientProfileId: profileId, readAt: null } });
    return { items: rows.map(view), unread };
  }

  async markRead(profileId: string, ids?: string[]) {
    const { count } = await prisma.notification.updateMany({
      where: { recipientProfileId: profileId, readAt: null, ...(ids?.length && { notificationId: { in: ids } }) },
      data: { readAt: new Date() },
    });
    return { marked: count };
  }
}

export default new NotificationService();
