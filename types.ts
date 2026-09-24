export type LastSeen = "recent" | "today" | "week" | "month" | "long_ago" | "hidden";
export type ChatKind = "group" | "channel";
export type AddResult = "pending" | "queued" | "added" | "skipped" | "failed" | "already";
export type JobKind = "idle" | "scraping" | "adding" | "done";

export type Member = {
  id: string;
  username: string | null;
  firstName: string;
  lastName: string;
  isBot: boolean;
  isDeleted: boolean;
  isPremium: boolean;
  lastSeen: LastSeen;
  privacyBlocksInvite: boolean;
  result: AddResult;
};

export type Community = {
  id: string;
  handle: string;
  title: string;
  kind: ChatKind;
  membersApprox: number;
  description: string;
};

export type LogLine = {
  id: string;
  at: number;
  tone: "info" | "ok" | "warn" | "bad" | "mute";
  text: string;
};

export type Settings = {
  skipBots: boolean;
  skipNoUsername: boolean;
  skipPrivate: boolean;
  onlyRecent: boolean;
  delayMs: number;
};

export type JobReport = {
  id: string;
  at: number;
  sourceHandle: string;
  destHandle: string;
  scraped: number;
  added: number;
  skipped: number;
  failed: number;
};
