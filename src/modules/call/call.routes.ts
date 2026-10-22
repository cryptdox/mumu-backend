import express, { Router } from "express";
import { z } from "zod";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { actorMiddleware, type Actor } from "../../middlewares/actor.middleware";
import { verifyDeclineSig } from "../../utils/push";
import { writeLimiter } from "../../middlewares/rateLimit.middleware";
import { asyncHandler, Forbidden } from "../../utils/errors";
import { guard, R, A } from "../../utils/guard";
import { idParam, send, validate } from "../../utils/http";
import callService from "./call.service";

const router: Router = express.Router();
const callId = validate({ params: idParam("callId") });

/**
 * @openapi
 * /api/calls/{callId}/push-decline:
 *   post:
 *     tags: [Calls]
 *     summary: Decline from the phone's call notification (no session there — signed by the push)
 *     parameters:
 *       - { name: callId, in: path, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, required: [profileId, sig], properties: { profileId: { type: string }, sig: { type: string } } }
 *     responses:
 *       200: { description: Call }
 *       403: { description: Bad signature }
 */
router.post("/:callId/push-decline", writeLimiter, callId, validate({ body: z.object({ profileId: z.string().min(1).max(64), sig: z.string().min(10).max(128) }) }), asyncHandler(async (req, res) => {
  const id = req.params.callId as string;
  if (!verifyDeclineSig(id, req.body.profileId, req.body.sig)) throw Forbidden("Invalid signature");
  const actor = { userId: "", profileId: req.body.profileId, kind: "BUSINESS", role: "OWNER" } as Actor;
  send(res, 200, "Declined", await callService.decline(actor, id));
}));

router.use(authMiddleware, actorMiddleware);

/**
 * @openapi
 * tags:
 *   - name: Calls
 *     description: |
 *       Audio / video calls in a chat, over MUMU RTC. Responses with `rtc` carry
 *       `{ apiUrl, token }` for the mumu-rtc SDK: `<MumuRoom apiUrl token>` or `new Room({ apiUrl }).join({ token })`.
 *       Socket events: call:ring, call:updated, call:declined.
 *
 * /api/calls:
 *   post:
 *     tags: [Calls]
 *     summary: Start a call in a chat (rings everyone; joins the running call if there is one)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, required: [conversationId], properties: { conversationId: { type: string }, type: { type: string, enum: [AUDIO, VIDEO], default: VIDEO } } }
 *     responses:
 *       201: { description: "{ call, rtc }" }
 *       402: { description: The calling plan's limit is reached }
 * /api/calls/active:
 *   get:
 *     tags: [Calls]
 *     summary: Calls going on in your chats right now
 *     responses:
 *       200: { description: Calls }
 * /api/calls/{callId}:
 *   get:
 *     tags: [Calls]
 *     summary: A call
 *     parameters:
 *       - { name: callId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Call }
 * /api/calls/{callId}/join:
 *   post:
 *     tags: [Calls]
 *     summary: Answer / join a call
 *     parameters:
 *       - { name: callId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: "{ call, rtc }" }
 * /api/calls/{callId}/decline:
 *   post:
 *     tags: [Calls]
 *     summary: Decline a ringing call
 *     parameters:
 *       - { name: callId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Call }
 * /api/calls/{callId}/end:
 *   post:
 *     tags: [Calls]
 *     summary: Hang up for everyone (1:1 either side; group caller or admin)
 *     parameters:
 *       - { name: callId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Call }
 */
router.post("/", writeLimiter, guard(R.CALL, A.CREATE), validate({ body: z.object({ conversationId: z.string().min(1).max(64), type: z.enum(["AUDIO", "VIDEO"]).default("VIDEO") }) }), asyncHandler(async (req, res) => {
  send(res, 201, "Calling", await callService.start(req.actor!, req.body.conversationId, req.body.type));
}));
router.get("/active", guard(R.CALL, A.READ), asyncHandler(async (req, res) => {
  send(res, 200, "Active calls", await callService.active(req.actor!));
}));
router.get("/:callId", guard(R.CALL, A.READ), callId, asyncHandler(async (req, res) => {
  send(res, 200, "Call fetched", await callService.get(req.actor!, req.params.callId as string));
}));
router.post("/:callId/join", writeLimiter, guard(R.CALL, A.UPDATE), callId, asyncHandler(async (req, res) => {
  send(res, 200, "Joined", await callService.join(req.actor!, req.params.callId as string));
}));
router.post("/:callId/decline", guard(R.CALL, A.UPDATE), callId, asyncHandler(async (req, res) => {
  send(res, 200, "Declined", await callService.decline(req.actor!, req.params.callId as string));
}));
router.post("/:callId/end", guard(R.CALL, A.UPDATE), callId, asyncHandler(async (req, res) => {
  send(res, 200, "Call ended", await callService.end(req.actor!, req.params.callId as string));
}));

export default router;
