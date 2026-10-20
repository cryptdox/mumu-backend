import { Request, Response, NextFunction, RequestHandler } from "express";

export class AppError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
    this.name = "AppError";
  }
}

export const BadRequest = (message: string, details?: unknown) => new AppError(400, message, details);
export const Unauthorized = (message = "Unauthorized") => new AppError(401, message);
export const Forbidden = (message = "Access denied") => new AppError(403, message);
export const NotFound = (message = "Not found") => new AppError(404, message);
export const Conflict = (message: string) => new AppError(409, message);
export const ServiceUnavailable = (message: string) => new AppError(503, message);

/** Wrap an async handler so rejections reach the error middleware. */
export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };
