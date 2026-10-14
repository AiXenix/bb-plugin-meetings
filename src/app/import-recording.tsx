import { useState } from "react";
import type { FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Field } from "./feature-controls";
import { useAsyncAction } from "./hooks";
import { useMeetingsRpc } from "./rpc";
import type { MeetingsNav } from "./route";
import { ErrorText, Spinner } from "./ui";

/** Import uses the recording host's existing file pipeline, without moving the source. */
export function ImportRecording({ nav, onImported }: { nav: MeetingsNav; onImported: () => void }) {
  const rpc = useMeetingsRpc();
  const [open, setOpen] = useState(false);
  const [sourcePath, setSourcePath] = useState("");
  const [title, setTitle] = useState("");
  const [validation, setValidation] = useState<string | null>(null);
  const importing = useAsyncAction(async () => {
    const result = await rpc.call("meetings.import", { sourcePath: sourcePath.trim(), title: title.trim() || null });
    onImported();
    setOpen(false);
    setSourcePath("");
    setTitle("");
    nav.toMeeting(result.meeting.id);
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // The trigger belongs to the join form; a dialog submission is its own operation.
    event.stopPropagation();
    if (importing.pending) return;
    if (!sourcePath.trim().startsWith("/")) { setValidation("Укажите абсолютный путь к файлу на машине записи, начиная с /"); return; }
    setValidation(null);
    void importing.run();
  };
  return <Dialog open={open} onOpenChange={next => { if (!importing.pending) { setOpen(next); setValidation(null); importing.setError(null); } }}>
    <DialogTrigger asChild><Button type="button" variant="outline" size="sm">Импорт записи</Button></DialogTrigger>
    <DialogContent className="max-w-md">
      <DialogHeader><DialogTitle>Импорт аудио или видео</DialogTitle><DialogDescription>Укажите абсолютный путь к существующему файлу на основной машине записи BB. Браузер не загружает файл с вашего устройства; сначала разместите запись на машине записи.</DialogDescription></DialogHeader>
      <form onSubmit={submit} className="min-w-0 space-y-3">
        <Field label="Путь к файлу на машине записи"><Input value={sourcePath} maxLength={4096} autoFocus spellCheck={false} disabled={importing.pending} placeholder="/путь/к/записи.mp4" onChange={event => { setSourcePath(event.target.value); setValidation(null); }} /></Field>
        <Field label="Название записи (необязательно)"><Input value={title} maxLength={200} disabled={importing.pending} onChange={event => setTitle(event.target.value)} /></Field>
        <p className="text-xs leading-relaxed text-muted-foreground">Аудиодорожка будет извлечена из файла, затем появится расшифровка с разделением по спикерам. Исходный файл сохраняется.</p>
        {importing.pending ? <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><Spinner />Подготавливаем запись. Это может занять несколько минут.</p> : null}
        <ErrorText className="text-xs">{validation ?? importing.error}</ErrorText>
        <DialogFooter><Button type="button" size="sm" variant="outline" disabled={importing.pending} onClick={() => setOpen(false)}>Отмена</Button><Button type="submit" size="sm" disabled={importing.pending}>{importing.pending ? <Spinner /> : null}Импортировать</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
