import { Request, Response, NextFunction } from "express";
import type { MemberRole, ProfileKind } from "@prisma/client";
import prisma from "../prisma/client";
import { ensurePersonalProfile } from "../modules/profile/profile.service";

export interface Actor {
  userId: string;
  profileId: string;
  kind: ProfileKind;
  role: MemberRole;
}

declare global {
  namespace Express {
    interface Request {
      /** The profile this request acts as (header x-profile-id, default: your personal profile). */
      actor?: Actor;
    }
  }
}

/**
 * Resolve the active profile. Everything you post, send, call or stream is done
 * as this profile. You must be a member (OWNER / ADMIN / EDITOR) of it.
 */
export const actorMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.user!;
    const requested = req.header("x-profile-id")?.trim();
    if (!requested) {
      const personal = await ensurePersonalProfile(user.userId, user.email);
      req.actor = { userId: user.userId, profileId: personal.profileId, kind: "PERSONAL", role: "OWNER" };
      return next();
    }
    const member = await prisma.profileMember.findUnique({
      where: { profileId_userId: { profileId: requested, userId: user.userId } },
      include: { profile: { select: { kind: true, deletedAt: true } } },
    });
    if (!member || member.profile.deletedAt) {
      return res.status(403).json({ success: false, status: 403, message: "You can't act as this profile" });
    }
    req.actor = { userId: user.userId, profileId: requested, kind: member.profile.kind, role: member.role };
    next();
  } catch (err) {
    next(err);
  }
};
