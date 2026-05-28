/** @jsxImportSource preact */
import { h, Fragment } from "preact";
import { useState } from "preact/hooks";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type InlineNode =
  | { t: "text"; v: string }
  | { t: "bold"; children: InlineNode[] }
  | { t: "italic"; children: InlineNode[] }
  | { t: "code"; v: string }
  | { t: "link"; href: string; children: InlineNode[] };

// ---------------------------------------------------------------------------
// Inline parser
// ---------------------------------------------------------------------------

/**
 * Tokenise a plain string into inline nodes: bold, italic, code, links,
 * plain text. Never throws — unknown/partial syntax degrades to plain text.
 */
function parseInline(src: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let i = 0;

  const pushText = (s: string) => {
    if (!s) return;
    const last = nodes[nodes.length - 1];
    if (last && last.t === "text") {
      last.v += s;
    } else {
      nodes.push({ t: "text", v: s });
    }
  };

  while (i < src.length) {
    // Inline code: `...`
    if (src[i] === "`") {
      const end = src.indexOf("`", i + 1);
      if (end !== -1) {
        nodes.push({ t: "code", v: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    // Link: [text](url)
    if (src[i] === "[") {
      const closeBracket = src.indexOf("]", i + 1);
      if (closeBracket !== -1 && src[closeBracket + 1] === "(") {
        const closeParen = src.indexOf(")", closeBracket + 2);
        if (closeParen !== -1) {
          const linkText = src.slice(i + 1, closeBracket);
          const href = src.slice(closeBracket + 2, closeParen);
          nodes.push({ t: "link", href, children: parseInline(linkText) });
          i = closeParen + 1;
          continue;
        }
      }
    }

    // Bold: **...** or __...__
    if (
      (src[i] === "*" && src[i + 1] === "*") ||
      (src[i] === "_" && src[i + 1] === "_")
    ) {
      const delim = src.slice(i, i + 2);
      const end = src.indexOf(delim, i + 2);
      if (end !== -1) {
        nodes.push({ t: "bold", children: parseInline(src.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }

    // Italic: *...* or _..._ (single)
    if (src[i] === "*" || src[i] === "_") {
      const delim = src[i];
      const end = src.indexOf(delim, i + 1);
      if (end !== -1) {
        nodes.push({ t: "italic", children: parseInline(src.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }

    pushText(src[i]);
    i++;
  }

  return nodes;
}

// ---------------------------------------------------------------------------
// Inline renderer
// ---------------------------------------------------------------------------

function renderInline(nodes: InlineNode[]): preact.ComponentChildren {
  return nodes.map((n, idx) => {
    switch (n.t) {
      case "text":
        return n.v;
      case "code":
        return (
          <code
            key={idx}
            class="px-1 py-0.5 rounded text-[0.8em] bg-gray-800 text-brand-300 font-mono border border-gray-700/60"
          >
            {n.v}
          </code>
        );
      case "bold":
        return <strong key={idx}>{renderInline(n.children)}</strong>;
      case "italic":
        return <em key={idx}>{renderInline(n.children)}</em>;
      case "link":
        return (
          <a
            key={idx}
            href={n.href}
            target="_blank"
            rel="noopener noreferrer"
            class="text-brand-400 underline hover:text-brand-300 transition-colors"
          >
            {renderInline(n.children)}
          </a>
        );
    }
  });
}

// ---------------------------------------------------------------------------
// Block types
// ---------------------------------------------------------------------------

type Block =
  | { t: "paragraph"; inline: string }
  | { t: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; inline: string }
  | { t: "code_block"; lang: string; code: string }
  | { t: "blockquote"; lines: string[] }
  | { t: "ul"; items: string[] }
  | { t: "ol"; items: string[] };

// ---------------------------------------------------------------------------
// Block parser — line-based
// ---------------------------------------------------------------------------

function parseBlocks(src: string): Block[] {
  const lines = src.split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (line.trimStart().startsWith("```")) {
      const fence = line.trimStart().slice(0, 3);
      const lang = line.trimStart().slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith(fence)) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      blocks.push({ t: "code_block", lang, code: codeLines.join("\n") });
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const level = Math.min(headingMatch[1].length, 6) as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push({ t: "heading", level, inline: headingMatch[2] });
      i++;
      continue;
    }

    // Blockquote (collect consecutive > lines)
    if (line.match(/^>\s?/)) {
      const bqLines: string[] = [];
      while (i < lines.length && lines[i].match(/^>\s?/)) {
        bqLines.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ t: "blockquote", lines: bqLines });
      continue;
    }

    // Unordered list
    if (line.match(/^[-*]\s/)) {
      const items: string[] = [];
      while (i < lines.length && lines[i].match(/^[-*]\s/)) {
        items.push(lines[i].replace(/^[-*]\s/, ""));
        i++;
      }
      blocks.push({ t: "ul", items });
      continue;
    }

    // Ordered list
    if (line.match(/^\d+\.\s/)) {
      const items: string[] = [];
      while (i < lines.length && lines[i].match(/^\d+\.\s/)) {
        items.push(lines[i].replace(/^\d+\.\s/, ""));
        i++;
      }
      blocks.push({ t: "ol", items });
      continue;
    }

    // Blank line — skip (paragraph separator)
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Paragraph — accumulate non-blank lines
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].match(/^(#{1,6}\s|>\s?|[-*]\s|\d+\.\s|```)/)
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      blocks.push({ t: "paragraph", inline: paraLines.join(" ") });
    }
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Copy button (code block)
// ---------------------------------------------------------------------------

function CopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => { /* ignore in extension sandboxed context */ });
  };

  return (
    <button
      onClick={handleCopy}
      title="Copy code"
      class={
        "absolute top-2 right-2 px-1.5 py-0.5 rounded text-[10px] font-mono transition-colors " +
        (copied
          ? "bg-brand-500/30 text-brand-300"
          : "bg-gray-700/60 text-gray-400 hover:bg-gray-600/60 hover:text-gray-200")
      }
    >
      {copied ? "copied" : "copy"}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Block renderer
// ---------------------------------------------------------------------------

function renderBlock(block: Block, idx: number): preact.VNode {
  switch (block.t) {
    case "heading": {
      const cls =
        "font-semibold leading-snug mt-3 mb-1 " +
        (block.level === 1
          ? "text-base text-gray-100"
          : block.level === 2
          ? "text-sm text-gray-100"
          : "text-sm text-gray-200");
      const Tag = `h${block.level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
      return (
        <Tag key={idx} class={cls}>
          {renderInline(parseInline(block.inline))}
        </Tag>
      );
    }

    case "code_block":
      return (
        <div key={idx} class="relative my-2">
          {block.lang && (
            <div class="flex items-center px-3 py-1 rounded-t-md bg-gray-800 border border-b-0 border-gray-700/60">
              <span class="text-[10px] font-mono text-gray-500">{block.lang}</span>
            </div>
          )}
          <pre
            class={
              "overflow-x-auto p-3 text-xs font-mono leading-relaxed text-gray-200 bg-gray-900/80 border border-gray-700/60 " +
              (block.lang ? "rounded-b-md" : "rounded-md")
            }
          >
            <code>{block.code}</code>
          </pre>
          <CopyButton code={block.code} />
        </div>
      );

    case "blockquote":
      return (
        <blockquote
          key={idx}
          class="border-l-2 border-brand-500/50 pl-3 my-2 text-gray-400 italic text-sm"
        >
          {block.lines.map((l, li) => (
            <p key={li} class="m-0">
              {renderInline(parseInline(l))}
            </p>
          ))}
        </blockquote>
      );

    case "ul":
      return (
        <ul key={idx} class="list-disc list-inside my-1 space-y-0.5 text-sm text-gray-200 pl-1">
          {block.items.map((item, ii) => (
            <li key={ii}>{renderInline(parseInline(item))}</li>
          ))}
        </ul>
      );

    case "ol":
      return (
        <ol key={idx} class="list-decimal list-inside my-1 space-y-0.5 text-sm text-gray-200 pl-1">
          {block.items.map((item, ii) => (
            <li key={ii}>{renderInline(parseInline(item))}</li>
          ))}
        </ol>
      );

    case "paragraph":
      return (
        <p key={idx} class="text-sm text-gray-200 leading-relaxed my-1 break-words">
          {renderInline(parseInline(block.inline))}
        </p>
      );
  }
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export function Markdown({ source }: { source: string }): preact.JSX.Element {
  if (!source || !source.trim()) {
    return <Fragment />;
  }
  const blocks = parseBlocks(source);
  return (
    <div class="markdown-body text-gray-200">
      {blocks.map((block, idx) => renderBlock(block, idx))}
    </div>
  );
}
