import type { ReactNode } from "react";

export const fieldClass = "block w-full min-w-0 rounded-md border border-input bg-transparent px-2.5 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50";

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="grid min-w-0 gap-1 text-xs text-muted-foreground"><span>{label}</span>{children}{hint ? <span className="text-xs leading-relaxed">{hint}</span> : null}</label>;
}

export function Toggle({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  return <label className="flex min-w-0 items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-current" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} /><span className="min-w-0 text-foreground">{label}</span></label>;
}
