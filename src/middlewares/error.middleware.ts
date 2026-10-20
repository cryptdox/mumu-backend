import { Request, Response, NextFunction } from "express";
import { Prisma } from "@prisma/client";
import { AppError } from "../utils/errors";
import { IS_PROD } from "../utils/consts";
import logger from "../utils/logger";

function toAppError(err: any): AppError {
  if (err instanceof AppError) return err;

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2025") return new AppError(404, "Resource not found");
    if (err.code === "P2002") {
      const target = (err.meta?.target as string[] | string | undefined) ?? "field";
      return new AppError(409, `Duplicate value for ${Array.isArray(target) ? target.join(", ") : target}`);
    }
    if (err.code === "P2003") return new AppError(409, "Related resource constraint failed");
  }

  // Malformed JSON body from express.json()
  if (err?.type === "entity.parse.failed") return new AppError(400, "Malformed JSON body");
  if (err?.type === "entity.too.large") return new AppError(413, "Request body too large");

  return new AppError(500, IS_PROD ? "Internal Server Error" : err?.message || "Internal Server Error");
}

export const errorMiddleware = (err: any, req: Request, res: Response, _next: NextFunction) => {
  const appErr = toAppError(err);
  if (appErr.status >= 500) logger.error(`${req.method} ${req.originalUrl} → ${err?.stack ?? err}`);

  res.status(appErr.status).json({
    success: false,
    status: appErr.status,
    message: appErr.message,
    ...(appErr.details !== undefined && { errors: appErr.details }),
    ...(!IS_PROD && appErr.status >= 500 && { stack: err?.stack }),
  });
};

export const notFoundMiddleware = (req: Request, res: Response) => {
  res.status(404).json({ success: false, status: 404, message: `Route not found: ${req.method} ${req.path}` });
};
