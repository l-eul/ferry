import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Check,
  ChevronDown,
  Download,
  LogOut,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Smartphone,
  Users,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  addTelegramMembers,
  disconnectTelegram,
  getTelegramStatus,
  listTelegramDialogs,
  listTelegramMembers,
  resolveTelegramPublicTarget,
  startTelegramLogin,
  verifyTelegramCode,
  verifyTelegramPassword,
  type TelegramDialog,
  type TelegramMember,
  type MemberFilters,
} from "@/lib/ferry/telegram";
import { cn } from "@/lib/utils";

const MAX_ADD_PER_RUN = 100;

type AddResult = { id: string; ok: boolean; error?: string };

function downloadCsv(results: AddResult[], members: TelegramMember[]) {
  const byId = new Map(members.map((m) => [m.id, m]));
  const esc = (value: unknown) => {
    const text = String(value ?? "");
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const rows = ["id,username,name,status,reason"];
  for (const result of results) {
    const member = byId.get(result.id);
    rows.push([
      result.id,
      member?.username ? `@${member.username}` : "",
      member ? [member.firstName, member.lastName].filter(Boolean).join(" ") : "",
      result.ok ? "added" : "not_added",
      result.error ?? "",
    ].map(esc).join(","));
  }
  const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `ferry-results-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function FerryApp() {
  const [status, setStatus] = useState<{ connected: boolean; username?: string | null; displayName?: string | null }>({ connected: false });
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [step, setStep] = useState<"idle" | "code" | "password">("idle");
  const [busy, setBusy] = useState(false);
  const [lastResults, setLastResults] = useState<AddResult[]>([]);
  const [dialogs, setDialogs] = useState<TelegramDialog[]>([]);
  const [source, setSource] = useState<TelegramDialog | null>(null);
  const [destination, setDestination] = useState<TelegramDialog | null>(null);
  const [members, setMembers] = useState<TelegramMember[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [loadingDialogs, setLoadingDialogs] = useState(false);
  const [publicSourceRef, setPublicSourceRef] = useState("");
  const [publicDestinationRef, setPublicDestinationRef] = useState("");
  const [resolvingTarget, setResolvingTarget] = useState<"source" | "destination" | null>(null);
  const [filters, setFilters] = useState<MemberFilters>({ activity: "all", excludeBots: true, excludeDeleted: true, excludeAlreadyInDestination: true, excludePreviouslyRejected: true });

  const loadStatus = async () => {
    try {
      const next = await getTelegramStatus();
      setStatus(next);
      if (next.connected) await loadDialogs();
      else if ("reason" in next && next.reason === "telegram-session-invalid") toast.info("Your Telegram session is no longer valid. Connect Telegram again.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to check Telegram status.");
    }
  };

  const loadDialogs = async () => {
    setLoadingDialogs(true);
    try {
      const next = await listTelegramDialogs();
      setDialogs(next);
      setSource((current) => current && next.some((d) => d.id === current.id) ? next.find((d) => d.id === current.id) ?? null : null);
      setDestination((current) => current && next.some((d) => d.id === current.id) ? next.find((d) => d.id === current.id) ?? null : null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to load Telegram groups.");
    } finally {
      setLoadingDialogs(false);
    }
  };

  useEffect(() => { void loadStatus(); }, []);

  const connect = async () => {
    setBusy(true);
    try {
      const result = await startTelegramLogin({ data: { phoneNumber: phone } });
      if (!result.ok) throw new Error(result.error);
      setStep("code");
      toast.success(result.isCodeViaApp ? "Telegram sent the code in the Telegram app." : "Telegram sent a verification code.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Telegram login failed.");
    } finally { setBusy(false); }
  };

  const submitCode = async () => {
    setBusy(true);
    try {
      const result = await verifyTelegramCode({ data: { code } });
      if (!result.ok) throw new Error(result.error);
      if (result.needsPassword) {
        setStep("password");
        toast.message("Your Telegram account uses 2-step verification.");
      } else {
        setStep("idle"); setCode(""); setPhone(""); await loadStatus(); toast.success("Telegram connected.");
      }
    } catch (error) { toast.error(error instanceof Error ? error.message : "Verification failed."); }
    finally { setBusy(false); }
  };

  const submitPassword = async () => {
    setBusy(true);
    try {
      const result = await verifyTelegramPassword({ data: { password } });
      if (!result.ok) throw new Error(result.error);
      setStep("idle"); setPassword(""); setCode(""); setPhone(""); await loadStatus(); toast.success("Telegram connected.");
    } catch (error) { toast.error(error instanceof Error ? error.message : "2FA verification failed."); }
    finally { setBusy(false); }
  };

  const scrape = async () => {
    if (!source) return toast.error("Choose a source group or channel first.");
    setLoadingMembers(true); setSelected(new Set()); setLastResults([]); setSearch("");
    try {
      if (!destination) return toast.error("Choose a destination first so Ferry can remove members who are already there.");
      if (source.id === destination.id) return toast.error("Source and destination must be different.");
      const next = await listTelegramMembers({ data: { dialogId: source.id, dialogUsername: source.username, destinationId: destination.id, destinationUsername: destination.username, filters } });
      setMembers(next.members);
      toast.success(`${next.members.length.toLocaleString()} eligible members loaded.`);
    } catch (error) { toast.error(error instanceof Error ? error.message : "Unable to load members."); }
    finally { setLoadingMembers(false); }
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return members;
    return members.filter((m) => `${m.firstName} ${m.lastName} ${m.username ?? ""}`.toLowerCase().includes(q));
  }, [members, search]);

  const toggle = (id: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else if (next.size < MAX_ADD_PER_RUN) next.add(id);
    else toast.info(`Ferry limits one add run to ${MAX_ADD_PER_RUN} selected members so Telegram errors remain individually traceable.`);
    return next;
  });

  const selectVisible = () => setSelected((current) => {
    const next = new Set(current);
    for (const member of filtered) {
      if (next.size >= MAX_ADD_PER_RUN) break;
      next.add(member.id);
    }
    return next;
  });

  const transfer = async () => {
    if (!destination) return toast.error("Choose a destination group or channel.");
    if (source?.id === destination.id) return toast.error("Source and destination must be different.");
    if (!selected.size) return toast.error("Select at least one member.");
    setBusy(true);
    setLastResults([]);
    try {
      const result = await addTelegramMembers({ data: { sourceId: source!.id, sourceUsername: source!.username, destinationId: destination.id, destinationUsername: destination.username, memberIds: [...selected] } });
      setLastResults(result.results);
      const added = result.results.filter((r) => r.ok).length;
      const failed = result.results.length - added;
      if (result.stoppedForFloodWait) toast.warning(`Telegram asked Ferry to pause. ${added} added before the limit; review the last result for the requested wait.`);
      else if (failed) toast.warning(`Finished: ${added} added, ${failed} not added. See the results below.`);
      else toast.success(`Finished: ${added} members added.`);
      setSelected(new Set(result.results.filter((r) => !r.ok).map((r) => r.id)));
    } catch (error) { toast.error(error instanceof Error ? error.message : "Transfer failed."); }
    finally { setBusy(false); }
  };

  const resolvePublic = async (kind: "source" | "destination") => {
    const value = kind === "source" ? publicSourceRef : publicDestinationRef;
    if (!value.trim()) return toast.error("Enter a public Telegram @username or t.me link.");
    setResolvingTarget(kind);
    try {
      const target = await resolveTelegramPublicTarget({ data: { publicRef: value } });
      if (kind === "source") {
        setSource(target);
        setMembers([]);
        setSelected(new Set());
        setLastResults([]);
      } else {
        setDestination(target);
      }
      toast.success(`${target.title} resolved from its public link.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to resolve the public Telegram link.");
    } finally {
      setResolvingTarget(null);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try { await disconnectTelegram(); setStatus({ connected: false }); setDialogs([]); setSource(null); setDestination(null); setMembers([]); setSelected(new Set()); setLastResults([]); toast.success("Telegram disconnected."); }
    catch (error) { toast.error(error instanceof Error ? error.message : "Disconnect failed."); }
    finally { setBusy(false); }
  };

  if (!status.connected) {
    return <LoginScreen phone={phone} setPhone={setPhone} step={step} code={code} setCode={setCode} password={password} setPassword={setPassword} busy={busy} onConnect={connect} onCode={submitCode} onPassword={submitPassword} />;
  }

  const addedCount = lastResults.filter((r) => r.ok).length;
  const failedCount = lastResults.length - addedCount;

  return (
    <div className="min-h-dvh bg-bg text-fg">
      <header className="border-b border-border bg-bg/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-4 md:px-6">
          <div><h1 className="font-display text-2xl font-medium tracking-tight md:text-3xl">Ferry</h1><p className="text-sm text-muted">Move selected Telegram members with your own account</p></div>
          <div className="flex items-center gap-2"><Badge variant="ok"><span className="mr-1 inline-block size-1.5 rounded-full bg-ok" />Connected</Badge><Button variant="ghost" size="sm" disabled={busy} onClick={() => void disconnect()}><LogOut />Disconnect</Button></div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-5 md:px-6 md:py-7">
        <section className="rounded-2xl border border-border bg-surface p-4 md:p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div><p className="text-xs font-medium uppercase tracking-wider text-subtle">Account</p><p className="mt-1 font-medium">{status.displayName || "Telegram account"}</p><p className="font-mono text-xs text-subtle">{status.username ? `@${status.username}` : "No public username"}</p></div>
            <Button variant="secondary" size="sm" disabled={loadingDialogs || busy} onClick={() => void loadDialogs()}><RefreshCw className={cn(loadingDialogs && "animate-spin")} />Refresh</Button>
          </div>
        </section>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_auto_1fr] md:items-stretch">
          <div className="space-y-3">
            <Picker label="1 · Source" hint="Choose an accessible group/channel, or resolve a public link when Telegram permits it." items={dialogs} active={source?.id ?? ""} disabled={busy} onPick={(id) => { setSource(dialogs.find((d) => d.id === id) ?? null); setMembers([]); setSelected(new Set()); setLastResults([]); }} />
            <PublicTargetInput value={publicSourceRef} onChange={setPublicSourceRef} onResolve={() => void resolvePublic("source")} disabled={busy || resolvingTarget !== null} loading={resolvingTarget === "source"} placeholder="@publicgroup or https://t.me/publicgroup" />
          </div>
          <div className="flex items-center justify-center text-subtle"><ArrowRight className="hidden size-5 md:block" /><span className="text-xs md:hidden">then choose a destination</span></div>
          <div className="space-y-3">
            <Picker label="2 · Destination" hint="Choose a destination, or resolve its public link when this account has permission to manage it." items={dialogs} active={destination?.id ?? ""} disabled={busy} onPick={(id) => setDestination(dialogs.find((d) => d.id === id) ?? null)} />
            <PublicTargetInput value={publicDestinationRef} onChange={setPublicDestinationRef} onResolve={() => void resolvePublic("destination")} disabled={busy || resolvingTarget !== null} loading={resolvingTarget === "destination"} placeholder="@destination or https://t.me/destination" />
          </div>
        </div>

        <section className="rounded-2xl border border-border bg-surface p-3 md:p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <Button onClick={() => void scrape()} disabled={!source || !destination || loadingMembers || busy}><Users />{loadingMembers ? "Filtering members…" : "Load eligible members"}</Button>
            <div className="flex flex-wrap gap-2"><Button variant="ghost" size="sm" onClick={selectVisible} disabled={!filtered.length || busy}>Select visible</Button><Button variant="ghost" size="sm" onClick={() => setSelected(new Set())} disabled={!selected.size || busy}>Clear</Button></div>
            <div className="sm:ml-auto text-sm text-muted"><span className="text-fg">{members.length.toLocaleString()} eligible</span> · {selected.size.toLocaleString()} selected</div>
          </div>
          <div className="mt-4 grid gap-3 rounded-xl border border-border bg-bg p-3 md:grid-cols-2">
            <label className="text-sm"><span className="mb-1 block font-medium">Activity</span><select value={filters.activity} disabled={busy} onChange={(e) => setFilters((f) => ({ ...f, activity: e.target.value as MemberFilters["activity"] }))} className="h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm"><option value="all">Any activity</option><option value="24h">Active within 24 hours</option><option value="7d">Active within 7 days</option><option value="30d">Active within 30 days</option></select></label>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <label className="flex items-center gap-2 text-sm"><Checkbox checked={filters.excludeBots} disabled={busy} onCheckedChange={(v) => setFilters((f) => ({ ...f, excludeBots: Boolean(v) }))} />Exclude bots</label>
              <label className="flex items-center gap-2 text-sm"><Checkbox checked={filters.excludeDeleted} disabled={busy} onCheckedChange={(v) => setFilters((f) => ({ ...f, excludeDeleted: Boolean(v) }))} />Exclude deleted</label>
              <label className="flex items-center gap-2 text-sm"><Checkbox checked={filters.excludeAlreadyInDestination} disabled={busy} onCheckedChange={(v) => setFilters((f) => ({ ...f, excludeAlreadyInDestination: Boolean(v) }))} />Exclude destination members</label>
              <label className="flex items-center gap-2 text-sm"><Checkbox checked={filters.excludePreviouslyRejected} disabled={busy} onCheckedChange={(v) => setFilters((f) => ({ ...f, excludePreviouslyRejected: Boolean(v) }))} />Exclude previous permanent failures</label>
            </div>
          </div>
          <p className="mt-3 text-xs leading-5 text-subtle">Filters run on the server before the list is shown. The eligible count is therefore the population Ferry will actually offer for this operation. Telegram privacy, membership and permission rules remain authoritative.</p>
        </section>

        <section className="overflow-hidden rounded-2xl border border-border bg-surface">
          <div className="flex flex-col gap-3 border-b border-border p-3 md:p-4 sm:flex-row sm:items-center">
            <div className="relative min-w-0 flex-1"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-subtle" /><Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search loaded members…" className="pl-9" /></div>
            <Button onClick={() => void transfer()} disabled={!destination || source?.id === destination.id || !selected.size || busy}><Send />{busy ? "Working…" : `Add ${selected.size ? selected.size.toLocaleString() : "selected"}`}</Button>
          </div>
          <ScrollArea className="h-[480px] md:h-[540px]">
            <div className="divide-y divide-border">
              {filtered.map((m) => <label key={m.id} className="flex cursor-pointer items-center gap-3 px-4 py-3 transition-colors hover:bg-bg"><Checkbox checked={selected.has(m.id)} onCheckedChange={() => toggle(m.id)} disabled={busy} /><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{[m.firstName, m.lastName].filter(Boolean).join(" ") || "Unnamed user"}</p><p className="truncate font-mono text-xs text-subtle">{m.username ? `@${m.username}` : `Telegram ID ${m.id}`}</p></div>{m.activity !== "unknown" ? <Badge>{m.activity === "online" ? "online" : m.activity}</Badge> : null}{m.isBot ? <Badge>bot</Badge> : null}{m.isDeleted ? <Badge variant="warn">deleted</Badge> : null}</label>)}
              {!filtered.length && <div className="p-12 text-center"><Users className="mx-auto mb-3 size-7 text-subtle" /><p className="text-sm text-muted">{members.length ? "No members match your search." : "Load the source members to begin."}</p></div>}
            </div>
          </ScrollArea>
        </section>

        {lastResults.length > 0 && <section className="rounded-2xl border border-border bg-surface p-4 md:p-5">
          <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="font-medium">Transfer results</p><p className="text-sm text-muted">Telegram's response for every selected member.</p></div><Button variant="secondary" size="sm" onClick={() => downloadCsv(lastResults, members)}><Download />Export CSV</Button></div>
          <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-3"><ResultStat icon={<Check />} label="Added" value={addedCount} tone="ok" /><ResultStat icon={<X />} label="Not added" value={failedCount} tone="bad" /><ResultStat icon={<Users />} label="Attempted" value={lastResults.length} /></div>
          {failedCount > 0 && <details className="group mt-4 rounded-xl border border-border bg-bg"><summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-3 text-sm font-medium"><ChevronDown className="size-4 transition-transform group-open:rotate-180" />Show individual failures</summary><div className="divide-y divide-border border-t border-border">{lastResults.filter((r) => !r.ok).map((r) => <div key={r.id} className="flex gap-3 px-3 py-2.5 text-xs"><span className="font-mono text-subtle">{r.id}</span><span className="text-bad">{r.error || "Telegram rejected the operation."}</span></div>)}</div></details>}
        </section>}

        <footer className="flex flex-col gap-1 pb-4 text-xs leading-5 text-subtle md:flex-row md:items-center md:justify-between"><span>Real Telegram data. No generated groups or members.</span><span>Telegram remains authoritative over privacy, permissions and rate limits.</span></footer>
      </main>
    </div>
  );
}

function ResultStat({ icon, label, value, tone = "" }: { icon: React.ReactNode; label: string; value: number; tone?: "ok" | "bad" | "" }) {
  return <div className="rounded-xl border border-border bg-bg p-3"><div className={cn("mb-1 flex items-center gap-1.5 text-xs text-subtle", tone === "ok" && "text-ok", tone === "bad" && "text-bad")}>{icon}{label}</div><p className="text-xl font-medium tabular-nums">{value.toLocaleString()}</p></div>;
}

function LoginScreen({ phone, setPhone, step, code, setCode, password, setPassword, busy, onConnect, onCode, onPassword }: any) {
  return <div className="min-h-dvh bg-bg text-fg"><div className="mx-auto flex min-h-dvh w-full max-w-lg items-center px-4 py-8"><section className="w-full rounded-2xl border border-border bg-surface p-6 shadow-sm md:p-7"><div className="mb-6 flex items-center gap-3"><div className="rounded-xl bg-accent/10 p-3"><Smartphone className="size-6 text-accent" /></div><div><h1 className="font-display text-2xl font-medium">Connect Telegram</h1><p className="text-sm text-muted">Use your own Telegram account</p></div></div><div className="mb-5 rounded-xl border border-border bg-bg p-3 text-sm text-muted"><div className="flex gap-2"><ShieldCheck className="mt-0.5 size-4 shrink-0" /><span>Your Telegram session is kept on the server. Ferry never asks you to paste your API hash, session string, or Telegram verification code anywhere except the secure login step.</span></div></div>{step === "idle" ? <div className="space-y-3"><label className="block text-sm font-medium">Phone number</label><Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+251…" autoComplete="tel" /><Button className="w-full" disabled={!phone.trim() || busy} onClick={() => void onConnect()}>Send Telegram code</Button></div> : step === "code" ? <div className="space-y-3"><label className="block text-sm font-medium">Telegram verification code</label><Input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" placeholder="12345" /><Button className="w-full" disabled={!code.trim() || busy} onClick={() => void onCode()}>Verify code</Button><Button variant="ghost" className="w-full" disabled={busy} onClick={() => { setStep("idle"); setCode(""); }}>Use a different number</Button></div> : <div className="space-y-3"><label className="block text-sm font-medium">Telegram 2-step verification password</label><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /><Button className="w-full" disabled={!password || busy} onClick={() => void onPassword()}>Complete Telegram login</Button></div>}<Separator className="my-5" /><p className="text-xs leading-5 text-subtle">After login, Ferry reads the real groups and channels available to this account. Telegram controls which members can be viewed or invited.</p></section></div></div>;
}

function PublicTargetInput({ value, onChange, onResolve, disabled, loading, placeholder }: { value: string; onChange: (value: string) => void; onResolve: () => void; disabled?: boolean; loading?: boolean; placeholder: string }) {
  return <div className="rounded-xl border border-border bg-bg p-3"><div className="mb-2 flex items-center justify-between gap-2"><span className="text-xs font-medium uppercase tracking-wider text-subtle">Public link (optional)</span><span className="text-[11px] text-subtle">Telegram decides access</span></div><div className="flex gap-2"><Input value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} placeholder={placeholder} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onResolve(); } }} /><Button variant="secondary" size="sm" disabled={disabled || !value.trim()} onClick={onResolve}>{loading ? "Checking…" : "Use link"}</Button></div></div>;
}

function Picker({ label, hint, items, active, disabled, onPick }: { label: string; hint: string; items: TelegramDialog[]; active: string; disabled?: boolean; onPick: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? items.filter((d) => `${d.title} ${d.username ?? ""}`.toLowerCase().includes(q)) : items;
  }, [items, query]);
  return <section className="rounded-2xl border border-border bg-surface p-3 md:p-4"><div className="mb-3"><p className="text-xs font-medium uppercase tracking-wider text-subtle">{label}</p><p className="mt-1 text-sm text-muted">{hint}</p></div><div className="relative mb-3"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-subtle" /><Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search groups…" className="pl-9" /></div><ScrollArea className="h-56"><div className="grid gap-1.5 pr-2">{filtered.map((d) => <button type="button" disabled={disabled} key={d.id} onClick={() => onPick(d.id)} className={cn("flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50", active === d.id ? "border-accent/40 bg-accent/10" : "border-border bg-bg hover:bg-surface-2")}><span className="shrink-0"><Users className="size-4 text-muted" /></span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{d.title}</span><span className="block truncate font-mono text-xs text-subtle">{d.username ? `@${d.username}` : d.kind}{d.membersCount ? ` · ${d.membersCount.toLocaleString()}` : ""}</span></span>{active === d.id ? <Check className="size-4 text-accent" /> : null}</button>)}{!filtered.length ? <p className="p-6 text-center text-sm text-muted">{items.length ? "No groups match your search." : "No accessible groups/channels found."}</p> : null}</div></ScrollArea></section>;
}
