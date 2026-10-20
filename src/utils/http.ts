import { Request, Response, NextFunction, RequestHandler } from "express";
import { z, ZodType } from "zod";
import { BadRequest } from "./errors";

declare global {
  namespace Express {
    interface Request {
      /** Values parsed by the `validate` middleware (Express 5 `req.query` is read-only). */
      validated?: { body?: any; query?: any; params?: any };
    }
  }
}

/**
 * Validate request body / query / params with zod. Parsed (coerced, stripped)
 * values replace `req.body` and are exposed on `req.validated`.
 */
export function validate(schemas: { body?: ZodType; query?: ZodType; params?: ZodType }): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const validated: { body?: any; query?: any; params?: any } = {};
    for (const part of ["params", "query", "body"] as const) {
      const schema = schemas[part];
      if (!schema) continue;
      const result = schema.safeParse(req[part] ?? {});
      if (!result.success) {
        const issues = result.error.issues.map((i) => ({ path: [part, ...i.path].join("."), message: i.message }));
        return next(BadRequest(`Invalid request ${part}`, issues));
      }
      validated[part] = result.data;
    }
    if (validated.body !== undefined) req.body = validated.body;
    req.validated = validated;
    next();
  };
}

/** Standard success envelope used across the API. */
export function send<T>(res: Response, status: number, message: string, data?: T) {
  res.status(status).json({ success: true, status, message, ...(data !== undefined && { data }) });
}

// ── Shared schemas ───────────────────────────────────────────────────────────

export const paginationSchema = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().min(1).max(200).optional(),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

export type Pagination = z.infer<typeof paginationSchema>;

/** Pagination plus a whitelisted sortBy field (prevents ordering by arbitrary columns). */
export const paginationWithSort = <T extends readonly [string, ...string[]]>(fields: T, fallback: T[number]) =>
  paginationSchema.extend({ sortBy: z.enum(fields).default(fallback as any) });

export const idParam = (...names: string[]) =>
  z.object(Object.fromEntries(names.map((n) => [n, z.string().trim().min(1).max(128)])));

export function paginated<T>(items: T[], total: number, p: { offset: number; limit: number }) {
  return { items, total, offset: p.offset, limit: p.limit };
}
