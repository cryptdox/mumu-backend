import type { Request, Response } from "express";
import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import { IS_TEST } from "../utils/consts";

/** Per account (or IP before auth), in memory — each instance limits on its own. */
const limiter = (limit: number, windowMs: number, message: string) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    skip: () => IS_TEST,
    keyGenerator: (req: Request) => req.user?.userId ?? ipKeyGenerator(req.ip ?? ""),
    handler: (_req: Request, res: Response) => res.status(429).json({ success: false, status: 429, message }),
  });

export const writeLimiter = limiter(Number(process.env.RATE_LIMIT_WRITES_PER_MIN ?? 120), 60_000, "Slow down — too many actions, try again in a minute");
export const uploadLimiter = limiter(Number(process.env.RATE_LIMIT_UPLOADS_PER_MIN ?? 20), 60_000, "Too many uploads, try again in a minute");
