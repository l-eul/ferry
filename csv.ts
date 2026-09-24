import type { Member } from "./types";

function csvCell(value: unknown): string {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function exportCsv(members: Member[]): string {
  const header = "id,username,name,bot,premium,last_seen,privacy,result";
  const rows = members.map((m) =>
    [
      m.id,
      m.username ?? "",
      `${m.firstName} ${m.lastName}`.trim(),
      m.isBot,
      m.isPremium,
      m.lastSeen,
      m.privacyBlocksInvite,
      m.result,
    ].map(csvCell).join(","),
  );
  return [header, ...rows].join("\n");
}
