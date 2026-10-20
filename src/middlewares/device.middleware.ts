import { Request, Response, NextFunction } from "express";
import { admitDevice, deviceIdOf } from "../modules/device/device.service";

declare global {
  namespace Express {
    interface Request {
      /** The app's device id (x-device-id), when sent. */
      deviceId?: string;
    }
  }
}

/**
 * Enforce the per-account device limit for the web / mobile app (requests that send
 * x-device-id). Requests without it (scripts, Swagger) aren't device-limited.
 */
export const deviceMiddleware = async (req: Request, _res: Response, next: NextFunction) => {
  try {
    const deviceId = deviceIdOf(req);
    if (deviceId && req.user) {
      await admitDevice(req.user.userId, deviceId, (req.user as { iat?: number }).iat, req.header("user-agent") ?? "");
      req.deviceId = deviceId;
    }
    next();
  } catch (err) {
    next(err);
  }
};
