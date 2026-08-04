import { randomBytes } from "node:crypto";

/** A project-scoped join capability. In-memory only: invites die with the
 *  process, like every other piece of server state in this POC. */
export interface Invite {
  /** Public, safe for the wire and the transcript. */
  id: string;
  /** Secret. Only ever leaves the server in an `invite_list` reply to the
   *  socket that asked — never in the replayed session log. */
  token: string;
  projectId: string;
  createdBy: string;
  createdByName: string;
  createdAt: number;
  expiresAt: number;
  maxUses: number;
  /** Distinct userIds. A reload mints a fresh sessionStorage identity, so
   *  counting raw joins would burn seats on the same human. */
  redeemedBy: Set<string>;
  revoked: boolean;
}

/** What a project member sees. Carries the token, which is why this shape
 *  only ever goes to the requesting socket. */
export interface InviteView {
  id: string;
  token: string;
  projectId: string;
  createdByName: string;
  expiresAt: number;
  uses: number;
  maxUses: number;
}

export type InviteFailure =
  | "invite not found"
  | "invite expired"
  | "invite revoked"
  | "invite is full";

export type InviteResult =
  | { ok: true; invite: Invite }
  | { ok: false; error: InviteFailure };

export const DEFAULT_INVITE_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_INVITE_MAX_USES = 10;

/** base64url of 24 bytes is always exactly 32 chars. Anything else is
 *  rejected before it reaches the map. */
const TOKEN_LEN = 32;
/** Dead invites linger this long past expiry so failures can still say *why*
 *  rather than collapsing to "not found". */
const PRUNE_GRACE_MS = 60 * 60 * 1000;

export class InviteStore {
  private byToken = new Map<string, Invite>();

  constructor(
    private opts: { ttlMs?: number; maxUses?: number; now?: () => number } = {},
  ) {}

  mint(args: {
    projectId: string;
    createdBy: string;
    createdByName: string;
  }): Invite {
    this.prune();
    const now = this.now();
    const invite: Invite = {
      // Separate draws: a public id must never be derived from a secret.
      id: randomBytes(6).toString("base64url"),
      token: randomBytes(24).toString("base64url"),
      projectId: args.projectId,
      createdBy: args.createdBy,
      createdByName: args.createdByName,
      createdAt: now,
      expiresAt: now + (this.opts.ttlMs ?? DEFAULT_INVITE_TTL_MS),
      maxUses: this.opts.maxUses ?? DEFAULT_INVITE_MAX_USES,
      redeemedBy: new Set(),
      revoked: false,
    };
    this.byToken.set(invite.token, invite);
    return invite;
  }

  /** Non-consuming preview. */
  peek(token: unknown): InviteResult {
    this.prune();
    const invite = this.lookup(token);
    const failure = this.classify(invite);
    return failure ? { ok: false, error: failure } : { ok: true, invite: invite! };
  }

  /** Consuming check. Takes a seat unless this user already holds one. */
  redeem(token: unknown, userId: string, projectId: string): InviteResult {
    this.prune();
    const invite = this.lookup(token);
    // A token that exists but belongs to another project reports "not found"
    // rather than confirming it is real somewhere else — checked before
    // classify() so revoked/expired/full states don't leak either.
    if (invite && invite.projectId !== projectId) {
      return { ok: false, error: "invite not found" };
    }
    const failure = this.classify(invite, userId);
    if (failure) return { ok: false, error: failure };
    invite!.redeemedBy.add(userId);
    return { ok: true, invite: invite! };
  }

  listFor(projectId: string): InviteView[] {
    this.prune();
    const live: InviteView[] = [];
    for (const invite of this.byToken.values()) {
      if (invite.projectId !== projectId) continue;
      // Include full invites (they show zero seats left); hide only revoked/expired
      if (invite.revoked || invite.expiresAt <= this.now()) continue;
      live.push({
        id: invite.id,
        token: invite.token,
        projectId: invite.projectId,
        createdByName: invite.createdByName,
        expiresAt: invite.expiresAt,
        uses: invite.redeemedBy.size,
        maxUses: invite.maxUses,
      });
    }
    live.sort((a, b) => a.expiresAt - b.expiresAt);
    return live;
  }

  revoke(id: string, projectId: string): boolean {
    this.prune();
    for (const invite of this.byToken.values()) {
      if (invite.id === id && invite.projectId === projectId) {
        invite.revoked = true;
        return true;
      }
    }
    return false;
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private lookup(token: unknown): Invite | undefined {
    if (typeof token !== "string" || token.length !== TOKEN_LEN) return undefined;
    return this.byToken.get(token);
  }

  /** Revoked is checked before expired: a human action is the more useful
   *  explanation when both are true. */
  private classify(invite: Invite | undefined, userId?: string): InviteFailure | null {
    if (!invite) return "invite not found";
    if (invite.revoked) return "invite revoked";
    if (invite.expiresAt <= this.now()) return "invite expired";
    if (userId !== undefined && invite.redeemedBy.has(userId)) return null;
    if (invite.redeemedBy.size >= invite.maxUses) return "invite is full";
    return null;
  }

  /** Called from every public entry point, so the store needs no sweep timer
   *  — and therefore has no teardown path to get wrong. */
  private prune(): void {
    const cutoff = this.now() - PRUNE_GRACE_MS;
    for (const [token, invite] of this.byToken) {
      if (invite.expiresAt <= cutoff) this.byToken.delete(token);
    }
  }
}
