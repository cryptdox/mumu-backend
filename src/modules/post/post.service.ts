import type { Prisma, ReactionType } from "@prisma/client";
import type { Request } from "express";
import prisma from "../../prisma/client";
import { BadRequest, Forbidden, NotFound } from "../../utils/errors";
import { Resource } from "../../utils/consts";
import { canModerate } from "../../utils/permissions";
import type { Actor } from "../../middlewares/actor.middleware";
import { profileCardSelect, toProfile } from "../profile/profile.view";
import { assertOwnMedia } from "../profile/profile.service";
import { canSee, viewerGraph } from "../connection/visibility";
import { notify } from "../notification/notification.service";
import type { CreatePostDto } from "./post.dto";

const postInclude = (viewerId: string) =>
  ({
    author: { select: profileCardSelect },
    media: { select: { url: true, width: true, height: true, mime: true } },
    liveStream: { select: { liveStreamId: true, title: true, status: true, viewerCount: true } },
    reactions: { where: { profileId: viewerId }, select: { type: true }, take: 1 },
  }) satisfies Prisma.PostInclude;

type PostRow = Prisma.PostGetPayload<{ include: ReturnType<typeof postInclude> }>;

function view(p: PostRow) {
  const { reactions, author, mediaId: _m, ...rest } = p;
  return { ...rest, author: toProfile(author), myReaction: reactions[0]?.type ?? null };
}

const live = { deletedAt: null, author: { deletedAt: null } } satisfies Prisma.PostWhereInput;

class PostService {
  async create(actor: Actor, dto: CreatePostDto) {
    await assertOwnMedia(actor.profileId, dto.mediaId);
    const post = await prisma.post.create({
      data: { authorProfileId: actor.profileId, text: dto.text, mediaId: dto.mediaId, audience: dto.audience },
      include: postInclude(actor.profileId),
    });
    return view(post);
  }

  /** "following": you, friends and who you follow. "explore": every public post. */
  async feed(actor: Actor, tab: "following" | "explore", before: Date | undefined, limit: number) {
    const me = actor.profileId;
    const g = await viewerGraph(me);
    const time = before ? { createdAt: { lt: before } } : {};
    const where: Prisma.PostWhereInput =
      tab === "explore"
        ? { ...live, ...time, audience: "PUBLIC", authorProfileId: { notIn: g.blocked } }
        : {
            ...live,
            ...time,
            authorProfileId: { in: [me, ...g.friends, ...g.following].filter((id) => !g.blocked.includes(id)) },
            OR: [{ authorProfileId: me }, { audience: "PUBLIC" }, { audience: "CONNECTIONS", authorProfileId: { in: g.connectionAuthors } }],
          };
    const rows = await prisma.post.findMany({ where, include: postInclude(me), orderBy: { createdAt: "desc" }, take: limit });
    return rows.map(view);
  }

  async byProfile(actor: Actor, profileId: string, before: Date | undefined, limit: number) {
    const author = await prisma.profile.findFirst({ where: { profileId, deletedAt: null }, select: { profileId: true, kind: true } });
    if (!author) throw NotFound("Profile not found");
    const audiences: ("PUBLIC" | "CONNECTIONS" | "ONLY_ME")[] =
      profileId === actor.profileId ? ["PUBLIC", "CONNECTIONS", "ONLY_ME"] : (await canSee(actor.profileId, author, "CONNECTIONS")) ? ["PUBLIC", "CONNECTIONS"] : (await canSee(actor.profileId, author, "PUBLIC")) ? ["PUBLIC"] : [];
    if (!audiences.length) return [];
    const rows = await prisma.post.findMany({
      where: { ...live, authorProfileId: profileId, audience: { in: audiences }, ...(before && { createdAt: { lt: before } }) },
      include: postInclude(actor.profileId),
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return rows.map(view);
  }

  /** A post the viewer may see, or 404 (never reveals that hidden posts exist). */
  async visible(actor: Actor, postId: string) {
    const post = await prisma.post.findFirst({ where: { postId, ...live }, include: postInclude(actor.profileId) });
    if (!post || !(await canSee(actor.profileId, post.author, post.audience))) throw NotFound("Post not found");
    return post;
  }

  async get(actor: Actor, postId: string) {
    return view(await this.visible(actor, postId));
  }

  async update(actor: Actor, postId: string, dto: { text?: string | null; audience?: "PUBLIC" | "CONNECTIONS" | "ONLY_ME" }) {
    const post = await prisma.post.findFirst({ where: { postId, deletedAt: null } });
    if (!post) throw NotFound("Post not found");
    if (post.authorProfileId !== actor.profileId) throw Forbidden("Only the author can edit a post");
    if (post.liveStreamId && dto.audience && dto.audience !== post.audience) throw BadRequest("Change a live post's audience on the stream");
    const text = dto.text === undefined ? post.text : dto.text ?? null;
    if (!text && !post.mediaId) throw BadRequest("A post needs text or an image");
    const updated = await prisma.post.update({
      where: { postId },
      data: { text, ...(dto.audience && { audience: dto.audience }), ...(dto.text !== undefined && { editedAt: new Date() }) },
      include: postInclude(actor.profileId),
    });
    return view(updated);
  }

  /** Authors delete their posts; moderators (MU_POST READ_ALL) anyone's. */
  async remove(req: Request, postId: string) {
    const actor = req.actor!;
    const post = await prisma.post.findFirst({ where: { postId, deletedAt: null }, select: { authorProfileId: true } });
    if (!post) throw NotFound("Post not found");
    if (post.authorProfileId !== actor.profileId && !(await canModerate(req, Resource.POST))) throw Forbidden("Not your post");
    await prisma.post.update({ where: { postId }, data: { deletedAt: new Date() } });
  }

  // ── Reactions ──────────────────────────────────────────────────────────────

  async react(actor: Actor, postId: string, type: ReactionType) {
    const post = await this.visible(actor, postId);
    const existing = await prisma.reaction.findUnique({ where: { postId_profileId: { postId, profileId: actor.profileId } } });
    if (existing) {
      await prisma.reaction.update({ where: { postId_profileId: { postId, profileId: actor.profileId } }, data: { type } });
      return { myReaction: type, reactionCount: post.reactionCount };
    }
    const [, updated] = await prisma.$transaction([
      prisma.reaction.create({ data: { postId, profileId: actor.profileId, type } }),
      prisma.post.update({ where: { postId }, data: { reactionCount: { increment: 1 } }, select: { reactionCount: true } }),
    ]);
    await notify(post.authorProfileId, "POST_REACTION", actor.profileId, postId);
    return { myReaction: type, reactionCount: updated.reactionCount };
  }

  async unreact(actor: Actor, postId: string) {
    await this.visible(actor, postId);
    const { count } = await prisma.reaction.deleteMany({ where: { postId, profileId: actor.profileId } });
    const post = count
      ? await prisma.post.update({ where: { postId }, data: { reactionCount: { decrement: 1 } }, select: { reactionCount: true } })
      : await prisma.post.findUniqueOrThrow({ where: { postId }, select: { reactionCount: true } });
    return { myReaction: null, reactionCount: post.reactionCount };
  }

  async reactions(actor: Actor, postId: string, limit: number) {
    await this.visible(actor, postId);
    const rows = await prisma.reaction.findMany({
      where: { postId },
      include: { profile: { select: profileCardSelect } },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return rows.map((r) => ({ type: r.type, profile: toProfile(r.profile) }));
  }

  // ── Comments ───────────────────────────────────────────────────────────────

  async comments(actor: Actor, postId: string, before: Date | undefined, limit: number) {
    await this.visible(actor, postId);
    const rows = await prisma.comment.findMany({
      where: { postId, deletedAt: null, ...(before && { createdAt: { lt: before } }) },
      include: { author: { select: profileCardSelect } },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return rows.map(({ author, ...c }) => ({ ...c, author: toProfile(author) }));
  }

  async comment(actor: Actor, postId: string, text: string, parentId?: string) {
    const post = await this.visible(actor, postId);
    let parentAuthor: string | null = null;
    if (parentId) {
      const parent = await prisma.comment.findFirst({ where: { commentId: parentId, postId, deletedAt: null } });
      if (!parent) throw BadRequest("Replying to a comment that doesn't exist");
      if (parent.parentId) parentId = parent.parentId; // keep one level of replies
      parentAuthor = parent.authorProfileId;
    }
    const [comment] = await prisma.$transaction([
      prisma.comment.create({
        data: { postId, authorProfileId: actor.profileId, text, parentId },
        include: { author: { select: profileCardSelect } },
      }),
      prisma.post.update({ where: { postId }, data: { commentCount: { increment: 1 } } }),
    ]);
    await notify(post.authorProfileId, "POST_COMMENT", actor.profileId, postId);
    if (parentAuthor && parentAuthor !== post.authorProfileId) await notify(parentAuthor, "COMMENT_REPLY", actor.profileId, postId);
    const { author, ...rest } = comment;
    return { ...rest, author: toProfile(author) };
  }

  /** The comment's author, the post's author, or a moderator (MU_COMMENT READ_ALL). */
  async removeComment(req: Request, commentId: string) {
    const actor = req.actor!;
    const comment = await prisma.comment.findFirst({ where: { commentId, deletedAt: null }, include: { post: { select: { authorProfileId: true } } } });
    if (!comment) throw NotFound("Comment not found");
    const allowed =
      comment.authorProfileId === actor.profileId || comment.post.authorProfileId === actor.profileId || (await canModerate(req, Resource.COMMENT));
    if (!allowed) throw Forbidden("You can't delete this comment");
    await prisma.$transaction([
      prisma.comment.update({ where: { commentId }, data: { deletedAt: new Date() } }),
      prisma.post.update({ where: { postId: comment.postId }, data: { commentCount: { decrement: 1 } } }),
    ]);
  }
}

export default new PostService();
