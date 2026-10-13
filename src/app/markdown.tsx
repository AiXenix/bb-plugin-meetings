// A tiny, safe Markdown renderer for meeting summaries. It produces React
// elements only (React escapes all text; nothing is injected as HTML) and
// renders links only for http(s) URLs. Supported: ATX headings, paragraphs
// with hard breaks, bullet/numbered/task lists (nested), block quotes, fenced
// code, horizontal rules, GFM tables, and inline code, bold, italic,
// strikethrough, [links](https://…), <https://…> and bare http(s) URLs.
import { useMemo } from "react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type LinkRenderer = (href: string, children: ReactNode, key: string) => ReactNode;

export interface MarkdownOptions {
  /** Render a validated http(s) link; defaults to a plain <a target="_blank">. */
  renderLink?: LinkRenderer;
}

type Align = "left" | "center" | "right" | null;

interface ListItem {
  text: string;
  checked: boolean | null;
  children: Block[];
}

type Block =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "code"; text: string }
  | { type: "quote"; blocks: Block[] }
  | { type: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { type: "hr" }
  | { type: "table"; header: string[]; align: Align[]; rows: string[][] };

const MAX_DEPTH = 8;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>[ ]?(.*)$/;
const LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const EMPTY_LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])[ \t]*$/;
const TABLE_SEPARATOR = /^ *\|? *:?-+:? *(?:\| *:?-+:? *)*\|? *$/;
const TASK = /^\[([ xX])\][ \t]+(.*)$/;

/** Only absolute http(s) URLs become links. */
export function safeHref(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

const isBlank = (line: string): boolean => line.trim() === "";
const indentOf = (line: string): number => line.length - line.trimStart().length;

function startsBlock(line: string): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    HR.test(line) ||
    QUOTE.test(line) ||
    LIST_ITEM.test(line) ||
    EMPTY_LIST_ITEM.test(line)
  );
}

function splitRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|") && !body.endsWith("\\|")) body = body.slice(0, -1);
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === "\\" && body[i + 1] === "|") {
      current += "|";
      i += 1;
    } else if (ch === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

function parseAlign(cell: string): Align {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return null;
}

function parseList(lines: string[], start: number, depth: number): [Block, number] {
  const first = LIST_ITEM.exec(lines[start]) ?? EMPTY_LIST_ITEM.exec(lines[start]);
  const baseIndent = first?.[1]?.length ?? 0;
  const firstMarker = first?.[2] ?? "-";
  const ordered = /\d/.test(firstMarker);
  const items: ListItem[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    const match = LIST_ITEM.exec(line) ?? EMPTY_LIST_ITEM.exec(line);
    if (match === null) break;
    const indent = match[1]?.length ?? 0;
    const marker = match[2] ?? "-";
    if (indent > baseIndent + 1 || indent + 1 < baseIndent || /\d/.test(marker) !== ordered) break;
    const contentIndent = indent + marker.length + 1;
    let text = (match[3] ?? "").trim();
    let checked: boolean | null = null;
    const task = TASK.exec(text);
    if (task !== null) {
      checked = task[1] !== " ";
      text = (task[2] ?? "").trim();
    }
    const nested: string[] = [];
    let j = i + 1;
    while (j < lines.length) {
      const next = lines[j];
      if (isBlank(next)) {
        let k = j + 1;
        while (k < lines.length && isBlank(lines[k])) k += 1;
        if (k < lines.length && indentOf(lines[k]) > indent && indentOf(lines[k]) >= contentIndent - 1) {
          nested.push("");
          j += 1;
          continue;
        }
        break;
      }
      if (indentOf(next) > indent) {
        if (nested.length === 0 && !startsBlock(next.trimStart())) {
          text = `${text}\n${next.trim()}`;
        } else {
          nested.push(next.slice(Math.min(indentOf(next), contentIndent)));
        }
        j += 1;
        continue;
      }
      if (startsBlock(next) || nested.length > 0) break;
      // A lazy continuation line of the item's paragraph.
      text = `${text}\n${next.trim()}`;
      j += 1;
    }
    items.push({ text, checked, children: depth < MAX_DEPTH ? parseBlocks(nested, depth + 1) : [] });
    i = j;
    // A blank line between items keeps the list going.
    if (i < lines.length && isBlank(lines[i])) {
      let k = i;
      while (k < lines.length && isBlank(lines[k])) k += 1;
      const after = k < lines.length ? LIST_ITEM.exec(lines[k]) : null;
      if (
        after !== null &&
        Math.abs((after[1]?.length ?? 0) - baseIndent) <= 1 &&
        /\d/.test(after[2] ?? "") === ordered
      ) {
        i = k;
      }
    }
  }
  const startNumber = ordered ? Number.parseInt(firstMarker, 10) : 1;
  return [{ type: "list", ordered, start: Number.isFinite(startNumber) ? startNumber : 1, items }, i];
}

function parseBlocks(lines: string[], depth = 0): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence !== null) {
      const marker = fence[1] ?? "```";
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const closing = lines[j].trim();
        if (closing.startsWith(marker[0]!.repeat(marker.length)) && /^(`+|~+)$/.test(closing)) break;
        body.push(lines[j]);
        j += 1;
      }
      blocks.push({ type: "code", text: body.join("\n") });
      i = j + 1;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading !== null) {
      blocks.push({ type: "heading", level: heading[1]?.length ?? 1, text: (heading[2] ?? "").trim() });
      i += 1;
      continue;
    }
    if (HR.test(line)) {
      blocks.push({ type: "hr" });
      i += 1;
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && !isBlank(lines[i])) {
        const quoted = QUOTE.exec(lines[i]);
        body.push(quoted === null ? lines[i] : (quoted[1] ?? ""));
        i += 1;
      }
      blocks.push({ type: "quote", blocks: depth < MAX_DEPTH ? parseBlocks(body, depth + 1) : [] });
      continue;
    }
    if (LIST_ITEM.test(line) || EMPTY_LIST_ITEM.test(line)) {
      const [list, next] = parseList(lines, i, depth);
      blocks.push(list);
      i = next > i ? next : i + 1;
      continue;
    }
    const separator = lines[i + 1];
    if (
      line.includes("|") &&
      separator !== undefined &&
      TABLE_SEPARATOR.test(separator) &&
      splitRow(separator).length === splitRow(line).length
    ) {
      const header = splitRow(line);
      const align = splitRow(separator).map(parseAlign);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && !isBlank(lines[j]) && lines[j].includes("|")) {
        rows.push(splitRow(lines[j]));
        j += 1;
      }
      blocks.push({ type: "table", header, align, rows });
      i = j;
      continue;
    }
    const paragraph: string[] = [line.trim() === "" ? "" : line.replace(/^ {0,3}/, "")];
    let j = i + 1;
    while (j < lines.length && !isBlank(lines[j]) && !startsBlock(lines[j])) {
      paragraph.push(lines[j].trim());
      j += 1;
    }
    blocks.push({ type: "paragraph", text: paragraph.join("\n") });
    i = j;
  }
  return blocks;
}

/** Parse Markdown into blocks (exported for tests). */
export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
  return parseBlocks(lines);
}

// --- inline ---------------------------------------------------------------

interface InlineRule {
  name: "escape" | "code" | "link" | "autolink" | "url" | "bold" | "strike" | "italic";
  re: RegExp;
}

// Order breaks ties at the same position: code before emphasis, bold before italic.
// The rules are global (searched from `lastIndex`). Code and emphasis spans are at most 500 characters
// long ({0,498}): an unclosed delimiter then costs bounded work instead of a scan to the end of the text.
const INLINE_RULES: readonly InlineRule[] = [
  { name: "escape", re: /\\([\\`*_{}[\]()#+\-.!~|>])/g },
  { name: "code", re: /(`+)([^`]|[^`][\s\S]{0,498}?[^`])\1(?!`)/g },
  { name: "link", re: /\[([^\]\n]+)\]\(\s*<?((?:[^\s()<>]|\([^\s()<>]*\))+)>?(?:\s+"[^"]*")?\s*\)/g },
  { name: "autolink", re: /<(https?:\/\/[^\s>]+)>/g },
  { name: "url", re: /\bhttps?:\/\/[^\s<>"'`]*[^\s<>"'`.,;:!?)\]]/g },
  { name: "bold", re: /\*\*(?=\S)([\s\S]{0,498}?\S)\*\*|__(?=\S)([\s\S]{0,498}?\S)__/g },
  { name: "strike", re: /~~(?=\S)([\s\S]{0,498}?\S)~~/g },
  {
    name: "italic",
    re: /\*(?=[^\s*])([\s\S]{0,498}?[^\s*])\*(?!\*)|(?<![\p{L}\p{N}_])_(?=[^\s_])([\s\S]{0,498}?[^\s_])_(?![\p{L}\p{N}_])/gu,
  },
];

const defaultRenderLink: LinkRenderer = (href, children, key) => (
  <a
    key={key}
    href={href}
    target="_blank"
    rel="noreferrer noopener"
    className="underline underline-offset-2 hover:text-foreground"
  >
    {children}
  </a>
);

function renderInline(text: string, key: string, options: MarkdownOptions, depth = 0): ReactNode[] {
  const out: ReactNode[] = [];
  let pos = 0;
  let plain = "";
  let n = 0;
  // Each rule's first match at or after `pos` (null: none left, undefined: not searched yet). A rule is
  // searched again only once the cursor has passed its match, so the text is scanned about once per rule.
  const next: Array<RegExpExecArray | null | undefined> = INLINE_RULES.map(() => undefined);
  const flushPlain = () => {
    if (plain === "") return;
    // A newline inside a paragraph is a hard break only after two spaces or a backslash.
    const parts = plain.split(/(?: {2,}|\\)\n/);
    parts.forEach((part, index) => {
      if (index > 0) out.push(<br key={`${key}-br${n++}`} />);
      if (part !== "") out.push(part.replace(/\n/g, " "));
    });
    plain = "";
  };
  while (pos < text.length) {
    let best: { rule: InlineRule; match: RegExpExecArray } | null = null;
    for (let index = 0; index < INLINE_RULES.length; index += 1) {
      const rule = INLINE_RULES[index];
      let match = next[index];
      if (match === undefined || (match !== null && match.index < pos)) {
        rule.re.lastIndex = pos;
        match = rule.re.exec(text);
        next[index] = match;
      }
      if (match !== null && (best === null || match.index < best.match.index)) best = { rule, match };
    }
    if (best === null) {
      plain += text.slice(pos);
      break;
    }
    const { rule, match } = best;
    plain += text.slice(pos, match.index);
    pos = match.index + match[0].length;
    const childKey = `${key}-${n++}`;
    const inner = (value: string): ReactNode[] =>
      depth < MAX_DEPTH ? renderInline(value, childKey, options, depth + 1) : [value];
    switch (rule.name) {
      case "escape":
        plain += match[1] ?? "";
        continue;
      case "code":
        flushPlain();
        out.push(
          <code key={childKey} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
            {(match[2] ?? "").replace(/\n/g, " ")}
          </code>,
        );
        continue;
      case "link": {
        const href = safeHref(match[2] ?? "");
        flushPlain();
        if (href === null) out.push(...inner(match[1] ?? ""));
        else out.push((options.renderLink ?? defaultRenderLink)(href, inner(match[1] ?? ""), childKey));
        continue;
      }
      case "autolink":
      case "url": {
        const raw = match[1] ?? match[0];
        const href = safeHref(raw);
        if (href === null) {
          plain += match[0];
          continue;
        }
        flushPlain();
        out.push((options.renderLink ?? defaultRenderLink)(href, raw, childKey));
        continue;
      }
      case "bold":
        flushPlain();
        out.push(
          <strong key={childKey} className="font-semibold">
            {inner(match[1] ?? match[2] ?? "")}
          </strong>,
        );
        continue;
      case "strike":
        flushPlain();
        out.push(<del key={childKey}>{inner(match[1] ?? "")}</del>);
        continue;
      case "italic":
        flushPlain();
        out.push(<em key={childKey}>{inner(match[1] ?? match[2] ?? "")}</em>);
        continue;
    }
  }
  flushPlain();
  return out;
}

// --- blocks -> React -------------------------------------------------------

const HEADING_CLASSES = [
  "text-base font-semibold",
  "text-[0.95rem] font-semibold",
  "text-sm font-semibold",
  "text-sm font-medium",
  "text-sm font-medium",
  "text-sm font-medium text-muted-foreground",
] as const;

function renderBlocks(blocks: Block[], key: string, options: MarkdownOptions): ReactNode[] {
  return blocks.map((block, index) => {
    const k = `${key}.${index}`;
    switch (block.type) {
      case "heading": {
        const Tag = (["h3", "h4", "h5", "h6", "h6", "h6"] as const)[block.level - 1] ?? "h6";
        return (
          <Tag key={k} className={cn("mt-4 first:mt-0", HEADING_CLASSES[block.level - 1])}>
            {renderInline(block.text, k, options)}
          </Tag>
        );
      }
      case "paragraph":
        return (
          <p key={k} className="mt-2 first:mt-0">
            {renderInline(block.text, k, options)}
          </p>
        );
      case "code":
        return (
          <pre key={k} className="mt-2 overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs first:mt-0">
            <code>{block.text}</code>
          </pre>
        );
      case "quote":
        return (
          <blockquote key={k} className="mt-2 border-l-2 border-border pl-3 text-muted-foreground first:mt-0">
            {renderBlocks(block.blocks, k, options)}
          </blockquote>
        );
      case "hr":
        return <hr key={k} className="my-4 border-border" />;
      case "list": {
        const items = block.items.map((item, itemIndex) => {
          const itemKey = `${k}.${itemIndex}`;
          return (
            <li key={itemKey} className={cn("pl-0.5", item.checked !== null && "list-none")}>
              {item.checked === null ? null : (
                <input
                  type="checkbox"
                  checked={item.checked}
                  disabled
                  readOnly
                  aria-label={item.checked ? "Выполнено" : "Не выполнено"}
                  className="-ml-5 mr-1.5 align-middle"
                />
              )}
              {renderInline(item.text, itemKey, options)}
              {item.children.length > 0 ? renderBlocks(item.children, itemKey, options) : null}
            </li>
          );
        });
        return block.ordered ? (
          <ol
            key={k}
            start={block.start === 1 ? undefined : block.start}
            className="mt-2 list-decimal space-y-1 pl-5 first:mt-0"
          >
            {items}
          </ol>
        ) : (
          <ul key={k} className="mt-2 list-disc space-y-1 pl-5 first:mt-0">
            {items}
          </ul>
        );
      }
      case "table":
        return (
          <div key={k} className="mt-2 overflow-x-auto first:mt-0">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  {block.header.map((cell, cellIndex) => (
                    <th
                      key={cellIndex}
                      style={{ textAlign: block.align[cellIndex] ?? undefined }}
                      className="border border-border bg-muted px-2 py-1 text-left font-medium"
                    >
                      {renderInline(cell, `${k}.h${cellIndex}`, options)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {block.header.map((_, cellIndex) => (
                      <td
                        key={cellIndex}
                        style={{ textAlign: block.align[cellIndex] ?? undefined }}
                        className="border border-border px-2 py-1 align-top"
                      >
                        {renderInline(row[cellIndex] ?? "", `${k}.${rowIndex}.${cellIndex}`, options)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
    }
  });
}

export function renderMarkdown(source: string, options: MarkdownOptions = {}): ReactNode[] {
  return renderBlocks(parseMarkdown(source), "md", options);
}

export function SafeMarkdown({
  source,
  className,
  renderLink,
}: {
  source: string;
  className?: string;
  renderLink?: LinkRenderer;
}) {
  return (
    <div className={cn("break-words text-sm leading-relaxed text-foreground", className)}>
      {useMemo(() => renderMarkdown(source, renderLink === undefined ? {} : { renderLink }), [source, renderLink])}
    </div>
  );
}
