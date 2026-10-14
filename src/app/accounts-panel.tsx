import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Toggle } from "./feature-controls";
import { useAsyncAction, useInterval } from "./hooks";
import { LiveView } from "./live-view";
import { useMeetingsRpc } from "./rpc";
import type { MeetingsNav } from "./route";
import { ConfirmDialog, ErrorText, Notice, PageFrame, Spinner } from "./ui";

export type AccountPlatform = "zoom" | "meet" | "telemost";
export const ACCOUNT_LABELS: Record<AccountPlatform, string> = { zoom: "Zoom", meet: "Google Meet", telemost: "Яндекс Телемост" };
interface Account {
  platform: AccountPlatform;
  enabled: boolean;
  profile: { exists: boolean; signedIn: boolean; updatedAt: number | null };
  session: { id: string; phase: string; detail: string; error: string | null } | null;
}
const settingKey: Record<AccountPlatform, string> = { zoom: "useZoomAccount", meet: "useMeetAccount", telemost: "useTelemostAccount" };
const running = (account: Account | null) => account?.session != null && !["ended", "failed"].includes(account.session.phase);

function useAccounts(poll = false) {
  const rpc = useMeetingsRpc();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const load = useAsyncAction(async () => setAccounts((await rpc.call("accounts.status", {})).accounts));
  const refresh = load.run;
  useEffect(() => { void refresh(); }, [refresh]);
  useInterval(() => void refresh(), poll || accounts.some(running) ? 3000 : null);
  const update = (account: Account) => setAccounts(previous => previous.some(current => current.platform === account.platform) ? previous.map(current => current.platform === account.platform ? account : current) : [...previous, account]);
  return { accounts, load, refresh, update };
}

export function ProviderAccountCards({ nav }: { nav: MeetingsNav }) {
  const state = useAccounts();
  return <div className="grid gap-3 sm:grid-cols-2">{(["meet", "telemost"] as const).map(platform => <ProviderAccountCard key={platform} platform={platform} account={state.accounts.find(account => account.platform === platform) ?? null} onUpdated={state.update} nav={nav} />)}<ErrorText>{state.load.error}</ErrorText></div>;
}

function ProviderAccountCard({ platform, account, onUpdated, nav }: { platform: AccountPlatform; account: Account | null; onUpdated: (account: Account) => void; nav: MeetingsNav }) {
  const rpc = useMeetingsRpc();
  const label = ACCOUNT_LABELS[platform];
  const [confirm, setConfirm] = useState(false);
  const login = useAsyncAction(async () => { onUpdated((await rpc.call("accounts.loginStart", { platform })).account); nav.toAccountLogin?.(platform); });
  const logout = useAsyncAction(async () => { onUpdated((await rpc.call("accounts.logout", { platform })).account); setConfirm(false); });
  const toggle = useAsyncAction(async (enabled: boolean) => { await rpc.call("notetaker.settings", { patch: { [settingKey[platform]]: enabled } }); if (account) onUpdated({ ...account, enabled }); });
  return <div className="min-w-0 space-y-3 rounded-lg border border-border bg-card p-3">
    <div><h3 className="text-sm font-medium">{label}</h3><p className="mt-1 text-xs text-muted-foreground">{account?.profile.signedIn ? "Аккаунт подключён" : "Вход не выполнен"}</p></div>
    <Toggle label="Использовать аккаунт для встреч" checked={account?.enabled ?? false} disabled={!account || toggle.pending} onChange={enabled => void toggle.run(enabled)} />
    {running(account) ? <p className="flex items-center gap-1 text-xs text-muted-foreground"><Spinner />Открыт сеанс входа</p> : null}
    {account?.session?.error ? <ErrorText className="text-xs">{account.session.error}</ErrorText> : null}
    <div className="flex flex-wrap gap-2"><Button size="sm" disabled={login.pending} onClick={() => running(account) ? nav.toAccountLogin?.(platform) : void login.run()}>{login.pending ? <Spinner /> : null}{running(account) ? "Открыть вход" : `Войти в ${label}`}</Button>{account?.profile.exists ? <Button size="sm" variant="outline" onClick={() => setConfirm(true)}>Выйти</Button> : null}</div>
    <ErrorText className="text-xs">{login.error ?? toggle.error}</ErrorText>
    <ConfirmDialog open={confirm} onOpenChange={setConfirm} title={`Выйти из ${label}?`} description="Сохранённый профиль бота будет удалён. Новые записи будут подключаться как гости." confirmLabel="Выйти" destructive pending={logout.pending} error={logout.error} onConfirm={() => void logout.run()} />
  </div>;
}

export function AccountLoginPage({ platform, nav }: { platform: AccountPlatform; nav: MeetingsNav }) {
  const rpc = useMeetingsRpc();
  const state = useAccounts(true);
  const account = state.accounts.find(current => current.platform === platform) ?? null;
  const label = ACCOUNT_LABELS[platform];
  const start = useAsyncAction(async () => state.update((await rpc.call("accounts.loginStart", { platform })).account));
  const finish = useAsyncAction(async () => state.update((await rpc.call("accounts.loginFinish", { platform })).account));
  const enable = useAsyncAction(async () => { await rpc.call("notetaker.settings", { patch: { [settingKey[platform]]: true } }); await state.refresh(); });
  return <PageFrame wide><Button size="sm" variant="ghost" onClick={() => nav.toList()}>← Все встречи</Button><h1 className="mt-3 text-lg font-semibold">Вход в {label}</h1><p className="mt-1 text-sm leading-relaxed text-muted-foreground">Войдите в аккаунт бота через «Управление» в браузере ниже. После входа нажмите «Готово», чтобы сохранить профиль.</p>
    <ErrorText className="mt-3">{state.load.error ?? start.error ?? finish.error ?? enable.error}</ErrorText>
    {running(account) && account?.session ? <><p className="mt-3 break-words text-xs text-muted-foreground">{account.session.detail}</p><LiveView id={account.session.id} title={`Браузер ${label}`} defaultControl className="mt-3" actions={<Button size="sm" disabled={finish.pending} onClick={() => void finish.run()}>{finish.pending ? <Spinner /> : null}Готово</Button>} /></> : account?.profile.signedIn ? <Notice tone="success" title={`Вход в ${label} выполнен`} className="mt-4"><p className="text-xs text-muted-foreground">Профиль бота сохранён на машине записи.</p><div className="flex flex-wrap gap-2">{!account.enabled ? <Button size="sm" disabled={enable.pending} onClick={() => void enable.run()}>Использовать для встреч</Button> : null}<Button size="sm" variant="outline" onClick={() => nav.toList()}>К встречам</Button></div></Notice> : <div className="mt-4 space-y-3 rounded-lg border border-border p-4"><p className="text-xs text-muted-foreground">{account?.session?.error ?? "Сеанс входа длится до 15 минут."}</p><Button size="sm" disabled={start.pending || state.load.pending} onClick={() => void start.run()}>{start.pending ? <Spinner /> : null}Начать вход</Button></div>}
  </PageFrame>;
}
