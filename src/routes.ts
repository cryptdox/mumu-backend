import express, { Router } from "express";
import swaggerUi from "swagger-ui-express";
import { swaggerSpec } from "./utils/swagger";
import iamRedis from "./utils/iam.redis";
import prisma from "./prisma/client";
import profileRoutes, { meRouter } from "./modules/profile/profile.routes";
import connectionRoutes from "./modules/connection/connection.routes";
import mediaRoutes from "./modules/media/media.routes";
import postRoutes from "./modules/post/post.routes";
import conversationRoutes from "./modules/conversation/conversation.routes";
import callRoutes from "./modules/call/call.routes";
import liveRoutes from "./modules/live/live.routes";
import notificationRoutes from "./modules/notification/notification.routes";
import reportRoutes from "./modules/report/report.routes";
import adminRoutes, { categoriesRouter } from "./modules/admin/admin.routes";

const routers: Router = express.Router();

/**
 * @openapi
 * tags:
 *   - name: Root
 *     description: Health
 */
routers.get("/", (req, res) => {
  res.send(req.t("WELCOME"));
});

/**
 * @openapi
 * /health/check:
 *   get:
 *     tags: [Root]
 *     security: []
 *     summary: App, IAM Redis and database status
 *     responses:
 *       200: { description: Health }
 */
routers.get("/health/check", async (_req, res) => {
  const [iamRedisStatus, dbStatus] = await Promise.all([
    iamRedis.ping().then(() => "ok", () => "failed"),
    prisma.$queryRaw`SELECT 1`.then(() => "ok", () => "failed"),
  ]);
  res.json({ success: true, status: 200, message: "App health check", services: { app: "ok", iamRedis: iamRedisStatus, db: dbStatus }, time: new Date().toISOString() });
});

routers.use("/api/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec, { swaggerOptions: { persistAuthorization: true } }));
routers.use("/api/me", meRouter);
routers.use("/api/profiles", profileRoutes);
routers.use("/api/connections", connectionRoutes);
routers.use("/api/media", mediaRoutes);
routers.use("/api/posts", postRoutes);
routers.use("/api/conversations", conversationRoutes);
routers.use("/api/calls", callRoutes);
routers.use("/api/live", liveRoutes);
routers.use("/api/notifications", notificationRoutes);
routers.use("/api/reports", reportRoutes);
routers.use("/api/categories", categoriesRouter);
routers.use("/api/admin", adminRoutes);

export default routers;
