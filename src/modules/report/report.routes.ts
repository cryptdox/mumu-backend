import express, { Router } from "express";
import { z } from "zod";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { actorMiddleware } from "../../middlewares/actor.middleware";
import { writeLimiter } from "../../middlewares/rateLimit.middleware";
import { asyncHandler } from "../../utils/errors";
import { guard, R, A } from "../../utils/guard";
import { idParam, send, validate } from "../../utils/http";
import reportService from "./report.service";

const router: Router = express.Router();
router.use(authMiddleware, actorMiddleware);

/**
 * @openapi
 * tags:
 *   - name: Moderation
 *     description: Reports. Anyone reports; moderators (MU_MU_REPORT READ_ALL / UPDATE — MANAGER and ADMIN roles) review.
 *
 * /api/reports:
 *   post:
 *     tags: [Moderation]
 *     summary: Report a profile, post, comment, message or live stream
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, required: [targetType, targetId, reason], properties: { targetType: { type: string, enum: [PROFILE, POST, COMMENT, MESSAGE, LIVE] }, targetId: { type: string }, reason: { type: string, maxLength: 500 } } }
 *     responses:
 *       201: { description: Reported }
 *   get:
 *     tags: [Moderation]
 *     summary: Review queue (MU_REPORT READ_ALL)
 *     parameters:
 *       - { name: status, in: query, schema: { type: string, enum: [OPEN, ACTIONED, DISMISSED], default: OPEN } }
 *       - { name: offset, in: query, schema: { type: integer, default: 0 } }
 *       - { name: limit, in: query, schema: { type: integer, default: 30 } }
 *     responses:
 *       200: { description: "{ items, total, offset, limit }" }
 * /api/reports/{reportId}:
 *   patch:
 *     tags: [Moderation]
 *     summary: Resolve — ACTIONED takes the content down, DISMISSED keeps it (MU_REPORT UPDATE)
 *     parameters:
 *       - { name: reportId, in: path, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { type: object, required: [status], properties: { status: { type: string, enum: [ACTIONED, DISMISSED] } } } } }
 *     responses:
 *       200: { description: Report }
 */
router.post("/", writeLimiter, guard(R.REPORT, A.CREATE), validate({ body: z.object({ targetType: z.enum(["PROFILE", "POST", "COMMENT", "MESSAGE", "LIVE"]), targetId: z.string().min(1).max(64), reason: z.string().trim().min(1).max(500) }) }), asyncHandler(async (req, res) => {
  send(res, 201, "Thanks — we'll take a look", await reportService.create(req.actor!, req.body.targetType, req.body.targetId, req.body.reason));
}));
router.get("/", guard(R.REPORT, A.READ_ALL), validate({ query: z.object({ status: z.enum(["OPEN", "ACTIONED", "DISMISSED"]).default("OPEN"), offset: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(100).default(30) }) }), asyncHandler(async (req, res) => {
  const { status, offset, limit } = req.validated!.query;
  send(res, 200, "Reports fetched", await reportService.list(status, offset, limit));
}));
router.patch("/:reportId", guard(R.REPORT, A.UPDATE), validate({ params: idParam("reportId"), body: z.object({ status: z.enum(["ACTIONED", "DISMISSED"]) }) }), asyncHandler(async (req, res) => {
  send(res, 200, "Report resolved", await reportService.resolve(req.user!.userId, req.params.reportId as string, req.body.status));
}));

export default router;
