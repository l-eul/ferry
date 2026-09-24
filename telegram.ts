import { createServerFn } from "@tanstack/react-start";
import { getSql } from "@/lib/db";
import { authMiddleware } from "@/lib/auth/middleware";
import { env } from "@/lib/env.server";

export type TelegramDialog = {
  id: string;
  title: string;
  username: string | null;
  kind: "group" | "channel";
  membersCount: number | null;
};

export type TelegramMember = {
  id: string;
  firstName: string;
  lastName: string;
  username: string | null;
  isBot: boolean;
  isDeleted: boolean;
  activity: "online" | "24h" | "7d" | "30d" | "older" | "unknown";
};

export type MemberFilters = {
  activity: "all" | "24h" | "7d" | "30d";
  excludeBots: boolean;
  excludeDeleted: boolean;
  excludeAlreadyInDestination: boolean;
  excludePreviouslyRejected: boolean;
};

type TelegramAccountRow = {
  session_string: string;
  telegram_user_id: string | null;
  username: string | null;
  display_name: string | null;
};

type PendingAuth = {
  client: any;
  phoneNumber: string;
  phoneCodeHash: string;
};

const globalRef = globalThis as typeof globalThis & {
  __ferryTelegramPending?: Map<string, PendingAuth>;
};
globalRef.__ferryTelegramPending ??= new Map();

function pending() {
  return globalRef.__ferryTelegramPending!;
}

function credentials() {
  const apiId = Number(env("TELEGRAM_API_ID"));
  const apiHash = env("TELEGRAM_API_HASH");
  if (!Number.isInteger(apiId) || apiId <= 0 || !apiHash) {
    throw new Error("Telegram API credentials are not configured. Set TELEGRAM_API_ID and TELEGRAM_API_HASH in .env.");
  }
  return { apiId, apiHash };
}

async function loadAccount(userId: string): Promise<TelegramAccountRow | null> {
  const sql = await getSql();
  const rows = await sql<TelegramAccountRow>`
    select session_string, telegram_user_id, username, display_name
    from telegram_accounts where user_id = ${userId}
  `;
  if (!rows[0]) return null;
  const { decryptSession } = await import("./session-crypto.server");
  return { ...rows[0], session_string: decryptSession(rows[0].session_string) };
}

async function clientFromSession(sessionString: string) {
  const { TelegramClient } = await import("teleproto");
  const { StringSession } = await import("teleproto/sessions");
  const { apiId, apiHash } = credentials();
  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 5,
  });
  await client.connect();
  return client;
}

async function saveAccount(userId: string, client: any, me: any) {
  const sql = await getSql();
  const { encryptSession } = await import("./session-crypto.server");
  const id = String(me.id);
  const username = me.username ?? null;
  const displayName = [me.firstName, me.lastName].filter(Boolean).join(" ") || username || "Telegram user";
  const sessionString = client.session.save();
  await sql.query(
    `insert into telegram_accounts (user_id, session_string, telegram_user_id, username, display_name)
     values ($1, $2, $3, $4, $5)
     on conflict (user_id) do update set session_string = excluded.session_string,
       telegram_user_id = excluded.telegram_user_id, username = excluded.username,
       display_name = excluded.display_name, updated_at = now()`,
    [userId, encryptSession(sessionString), id, username, displayName],
  );
}

function floodWaitSeconds(error: unknown): number | null {
  const e = error as { errorMessage?: string; message?: string; seconds?: number };
  if (typeof e?.seconds === "number" && e.seconds > 0) return e.seconds;
  const match = String(e?.errorMessage ?? e?.message ?? "").match(/FLOOD_WAIT_(\d+)/i);
  return match ? Number(match[1]) : null;
}

function cleanError(error: unknown): string {
  const e = error as { errorMessage?: string; message?: string; seconds?: number };
  if (e?.errorMessage === "SESSION_PASSWORD_NEEDED") return "Telegram 2FA password is required.";
  if (e?.errorMessage === "PHONE_CODE_INVALID") return "The Telegram verification code is invalid.";
  if (e?.errorMessage === "PHONE_CODE_EXPIRED") return "The Telegram verification code expired. Request a new code.";
  if (e?.errorMessage === "PHONE_NUMBER_INVALID") return "That Telegram phone number is invalid.";
  if (e?.errorMessage === "PHONE_NUMBER_UNOCCUPIED") return "That phone number is not registered on Telegram.";
  if (e?.errorMessage === "USER_PRIVACY_RESTRICTED") return "This user’s Telegram privacy settings do not allow you to add them to this destination.";
  if (e?.errorMessage === "USER_NOT_MUTUAL_CONTACT") return "Telegram requires this user to be a mutual contact before they can be added.";
  if (e?.errorMessage === "CHAT_ADMIN_REQUIRED") return "Your Telegram account does not have the required admin permission for this operation.";
  if (e?.errorMessage === "CHAT_ADMIN_INVITE_REQUIRED") return "Your Telegram account does not have permission to invite members to this destination.";
  if (e?.errorMessage === "CHAT_WRITE_FORBIDDEN") return "Your Telegram account cannot add members to this destination.";
  if (e?.errorMessage === "CHANNEL_PRIVATE") return "This Telegram group/channel is private and is not accessible to this account.";
  if (e?.errorMessage === "USER_CHANNELS_TOO_MUCH") return "Telegram will not let this user join more groups/channels.";
  if (e?.errorMessage === "USER_BANNED_IN_CHANNEL") return "This user is banned from the destination.";
  if (e?.errorMessage === "USER_KICKED") return "This user was removed from the destination and cannot be invited this way.";
  if (e?.errorMessage === "USER_BLOCKED") return "This user has blocked the inviting account.";
  if (e?.errorMessage === "USER_ALREADY_PARTICIPANT") return "This user is already a member of the destination.";
  if (e?.errorMessage === "USER_NOT_PARTICIPANT") return "This account is not a member of the selected destination.";
  const flood = floodWaitSeconds(error);
  if (flood) return `Telegram asked Ferry to pause for ${flood.toLocaleString()} seconds before retrying.`;
  if (e?.errorMessage === "FLOOD") return "Telegram temporarily limited this operation. Wait and try again later.";
  if (typeof e?.seconds === "number") return `Telegram asked Ferry to pause for ${e.seconds.toLocaleString()} seconds before retrying.`;
  return e?.message || e?.errorMessage || "Telegram request failed.";
}

export const getTelegramStatus = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    credentials();
    const account = await loadAccount(context.userId);
    if (!account) return { connected: false as const };
    const client = await clientFromSession(account.session_string);
    try {
      const me = await client.getMe();
      return {
        connected: true as const,
        username: me?.username ?? account.username,
        displayName: [me?.firstName, me?.lastName].filter(Boolean).join(" ") || account.display_name,
        telegramUserId: me?.id ? String(me.id) : account.telegram_user_id,
      };
    } catch (error) {
      const message = cleanError(error);
      if (/AUTH_KEY_UNREGISTERED|SESSION_REVOKED|USER_DEACTIVATED/i.test(message)) {
        const sql = await getSql();
        await sql.query("delete from telegram_accounts where user_id = $1", [context.userId]);
        return { connected: false as const, reason: "telegram-session-invalid" as const };
      }
      throw new Error(`Telegram connection could not be verified: ${message}`);
    } finally {
      await client.disconnect();
    }
  });

export const startTelegramLogin = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context, data }: { context: { userId: string }; data: { phoneNumber: string } }) => {
    try {
      const { TelegramClient } = await import("teleproto");
      const { StringSession } = await import("teleproto/sessions");
      const creds = credentials();
      const phoneNumber = data.phoneNumber.trim();
      if (!phoneNumber) throw new Error("Enter your Telegram phone number in international format.");
      const client = new TelegramClient(new StringSession(""), creds.apiId, creds.apiHash, {
        connectionRetries: 5,
      });
      await client.connect();
      const sent = await client.sendCode(creds, phoneNumber);
      pending().set(context.userId, {
        client,
        phoneNumber,
        phoneCodeHash: sent.phoneCodeHash,
      });
      return { ok: true as const, isCodeViaApp: sent.isCodeViaApp };
    } catch (error) {
      return { ok: false as const, error: cleanError(error) };
    }
  });

export const verifyTelegramCode = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context, data }: { context: { userId: string }; data: { code: string } }) => {
    const auth = pending().get(context.userId);
    if (!auth) return { ok: false as const, error: "Your login step expired. Start Telegram login again." };
    try {
      const { Api } = await import("teleproto");
      const result = await auth.client.invoke(
        new Api.auth.SignIn({
          phoneNumber: auth.phoneNumber,
          phoneCodeHash: auth.phoneCodeHash,
          phoneCode: data.code.trim(),
        }),
      );
      if (result instanceof Api.auth.AuthorizationSignUpRequired) {
        return { ok: false as const, error: "This phone number is not registered for a Telegram account." };
      }
      await saveAccount(context.userId, auth.client, result.user);
      pending().delete(context.userId);
      return { ok: true as const, needsPassword: false as const, displayName: [result.user.firstName, result.user.lastName].filter(Boolean).join(" ") };
    } catch (error) {
      const e = error as { errorMessage?: string };
      if (e?.errorMessage === "SESSION_PASSWORD_NEEDED") {
        return { ok: true as const, needsPassword: true as const };
      }
      return { ok: false as const, error: cleanError(error) };
    }
  });

export const verifyTelegramPassword = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context, data }: { context: { userId: string }; data: { password: string } }) => {
    const auth = pending().get(context.userId);
    if (!auth) return { ok: false as const, error: "Your login step expired. Start Telegram login again." };
    try {
      const creds = credentials();
      const user = await auth.client.signInWithPassword(creds, {
        password: async () => data.password,
        onError: () => false,
      });
      await saveAccount(context.userId, auth.client, user);
      pending().delete(context.userId);
      return { ok: true as const, displayName: [user.firstName, user.lastName].filter(Boolean).join(" ") };
    } catch (error) {
      return { ok: false as const, error: cleanError(error) };
    }
  });

export const disconnectTelegram = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    pending().delete(context.userId);
    const account = await loadAccount(context.userId);
    if (account) {
      try {
        const client = await clientFromSession(account.session_string);
        try {
          const { Api } = await import("teleproto");
          await client.invoke(new Api.auth.LogOut());
        } finally {
          await client.disconnect();
        }
      } catch {
        // Local deletion is still performed if Telegram has already revoked or
        // invalidated the session. Ferry must never leave a stale local secret.
      }
    }
    const sql = await getSql();
    await sql.query("delete from telegram_accounts where user_id = $1", [context.userId]);
    return { ok: true as const };
  });

function normalizePublicRef(value: string) {
  let ref = value.trim();
  if (!ref) return "";
  ref = ref.replace(/^https?:\/\/(www\.)?t\.me\//i, "");
  ref = ref.replace(/^https?:\/\/(www\.)?telegram\.me\//i, "");
  ref = ref.replace(/^@/, "").split(/[?#/]/)[0];
  return ref.trim();
}

export const resolveTelegramPublicTarget = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context, data }: { context: { userId: string }; data: { publicRef: string } }) => {
    const account = await loadAccount(context.userId);
    if (!account) throw new Error("Connect a Telegram account first.");
    const username = normalizePublicRef(data.publicRef);
    if (!username) throw new Error("Enter a public Telegram @username or t.me link.");
    if (!/^[A-Za-z0-9_]{5,}$/.test(username)) throw new Error("That does not look like a public Telegram username or t.me link.");
    const client = await clientFromSession(account.session_string);
    try {
      const entity: any = await client.getEntity(username);
      const isChannel = Boolean(entity?.className?.includes?.("Channel") || entity?.constructor?.name?.includes?.("Channel"));
      return {
        id: String(entity.id),
        title: entity.title || entity.username || username,
        username: entity.username ?? username,
        kind: isChannel ? "channel" : "group",
        membersCount: typeof entity.participantsCount === "number" ? entity.participantsCount : null,
      } as TelegramDialog;
    } catch (error) {
      throw new Error(`Telegram could not resolve that public link: ${cleanError(error)}`);
    } finally {
      await client.disconnect();
    }
  });

export const listTelegramDialogs = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const account = await loadAccount(context.userId);
    if (!account) throw new Error("Connect a Telegram account first.");
    const client = await clientFromSession(account.session_string);
    try {
      const dialogs = await client.getDialogs({ limit: undefined });
      return dialogs
        .filter((d: any) => d.isGroup || d.isChannel)
        .map((d: any) => ({
          id: String(d.id),
          title: d.title || "Untitled",
          username: d.entity?.username ?? d.username ?? null,
          kind: d.isChannel ? "channel" : "group",
          membersCount: typeof d.entity?.participantsCount === "number" ? d.entity.participantsCount : null,
        })) as TelegramDialog[];
    } finally {
      await client.disconnect();
    }
  });

function memberActivity(user: any): TelegramMember["activity"] {
  const status = user?.status;
  const name = status?.className ?? status?.constructor?.name ?? "";
  if (/UserStatusOnline/i.test(name)) return "online";
  if (/UserStatusOffline/i.test(name)) {
    const ts = Number(status?.wasActive ?? status?.wasActive?.value ?? 0);
    if (ts > 0) {
      const age = Date.now() / 1000 - ts;
      if (age <= 86400) return "24h";
      if (age <= 7 * 86400) return "7d";
      if (age <= 30 * 86400) return "30d";
      return "older";
    }
  }
  if (/UserStatusRecently/i.test(name)) return "7d";
  if (/UserStatusLastWeek/i.test(name)) return "7d";
  if (/UserStatusLastMonth/i.test(name)) return "30d";
  return "unknown";
}

function activityMatches(activity: TelegramMember["activity"], filter: MemberFilters["activity"]) {
  if (filter === "all") return true;
  if (filter === "24h") return activity === "online" || activity === "24h";
  if (filter === "7d") return activity === "online" || activity === "24h" || activity === "7d";
  return activity === "online" || activity === "24h" || activity === "7d" || activity === "30d";
}

async function participantMap(client: any, entity: any) {
  const map = new Map<string, any>();
  if (typeof client.iterParticipants === "function") {
    for await (const user of client.iterParticipants(entity)) map.set(String(user.id), user);
  } else {
    // Fallback for clients without iterParticipants: page until Telegram returns
    // fewer users than the requested page size. Never impose a 10,000-user cap.
    const pageSize = 200;
    for (let offset = 0; ; offset += pageSize) {
      const users = await client.getParticipants(entity, { offset, limit: pageSize });
      for (const user of users as any[]) map.set(String(user.id), user);
      if (!Array.isArray(users) || users.length < pageSize) break;
    }
  }
  return map;
}

export const listTelegramMembers = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context, data }: { context: { userId: string }; data: { dialogId: string; dialogUsername?: string | null; destinationId?: string; destinationUsername?: string | null; filters?: Partial<MemberFilters> } }) => {
    const account = await loadAccount(context.userId);
    if (!account) throw new Error("Connect a Telegram account first.");
    const client = await clientFromSession(account.session_string);
    const filters: MemberFilters = {
      activity: data.filters?.activity ?? "all",
      excludeBots: data.filters?.excludeBots ?? true,
      excludeDeleted: data.filters?.excludeDeleted ?? true,
      excludeAlreadyInDestination: data.filters?.excludeAlreadyInDestination ?? true,
      excludePreviouslyRejected: data.filters?.excludePreviouslyRejected ?? true,
    };
    try {
      const dialogs = await client.getDialogs({ limit: undefined });
      const sourceDialog = dialogs.find((d: any) => String(d.id) === String(data.dialogId));
      const sourceEntity = sourceDialog?.entity ?? (data.dialogUsername ? await client.getEntity(normalizePublicRef(data.dialogUsername)) : null);
      if (!sourceEntity) throw new Error("This Telegram group is no longer available to the connected account.");
      let destinationEntity: any = null;
      if (data.destinationId && filters.excludeAlreadyInDestination) {
        const destinationDialog = dialogs.find((d: any) => String(d.id) === String(data.destinationId));
        destinationEntity = destinationDialog?.entity ?? (data.destinationUsername ? await client.getEntity(normalizePublicRef(data.destinationUsername)) : null);
        if (!destinationEntity) throw new Error("Choose an accessible destination before loading eligible members.");
      }
      let destinationIds = new Set<string>();
      if (destinationEntity) {
        try {
          destinationIds = new Set((await participantMap(client, destinationEntity)).keys());
        } catch (error) {
          throw new Error(`Ferry cannot verify which members are already in the destination: ${cleanError(error)}. Choose a destination where this account can inspect members, or turn off the duplicate filter.`);
        }
      }
      const sql = await getSql();
      const rejectedRows = filters.excludePreviouslyRejected && data.destinationId
        ? await sql<{ member_id: string }>`select member_id from telegram_member_results where user_id = ${context.userId} and destination_id = ${data.destinationId} and status = 'rejected'`
        : [];
      const rejectedIds = new Set(rejectedRows.map((r) => r.member_id));
      const users = await participantMap(client, sourceEntity);
      const members: TelegramMember[] = [];
      for (const user of users.values()) {
        const member: TelegramMember = {
          id: String(user.id), firstName: user.firstName ?? "", lastName: user.lastName ?? "",
          username: user.username ?? null, isBot: Boolean(user.bot), isDeleted: Boolean(user.deleted), activity: memberActivity(user),
        };
        if (filters.excludeBots && member.isBot) continue;
        if (filters.excludeDeleted && member.isDeleted) continue;
        if (!activityMatches(member.activity, filters.activity)) continue;
        if (filters.excludeAlreadyInDestination && destinationIds.has(member.id)) continue;
        if (filters.excludePreviouslyRejected && rejectedIds.has(member.id)) continue;
        members.push(member);
      }
      return { members, filters };
    } catch (error) {
      const message = cleanError(error);
      if (/admin permission|private and is not accessible/i.test(message)) throw new Error(`${message} Telegram does not expose the member list in this case.`);
      if (error instanceof Error) throw error;
      throw new Error(`Telegram could not load this group's members: ${message}`);
    } finally {
      await client.disconnect();
    }
  });

export const addTelegramMembers = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context, data }: { context: { userId: string }; data: { sourceId: string; sourceUsername?: string | null; destinationId: string; destinationUsername?: string | null; memberIds: string[] } }) => {
    const account = await loadAccount(context.userId);
    if (!account) throw new Error("Connect a Telegram account first.");
    const ids = [...new Set(data.memberIds)].filter(Boolean).slice(0, 100);
    if (!ids.length) return { added: 0, failed: 0, results: [] as { id: string; ok: boolean; error?: string }[] };
    const client = await clientFromSession(account.session_string);
    try {
      const { Api } = await import("teleproto");
      const dialogs = await client.getDialogs({ limit: undefined });
      const sourceDialog = dialogs.find((d: any) => String(d.id) === String(data.sourceId));
      const destinationDialog = dialogs.find((d: any) => String(d.id) === String(data.destinationId));
      const sourceEntity = sourceDialog?.entity ?? (data.sourceUsername ? await client.getEntity(normalizePublicRef(data.sourceUsername)) : null);
      const destinationEntity = destinationDialog?.entity ?? (data.destinationUsername ? await client.getEntity(normalizePublicRef(data.destinationUsername)) : null);
      if (!sourceEntity) throw new Error("The selected source group is no longer available to the connected account.");
      if (!destinationEntity) throw new Error("The selected destination group is no longer available to the connected account.");
      if (String(data.sourceId) === String(data.destinationId)) throw new Error("Source and destination must be different.");
      const sourceUsers = await participantMap(client, sourceEntity);
      const destinationUsers = await participantMap(client, destinationEntity).catch((error) => { throw new Error(`Ferry cannot verify the destination member list: ${cleanError(error)}`); });
      const sql = await getSql();
      const results: { id: string; ok: boolean; error?: string }[] = [];
      for (const id of ids) {
        if (destinationUsers.has(String(id))) {
          results.push({ id, ok: false, error: "Already a member of the destination; skipped." });
          continue;
        }
        try {
          const participant = sourceUsers.get(String(id));
          if (!participant) throw new Error("This member is no longer available in the selected source group.");
          const inputUser = await client.getInputEntity(participant);
          if (destinationEntity instanceof Api.Channel) {
            await client.invoke(new Api.channels.InviteToChannel({ channel: destinationEntity, users: [inputUser] }));
          } else if (destinationEntity instanceof Api.Chat) {
            await client.invoke(new Api.messages.AddChatUser({ chatId: destinationEntity.id, userId: inputUser, fwdLimit: 0 }));
          } else throw new Error("Destination must be a Telegram group or channel.");
          results.push({ id, ok: true });
          await sql.query(`insert into telegram_member_results (user_id,destination_id,member_id,status,reason) values ($1,$2,$3,'added',null) on conflict (user_id,destination_id,member_id) do update set status='added',reason=null,updated_at=now()`, [context.userId, data.destinationId, id]);
          destinationUsers.set(String(id), participant);
        } catch (error) {
          const message = cleanError(error);
          results.push({ id, ok: false, error: message });
          const permanent = /privacy settings|mutual contact|banned|blocked|already a member|cannot be invited|does not have permission|cannot add members/i.test(message);
          if (permanent) await sql.query(`insert into telegram_member_results (user_id,destination_id,member_id,status,reason) values ($1,$2,$3,'rejected',$4) on conflict (user_id,destination_id,member_id) do update set status='rejected',reason=excluded.reason,updated_at=now()`, [context.userId, data.destinationId, id, message]);
          const flood = floodWaitSeconds(error);
          if (flood) break;
        }
      }
      return { added: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results, stoppedForFloodWait: results.some((r) => !r.ok && /pause for .* seconds/i.test(r.error ?? "")) };
    } finally { await client.disconnect(); }
  });
