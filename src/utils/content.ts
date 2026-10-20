import { z } from "zod";
import { MAX_TEXT } from "./consts";

/** Up to 500 characters (emoji count as one), trimmed; empty → undefined. */
export const textSchema = z
  .string()
  .trim()
  .refine((t) => [...t].length <= MAX_TEXT, `At most ${MAX_TEXT} characters`)
  .transform((t) => (t.length ? t : undefined));

export const audienceSchema = z.enum(["PUBLIC", "CONNECTIONS", "ONLY_ME"]);

/** Cursor paging by time: `before` = createdAt of the last item you have. */
export const beforeQuery = z.object({
  before: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
