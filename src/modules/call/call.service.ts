import type { CallStatus, CallType } from "@prisma/client";
import prisma from "../../prisma/client";
import { BadRequest, Forbidden, NotFound } from "../../utils/errors";
import { CALL_RING_SECONDS } from "../../utils/consts";
import { issueRtcToken } from "../../utils/rtc";
import logger from "../../utils/logger";
import type { Actor } from "../../middlewares/actor.middleware";
import { emitToProfiles } from "../../realtime/socket";
import { profileCardSelect, toProfile } from "../profile/profile.view";
import { isBlocked } from "../connection/visibility";
import { notify } from "../notification/notification.service";
import { activeMemberIds, messageInclude, messageView, postMessage, requireMember } from "../conversation/conversation.service";

const ACTIVE: CallStatus[] = ["RINGING", "ONGOING"];
/** One RTC channel per chat, reused by every call in it. */
const channelFor = (conversationId: string) => `c_${conversationId}`;

const callInclude = { startedBy: { select: profileCardSelect }, conversation: { select: { conversationId: true, type: true, title: true } } } as const;

async function callView(callId: string) {
  const call = await prisma.call.findUniqueOrThrow({ where: { callId }, include: callInclude });
  return { ...call, startedBy: toProfile(call.startedBy) };
}

/** Push the new state to everyone in the chat, and refresh the call bubble. */
async function broadcast(callId: string) {
  const view = await callView(callId);
  const members = await activeMemberIds(view.conversationId);
  emitToProfiles(members, "call:updated", view);
  const bubble = await prisma.message.findFirst({ where: { callId }, include: messageInclude });
  if (bubble) emitToProfiles(members, "message:updated", messageView(bubble));
  return view;
}

async function finish(callId: string, status: "ENDED" | "MISSED") {
  const call = await prisma.call.update({ where: { callId }, data: { status, endedAt: new Date() } });
  if (status === "MISSED") {
    const others = (await activeMemberIds(call.conversationId)).filter((id) => id !== call.startedById);
    await notify(others, "MISSED_CALL", call.startedById, call.conversationId);
  }
  return broadcast(callId);
}

class CallService {
  /** Ring everyone in the chat. If a call is already going, you get that one instead. */
  async start(actor: Actor, conversationId: string, type: CallType) {
    const member = await requireMember(actor, conversationId);
    const members = await activeMemberIds(conversationId);
    if (member.conversation.type === "DIRECT") {
      const other = members.find((id) => id !== actor.profileId);
      if (!other) throw BadRequest("Nobody to call");
      if (await isBlocked(actor.profileId, other)) throw Forbidden("You can't call this profile");
    }
    const existing = await prisma.call.findFirst({ where: { conversationId, status: { in: ACTIVE } }, orderBy: { startedAt: "desc" } });
    if (existing) return this.join(actor, existing.callId);

    // Get the token first, so a plan / quota refusal doesn't leave a ringing call behind.
    const rtc = await issueRtcToken(actor.profileId, channelFor(conversationId), "PUBLISHER");
    const call = await prisma.call.create({ data: { conversationId, startedById: actor.profileId, type, rtcChannel: channelFor(conversationId) } });
    await postMessage(conversationId, actor.profileId, { kind: "CALL", callId: call.callId });
    const view = await callView(call.callId);
    // `to` = which of the callee's profiles is being called (they may manage several).
    for (const id of members.filter((m) => m !== actor.profileId)) emitToProfiles([id], "call:ring", { ...view, to: id });
    return { call: view, rtc };
  }

  async join(actor: Actor, callId: string) {
    const call = await prisma.call.findUnique({ where: { callId } });
    if (!call) throw NotFound("Call not found");
    await requireMember(actor, call.conversationId);
    if (!ACTIVE.includes(call.status)) throw BadRequest("This call has ended");
    const rtc = await issueRtcToken(actor.profileId, call.rtcChannel, "PUBLISHER");
    if (call.status === "RINGING" && actor.profileId !== call.startedById) {
      await prisma.call.update({ where: { callId }, data: { status: "ONGOING", answeredAt: new Date() } });
      return { call: await broadcast(callId), rtc };
    }
    return { call: await callView(callId), rtc };
  }

  /** Decline: a 1:1 call ends; in a group only the caller is told. */
  async decline(actor: Actor, callId: string) {
    const call = await prisma.call.findUnique({ where: { callId }, include: { conversation: { select: { type: true } } } });
    if (!call) throw NotFound("Call not found");
    await requireMember(actor, call.conversationId);
    if (call.status !== "RINGING") return callView(callId);
    if (call.conversation.type === "DIRECT") return finish(callId, "ENDED");
    emitToProfiles([call.startedById], "call:declined", { callId, profileId: actor.profileId });
    return callView(callId);
  }

  /**
   * Hang up for everyone. 1:1: either side. Group: the caller or a group admin
   * (others just leave the room in the app). Unanswered calls end as MISSED.
   */
  async end(actor: Actor, callId: string) {
    const call = await prisma.call.findUnique({ where: { callId }, include: { conversation: { select: { type: true } } } });
    if (!call) throw NotFound("Call not found");
    const member = await requireMember(actor, call.conversationId);
    if (!ACTIVE.includes(call.status)) return callView(callId);
    if (call.conversation.type === "GROUP" && call.startedById !== actor.profileId && member.role !== "ADMIN") {
      throw Forbidden("Only the caller or a group admin can end a group call — just leave it");
    }
    return finish(callId, call.status === "RINGING" ? "MISSED" : "ENDED");
  }

  async get(actor: Actor, callId: string) {
    const call = await prisma.call.findUnique({ where: { callId } });
    if (!call) throw NotFound("Call not found");
    await requireMember(actor, call.conversationId);
    return callView(callId);
  }

  /** Calls you could (re)join right now — e.g. after a page reload. */
  async active(actor: Actor) {
    const calls = await prisma.call.findMany({
      where: { status: { in: ACTIVE }, conversation: { members: { some: { profileId: actor.profileId, leftAt: null } } } },
      include: callInclude,
      orderBy: { startedAt: "desc" },
    });
    return calls.map((c) => ({ ...c, startedBy: toProfile(c.startedBy) }));
  }
}

/** Unanswered calls become MISSED; calls nobody ended close after 4 hours. */
export async function sweepCalls() {
  const ringCutoff = new Date(Date.now() - CALL_RING_SECONDS * 1000);
  const stale = await prisma.call.findMany({
    where: { OR: [{ status: "RINGING", startedAt: { lt: ringCutoff } }, { status: "ONGOING", startedAt: { lt: new Date(Date.now() - 4 * 3600_000) } }] },
    select: { callId: true, status: true },
    take: 100,
  });
  for (const c of stale) await finish(c.callId, c.status === "RINGING" ? "MISSED" : "ENDED").catch((err) => logger.warn(`[Calls] sweep ${c.callId}: ${err?.message ?? err}`));
}

let timer: NodeJS.Timeout | null = null;
export function startCallSweeper() {
  timer = setInterval(() => void sweepCalls().catch(() => {}), 10_000);
  timer.unref();
}
export function stopCallSweeper() {
  if (timer) clearInterval(timer);
  timer = null;
}

export default new CallService();
