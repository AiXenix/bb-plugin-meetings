import { useEffect, useRef, useState } from "react";
import type { BotProfile } from "../shared/rpc-contract";
import { Button } from "@/components/ui/button";
import { fieldClass, Field } from "./feature-controls";
import { useAsyncAction } from "./hooks";
import { useMeetingsRpc } from "./rpc";
import { ErrorText, Spinner } from "./ui";

export function avatarInitials(name: string): string {
  return name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map(word => Array.from(word)[0]).join("").toUpperCase() || "AI";
}

export function AvatarGenerator({ name, onApplied }: { name: string; onApplied: (profile: BotProfile) => void }) {
  const [open, setOpen] = useState(false);
  return <details className="rounded-md border border-border" onToggle={event => setOpen(event.currentTarget.open)}><summary className="cursor-pointer px-3 py-2 text-xs font-medium">Создать аватар из текста</summary>{open ? <AvatarMaker name={name} onApplied={onApplied} /> : null}</details>;
}

function AvatarMaker({ name, onApplied }: { name: string; onApplied: (profile: BotProfile) => void }) {
  const rpc = useMeetingsRpc();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [style, setStyle] = useState<"initials" | "circle" | "rounded">("initials");
  const [color, setColor] = useState("#0ea5e9");
  const [text, setText] = useState(avatarInitials(name));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    rpc.call("notetaker.settings", {}).then(({ settings }) => { if (cancelled) return; setStyle(settings.avatarStyle); setColor(settings.avatarColor); setText(settings.avatarText || avatarInitials(name)); }, () => {});
    return () => { cancelled = true; };
  }, [rpc, name]);
  useEffect(() => {
    try {
      const ctx = canvas.current?.getContext("2d");
      if (!ctx) return;
      const gradient = ctx.createLinearGradient(0, 0, 512, 512);
      gradient.addColorStop(0, color); gradient.addColorStop(1, "#1e1b4b");
      ctx.clearRect(0, 0, 512, 512); ctx.fillStyle = gradient; ctx.fillRect(0, 0, 512, 512);
      if (style === "circle") {
        ctx.strokeStyle = "rgba(255,255,255,0.18)"; ctx.lineWidth = 32;
        for (const radius of [120, 190, 260]) { ctx.beginPath(); ctx.arc(256, 256, radius, 0, Math.PI * 2); ctx.stroke(); }
      } else if (style === "rounded") {
        ctx.fillStyle = "rgba(255,255,255,0.12)"; ctx.beginPath(); ctx.roundRect(62, 62, 388, 388, 70); ctx.fill();
      }
      ctx.fillStyle = "#ffffff"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.font = `600 ${Math.max(42, 185 - Math.max(0, text.length - 2) * 18)}px system-ui, sans-serif`;
      ctx.fillText(text.trim() || "AI", 256, 265, 410); setError(null);
    } catch { setError("Браузер не смог построить аватар."); }
  }, [style, color, text]);
  const apply = useAsyncAction(async () => {
    if (!canvas.current) throw new Error("Аватар ещё не готов");
    const imageBase64 = canvas.current.toDataURL("image/png").split(",")[1];
    if (!imageBase64) throw new Error("Не удалось подготовить изображение");
    onApplied(await rpc.call("bot.setAvatar", { imageBase64, mimeType: "image/png" }));
    await rpc.call("notetaker.settings", { patch: { avatarStyle: style, avatarColor: color, avatarText: text } });
  });
  return <div className="space-y-3 border-t border-border p-3"><div className="flex flex-col items-start gap-3 sm:flex-row"><canvas ref={canvas} width={512} height={512} aria-label="Превью создаваемого аватара" className="size-24 shrink-0 rounded-full border border-border" /><div className="grid w-full min-w-0 gap-3 sm:grid-cols-2"><Field label="Текст аватара"><input className={fieldClass} maxLength={12} value={text} onChange={event => setText(event.target.value)} /></Field><Field label="Стиль"><select className={fieldClass} value={style} onChange={event => setStyle(event.target.value as typeof style)}><option value="initials">Инициалы</option><option value="circle">Круги</option><option value="rounded">Мягкие углы</option></select></Field><Field label="Цвет"><input type="color" className="h-9 w-16 rounded-md border border-input bg-transparent" value={color} onChange={event => setColor(event.target.value)} /></Field></div></div><Button size="sm" variant="outline" disabled={apply.pending || error !== null} onClick={() => void apply.run()}>{apply.pending ? <Spinner /> : null}Применить аватар</Button><ErrorText className="text-xs">{error ?? apply.error}</ErrorText></div>;
}
