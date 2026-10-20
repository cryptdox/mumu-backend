import { z } from "zod";
import { textSchema } from "../../utils/content";
import { MAX_GROUP_MEMBERS } from "../../utils/consts";

const id = z.string().min(1).max(64);

/**
 * @openapi
 * components:
 *   schemas:
 *     SendMessageDto:
 *       type: object
 *       description: Text (≤ 500 chars) and/or one uploaded image
 *       properties:
 *         text: { type: string, maxLength: 500 }
 *         mediaId: { type: string }
 *         replyToId: { type: string }
 *     Message:
 *       type: object
 *       properties:
 *         messageId: { type: string }
 *         conversationId: { type: string }
 *         sender: { type: object }
 *         kind: { type: string, enum: [TEXT, CALL, SYSTEM] }
 *         text: { type: string, nullable: true }
 *         media: { type: object, nullable: true }
 *         replyTo: { type: object, nullable: true }
 *         call: { type: object, nullable: true }
 *         createdAt: { type: string, format: date-time }
 *         editedAt: { type: string, nullable: true }
 *         deletedAt: { type: string, nullable: true }
 */
export const directSchema = z.object({ profileId: id });
export const groupSchema = z.object({
  title: z.string().trim().min(1).max(60),
  memberIds: z.array(id).min(1).max(MAX_GROUP_MEMBERS - 1),
  avatarMediaId: id.optional(),
});
export const updateGroupSchema = z
  .object({ title: z.string().trim().min(1).max(60), avatarMediaId: id.nullable() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");
export const addMembersSchema = z.object({ profileIds: z.array(id).min(1).max(50) });
export const sendMessageSchema = z
  .object({ text: textSchema.optional(), mediaId: id.optional(), replyToId: id.optional() })
  .refine((m) => m.text || m.mediaId, "Write something or add an image");
export type SendMessageDto = z.infer<typeof sendMessageSchema>;
export const editMessageSchema = z.object({ text: textSchema.refine((t) => !!t, "Write something") });
export const readSchema = z.object({ messageId: id.optional() });
export const muteSchema = z.object({ until: z.coerce.date().nullable() });
