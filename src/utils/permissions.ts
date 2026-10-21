import type { Request } from "express";
import iamRedis from "./iam.redis";
import { IAM_CLIENT_ID, Resource, TypeAction, TypeResource } from "./consts";

declare global {
  namespace Express {
    interface Request {
      /** This client's permission strings for the caller, loaded once per request. */
      iamPermissions?: string[];
    }
  }
}

const CLIENT_PREFIX = `${IAM_CLIENT_ID.toUpperCase()}:`;

/**
 * Permissions crypt-iam cached for the user at login / refresh
 * (`user:<userId>:permissions`), restricted to this client — strings look like
 * "MU:POST:CREATE:API_ENDPOINT". Returns null when IAM has no profile cached.
 */
export async function loadPermissions(req: Request): Promise<string[] | null> {
  if (req.iamPermissions) return req.iamPermissions;
  const userId = req.user?.userId;
  if (!userId) return null;

  const raw = await iamRedis.get(`user:${userId}:permissions`);
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  const profile = typeof parsed === "string" ? JSON.parse(parsed) : parsed;
  const all: string[] = Array.isArray(profile?.permissions) ? profile.permissions : [];

  req.iamPermissions = all.filter((p) => p.startsWith(CLIENT_PREFIX));
  return req.iamPermissions;
}

export function hasPermission(
  permissions: string[],
  resource: Resource,
  actions: TypeAction[],
  type: TypeResource = TypeResource.API_ENDPOINT,
): boolean {
  return permissions.some((perm) => {
    const [, name, action, permType] = perm.split(":");
    return name === resource && permType === type && actions.includes(action as TypeAction);
  });
}


/** Moderators hold READ_ALL on a resource: they may act on anyone's content of that kind. */
export async function canModerate(req: Request, resource: Resource): Promise<boolean> {
  const permissions = await loadPermissions(req);
  return !!permissions && hasPermission(permissions, resource, [TypeAction.READ_ALL]);
}

/**
 * App admins (the admin panel): hold MU_PROFILE READ_ALL *and* UPDATE — the IAM ADMIN role
 * of client "mu". MANAGER (moderation) and AUDITOR (read-only) don't have both.
 */
export async function isAppAdmin(req: Request): Promise<boolean> {
  const permissions = await loadPermissions(req);
  return !!permissions && hasPermission(permissions, Resource.PROFILE, [TypeAction.READ_ALL]) && hasPermission(permissions, Resource.PROFILE, [TypeAction.UPDATE]);
}
