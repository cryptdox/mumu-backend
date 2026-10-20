import { z } from "zod";
import { audienceSchema, textSchema } from "../../utils/content";

/**
 * @openapi
 * components:
 *   schemas:
 *     CreatePostDto:
 *       type: object
 *       description: Text (≤ 500 chars) and/or one uploaded image
 *       properties:
 *         text: { type: string, maxLength: 500 }
 *         mediaId: { type: string }
 *         audience: { type: string, enum: [PUBLIC, CONNECTIONS, ONLY_ME], default: PUBLIC, description: "CONNECTIONS = friends (personal) / followers (business)" }
 *     Post:
 *       type: object
 *       properties:
 *         postId: { type: string }
 *         author: { type: object }
 *         text: { type: string, nullable: true }
 *         media: { type: object, nullable: true, properties: { url: { type: string }, width: { type: integer }, height: { type: integer } } }
 *         audience: { type: string }
 *         reactionCount: { type: integer }
 *         commentCount: { type: integer }
 *         myReaction: { type: string, nullable: true }
 *         liveStream: { type: object, nullable: true }
 *         createdAt: { type: string, format: date-time }
 */
export const createPostSchema = z
  .object({ text: textSchema.optional(), mediaId: z.string().min(1).max(64).optional(), audience: audienceSchema.default("PUBLIC") })
  .refine((p) => p.text || p.mediaId, "Write something or add an image");
export type CreatePostDto = z.infer<typeof createPostSchema>;

export const updatePostSchema = z
  .object({ text: textSchema.nullable(), audience: audienceSchema })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");

export const feedQuery = z.object({
  tab: z.enum(["following", "explore"]).default("following"),
  before: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const commentSchema = z.object({
  text: textSchema.refine((t) => !!t, "Write something"),
  parentId: z.string().min(1).max(64).optional(),
});

export const reactionSchema = z.object({ type: z.enum(["LIKE", "LOVE", "HAHA", "WOW", "SAD"]).default("LIKE") });
