// Meeting summary: Markdown (rendered by the safe renderer), editable in place
// (meetings.update summaryMd; an empty text clears it).
import { memo, useId, useState } from "react";
import { UrlLink } from "@get-bb/plugin-sdk/app";
import type { MeetingDetail } from "../shared/rpc-contract";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useAsyncAction } from "./hooks";
import type { LinkRenderer } from "./markdown";
import { SafeMarkdown } from "./markdown";
import { useMeetingsRpc } from "./rpc";
import { CopyButton, EmptyState, ErrorText, Section, Spinner } from "./ui";

const renderLink: LinkRenderer = (href, children, key) => (
  <UrlLink key={key} href={href} className="underline underline-offset-2 hover:text-foreground">
    {children}
  </UrlLink>
);

/** Memoized: the detail page re-renders while audio plays, the summary does not need to. */
export const SummaryPanel = memo(function SummaryPanel({
  meeting,
  onSaved,
}: {
  meeting: MeetingDetail;
  onSaved: () => void;
}) {
  const rpc = useMeetingsRpc();
  const textareaId = useId();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const summary = meeting.summaryMd ?? "";
  const save = useAsyncAction(async () => {
    await rpc.call("meetings.update", { id: meeting.id, summaryMd: draft.trim() === "" ? null : draft });
    onSaved();
    setEditing(false);
  });
  const prompt = `сделай саммари встречи ${meeting.id}`;
  return (
    <Section
      title="Саммари"
      actions={
        editing ? undefined : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setDraft(summary);
              save.setError(null);
              setEditing(true);
            }}
          >
            <Icon name="Edit" className="size-3.5" aria-hidden />
            {summary.trim() === "" ? "Написать" : "Изменить"}
          </Button>
        )
      }
    >
      {editing ? (
        <div className="space-y-2">
          <label htmlFor={textareaId} className="sr-only">
            Текст саммари в Markdown
          </label>
          <textarea
            id={textareaId}
            value={draft}
            rows={14}
            maxLength={200_000}
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                void save.run();
              } else if (event.key === "Escape" && !save.pending) {
                event.preventDefault();
                setEditing(false);
              }
            }}
            className="block w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm leading-relaxed text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            placeholder={"## Итоги\n- …\n\n## Задачи\n- [ ] …"}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" disabled={save.pending} onClick={() => void save.run()}>
              {save.pending ? <Spinner /> : null}
              Сохранить
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={save.pending} onClick={() => setEditing(false)}>
              Отмена
            </Button>
            <span className="text-xs text-muted-foreground">Markdown · Ctrl+Enter — сохранить</span>
          </div>
          <ErrorText>{save.error}</ErrorText>
        </div>
      ) : summary.trim() === "" ? (
        <EmptyState className="py-4">
          <span className="inline-flex flex-wrap items-center justify-center gap-1">
            Саммари пока нет. Попросите агента: «{prompt}»
            <CopyButton text={prompt} label="Скопировать просьбу" />
          </span>
        </EmptyState>
      ) : (
        <div className="rounded-lg border border-border bg-card p-4">
          <SafeMarkdown source={summary} renderLink={renderLink} />
        </div>
      )}
    </Section>
  );
});
