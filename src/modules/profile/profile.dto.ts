import { z } from "zod";

const RESERVED = new Set(["admin", "api", "app", "help", "login", "logout", "me", "mu", "mumu", "settings", "support", "live", "chats", "feed", "notifications"]);

export const handleSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(30)
  .regex(/^[a-z0-9][a-z0-9_.]*$/, "Use letters, digits, _ and . (start with a letter or digit)")
  .refine((h) => !RESERVED.has(h), "This name is reserved");

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

/**
 * @openapi
 * components:
 *   schemas:
 *     Profile:
 *       type: object
 *       properties:
 *         profileId: { type: string }
 *         kind: { type: string, enum: [PERSONAL, BUSINESS] }
 *         handle: { type: string, example: "sunrise.bakery" }
 *         displayName: { type: string }
 *         bio: { type: string, nullable: true }
 *         category: { type: string, nullable: true }
 *         website: { type: string, nullable: true }
 *         avatarUrl: { type: string, nullable: true }
 *         coverUrl: { type: string, nullable: true }
 *         isVerified: { type: boolean }
 *     CreateBusinessProfileDto:
 *       type: object
 *       required: [handle, displayName]
 *       properties:
 *         handle: { type: string }
 *         displayName: { type: string }
 *         category: { type: string }
 *         bio: { type: string }
 *         website: { type: string }
 *     UpdateProfileDto:
 *       type: object
 *       properties:
 *         handle: { type: string }
 *         displayName: { type: string }
 *         bio: { type: string, nullable: true }
 *         category: { type: string, nullable: true }
 *         website: { type: string, nullable: true }
 *         avatarMediaId: { type: string, nullable: true }
 *         coverMediaId: { type: string, nullable: true }
 */
export const createBusinessSchema = z.object({
  handle: handleSchema,
  displayName: z.string().trim().min(1).max(60),
  category: optionalText(40),
  bio: optionalText(300),
  website: z.url().max(200).nullable().optional(),
});
export type CreateBusinessDto = z.infer<typeof createBusinessSchema>;

export const updateProfileSchema = z
  .object({
    handle: handleSchema,
    displayName: z.string().trim().min(1).max(60),
    category: optionalText(40),
    bio: optionalText(300),
    website: z.url().max(200).nullable(),
    avatarMediaId: z.string().nullable(),
    coverMediaId: z.string().nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");
export type UpdateProfileDto = z.infer<typeof updateProfileSchema>;

export const addMemberSchema = z.object({
  /** Handle of the person's personal profile. */
  handle: handleSchema,
  role: z.enum(["ADMIN", "EDITOR"]),
});

export const searchQuery = z.object({
  q: z.string().trim().min(1).max(60),
  kind: z.enum(["PERSONAL", "BUSINESS"]).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
