// Speakers of a meeting: identity color, talk time and share, inline rename
// (meetings.renameSpeaker; an empty name restores the transcriber's label).
import { memo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { formatDuration, formatPercent } from "./format";
import { useAsyncAction } from "./hooks";
import { useMeetingsRpc } from "./rpc";
import { colorFor } from "./speaker-colors";
import type { SpeakerStat } from "./transcript-model";
import { EmptyState, ErrorText, InlineTextInput, Section } from "./ui";

function SpeakerRow({
  meetingId,
  stat,
  color,
  share,
  onRenamed,
}: {
  meetingId: string;
  stat: SpeakerStat;
  color: string;
  share: number;
  onRenamed: () => void;
}) {
  const rpc = useMeetingsRpc();
  const [editing, setEditing] = useState(false);
  const rename = useAsyncAction(async (name: string) => {
    await rpc.call("meetings.renameSpeaker", { id: meetingId, speakerKey: stat.key, name });
    onRenamed();
  });
  const renamed = stat.label !== stat.originalLabel;
  return (
    <li className="flex flex-col gap-1.5 px-3 py-2 sm:flex-row sm:items-center sm:gap-3">
      <div className="flex min-w-0 items-center gap-2 sm:w-56 sm:shrink-0">
        <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} aria-hidden />
        {editing ? (
          <InlineTextInput
            initial={stat.label}
            label={`Новое имя для «${stat.label}»`}
            placeholder="Пусто — вернуть исходное имя"
            maxLength={100}
            pending={rename.pending}
            onCommit={(name) => {
              setEditing(false);
              void rename.run(name);
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-1">
              <span className="min-w-0 truncate text-sm font-medium text-foreground" title={stat.label}>
                {stat.label}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
                aria-label={`Переименовать «${stat.label}»`}
                disabled={rename.pending}
                onClick={() => setEditing(true)}
              >
                <Icon name="Edit" className="size-3.5" aria-hidden />
              </Button>
            </div>
            {renamed ? (
              <p className="truncate text-xs text-muted-foreground" title={stat.originalLabel}>
                было: {stat.originalLabel}
              </p>
            ) : null}
          </div>
        )}
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden>
          <div
            className="h-full rounded-full"
            style={{ width: `${Math.max(1, Math.round(share * 100))}%`, backgroundColor: color }}
          />
        </div>
        <span className="w-28 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
          {formatDuration(stat.talkSec)} · {formatPercent(share)}
        </span>
      </div>
      <ErrorText className="text-xs">{rename.error}</ErrorText>
    </li>
  );
}

export const SpeakersPanel = memo(function SpeakersPanel({
  meetingId,
  stats,
  colors,
  onRenamed,
}: {
  meetingId: string;
  stats: readonly SpeakerStat[];
  colors: ReadonlyMap<string, string>;
  onRenamed: () => void;
}) {
  const total = stats.reduce((sum, stat) => sum + stat.talkSec, 0);
  return (
    <Section title="Спикеры" count={stats.length === 0 ? undefined : stats.length}>
      {stats.length === 0 ? (
        <EmptyState>Спикеры появятся вместе с расшифровкой.</EmptyState>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border bg-card">
          {stats.map((stat) => (
            <SpeakerRow
              key={stat.key}
              meetingId={meetingId}
              stat={stat}
              color={colorFor(colors, stat.key)}
              share={total > 0 ? stat.talkSec / total : 0}
              onRenamed={onRenamed}
            />
          ))}
        </ul>
      )}
      {stats.length === 0 ? null : (
        <p className="mt-1.5 px-1 text-xs text-muted-foreground">
          Нажмите на карандаш, чтобы переименовать спикера во всей расшифровке. Пустое имя возвращает исходное.
        </p>
      )}
    </Section>
  );
});
