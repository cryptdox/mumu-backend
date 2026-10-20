import 'dotenv/config'
import http from "http";
import app from "./src/app";
import bootstrapSystem from "./src/utils/bootstrap";
import { ConnectIamRedis } from "./src/utils/iam.redis";
import { attachRealtime, closeRealtime } from "./src/realtime/socket";
import { initStorage } from "./src/utils/storage";
import { startCallSweeper, stopCallSweeper } from "./src/modules/call/call.service";
import { sweepStreams } from "./src/modules/live/live.service";
import prisma from "./src/prisma/client";
import logger from "./src/utils/logger";

const port = Number(process.env.PORT ?? 4100);
const server = http.createServer(app);
let streamSweeper: NodeJS.Timeout | undefined;

async function startServer() {
  await bootstrapSystem();
  await ConnectIamRedis();
  await initStorage();
  attachRealtime(server);
  startCallSweeper();
  streamSweeper = setInterval(() => void sweepStreams().catch(() => {}), 10 * 60_000);
  streamSweeper.unref();

  server.listen(port, () => {
    logger.info(`🚀 MuMu API on http://localhost:${port} — docs at /api/docs, realtime at /socket.io`);
  });
}

async function shutdown(signal: string) {
  logger.info(`${signal} received — shutting down`);
  stopCallSweeper();
  if (streamSweeper) clearInterval(streamSweeper);
  await closeRealtime();
  server.close();
  await prisma.$disconnect().catch(() => {});
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (reason: any) => logger.error(`Unhandled rejection: ${reason?.stack ?? reason}`));

startServer().catch((err) => {
  logger.error(`Startup failed: ${err?.stack ?? err}`);
  process.exit(1);
});
