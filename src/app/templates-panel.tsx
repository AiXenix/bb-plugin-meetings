import { useCallback, useEffect, useState } from "react";
import type { SummaryTemplate } from "../shared/analysis";
import { Button } from "@/components/ui/button";
import { useAsyncAction } from "./hooks";
import { fieldClass, Field } from "./feature-controls";
import { useMeetingsRpc } from "./rpc";
import { ConfirmDialog, CopyButton, ErrorText, Spinner } from "./ui";

export function TemplatesPanel({ defaultId, onDefault }: { defaultId: string; onDefault: (id: string) => Promise<void> }) {
  const rpc = useMeetingsRpc();
  const [templates, setTemplates] = useState<SummaryTemplate[]>([]);
  const [selected, setSelected] = useState<SummaryTemplate | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ label: "", description: "", prompt: "" });
  const [copyFrom, setCopyFrom] = useState<string | undefined>();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const load = useAsyncAction(async () => {
    const result = await rpc.call("templates.list", {});
    setTemplates(result.templates);
    setSelected(previous => result.templates.find(template => template.id === previous?.id) ?? result.templates.find(template => template.id === defaultId) ?? result.templates[0] ?? null);
  });
  const refresh = load.run;
  useEffect(() => { void refresh(); }, [refresh]);
  const begin = (mode: "new" | "copy" | "edit") => {
    setCopyFrom(mode === "copy" ? selected?.id : undefined);
    setDraft(mode === "new" ? { label: "", description: "", prompt: "" } : { label: `${selected?.label ?? ""}${mode === "copy" ? " — копия" : ""}`, description: selected?.description ?? "", prompt: selected?.prompt ?? "" });
    if (mode === "new" || mode === "copy") setSelected(null);
    setEditing(true);
  };
  const save = useAsyncAction(async () => {
    const result = await rpc.call("templates.save", { ...draft, ...(selected?.editable ? { id: selected.id } : {}), ...(copyFrom ? { copyFrom } : {}) });
    setEditing(false);
    await refresh();
    setSelected(result.template);
  });
  const remove = useAsyncAction(async () => {
    if (!selected) return;
    await rpc.call("templates.delete", { id: selected.id });
    setDeleteOpen(false);
    setSelected(null);
    await refresh();
  });
  const makeDefault = useAsyncAction(async () => { if (selected) await onDefault(selected.id); });
  const choose = useCallback((id: string) => { setSelected(templates.find(template => template.id === id) ?? null); setEditing(false); }, [templates]);
  return <div className="space-y-3">
    <p className="text-xs leading-relaxed text-muted-foreground">Пять готовых шаблонов и ваши правила. Готовый шаблон можно скопировать и изменить для своего процесса.</p>
    <div className="flex flex-wrap items-end gap-2"><div className="min-w-0 flex-1"><Field label="Шаблон"><select className={fieldClass} value={selected?.id ?? ""} onChange={event => choose(event.target.value)}><option value="" disabled>Выберите шаблон</option>{templates.map(template => <option key={template.id} value={template.id}>{template.label}{template.id === defaultId ? " · по умолчанию" : ""}</option>)}</select></Field></div><Button size="sm" variant="outline" onClick={() => begin("new")}>Новый</Button></div>
    {editing ? <form className="space-y-3" onSubmit={event => { event.preventDefault(); void save.run(); }}>
      <Field label="Название шаблона"><input required maxLength={120} className={fieldClass} value={draft.label} onChange={event => setDraft({ ...draft, label: event.target.value })} /></Field>
      <Field label="Описание"><input maxLength={1000} className={fieldClass} value={draft.description} onChange={event => setDraft({ ...draft, description: event.target.value })} /></Field>
      <Field label="Полный текст правил"><textarea required maxLength={12000} className={`${fieldClass} min-h-48 resize-y font-mono text-xs leading-relaxed`} rows={10} value={draft.prompt} onChange={event => setDraft({ ...draft, prompt: event.target.value })} /></Field>
      <div className="flex flex-wrap gap-2"><Button type="submit" size="sm" disabled={save.pending}>{save.pending ? <Spinner /> : null}Сохранить шаблон</Button><Button type="button" size="sm" variant="outline" onClick={() => setEditing(false)}>Отмена</Button></div>
    </form> : selected ? <div className="space-y-3">
      <div className="min-w-0"><p className="break-words text-sm font-medium">{selected.label}<span className="ml-2 text-xs font-normal text-muted-foreground">{selected.builtIn ? "Готовый" : "Свой"}</span></p>{selected.description ? <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{selected.description}</p> : null}</div>
      <details className="rounded-md border border-border"><summary className="cursor-pointer px-3 py-2 text-xs font-medium">Полный текст правил</summary><pre className="max-h-80 overflow-y-auto whitespace-pre-wrap break-words border-t border-border p-3 font-mono text-xs leading-relaxed">{selected.prompt}</pre></details>
      <div className="flex flex-wrap items-center gap-2"><Button size="sm" variant="outline" onClick={() => begin("copy")}>Создать копию</Button>{selected.editable ? <Button size="sm" variant="outline" onClick={() => begin("edit")}>Изменить</Button> : null}<Button size="sm" variant="outline" disabled={selected.id === defaultId || makeDefault.pending} onClick={() => void makeDefault.run()}>По умолчанию</Button><CopyButton text={selected.prompt} label="Скопировать правила шаблона" />{selected.editable ? <Button size="sm" variant="ghost" onClick={() => setDeleteOpen(true)}>Удалить</Button> : null}</div>
    </div> : load.pending ? <Spinner /> : null}
    <ErrorText>{load.error ?? save.error ?? makeDefault.error}</ErrorText>
    <ConfirmDialog open={deleteOpen} onOpenChange={setDeleteOpen} title="Удалить свой шаблон?" description="Сохранённые разборы встреч сохранят свои правила и результаты." confirmLabel="Удалить" destructive pending={remove.pending} error={remove.error} onConfirm={() => void remove.run()} />
  </div>;
}
