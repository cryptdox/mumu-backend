import prisma from "../../prisma/client";
import { BadRequest, Conflict, NotFound } from "../../utils/errors";
import { profileSelect, toProfile } from "../profile/profile.view";
import { endStream } from "../live/live.service";
import { getSettings, updateSettings, type Settings } from "./settings";

class AdminService {
  async overview() {
    const since = new Date(Date.now() - 24 * 3600_000);
    const [providers, consumers, suspended, posts, posts24h, messages24h, liveNow, openReports, categories, devices] = await Promise.all([
      prisma.profile.count({ where: { kind: "BUSINESS", deletedAt: null } }),
      prisma.profile.count({ where: { kind: "PERSONAL", deletedAt: null } }),
      prisma.profile.count({ where: { suspendedAt: { not: null }, deletedAt: null } }),
      prisma.post.count({ where: { deletedAt: null } }),
      prisma.post.count({ where: { deletedAt: null, createdAt: { gt: since } } }),
      prisma.message.count({ where: { createdAt: { gt: since } } }),
      prisma.liveStream.count({ where: { status: "LIVE" } }),
      prisma.report.count({ where: { status: "OPEN" } }),
      prisma.category.count({ where: { isActive: true } }),
      prisma.device.count({ where: { revokedAt: null, lastSeenAt: { gt: since } } }),
    ]);
    return { providers, consumers, suspended, posts, posts24h, messages24h, liveNow, openReports, categories, activeDevices24h: devices };
  }

  // ── Categories ─────────────────────────────────────────────────────────────
  listCategories(all: boolean) {
    return prisma.category.findMany({
      where: all ? {} : { isActive: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { categoryId: true, name: true, sortOrder: true, isActive: true, ...(all && { _count: { select: { profiles: true } } }) },
    });
  }

  async createCategory(name: string, sortOrder?: number) {
    if (await prisma.category.findUnique({ where: { name } })) throw Conflict("That category already exists");
    const max = await prisma.category.aggregate({ _max: { sortOrder: true } });
    return prisma.category.create({ data: { name, sortOrder: sortOrder ?? (max._max.sortOrder ?? 0) + 1 } });
  }

  async updateCategory(categoryId: string, dto: { name?: string; sortOrder?: number; isActive?: boolean }) {
    if (!(await prisma.category.findUnique({ where: { categoryId } }))) throw NotFound("Category not found");
    return prisma.category.update({ where: { categoryId }, data: dto });
  }

  /** Deleting a category in use is refused — deactivate it instead (profiles keep it). */
  async deleteCategory(categoryId: string) {
    const inUse = await prisma.profile.count({ where: { categoryId } });
    if (inUse) throw BadRequest(`${inUse} profile(s) use this category — turn it off instead`);
    await prisma.category.delete({ where: { categoryId } });
  }

  // ── Settings ───────────────────────────────────────────────────────────────
  settings() {
    return getSettings();
  }
  saveSettings(patch: Partial<Settings>, userId: string) {
    return updateSettings(patch, userId);
  }

  // ── Profiles ───────────────────────────────────────────────────────────────
  async profiles(q: { q?: string; kind?: "PERSONAL" | "BUSINESS"; status?: "active" | "suspended"; offset: number; limit: number }) {
    const where = {
      deletedAt: null,
      ...(q.kind && { kind: q.kind }),
      ...(q.status === "suspended" ? { suspendedAt: { not: null } } : q.status === "active" ? { suspendedAt: null } : {}),
      ...(q.q && { OR: [{ handle: { contains: q.q.toLowerCase() } }, { displayName: { contains: q.q, mode: "insensitive" as const } }] }),
    };
    const [items, total] = await Promise.all([
      prisma.profile.findMany({
        where,
        select: { ...profileSelect, suspendedAt: true, _count: { select: { members: true, posts: true, followers: true } } },
        orderBy: { createdAt: "desc" },
        skip: q.offset,
        take: q.limit,
      }),
      prisma.profile.count({ where }),
    ]);
    return { items: items.map(toProfile), total, offset: q.offset, limit: q.limit };
  }

  async moderateProfile(profileId: string, dto: { isVerified?: boolean; suspended?: boolean }) {
    const p = await prisma.profile.findFirst({ where: { profileId, deletedAt: null } });
    if (!p) throw NotFound("Profile not found");
    const updated = await prisma.profile.update({
      where: { profileId },
      data: {
        ...(dto.isVerified !== undefined && { isVerified: dto.isVerified }),
        ...(dto.suspended !== undefined && { suspendedAt: dto.suspended ? new Date() : null }),
      },
      select: { ...profileSelect, suspendedAt: true },
    });
    // A suspended profile's live ends.
    if (dto.suspended) {
      const live = await prisma.liveStream.findMany({ where: { hostProfileId: profileId, status: "LIVE" }, select: { liveStreamId: true } });
      for (const l of live) await endStream(l.liveStreamId);
    }
    return toProfile(updated);
  }

  // ── Lives ──────────────────────────────────────────────────────────────────
  async lives() {
    const rows = await prisma.liveStream.findMany({
      where: { status: "LIVE" },
      include: { host: { select: { profileId: true, handle: true, displayName: true, kind: true, isVerified: true, avatar: { select: { url: true } } } } },
      orderBy: { startedAt: "desc" },
    });
    return rows.map(({ host, rtcChannel: _c, hostDeviceId: _d, ...l }) => ({ ...l, host: toProfile(host) }));
  }
  endLive(liveStreamId: string) {
    return endStream(liveStreamId);
  }
}

export default new AdminService();
