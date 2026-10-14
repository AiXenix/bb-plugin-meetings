import { useState } from "react";
import type { AskResult } from "../shared/analysis";
import { Button } from "@/components/ui/button";
import { fieldClass } from "./feature-controls";
import { formatClock } from "./format";
import { useAsyncAction } from "./hooks";
import { SafeMarkdown } from "./markdown";
import { useMeetingsRpc } from "./rpc";
import type { MeetingsNav } from "./route";
import { CopyButton, ErrorText, Spinner } from "./ui";

export function AgentPrompt({ prompt }: { prompt: string }) {
  return <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3"><p className="text-xs leading-relaxed text-muted-foreground">Разбор выполняет агент BB. Скопируйте запрос и отправьте его агенту в тред; здесь появится сохранённый результат.</p><div className="flex items-center gap-1 text-xs font-medium">Скопировать запрос агенту<CopyButton text={prompt} label="Скопировать запрос агенту" /></div><details><summary className="cursor-pointer text-xs text-muted-foreground">Показать запрос</summary><pre className="mt-2 max-h-56 overflow-y-auto whitespace-pre-wrap break-words text-xs">{prompt}</pre></details></div>;
}

export function AskPanel({ id, nav }: { id?: string; nav: MeetingsNav }) {
  const rpc = useMeetingsRpc();
  const [question, setQuestion] = useState("");
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<(Pick<AskResult, "answer" | "citations"> & { needsAgent?: boolean; prompt?: string | null }) | null>(null);
  const ask = useAsyncAction(async () => setResult(await rpc.call("meetings.ask", { question: question.trim(), ...(id ? { id } : {}), ...(query.trim() ? { query: query.trim() } : {}) })));
  return <details className="mt-4 rounded-lg border border-border bg-card"><summary className="cursor-pointer px-4 py-3 text-sm font-medium">{id ? "Вопрос по этой встрече" : "Вопрос по всем встречам"}</summary><div className="space-y-3 border-t border-border p-3">
    <form className="space-y-2" onSubmit={event => { event.preventDefault(); if (question.trim()) void ask.run(); }}>
      <textarea aria-label={id ? "Вопрос по этой встрече" : "Вопрос по всем встречам"} required rows={2} maxLength={2000} className={`${fieldClass} resize-y`} value={question} onChange={event => setQuestion(event.target.value)} placeholder="Какие решения приняли по срокам?" />
      {!id ? <input aria-label="Поиск встреч для ответа" className={fieldClass} value={query} onChange={event => setQuery(event.target.value)} placeholder="Слова в расшифровках для поиска (необязательно)" /> : null}
      <Button size="sm" type="submit" disabled={ask.pending || !question.trim()}>{ask.pending ? <Spinner /> : null}Задать вопрос</Button>
    </form>
    <ErrorText>{ask.error}</ErrorText>
    {result?.needsAgent && result.prompt ? <AgentPrompt prompt={result.prompt} /> : result ? <div className="min-w-0 space-y-3 text-sm"><SafeMarkdown source={result.answer} />{result.citations.length ? <div className="space-y-2 border-t border-border pt-2"><p className="text-xs font-medium">Из расшифровок</p>{result.citations.map((citation, index) => <button key={`${citation.meetingId}-${citation.segmentId}-${index}`} className="block w-full min-w-0 rounded-md border border-border p-2 text-left hover:bg-muted/50" onClick={() => nav.toMeeting(citation.meetingId, citation.segmentId)}><span className="text-xs text-muted-foreground">{citation.meetingTitle} · {formatClock(citation.timecodeSec)} · {citation.speaker}</span><span className="mt-1 block break-words text-xs">{citation.quote}</span></button>)}</div> : null}</div> : null}
  </div></details>;
}
