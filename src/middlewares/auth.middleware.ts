import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { iamCacheService } from "../utils/iam.redis";

export interface JwtPayload {
  realmId: string;
  sessionId: string;
  userId: string;
  email: string;
  clientIdInternal: string;
  isMasterRealmUser: boolean;
}

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

/**
 * Verify a crypt-iam access token: HS256 with the realm secret IAM caches in
 * Redis, and not revoked (blacklist). Returns null when it isn't valid.
 */
export async function verifyIamToken(token: string): Promise<JwtPayload | null> {
  const decoded = jwt.decode(token) as JwtPayload | null;
  if (!decoded?.realmId) return null;
  const secret = await iamCacheService.get<string>(`realm:${decoded.realmId}:secret`);
  if (!secret) return null;
  try {
    const payload = jwt.verify(token, secret, { algorithms: ["HS256"] }) as JwtPayload;
    if (await iamCacheService.get(`blacklist:${token}`)) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Require a valid IAM access token (`Authorization: Bearer <token>`). */
export const authMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  const [scheme, token] = (req.headers.authorization ?? "").split(" ");
  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({ success: false, status: 401, message: "Authorization header missing" });
  }
  try {
    const user = await verifyIamToken(token);
    if (!user) return res.status(401).json({ success: false, status: 401, message: "Invalid or expired token" });
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
};
