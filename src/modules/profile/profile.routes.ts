import express, { Router } from "express";
import { authMiddleware } from "../../middlewares/auth.middleware";
import { actorMiddleware } from "../../middlewares/actor.middleware";
import { writeLimiter } from "../../middlewares/rateLimit.middleware";
import { asyncHandler } from "../../utils/errors";
import { guard, R, A } from "../../utils/guard";
import { idParam, send, validate } from "../../utils/http";
import profileService from "./profile.service";
import deviceService from "../device/device.service";
import { deviceMiddleware } from "../../middlewares/device.middleware";
import { deviceIdOf } from "../device/device.service";
import { isAppAdmin } from "../../utils/permissions";
import { addMemberSchema, createBusinessSchema, searchQuery, updateProfileSchema } from "./profile.dto";

const router: Router = express.Router();
router.use(authMiddleware, actorMiddleware);

/**
 * @openapi
 * tags:
 *   - name: Profile
 *     description: Personal and business profiles. Send `x-profile-id` to act as one of your business profiles.
 *
 * /api/me:
 *   get:
 *     tags: [Profile]
 *     summary: Your account and every profile you can switch to (creates your personal profile on first call)
 *     responses:
 *       200: { description: "{ userId, email, profiles: [Profile & { role }] }" }
 */
export const meRouter: Router = express.Router();
meRouter.get("/", authMiddleware, deviceMiddleware, asyncHandler(async (req, res) => {
  send(res, 200, "Account fetched", await profileService.me(req.user!.userId, req.user!.email, await isAppAdmin(req)));
}));

/**
 * @openapi
 * /api/me/devices:
 *   get:
 *     tags: [Profile]
 *     summary: Devices signed in to your account (max 3). Works even when this device is over the limit.
 *     parameters:
 *       - { name: x-device-id, in: header, schema: { type: string }, description: This device (marked current) }
 *     responses:
 *       200: { description: "{ max, devices: [{ deviceId, label, signedInAt, lastSeenAt, current }] }" }
 * /api/me/devices/{deviceId}:
 *   delete:
 *     tags: [Profile]
 *     summary: Sign a device out (this one, or remotely — it's signed out live over its socket)
 *     parameters:
 *       - { name: deviceId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Signed out }
 */
/**
 * @openapi
 * /api/me:
 *   delete:
 *     tags: [Profile]
 *     summary: Delete your MuMu account — all profiles you own and their content, your memberships and devices. The Cryptdox sign-in (IAM) is not deleted.
 *     responses:
 *       200: { description: "{ deletedProfiles }" }
 */
meRouter.delete("/", authMiddleware, asyncHandler(async (req, res) => {
  send(res, 200, "Your MuMu account was deleted", await profileService.deleteAccount(req.user!.userId));
}));

meRouter.get("/devices", authMiddleware, asyncHandler(async (req, res) => {
  send(res, 200, "Devices fetched", await deviceService.list(req.user!.userId, deviceIdOf(req)));
}));
meRouter.delete("/devices/:deviceId", authMiddleware, validate({ params: idParam("deviceId") }), asyncHandler(async (req, res) => {
  await deviceService.signOut(req.user!.userId, req.params.deviceId as string);
  send(res, 200, "Device signed out");
}));

/**
 * @openapi
 * /api/profiles:
 *   post:
 *     tags: [Profile]
 *     summary: Create a business profile (you become its OWNER)
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { $ref: '#/components/schemas/CreateBusinessProfileDto' } } }
 *     responses:
 *       201: { description: Created }
 *       409: { description: Handle taken }
 */
router.post("/", writeLimiter, guard(R.PROFILE, A.CREATE), validate({ body: createBusinessSchema }), asyncHandler(async (req, res) => {
  send(res, 201, "Business profile created", await profileService.createBusiness(req.actor!, req.body));
}));

/**
 * @openapi
 * /api/profiles/search:
 *   get:
 *     tags: [Profile]
 *     summary: Find people and businesses by handle or name
 *     parameters:
 *       - { name: q, in: query, required: true, schema: { type: string } }
 *       - { name: kind, in: query, schema: { type: string, enum: [PERSONAL, BUSINESS] } }
 *       - { name: limit, in: query, schema: { type: integer, default: 20 } }
 *     responses:
 *       200: { description: Profile cards }
 */
router.get("/search", guard(R.PROFILE, A.READ), validate({ query: searchQuery }), asyncHandler(async (req, res) => {
  const { q, kind, limit } = req.validated!.query;
  send(res, 200, "Profiles found", await profileService.search(req.actor!, q, kind, limit));
}));

/**
 * @openapi
 * /api/profiles/{idOrHandle}:
 *   get:
 *     tags: [Profile]
 *     summary: A profile with counts and your relationship to it
 *     parameters:
 *       - { name: idOrHandle, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Profile }
 *       404: { description: Not found }
 *   patch:
 *     tags: [Profile]
 *     summary: Edit a profile you own or administer
 *     parameters:
 *       - { name: idOrHandle, in: path, required: true, schema: { type: string }, description: profileId }
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { $ref: '#/components/schemas/UpdateProfileDto' } } }
 *     responses:
 *       200: { description: Updated }
 *   delete:
 *     tags: [Profile]
 *     summary: Delete a business profile you own
 *     parameters:
 *       - { name: idOrHandle, in: path, required: true, schema: { type: string }, description: profileId }
 *     responses:
 *       200: { description: Deleted }
 */
router.get("/:idOrHandle", guard(R.PROFILE, A.READ), validate({ params: idParam("idOrHandle") }), asyncHandler(async (req, res) => {
  send(res, 200, "Profile fetched", await profileService.get(req.actor!, req.params.idOrHandle as string));
}));
router.patch("/:idOrHandle", writeLimiter, guard(R.PROFILE, A.UPDATE), validate({ params: idParam("idOrHandle"), body: updateProfileSchema }), asyncHandler(async (req, res) => {
  send(res, 200, "Profile updated", await profileService.update(req.actor!, req.params.idOrHandle as string, req.body));
}));
router.delete("/:idOrHandle", guard(R.PROFILE, A.DELETE), validate({ params: idParam("idOrHandle") }), asyncHandler(async (req, res) => {
  await profileService.remove(req.actor!, req.params.idOrHandle as string);
  send(res, 200, "Profile deleted");
}));

/**
 * @openapi
 * /api/profiles/{profileId}/members:
 *   get:
 *     tags: [Profile]
 *     summary: People who can act as this business profile (owner / admins)
 *     parameters:
 *       - { name: profileId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Members }
 *   post:
 *     tags: [Profile]
 *     summary: Add or change a member by their personal handle
 *     parameters:
 *       - { name: profileId, in: path, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, required: [handle, role], properties: { handle: { type: string }, role: { type: string, enum: [ADMIN, EDITOR] } } }
 *     responses:
 *       200: { description: Saved }
 * /api/profiles/{profileId}/members/{userId}:
 *   delete:
 *     tags: [Profile]
 *     summary: Remove a member (or leave yourself)
 *     parameters:
 *       - { name: profileId, in: path, required: true, schema: { type: string } }
 *       - { name: userId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Removed }
 */
router.get("/:profileId/members", guard(R.PROFILE, A.READ), validate({ params: idParam("profileId") }), asyncHandler(async (req, res) => {
  send(res, 200, "Members fetched", await profileService.members(req.actor!, req.params.profileId as string));
}));
router.post("/:profileId/members", writeLimiter, guard(R.PROFILE, A.UPDATE), validate({ params: idParam("profileId"), body: addMemberSchema }), asyncHandler(async (req, res) => {
  await profileService.addMember(req.actor!, req.params.profileId as string, req.body.handle, req.body.role);
  send(res, 200, "Member saved");
}));
router.delete("/:profileId/members/:userId", guard(R.PROFILE, A.UPDATE), validate({ params: idParam("profileId", "userId") }), asyncHandler(async (req, res) => {
  await profileService.removeMember(req.actor!, req.params.profileId as string, req.params.userId as string);
  send(res, 200, "Member removed");
}));

export default router;
