import express, { Router } from "express";
import { z } from "zod";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { actorMiddleware } from "../../middlewares/actor.middleware";
import { writeLimiter } from "../../middlewares/rateLimit.middleware";
import { asyncHandler } from "../../utils/errors";
import { guard, R, A } from "../../utils/guard";
import { idParam, send, validate } from "../../utils/http";
import { beforeQuery } from "../../utils/content";
import conversationService from "./conversation.service";
import { addMembersSchema, directSchema, editMessageSchema, groupSchema, muteSchema, readSchema, sendMessageSchema, updateGroupSchema } from "./conversation.dto";

const router: Router = express.Router();
router.use(authMiddleware, actorMiddleware);
const cid = idParam("conversationId");
const listQuery = z.object({ before: z.coerce.date().optional(), limit: z.coerce.number().int().min(1).max(100).default(30) });

/**
 * @openapi
 * tags:
 *   - name: Chats
 *     description: Direct and group chats of the active profile. New messages, edits, reads and typing also arrive over socket.io.
 *
 * /api/conversations:
 *   get:
 *     tags: [Chats]
 *     summary: Your chats, most recent first (last message, unread count, partner online)
 *     parameters:
 *       - { name: before, in: query, schema: { type: string, format: date-time }, description: lastMessageAt of the last chat you have }
 *       - { name: limit, in: query, schema: { type: integer, default: 30 } }
 *     responses:
 *       200: { description: Chats }
 * /api/conversations/direct:
 *   post:
 *     tags: [Chats]
 *     summary: Open (find or start) a 1:1 chat with any profile
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { type: object, required: [profileId], properties: { profileId: { type: string } } } } }
 *     responses:
 *       200: { description: Chat }
 * /api/conversations/group:
 *   post:
 *     tags: [Chats]
 *     summary: Create a group (you become its admin)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, required: [title, memberIds], properties: { title: { type: string }, memberIds: { type: array, items: { type: string } }, avatarMediaId: { type: string } } }
 *     responses:
 *       201: { description: Chat }
 */
router.get("/", guard(R.CONVERSATION, A.READ), validate({ query: listQuery }), asyncHandler(async (req, res) => {
  const { before, limit } = req.validated!.query;
  send(res, 200, "Chats fetched", await conversationService.list(req.actor!, before, limit));
}));
router.post("/direct", writeLimiter, guard(R.CONVERSATION, A.CREATE), validate({ body: directSchema }), asyncHandler(async (req, res) => {
  send(res, 200, "Chat opened", await conversationService.openDirect(req.actor!, req.body.profileId));
}));
router.post("/group", writeLimiter, guard(R.CONVERSATION, A.CREATE), validate({ body: groupSchema }), asyncHandler(async (req, res) => {
  send(res, 201, "Group created", await conversationService.createGroup(req.actor!, req.body.title, req.body.memberIds, req.body.avatarMediaId));
}));

/**
 * @openapi
 * /api/conversations/messages/{messageId}:
 *   patch:
 *     tags: [Chats]
 *     summary: Edit your message
 *     parameters:
 *       - { name: messageId, in: path, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { type: object, required: [text], properties: { text: { type: string } } } } }
 *     responses:
 *       200: { description: Message }
 *   delete:
 *     tags: [Chats]
 *     summary: Delete your message for everyone (moderators — MU_MESSAGE READ_ALL — any)
 *     parameters:
 *       - { name: messageId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Deleted }
 */
router.patch("/messages/:messageId", writeLimiter, guard(R.MESSAGE, A.UPDATE), validate({ params: idParam("messageId"), body: editMessageSchema }), asyncHandler(async (req, res) => {
  send(res, 200, "Message edited", await conversationService.edit(req, req.params.messageId as string, req.body.text));
}));
router.delete("/messages/:messageId", guard(R.MESSAGE, A.DELETE), validate({ params: idParam("messageId") }), asyncHandler(async (req, res) => {
  await conversationService.remove(req, req.params.messageId as string);
  send(res, 200, "Message deleted");
}));

/**
 * @openapi
 * /api/conversations/{conversationId}:
 *   get:
 *     tags: [Chats]
 *     summary: A chat with all members
 *     parameters:
 *       - { name: conversationId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Chat }
 *   patch:
 *     tags: [Chats]
 *     summary: Rename / change the photo of a group (group admins)
 *     parameters:
 *       - { name: conversationId, in: path, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { type: object, properties: { title: { type: string }, avatarMediaId: { type: string, nullable: true } } } } }
 *     responses:
 *       200: { description: Chat }
 */
router.get("/:conversationId", guard(R.CONVERSATION, A.READ), validate({ params: cid }), asyncHandler(async (req, res) => {
  send(res, 200, "Chat fetched", await conversationService.get(req.actor!, req.params.conversationId as string));
}));
router.patch("/:conversationId", writeLimiter, guard(R.CONVERSATION, A.UPDATE), validate({ params: cid, body: updateGroupSchema }), asyncHandler(async (req, res) => {
  send(res, 200, "Group updated", await conversationService.updateGroup(req.actor!, req.params.conversationId as string, req.body));
}));

/**
 * @openapi
 * /api/conversations/{conversationId}/members:
 *   post:
 *     tags: [Chats]
 *     summary: Add people to a group (group admins)
 *     parameters:
 *       - { name: conversationId, in: path, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { type: object, required: [profileIds], properties: { profileIds: { type: array, items: { type: string } } } } } }
 *     responses:
 *       200: { description: Chat }
 * /api/conversations/{conversationId}/members/{profileId}:
 *   delete:
 *     tags: [Chats]
 *     summary: Remove a member (group admins) or leave (your own profileId)
 *     parameters:
 *       - { name: conversationId, in: path, required: true, schema: { type: string } }
 *       - { name: profileId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Removed }
 */
router.post("/:conversationId/members", writeLimiter, guard(R.CONVERSATION, A.UPDATE), validate({ params: cid, body: addMembersSchema }), asyncHandler(async (req, res) => {
  send(res, 200, "Members added", await conversationService.addMembers(req.actor!, req.params.conversationId as string, req.body.profileIds));
}));
router.delete("/:conversationId/members/:profileId", guard(R.CONVERSATION, A.UPDATE), validate({ params: idParam("conversationId", "profileId") }), asyncHandler(async (req, res) => {
  await conversationService.removeMember(req.actor!, req.params.conversationId as string, req.params.profileId as string);
  send(res, 200, "Member removed");
}));

/**
 * @openapi
 * /api/conversations/{conversationId}/messages:
 *   get:
 *     tags: [Chats]
 *     summary: Messages, newest first
 *     parameters:
 *       - { name: conversationId, in: path, required: true, schema: { type: string } }
 *       - { name: before, in: query, schema: { type: string, format: date-time } }
 *       - { name: limit, in: query, schema: { type: integer, default: 20 } }
 *     responses:
 *       200: { description: "Message[]" }
 *   post:
 *     tags: [Chats]
 *     summary: Send a message (text ≤ 500 and/or one image)
 *     parameters:
 *       - { name: conversationId, in: path, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { $ref: '#/components/schemas/SendMessageDto' } } }
 *     responses:
 *       201: { description: Message }
 * /api/conversations/{conversationId}/read:
 *   post:
 *     tags: [Chats]
 *     summary: Mark read up to a message (default all)
 *     parameters:
 *       - { name: conversationId, in: path, required: true, schema: { type: string } }
 *     requestBody:
 *       content: { application/json: { schema: { type: object, properties: { messageId: { type: string } } } } }
 *     responses:
 *       200: { description: "{ lastReadAt }" }
 * /api/conversations/{conversationId}/mute:
 *   post:
 *     tags: [Chats]
 *     summary: Mute until a time (null = unmute)
 *     parameters:
 *       - { name: conversationId, in: path, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { type: object, properties: { until: { type: string, format: date-time, nullable: true } } } } }
 *     responses:
 *       200: { description: "{ mutedUntil }" }
 */
router.get("/:conversationId/messages", guard(R.MESSAGE, A.READ), validate({ params: cid, query: beforeQuery }), asyncHandler(async (req, res) => {
  const { before, limit } = req.validated!.query;
  send(res, 200, "Messages fetched", await conversationService.messages(req.actor!, req.params.conversationId as string, before, limit));
}));
router.post("/:conversationId/messages", writeLimiter, guard(R.MESSAGE, A.CREATE), validate({ params: cid, body: sendMessageSchema }), asyncHandler(async (req, res) => {
  send(res, 201, "Message sent", await conversationService.send(req.actor!, req.params.conversationId as string, req.body));
}));
router.post("/:conversationId/read", guard(R.MESSAGE, A.READ), validate({ params: cid, body: readSchema }), asyncHandler(async (req, res) => {
  send(res, 200, "Marked read", await conversationService.markRead(req.actor!, req.params.conversationId as string, req.body.messageId));
}));
router.post("/:conversationId/mute", guard(R.CONVERSATION, A.UPDATE), validate({ params: cid, body: muteSchema }), asyncHandler(async (req, res) => {
  send(res, 200, "Mute updated", await conversationService.mute(req.actor!, req.params.conversationId as string, req.body.until));
}));

export default router;
