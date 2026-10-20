import express, { Router } from "express";
import { z } from "zod";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { actorMiddleware } from "../../middlewares/actor.middleware";
import { asyncHandler } from "../../utils/errors";
import { guard, R, A } from "../../utils/guard";
import { send, validate } from "../../utils/http";
import notificationService from "./notification.service";

const router: Router = express.Router();
router.use(authMiddleware, actorMiddleware);

/**
 * @openapi
 * tags:
 *   - name: Notification
 *     description: Notifications of the active profile (also pushed live as socket event "notification")
 *
 * /api/notifications:
 *   get:
 *     tags: [Notification]
 *     summary: Newest first, with the unread count
 *     parameters:
 *       - { name: before, in: query, schema: { type: string, format: date-time } }
 *       - { name: limit, in: query, schema: { type: integer, default: 30 } }
 *     responses:
 *       200: { description: "{ items, unread }" }
 * /api/notifications/read:
 *   post:
 *     tags: [Notification]
 *     summary: Mark some (ids) or all notifications read
 *     requestBody:
 *       content:
 *         application/json:
 *           schema: { type: object, properties: { ids: { type: array, items: { type: string } } } }
 *     responses:
 *       200: { description: "{ marked }" }
 */
router.get("/", guard(R.NOTIFICATION, A.READ), validate({ query: z.object({ before: z.coerce.date().optional(), limit: z.coerce.number().int().min(1).max(100).default(30) }) }), asyncHandler(async (req, res) => {
  const { before, limit } = req.validated!.query;
  send(res, 200, "Notifications fetched", await notificationService.list(req.actor!.profileId, before, limit));
}));
router.post("/read", guard(R.NOTIFICATION, A.UPDATE), validate({ body: z.object({ ids: z.array(z.string()).max(200).optional() }) }), asyncHandler(async (req, res) => {
  send(res, 200, "Marked read", await notificationService.markRead(req.actor!.profileId, req.body.ids));
}));

export default router;
