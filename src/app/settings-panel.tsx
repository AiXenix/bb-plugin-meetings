import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { BotCard } from "./bot-card";
import { ProviderAccountCards } from "./accounts-panel";
import { fieldClass, Field, Toggle } from "./feature-controls";
import { useAsyncAction } from "./hooks";
import { IntegrationsPanel } from "./integrations-panel";
import { useMeetingsRpc } from "./rpc";
import type { MeetingsNav } from "./route";
import { TemplatesPanel } from "./templates-panel";
import { ErrorText, Spinner } from "./ui";
import { ZoomAccountCard } from "./zoom-card";

export type SettingsValues = Record<string, string | number | boolean | null | undefined>;
const TABS = [["recording", "Запись"], ["bot", "Бот"], ["analysis", "ИИ-разбор"], ["templates", "Шаблоны"], ["accounts", "Аккаунты"], ["integrations", "Интеграции"]] as const;
type Tab = typeof TABS[number][0];

export function SettingsPanel({ nav }: { nav: MeetingsNav }) {
  const [open, setOpen] = useState(false);
  return <details className="mt-5 rounded-lg border border-border bg-card" onToggle={event => setOpen(event.currentTarget.open)}><summary className="cursor-pointer px-4 py-3 text-sm font-medium">Настройки бота, разбора и интеграций</summary>{open ? <SettingsContent nav={nav} /> : null}</details>;
}

function SettingsContent({ nav }: { nav: MeetingsNav }) {
  const rpc = useMeetingsRpc();
  const [tab, setTab] = useState<Tab>("recording");
  const [settings, setSettings] = useState<SettingsValues | null>(null);
  const [patch, setPatch] = useState<SettingsValues>({});
  const [saved, setSaved] = useState(false);
  const load = useAsyncAction(async () => { setSettings((await rpc.call("notetaker.settings", {})).settings as SettingsValues); });
  const refresh = load.run;
  useEffect(() => { void refresh(); }, [refresh]);
  const update = (key: string, value: string | number | boolean) => { setPatch(previous => ({ ...previous, [key]: value })); setSaved(false); };
  const value = (key: string) => patch[key] ?? settings?.[key];
  const savePatch = async (next: SettingsValues) => {
    const clean = Object.fromEntries(Object.entries(next).filter(([key, value]) => !(["aiApiKey", "webhookSecret", "calendarIcsUrls"].includes(key) && value === "")));
    setSettings((await rpc.call("notetaker.settings", { patch: clean })).settings as SettingsValues);
    setPatch(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => !(key in next))));
    setSaved(true);
  };
  const save = useAsyncAction(async () => savePatch(patch));
  const boolean = (key: string, label: string) => <Toggle key={key} label={label} checked={value(key) === true} onChange={checked => update(key, checked)} />;
  const number = (key: string, label: string, min: number, max: number, step = 1) => <Field key={key} label={label}><input className={fieldClass} type="number" min={min} max={max} step={step} value={Number(value(key) ?? min)} onChange={event => update(key, event.target.valueAsNumber)} /></Field>;
  const text = (key: string, label: string, hint?: string, secret = false) => <Field key={key} label={label} hint={hint}><input className={fieldClass} type={secret ? "password" : "text"} autoComplete={secret ? "new-password" : "off"} value={String(secret ? patch[key] ?? "" : value(key) ?? "")} onChange={event => update(key, event.target.value)} placeholder={secret ? "Оставьте пустым, чтобы сохранить ключ" : undefined} /></Field>;
  return <div className="min-w-0 border-t border-border p-3">
    <div role="tablist" aria-label="Настройки встреч" className="mb-4 flex flex-wrap gap-1">{TABS.map(([id, label]) => <button type="button" role="tab" aria-selected={tab === id} key={id} className={`rounded-md px-2.5 py-1.5 text-xs font-medium ${tab === id ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50"}`} onClick={() => setTab(id)}>{label}</button>)}</div>
    <ErrorText>{load.error}</ErrorText>
    {settings === null && load.error === null ? <p className="flex items-center gap-2 text-xs text-muted-foreground"><Spinner />Загружаем настройки…</p> : null}
    <div role="tabpanel" className="min-w-0 space-y-4">
      {tab === "recording" && settings ? <>
        <div className="grid gap-3 sm:grid-cols-2">{number("maxDurationMinutes", "Максимальная запись, мин", 5, 1440)}{number("maxConcurrentBots", "Одновременно ботов", 1, 8)}{number("waitingTimeoutMinutes", "Ожидание впуска, мин", 1, 240)}{number("aloneTimeoutMinutes", "Выйти, если остался один, мин", 0.5, 60, 0.5)}{number("silenceTimeoutMinutes", "Выйти при тишине, мин (0 — никогда)", 0, 240)}{number("screenshotIntervalSec", "Скриншоты, секунд (0 — по событиям)", 0, 300)}</div>
        <div className="grid gap-2 sm:grid-cols-2">{boolean("autoTranscribe", "Расшифровывать автоматически")}{boolean("liveTranscription", "Расшифровывать во время встречи")}{boolean("keepRawAudio", "Сохранять несжатый звук")}{boolean("notifyThread", "Сообщать агенту о завершении")}</div>
        {text("chatAnnouncement", "Сообщение в чат после подключения", "Пусто — не отправлять сообщение")}
        <div className="grid gap-3 sm:grid-cols-2"><Field label="Разделение по спикерам"><select className={fieldClass} value={String(value("diarization") ?? "ui+acoustic")} onChange={event => update("diarization", event.target.value)}><option value="ui+acoustic">Интерфейс и голоса</option><option value="ui">Интерфейс встречи</option><option value="acoustic">По голосам</option></select></Field>{number("speakerLagMs", "Задержка индикатора спикера, мс", 0, 5000)}{text("gigaamUrl", "Сервер распознавания", "Пусто — GigaAM этого BB")}{text("chromePath", "Путь к Chrome", "Пусто — определить автоматически")}</div>
        <details><summary className="cursor-pointer text-xs text-muted-foreground">Календарь и расширенные настройки</summary><div className="mt-3 grid gap-3 sm:grid-cols-2">{boolean("calendarAutoJoin", "Автоматически входить по календарю")}{number("calendarLeadMinutes", "Входить заранее, мин", 0, 30)}{number("calendarOvertimeMinutes", "Задержаться после события, мин", 0, 600)}{number("calendarSyncMinutes", "Синхронизация календаря, мин", 1, 120)}{text("calendarFilter", "Фильтр событий")}{text("calendarIcsUrls", "Ссылки ICS", "Новые секретные ссылки через пробел; пусто сохраняет текущие", true)}{text("speakerSelectors", "Селекторы спикеров (JSON)")}</div></details>
      </> : null}
      {tab === "bot" ? <BotCard /> : null}
      {tab === "analysis" && settings ? <>
        {boolean("autoSummarize", "Автоматически разбирать готовые расшифровки")}
        <Field label="Как выполнять разбор"><select className={fieldClass} value={String(value("summaryMode") ?? "agent")} onChange={event => update("summaryMode", event.target.value)}><option value="agent">Агент BB</option><option value="api">Настроенный API</option></select></Field>
        <p className="text-xs leading-relaxed text-muted-foreground">{value("summaryMode") === "api" ? "Разбор и ответы выполняются через ваш API. Текст расшифровки передаётся выбранному провайдеру." : "Запрос на разбор получит агент в треде, который запустил встречу. Для записей из интерфейса запрос можно скопировать из карточки встречи."}</p>
        {value("summaryMode") === "api" ? <div className="grid gap-3 sm:grid-cols-2">{text("aiBaseUrl", "Адрес API", "Например https://api.example.com/v1")}{text("aiModel", "Модель")}{text("aiApiKey", "Ключ API", value("aiApiKeyConfigured") ? "Ключ уже сохранён" : "Ключ ещё не задан", true)}</div> : null}
        <Field label="Запрос агенту после встречи"><textarea rows={4} className={`${fieldClass} resize-y text-xs`} value={String(value("autoSummaryPrompt") ?? "")} onChange={event => update("autoSummaryPrompt", event.target.value)} /></Field>
      </> : null}
      {tab === "templates" && settings ? <TemplatesPanel defaultId={String(value("summaryTemplateId") ?? "executive")} onDefault={async id => savePatch({ summaryTemplateId: id })} /> : null}
      {tab === "accounts" ? <><ZoomAccountCard nav={nav} /><ProviderAccountCards nav={nav} /></> : null}
      {tab === "integrations" ? <><IntegrationsPanel /><div className="grid gap-3 sm:grid-cols-2">{text("webhookUrl", "Webhook завершения встречи")}{text("webhookSecret", "Секрет подписи", value("webhookSecretConfigured") ? "Секрет уже сохранён" : "Секрет не задан", true)}</div><p className="text-xs text-muted-foreground">Webhook отправляется после завершения расшифровки. Настройки агента и MCP доступны выше.</p></> : null}
    </div>
    {settings && (tab === "recording" || tab === "analysis" || tab === "integrations") ? <div className="mt-4 flex flex-wrap items-center gap-2"><Button size="sm" disabled={save.pending || Object.keys(patch).length === 0} onClick={() => void save.run()}>{save.pending ? <Spinner /> : null}Сохранить настройки</Button>{saved ? <span role="status" className="text-xs text-muted-foreground">Сохранено</span> : null}<ErrorText>{save.error}</ErrorText></div> : null}
  </div>;
}
