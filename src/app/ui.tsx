// Small presentational pieces shared by the Meetings pages.
import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { experimental_copyToClipboard } from "@get-bb/plugin-sdk/app";
import type { MeetingSummary } from "../shared/rpc-contract";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { formatClock } from "./format";
import { useNow } from "./hooks";
import { statusText, statusTone } from "./labels";
import type { StatusTone } from "./labels";

/** The scrolling page frame bb's own nav-panel pages use. */
export function PageFrame({ wide = false, children }: { wide?: boolean; children: ReactNode }) {
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto" data-meetings-scroll="">
      <div className={cn("mx-auto box-border w-full px-4 pb-8 pt-3 md:px-5 md:pt-4", wide ? "max-w-4xl" : "max-w-3xl")}>
        {children}
      </div>
    </div>
  );
}

/** The dashed box bb's list pages use for loading and empty states. */
export function EmptyState({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      role="status"
      className={cn(
        "rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Icon name="Loading" className={cn("size-4 animate-spin", className)} aria-hidden />;
}

export function ErrorText({ children, className }: { children: ReactNode; className?: string }) {
  if (children === null || children === undefined || children === "") return null;
  return (
    <p role="alert" className={cn("text-sm text-destructive-text", className)}>
      {children}
    </p>
  );
}

type NoticeTone = "warning" | "danger" | "info" | "success";

const NOTICE_CLASSES: Readonly<Record<NoticeTone, string>> = {
  warning: "border-attention/50 bg-surface-attention",
  danger: "border-surface-destructive-border bg-surface-destructive",
  info: "border-border bg-surface-recessed",
  success: "border-success/40 bg-success/10",
};

const NOTICE_ICONS: Readonly<Record<NoticeTone, { name: string; className: string }>> = {
  warning: { name: "AlertTriangle", className: "text-warning-text" },
  danger: { name: "AlertCircle", className: "text-destructive-text" },
  info: { name: "Info", className: "text-muted-foreground" },
  success: { name: "CircleCheck", className: "text-success-foreground" },
};

/** A tinted box with an icon, an optional title and free content. */
export function Notice({
  tone,
  title,
  children,
  className,
  role,
}: {
  tone: NoticeTone;
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
  role?: "alert" | "status";
}) {
  const icon = NOTICE_ICONS[tone];
  return (
    <div
      role={role}
      className={cn("flex gap-3 rounded-lg border px-3 py-2.5 text-sm", NOTICE_CLASSES[tone], className)}
    >
      <Icon name={icon.name} className={cn("mt-0.5 size-4 shrink-0", icon.className)} aria-hidden />
      <div className="min-w-0 flex-1 space-y-1.5">
        {title === undefined ? null : <div className="font-medium text-foreground">{title}</div>}
        {children}
      </div>
    </div>
  );
}

/** A page section with a heading, an optional counter and actions on the right. */
export function Section({
  title,
  count,
  actions,
  children,
  className,
}: {
  title: string;
  count?: number;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className={cn("mt-6", className)}>
      <div className="mb-2 flex min-h-8 flex-wrap items-center gap-2">
        <h2 id={headingId} className="text-sm font-semibold text-foreground">
          {title}
          {count === undefined ? null : <span className="ml-1.5 font-normal text-muted-foreground">{count}</span>}
        </h2>
        {actions === undefined ? null : <div className="ml-auto flex items-center gap-1">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

const TONE_CLASSES: Readonly<Record<StatusTone, string>> = {
  live: "border-surface-destructive-border bg-surface-destructive text-destructive-text",
  progress: "border-surface-selected-border bg-surface-selected text-foreground",
  attention: "border-attention/50 bg-surface-attention text-warning-text",
  success: "border-success/40 bg-success/10 text-success-foreground",
  danger: "border-surface-destructive-border bg-surface-destructive text-destructive-text",
  neutral: "border-border bg-muted text-muted-foreground",
};

export function Chip({ tone, children, className }: { tone: StatusTone; children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium",
        TONE_CLASSES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function StatusChip({
  meeting,
  className,
}: {
  meeting: Pick<MeetingSummary, "status" | "transcriptProgress">;
  className?: string;
}) {
  return (
    <Chip tone={statusTone(meeting.status)} className={className}>
      {meeting.status === "processing" ? <Spinner className="size-3" /> : null}
      {statusText(meeting)}
    </Chip>
  );
}

/** Time since `since` (epoch ms), ticking every second without re-rendering its parent. */
export function ElapsedClock({ since, className }: { since: number; className?: string }) {
  const now = useNow(1000);
  return <span className={cn("font-mono tabular-nums", className)}>{formatClock((now - since) / 1000)}</span>;
}

/** The pulsing red dot of a meeting that is being recorded. */
export function RecordingDot({ className }: { className?: string }) {
  return (
    <span className={cn("relative inline-flex size-2.5 shrink-0", className)} aria-hidden>
      <span className="absolute inline-flex size-full animate-ping rounded-full bg-destructive opacity-60" />
      <span className="relative inline-flex size-2.5 rounded-full bg-destructive" />
    </span>
  );
}

/** Copies `text`; the icon turns into a check for a moment. */
export function CopyButton({ text, label, className }: { text: string; label: string; className?: string }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  useEffect(() => {
    if (copied === null) return;
    const timer = setTimeout(() => setCopied(null), 1800);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn("size-7 text-muted-foreground hover:text-foreground", className)}
      aria-label={copied === true ? "Скопировано" : copied === false ? "Не удалось скопировать" : label}
      onClick={() => {
        experimental_copyToClipboard({ text }).then(
          (ok) => setCopied(ok),
          () => setCopied(false),
        );
      }}
    >
      <Icon name={copied === true ? "Check" : copied === false ? "X" : "Copy"} className="size-3.5" aria-hidden />
    </Button>
  );
}

/** Text input for inline renames: Enter or blur commits, Escape cancels. */
export function InlineTextInput({
  initial,
  label,
  placeholder,
  maxLength,
  pending,
  onCommit,
  onCancel,
  className,
}: {
  initial: string;
  label: string;
  placeholder?: string;
  maxLength?: number;
  pending?: boolean;
  onCommit: (value: string) => void;
  onCancel: () => void;
  className?: string;
}) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (commit && value.trim() !== initial.trim()) onCommit(value.trim());
    else onCancel();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      finish(false);
    }
  };
  return (
    <Input
      ref={inputRef}
      value={value}
      maxLength={maxLength}
      placeholder={placeholder}
      aria-label={label}
      disabled={pending}
      className={cn("h-8", className)}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => finish(true)}
    />
  );
}

/** A button that shows/hides a region below it. */
export function DisclosureButton({
  open,
  onToggle,
  controls,
  children,
  className,
}: {
  open: boolean;
  onToggle: () => void;
  controls: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
      className={cn(
        "inline-flex items-center gap-1 rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        className,
      )}
    >
      <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-3.5" aria-hidden />
      {children}
    </button>
  );
}

/** Confirmation dialog for destructive or slow actions; the caller closes it via `onOpenChange`. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  destructive = false,
  pending = false,
  error = null,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  pending?: boolean;
  error?: string | null;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <ErrorText>{error}</ErrorText>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={pending}>
              Отмена
            </Button>
          </DialogClose>
          <Button
            type="button"
            variant={destructive ? "destructive" : "default"}
            disabled={pending}
            onClick={onConfirm}
          >
            {pending ? <Spinner /> : null}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
