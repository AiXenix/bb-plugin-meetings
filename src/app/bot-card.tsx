// "Бот" card on the list page: the name the bot joins with and its avatar,
// shown in Zoom as the bot's camera (bot.profile / updateProfile / setAvatar /
// clearAvatar, DESIGN §14).
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";
import { useRealtime } from "@get-bb/plugin-sdk/app";
import type { BotProfile } from "../shared/rpc-contract";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { AVATAR_ACCEPT, AVATAR_MAX_BYTES, formatMegabytes, prepareAvatar } from "./avatar-image";
import { CHANNEL_BOT_CHANGED, avatarPreviewUrl } from "./constants";
import { useAsyncAction, useDebouncedCallback, useLatest, useMountedRef, useOnReconnect } from "./hooks";
import { messageOf, useMeetingsRpc } from "./rpc";
import { ErrorText, InlineTextInput, Section, Spinner } from "./ui";

/** bot.updateProfile limit for botName. */
const BOT_NAME_MAX = 64;

export function useBotProfile() {
  const rpc = useMeetingsRpc();
  const mounted = useMountedRef();
  const [profile, setProfile] = useState<BotProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Results of older requests must not overwrite a newer answer (a refetch racing an update).
  const sequence = useRef(0);
  const refetch = useCallback(() => {
    const seq = ++sequence.current;
    rpc.call("bot.profile").then(
      (result) => {
        if (!mounted.current || seq !== sequence.current) return;
        setProfile(result);
        setError(null);
      },
      (cause: unknown) => {
        if (mounted.current && seq === sequence.current) setError(messageOf(cause));
      },
    );
  }, [rpc, mounted]);
  useEffect(refetch, [refetch]);
  const debounced = useDebouncedCallback(refetch, 300);
  useRealtime(CHANNEL_BOT_CHANGED, debounced);
  useOnReconnect(refetch);
  const update = useCallback(
    (next: BotProfile) => {
      sequence.current += 1;
      if (!mounted.current) return;
      setProfile(next);
      setError(null);
    },
    [mounted],
  );
  return { profile, error, refetch, update };
}

function BotNameEditor({ profile, onProfile }: { profile: BotProfile; onProfile: (next: BotProfile) => void }) {
  const rpc = useMeetingsRpc();
  const [editing, setEditing] = useState(false);
  const [pendingName, setPendingName] = useState<string | null>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  // Enter or Escape in the input returns focus to the edit button; a blur (a click elsewhere) leaves it there.
  const refocus = useRef(false);
  const save = useAsyncAction(async (botName: string) => {
    setPendingName(botName);
    try {
      onProfile(await rpc.call("bot.updateProfile", { botName }));
    } finally {
      setPendingName(null);
    }
  });
  useEffect(() => {
    if (editing || !refocus.current) return;
    refocus.current = false;
    editButton.current?.focus();
  }, [editing]);
  const name = pendingName ?? profile.botName;
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">Имя во встрече</p>
      {editing ? (
        <div
          onKeyDownCapture={(event) => {
            refocus.current = event.key === "Enter" || event.key === "Escape";
          }}
        >
          <InlineTextInput
            initial={profile.botName}
            label="Имя бота в Zoom"
            maxLength={BOT_NAME_MAX}
            className="max-w-xs"
            onCommit={(value) => {
              setEditing(false);
              if (value === "") save.setError("Имя не может быть пустым");
              else void save.run(value);
            }}
            onCancel={() => setEditing(false)}
          />
        </div>
      ) : (
        <div className="flex min-w-0 items-center gap-1">
          <span className="min-w-0 truncate font-medium text-foreground">{name}</span>
          <Button
            ref={editButton}
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
            aria-label="Изменить имя бота"
            // Not `disabled` while saving: a disabled button cannot take the focus back from the input.
            aria-disabled={save.pending || undefined}
            onClick={() => {
              if (save.pending) return;
              save.setError(null);
              refocus.current = false;
              setEditing(true);
            }}
          >
            {save.pending ? <Spinner className="size-3.5" /> : <Icon name="Edit" className="size-3.5" aria-hidden />}
          </Button>
        </div>
      )}
      <ErrorText className="text-xs">{save.error}</ErrorText>
    </div>
  );
}

/** The rendered camera frame (avatar + name) as Zoom shows it, or a placeholder. */
function AvatarPreview({ profile, dragging, busy }: { profile: BotProfile; dragging: boolean; busy: boolean }) {
  const { hasAvatar, version } = profile.avatar;
  // The host renders the preview on demand and may fail briefly (busy, restarting): a retry asks
  // again under a new URL, so a failed answer is never reused.
  const [retry, setRetry] = useState(0);
  const base = hasAvatar && version !== null ? avatarPreviewUrl(version, profile.botName) : null;
  const src = base === null ? null : retry === 0 ? base : `${base}&retry=${retry}`;
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const failed = src !== null && failedSrc === src;
  const failedNow = useLatest(failed);
  // A fresh profile (meetings.bot signal, reconnect, an action) retries a failed preview.
  useEffect(() => {
    if (failedNow.current) setRetry((value) => value + 1);
  }, [profile, failedNow]);
  return (
    <div
      className={cn(
        "relative flex aspect-video w-full max-w-xs shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted sm:w-56",
        dragging ? "border-ring ring-1 ring-ring" : "border-border",
      )}
    >
      {src !== null && !failed ? (
        <img
          key={src}
          src={src}
          alt={`Камера бота в Zoom: аватар и имя «${profile.botName}»`}
          className="size-full object-cover"
          draggable={false}
          onLoad={() => setLoadedSrc(src)}
          onError={() => setFailedSrc(src)}
        />
      ) : (
        <div className="flex flex-col items-center gap-1 px-3 text-center text-xs text-muted-foreground">
          <Icon name="Bot" className="size-6" aria-hidden />
          {failed ? (
            <>
              <span>Не удалось показать превью</span>
              <button
                type="button"
                className="rounded-sm text-foreground underline underline-offset-2 hover:text-foreground/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                onClick={() => setRetry((value) => value + 1)}
              >
                Повторить
              </button>
            </>
          ) : (
            <>
              <span>Аватара нет</span>
              <span className="hidden sm:inline">Перетащите сюда изображение</span>
            </>
          )}
        </div>
      )}
      {src !== null && !failed && !profile.avatar.enabled ? (
        <span className="absolute bottom-1.5 left-1.5 rounded bg-background/80 px-1.5 py-0.5 text-xs text-muted-foreground">
          Камера выключена
        </span>
      ) : null}
      {dragging ? (
        <div className="absolute inset-0 flex items-center justify-center bg-surface-scrim text-xs font-medium text-foreground">
          Отпустите, чтобы загрузить
        </div>
      ) : busy || (src !== null && !failed && loadedSrc !== src) ? (
        <div className="absolute right-1.5 top-1.5 rounded-full bg-background/80 p-1">
          <Spinner className="size-3.5 text-muted-foreground" />
        </div>
      ) : null}
    </div>
  );
}

function hasFiles(event: DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

export function BotCard() {
  const rpc = useMeetingsRpc();
  const { profile, error, update } = useBotProfile();
  const fileInput = useRef<HTMLInputElement>(null);
  const toggleId = useId();
  const hintId = useId();
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  const upload = useAsyncAction(async (file: File) => {
    const avatar = await prepareAvatar(file);
    update(await rpc.call("bot.setAvatar", { imageBase64: avatar.base64, mimeType: avatar.mimeType }));
  });
  const clear = useAsyncAction(async () => {
    update(await rpc.call("bot.clearAvatar"));
  });
  const toggle = useAsyncAction(async (showAvatar: boolean) => {
    update(await rpc.call("bot.updateProfile", { showAvatar }));
  });
  const busy = upload.pending || clear.pending;

  const pick = (files: FileList | null | undefined) => {
    const file = files?.[0];
    if (file === undefined || busy) return;
    clear.setError(null);
    void upload.run(file);
  };
  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    pick(event.target.files);
    // Choosing the same file again must fire change again.
    event.target.value = "";
  };
  // The whole card, padding included, takes dropped images, so a near miss does not open the file
  // in the app; before the profile is loaded a drop is swallowed without an upload.
  const dropHandlers = {
    onDragEnter: (event: DragEvent<HTMLElement>) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth.current += 1;
      setDragging(true);
    },
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: () => {
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      if (profile !== null) pick(event.dataTransfer?.files);
    },
  };

  return (
    <Section title="Бот">
      <div className="rounded-lg border border-border bg-card p-4 text-sm" data-avatar-dropzone="" {...dropHandlers}>
        {profile === null ? (
          error === null ? (
            <p role="status" className="flex items-center gap-2 text-muted-foreground">
              <Spinner /> Загружаем профиль бота…
            </p>
          ) : (
            <ErrorText>Не удалось загрузить профиль бота: {error}</ErrorText>
          )
        ) : (
          <div className="flex flex-col gap-4 sm:flex-row">
            <AvatarPreview profile={profile} dragging={dragging} busy={busy} />
            <div className="min-w-0 flex-1 space-y-3">
              <BotNameEditor profile={profile} onProfile={update} />
              <div className="space-y-2">
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => fileInput.current?.click()}
                  >
                    {upload.pending ? <Spinner /> : <Icon name="FolderOpen" className="size-4" aria-hidden />}
                    {profile.avatar.hasAvatar ? "Заменить аватар" : "Загрузить аватар"}
                  </Button>
                  {profile.avatar.hasAvatar ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        upload.setError(null);
                        void clear.run();
                      }}
                    >
                      {clear.pending ? <Spinner /> : <Icon name="Trash2" className="size-4" aria-hidden />}
                      Удалить аватар
                    </Button>
                  ) : null}
                  <input
                    ref={fileInput}
                    type="file"
                    accept={AVATAR_ACCEPT}
                    aria-label="Файл аватара"
                    className="hidden"
                    tabIndex={-1}
                    onChange={onFileChange}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  PNG, JPEG или WebP до {formatMegabytes(AVATAR_MAX_BYTES)} — можно перетащить на превью. Картинка
                  обрезается до квадрата и показывается в круге.
                </p>
                {upload.pending ? (
                  <p role="status" className="text-xs text-muted-foreground">
                    Загружаем аватар…
                  </p>
                ) : null}
                <ErrorText className="text-xs">{upload.error ?? clear.error}</ErrorText>
              </div>
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id={toggleId}
                    checked={profile.avatar.enabled}
                    disabled={toggle.pending}
                    aria-describedby={hintId}
                    onCheckedChange={(checked) => void toggle.run(checked === true)}
                  />
                  <label htmlFor={toggleId} className="cursor-pointer select-none text-foreground">
                    Показывать аватар в Zoom (камера бота)
                  </label>
                  {toggle.pending ? <Spinner className="size-3.5 text-muted-foreground" /> : null}
                </div>
                <p id={hintId} className="text-xs text-muted-foreground">
                  {profile.avatar.hasAvatar
                    ? profile.avatar.enabled
                      ? "Бот включает камеру: участники видят этот кадр с аватаром и именем."
                      : "Камера бота выключена — участники видят только имя."
                    : "Пока аватара нет, камера бота выключена — участники видят только имя."}{" "}
                  Имя — то, под которым бот появляется в списке участников. Изменения действуют со следующего
                  подключения.
                </p>
                <ErrorText className="text-xs">{toggle.error}</ErrorText>
              </div>
            </div>
          </div>
        )}
      </div>
    </Section>
  );
}
