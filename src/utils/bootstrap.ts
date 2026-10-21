import prisma from "../prisma/client";
import { RESET } from "./consts";
import logger from "./logger";

async function bootstrapSystem() {
  if (RESET) await wipeAllTables();
  logger.info("🚀 System bootstrap complete");
}

const TABLES = [
  "Report", "Notification", "LiveStream", "Call", "Message", "ConversationMember", "Conversation",
  "Reaction", "Comment", "Post", "Media", "Block", "Follow", "Friendship", "ProfileMember", "Profile", "Device",
  "Category", "AppSetting",
];

/** Empty every table (tests and RESET_DB=true in development only). */
export async function wipeAllTables() {
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE;`);
  logger.info("✅ All tables wiped");
}

export default bootstrapSystem;
