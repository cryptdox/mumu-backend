import { Request, Response, NextFunction } from "express";
import { TypeResource, TypeAction, Resource } from "../utils/consts";
import { hasPermission, loadPermissions } from "../utils/permissions";

/**
 * Require one of `actions` on `resource` for this IAM client. Unlike crypt-iam's
 * own check, the client segment of the permission string is enforced, so
 * permissions granted on other clients never count here.
 */
export function authorizationMiddleware(authorization: {
  resource: Resource;
  resourceType: TypeResource;
  actions: TypeAction[];
}) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user?.userId) {
        return res.status(401).json({ success: false, status: 401, message: "Unauthorized" });
      }

      const permissions = await loadPermissions(req);
      if (!permissions) {
        // IAM caches permissions at login/refresh; a refresh repopulates them.
        return res.status(401).json({ success: false, status: 401, message: "Permissions not loaded — refresh your session" });
      }

      if (!hasPermission(permissions, authorization.resource, authorization.actions, authorization.resourceType)) {
        return res.status(403).json({ success: false, status: 403, message: "Access denied" });
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}
