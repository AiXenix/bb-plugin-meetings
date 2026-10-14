import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useAsyncAction } from "./hooks";
import { useMeetingsRpc } from "./rpc";
import { ConfirmDialog, CopyButton, ErrorText, Spinner } from "./ui";
import { fieldClass } from "./feature-controls";

export function IntegrationsPanel() {
  const rpc = useMeetingsRpc();
  const [configured, setConfigured] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [meta, setMeta] = useState<Record<string, unknown> | null>(null);
  const [confirm, setConfirm] = useState<"replace" | "revoke" | null>(null);
  const load = useAsyncAction(async () => { const [status, info] = await Promise.all([rpc.call("agent.tokenStatus", {}), rpc.call("agent.meta", {})]); setConfigured(status.configured); setMeta(info); });
  const refresh = load.run;
  useEffect(() => { void refresh(); }, [refresh]);
  const create = useAsyncAction(async () => { const result = await rpc.call("agent.tokenCreate", {}); setToken(result.token); setConfigured(true); setConfirm(null); });
  const revoke = useAsyncAction(async () => { await rpc.call("agent.tokenRevoke", {}); setToken(null); setConfigured(false); setConfirm(null); });
  const absolute = (path: unknown, fallback: string) => new URL(typeof path === "string" ? path : fallback, window.location.origin).toString();
  const mcpUrl = absolute(meta?.personalMcpPath ?? meta?.mcpPath, "/api/v1/plugins/meetings/http/mcp");
  const apiUrl = absolute(meta?.personalApiPath ?? meta?.apiPath, "/api/v1/plugins/meetings/http/api");
  const stdioConfig = JSON.stringify({ mcpServers: { meetings: { command: "node", args: ["/path/to/bb-plugin-meetings/integrations/mcp/stdio.mjs"] } } }, null, 2);
  return <div className="space-y-3">
    <p className="text-xs leading-relaxed text-muted-foreground">Внешние агенты работают с тем же реестром встреч BB через MCP и JSON API.</p>
    <div className="space-y-2 rounded-md border border-border p-3">
      <div className="flex items-center justify-between gap-2"><p className="text-xs font-medium">MCP · stdio</p><CopyButton text={stdioConfig} label="Скопировать пример конфигурации MCP" /></div>
      <p className="text-xs leading-relaxed text-muted-foreground">Укажите путь к плагину на машине агента. Команда bb должна уже иметь доступ к вашей BB; дополнительный токен не нужен.</p>
      <pre className="max-w-full overflow-x-auto whitespace-pre text-[11px] text-muted-foreground">{stdioConfig}</pre>
    </div>
    <details className="space-y-2 rounded-md border border-border p-3"><summary className="cursor-pointer text-xs font-medium">HTTP MCP и JSON API</summary>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">Через BB Connect клиенту также нужна авторизация BB. Токен плагина сам по себе не открывает доступ через getbb.app.</p>
      {[["MCP", mcpUrl], ["JSON API", apiUrl]].map(([label, url]) => <div key={label} className="min-w-0 pt-2"><p className="text-xs font-medium">{label}</p><div className="flex min-w-0 items-start gap-1"><code className="min-w-0 break-all text-xs text-muted-foreground">{url}</code><CopyButton text={url} label={`Скопировать адрес ${label}`} /></div></div>)}
    <p className="text-xs text-muted-foreground">{configured ? "Токен создан. Его значение повторно не показывается." : "Внешний доступ по токену ещё не настроен."}</p>
    {meta?.webhookHeader ? <p className="break-words text-xs text-muted-foreground">Подпись webhook: {String(meta.webhookHeader)} · {String(meta.webhookAlgorithm ?? "HMAC SHA-256")}</p> : null}
    <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={create.pending} onClick={() => configured ? setConfirm("replace") : void create.run()}>{create.pending ? <Spinner /> : null}{configured ? "Заменить токен" : "Создать токен"}</Button>{configured ? <Button size="sm" variant="outline" onClick={() => setConfirm("revoke")}>Отозвать токен</Button> : null}</div>
    {token ? <div className="space-y-2 rounded-md border border-border p-3"><p className="text-xs text-muted-foreground">Сохраните токен сейчас. Передавайте его в заголовке Authorization: Bearer.</p><div className="flex min-w-0 items-center gap-1"><input className={`${fieldClass} font-mono text-xs`} readOnly aria-label="Новый токен агента" value={token} /><CopyButton text={token} label="Скопировать токен агента" /></div><Button size="sm" variant="ghost" onClick={() => setToken(null)}>Скрыть токен</Button></div> : null}
    </details>
    <ErrorText>{load.error ?? create.error ?? revoke.error}</ErrorText>
    <ConfirmDialog open={confirm !== null} onOpenChange={open => { if (!open) setConfirm(null); }} title={confirm === "revoke" ? "Отозвать токен?" : "Заменить токен?"} description="Агенты со старым токеном потеряют доступ к встречам." confirmLabel={confirm === "revoke" ? "Отозвать" : "Заменить"} destructive pending={create.pending || revoke.pending} error={create.error ?? revoke.error} onConfirm={() => void (confirm === "revoke" ? revoke.run() : create.run())} />
  </div>;
}
