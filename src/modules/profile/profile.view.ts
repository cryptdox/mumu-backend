import type { Prisma } from "@prisma/client";

/** Columns of a profile anyone may see. */
export const profileSelect = {
  profileId: true,
  kind: true,
  handle: true,
  displayName: true,
  bio: true,
  category: { select: { categoryId: true, name: true } },
  website: true,
  isVerified: true,
  createdAt: true,
  avatar: { select: { url: true } },
  cover: { select: { url: true } },
} satisfies Prisma.ProfileSelect;

/** Small form used inside posts, messages, lists. */
export const profileCardSelect = {
  profileId: true,
  kind: true,
  handle: true,
  displayName: true,
  isVerified: true,
  avatar: { select: { url: true } },
} satisfies Prisma.ProfileSelect;

type WithImages = { avatar?: { url: string } | null; cover?: { url: string } | null; category?: { categoryId: string; name: string } | null };

/** Flatten avatar/cover/category relations (category → its name + categoryId). */
export function toProfile<T extends WithImages>(p: T) {
  const { avatar, cover, category, ...rest } = p;
  return {
    ...rest,
    avatarUrl: avatar?.url ?? null,
    ...(cover !== undefined && { coverUrl: cover?.url ?? null }),
    ...(category !== undefined && { category: category?.name ?? null, categoryId: category?.categoryId ?? null }),
  } as Omit<T, "avatar" | "cover" | "category"> & { avatarUrl: string | null; coverUrl?: string | null; category?: string | null; categoryId?: string | null };
}
