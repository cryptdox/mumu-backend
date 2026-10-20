import express, { Router } from "express";
import { z } from "zod";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { actorMiddleware } from "../../middlewares/actor.middleware";
import { writeLimiter } from "../../middlewares/rateLimit.middleware";
import { asyncHandler } from "../../utils/errors";
import { guard, R, A } from "../../utils/guard";
import { idParam, send, validate } from "../../utils/http";
import { audienceSchema } from "../../utils/content";
import liveService from "./live.service";

const router: Router = express.Router();
router.use(authMiddleware, actorMiddleware);
const sid = validate({ params: idParam("liveStreamId") });
const title = z.string().trim().min(1).max(100);

/**
 * @openapi
 * tags:
 *   - name: Live
 *     description: |
 *       Live streams over MUMU RTC (no recording). The host publishes (HOST token), viewers
 *       receive (AUDIENCE token). Audience PUBLIC / CONNECTIONS (friends or followers) / ONLY_ME.
 *       Live chat uses the SDK's room chat. Socket: send "live:watch" { liveStreamId } to get "live:updated".
 *
 * /api/live:
 *   get:
 *     tags: [Live]
 *     summary: Streams live now that you may watch
 *     responses:
 *       200: { description: Streams }
 *   post:
 *     tags: [Live]
 *     summary: Go live as the active profile (also posts to the feed and notifies friends / followers)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, required: [title], properties: { title: { type: string }, audience: { type: string, enum: [PUBLIC, CONNECTIONS, ONLY_ME], default: PUBLIC } } }
 *     responses:
 *       201: { description: "{ stream, rtc }" }
 *       409: { description: Already live }
 * /api/live/{liveStreamId}:
 *   get:
 *     tags: [Live]
 *     summary: A stream
 *     parameters:
 *       - { name: liveStreamId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Stream }
 *   patch:
 *     tags: [Live]
 *     summary: Change title / audience (host)
 *     parameters:
 *       - { name: liveStreamId, in: path, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { type: object, properties: { title: { type: string }, audience: { type: string, enum: [PUBLIC, CONNECTIONS, ONLY_ME] } } } } }
 *     responses:
 *       200: { description: Stream }
 * /api/live/{liveStreamId}/watch:
 *   post:
 *     tags: [Live]
 *     summary: Get a token to watch (host gets a HOST token to rejoin)
 *     parameters:
 *       - { name: liveStreamId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: "{ stream, rtc }" }
 * /api/live/{liveStreamId}/leave:
 *   post:
 *     tags: [Live]
 *     summary: Stop watching (viewer count)
 *     parameters:
 *       - { name: liveStreamId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Stream }
 * /api/live/{liveStreamId}/end:
 *   post:
 *     tags: [Live]
 *     summary: End the stream (host, or a moderator)
 *     parameters:
 *       - { name: liveStreamId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Stream }
 */
router.get("/", guard(R.LIVE, A.READ), asyncHandler(async (req, res) => {
  send(res, 200, "Live streams", await liveService.list(req.actor!));
}));
router.post("/", writeLimiter, guard(R.LIVE, A.CREATE), validate({ body: z.object({ title, audience: audienceSchema.default("PUBLIC") }) }), asyncHandler(async (req, res) => {
  send(res, 201, "You're live", await liveService.start(req.actor!, req.body.title, req.body.audience));
}));
router.get("/:liveStreamId", guard(R.LIVE, A.READ), sid, asyncHandler(async (req, res) => {
  send(res, 200, "Stream fetched", await liveService.get(req.actor!, req.params.liveStreamId as string));
}));
router.patch("/:liveStreamId", guard(R.LIVE, A.UPDATE), validate({ params: idParam("liveStreamId"), body: z.object({ title, audience: audienceSchema }).partial().refine((v) => Object.keys(v).length > 0, "Nothing to update") }), asyncHandler(async (req, res) => {
  send(res, 200, "Stream updated", await liveService.update(req.actor!, req.params.liveStreamId as string, req.body));
}));
router.post("/:liveStreamId/watch", writeLimiter, guard(R.LIVE, A.READ), sid, asyncHandler(async (req, res) => {
  send(res, 200, "Watching", await liveService.watch(req.actor!, req.params.liveStreamId as string));
}));
router.post("/:liveStreamId/leave", guard(R.LIVE, A.READ), sid, asyncHandler(async (req, res) => {
  send(res, 200, "Left", await liveService.leave(req.actor!, req.params.liveStreamId as string));
}));
router.post("/:liveStreamId/end", guard(R.LIVE, A.UPDATE), sid, asyncHandler(async (req, res) => {
  send(res, 200, "Stream ended", await liveService.end(req, req.params.liveStreamId as string));
}));

export default router;
