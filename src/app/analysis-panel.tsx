import { useEffect, useState } from "react";
import { useRealtime } from "@get-bb/plugin-sdk/app";
import type { MeetingAnalysis, SummaryTemplate } from "../shared/analysis";
import { Button } from "@/components/ui/button";
import { AgentPrompt } from "./ask-panel";
import { fieldClass, Field } from "./feature-controls";
import { formatClock, formatDuration } from "./format";
import { useAsyncAction, useDebouncedCallback, useOnReconnect } from "./hooks";
import { CHANNEL_MEETING_CHANGED } from "./constants";
import { SafeMarkdown } from "./markdown";
import { useMeetingsRpc } from "./rpc";
import { CopyButton, ErrorText, Section, Spinner } from "./ui";

const TABS = [["overview", "Итоги"], ["tasks", "Задачи"], ["chapters", "Главы"], ["metrics", "Участники"], ["followup", "Следующее письмо"]] as const;
type Tab = typeof TABS[number][0];
const PRIORITY = { high: "Высокий приоритет", medium: "Средний приоритет", low: "Низкий приоритет" };

export function AnalysisPanel({ id, onSaved, onSeek }: { id: string; onSaved: () => void; onSeek: ((seconds: number) => void) | null }) {
  const rpc = useMeetingsRpc();
  const [analysis, setAnalysis] = useState<MeetingAnalysis | null>(null);
  const [templates, setTemplates] = useState<SummaryTemplate[]>([]);
  const [templateId, setTemplateId] = useState("executive");
  const [prompt, setPrompt] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const load = useAsyncAction(async () => {
    const result = await rpc.call("meetings.analysis", { id });
    setAnalysis(result.analysis);
    setTemplates(result.templates);
    setTemplateId(result.analysis?.insights.template ?? result.templateId);
    if (result.analysis) setPrompt(null);
  });
  const refresh = load.run;
  useEffect(() => { void refresh(); }, [id, refresh]);
  const debounced = useDebouncedCallback(() => void refresh(), 250);
  useRealtime(CHANNEL_MEETING_CHANGED, (payload: unknown) => {
    const target = typeof payload === "object" && payload !== null ? (payload as { id?: unknown }).id : undefined;
    if (target === undefined || target === id) debounced();
  });
  useOnReconnect(() => void refresh());
  const generate = useAsyncAction(async () => {
    const result = await rpc.call("meetings.analyze", { id, templateId });
    if (result.needsAgent) { setPrompt(result.prompt); return; }
    setPrompt(null);
    setAnalysis(result.analysis);
    onSaved();
  });
  const updateTask = useAsyncAction(async (itemId: string, done: boolean) => { setAnalysis((await rpc.call("meetings.actionItem", { id, itemId, done })).analysis); onSaved(); });
  const insights = analysis?.insights;
  const selected = templates.find(template => template.id === templateId);
  const completed = insights?.actionItems.filter(item => item.done).length ?? 0;
  const timestamp = (seconds: number) => onSeek ? <button type="button" className="shrink-0 font-mono text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground" onClick={() => onSeek(seconds)}>{formatClock(seconds)}</button> : <span className="shrink-0 font-mono text-xs text-muted-foreground">{formatClock(seconds)}</span>;
  return <Section title="Разбор встречи" actions={<Button size="sm" variant="ghost" disabled={load.pending} onClick={() => void refresh()}>{load.pending ? <Spinner /> : null}Обновить</Button>}>
    <div className="min-w-0 space-y-3 rounded-lg border border-border bg-card p-3">
      <div className="flex flex-wrap items-end gap-2"><div className="min-w-0 flex-1"><Field label="Шаблон для разбора"><select className={fieldClass} value={templateId} onChange={event => setTemplateId(event.target.value)}>{templates.length === 0 ? <option value={templateId}>Шаблон из настроек</option> : templates.map(template => <option key={template.id} value={template.id}>{template.label}</option>)}</select></Field></div><Button size="sm" disabled={generate.pending || load.pending} onClick={() => void generate.run()}>{generate.pending ? <Spinner /> : null}{analysis ? "Разобрать заново" : "Разобрать встречу"}</Button></div>
      {selected ? <details className="text-xs"><summary className="cursor-pointer text-muted-foreground">Правила выбранного шаблона</summary><pre className="mt-2 max-h-56 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-2 leading-relaxed">{selected.prompt}</pre></details> : null}
      <ErrorText>{load.error ?? generate.error ?? updateTask.error}</ErrorText>
      {prompt ? <AgentPrompt prompt={prompt} /> : null}
      {!insights && !prompt && !load.pending ? <p className="text-xs text-muted-foreground">Разбор ещё не сохранён. Выберите шаблон и запустите его по готовой расшифровке.</p> : null}
      {insights ? <>
        <div className="flex flex-wrap gap-1 border-t border-border pt-3" role="tablist" aria-label="Разделы разбора">{TABS.map(([value, label]) => <button type="button" role="tab" aria-selected={tab === value} key={value} className={`rounded-md px-2.5 py-1.5 text-xs ${tab === value ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/50"}`} onClick={() => setTab(value)}>{label}{value === "tasks" ? ` ${completed}/${insights.actionItems.length}` : ""}</button>)}</div>
        <div role="tabpanel" className="min-w-0 space-y-3 text-sm">
          {tab === "overview" ? <>
            <SafeMarkdown source={insights.tldr} />
            {insights.keyTopics.length ? <div className="flex flex-wrap gap-1.5">{insights.keyTopics.map((topic, index) => <span key={index} className="max-w-full break-words rounded-md bg-muted px-2 py-1 text-xs">{topic}</span>)}</div> : null}
            {insights.decisions.length ? <div><h3 className="text-xs font-semibold">Решения</h3><ul className="mt-1 list-disc space-y-1 pl-4 text-sm">{insights.decisions.map((decision, index) => <li className="break-words" key={index}>{decision}</li>)}</ul></div> : null}
            {insights.risks.length ? <div><h3 className="text-xs font-semibold">Открытые вопросы и риски</h3><ul className="mt-1 list-disc space-y-1 pl-4 text-sm">{insights.risks.map((risk, index) => <li className="break-words" key={index}>{risk}</li>)}</ul></div> : null}
            <p className="text-xs text-muted-foreground">Тон встречи: {insights.sentiment.label} · {Math.round(insights.sentiment.score)}/100</p>
          </> : null}
          {tab === "tasks" ? insights.actionItems.length ? <div className="space-y-2">{insights.actionItems.map(item => <div key={item.id} className="flex min-w-0 items-start gap-2 rounded-md border border-border p-2.5"><input type="checkbox" aria-label={`Выполнено: ${item.task}`} className="mt-0.5 size-4 shrink-0 accent-current" checked={item.done} disabled={updateTask.pending} onChange={event => void updateTask.run(item.id, event.target.checked)} /><div className="min-w-0 flex-1"><p className={`break-words text-sm ${item.done ? "text-muted-foreground line-through" : "text-foreground"}`}>{item.task}</p><p className="mt-1 break-words text-xs text-muted-foreground">{item.assignee || "Ответственный не указан"}{item.due ? ` · ${item.due}` : ""} · {PRIORITY[item.priority]}</p></div>{timestamp(item.timecodeSec)}</div>)}</div> : <p className="text-xs text-muted-foreground">Задачи в расшифровке не найдены.</p> : null}
          {tab === "chapters" ? insights.chapters.length ? <div className="space-y-2">{insights.chapters.map((chapter, index) => <div key={index} className="flex min-w-0 items-start gap-3 rounded-md border border-border p-3">{timestamp(chapter.startSec)}<div className="min-w-0"><h3 className="break-words text-sm font-medium">{chapter.title}</h3><p className="mt-1 break-words text-xs leading-relaxed text-muted-foreground">{chapter.summary}</p></div></div>)}</div> : <p className="text-xs text-muted-foreground">Главы не выделены.</p> : null}
          {tab === "metrics" ? <div className="space-y-3">{insights.speakerMetrics.map((metric, index) => <div key={index} className="min-w-0 space-y-1.5"><div className="flex min-w-0 justify-between gap-3"><span className="min-w-0 break-words text-sm font-medium">{metric.speaker}</span><span className="shrink-0 text-xs text-muted-foreground">{Math.round(metric.sharePercent)}% · {formatDuration(metric.talkTimeSec)}</span></div><div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-foreground/50" style={{ width: `${metric.sharePercent}%` }} /></div><p className="text-xs text-muted-foreground">{metric.wordCount} слов · {Math.round(metric.wordsPerMin)} слов/мин · {metric.questionsAsked} вопросов · {metric.segmentCount} реплик</p></div>)}</div> : null}
          {tab === "followup" ? insights.followUpDraft ? <div className="space-y-2"><div className="flex items-center justify-between gap-2"><h3 className="text-xs font-medium">Черновик следующего письма</h3><CopyButton text={insights.followUpDraft} label="Скопировать черновик письма" /></div><SafeMarkdown source={insights.followUpDraft} /></div> : <p className="text-xs text-muted-foreground">Черновик письма не сформирован.</p> : null}
        </div>
        <details className="border-t border-border pt-2 text-xs"><summary className="cursor-pointer text-muted-foreground">Применённые правила · {insights.templateSnapshot.label}</summary><pre className="mt-2 max-h-56 overflow-y-auto whitespace-pre-wrap break-words leading-relaxed">{insights.templateSnapshot.prompt}</pre></details>
        {insights.context.truncated ? <p className="text-xs text-muted-foreground">В разбор вошло {insights.context.includedSegments} из {insights.context.totalSegments} фрагментов расшифровки.</p> : null}
      </> : null}
    </div>
  </Section>;
}
