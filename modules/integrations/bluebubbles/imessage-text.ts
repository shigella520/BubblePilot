function formatMarkdownLink(label: string, rawTarget: string): string {
  const target = rawTarget
    .trim()
    .replace(/\s+["'][^"']*["']$/, "")
    .replace(/^<|>$/g, "")
    .trim();
  const visibleLabel = label.trim();

  if (visibleLabel.length === 0 || visibleLabel === target) {
    return target;
  }
  if (target.length === 0) {
    return visibleLabel;
  }
  return `${visibleLabel}：${target}`;
}

/** Convert common model-generated Markdown into iMessage-friendly plain text. */
export function normalizeIMessageText(input: string): string {
  let output = input.replace(/\r\n?/g, "\n");
  const protectedCode: string[] = [];
  const protectCode = (value: string): string => {
    const token = `\uE000${protectedCode.length}\uE001`;
    protectedCode.push(value);
    return token;
  };

  output = output
    .replace(
      /^[ \t]*(?:`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n^[ \t]*(?:`{3,}|~{3,})[ \t]*$/gm,
      (_, code) => protectCode(String(code)),
    )
    .replace(/(`+)([^`\n]+?)\1/g, (_, _delimiter, code) =>
      protectCode(String(code)),
    );

  output = output
    // Remove unmatched fences and other unsupported block syntax.
    .replace(/^[ \t]*(`{3,}|~{3,})[^\n]*$/gm, "")
    // Remove Markdown-only block syntax while retaining readable structure.
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]{0,3}(?:>[ \t]?)+/gm, "")
    .replace(
      /^[ \t]{0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/gm,
      "",
    )
    .replace(
      /^([ \t]*)[-+*][ \t]+\[([ xX])\][ \t]+/gm,
      (_, indent, mark) =>
        `${String(indent)}${String(mark).toLowerCase() === "x" ? "☑" : "☐"} `,
    )
    .replace(/^([ \t]*)[-+*][ \t]+/gm, "$1• ")
    // Drop Markdown table separators and render table rows as plain text.
    .replace(
      /^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)+\|?[ \t]*$(?:\n)?/gm,
      "",
    )
    .replace(/^([ \t]*)\|(.+)\|[ \t]*$/gm, (_, indent, cells) => {
      const row = String(cells)
        .split("|")
        .map((cell) => cell.trim())
        .join(" ｜ ");
      return `${String(indent)}${row}`;
    });

  output = output
    .replace(/!\[([^\]\n]*)\]\(([^)\n]+)\)/g, (_, label, target) =>
      formatMarkdownLink(String(label), String(target)),
    )
    .replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, (_, label, target) =>
      formatMarkdownLink(String(label), String(target)),
    )
    .replace(/<((?:https?:\/\/|mailto:)[^>\n]+)>/g, "$1")
    .replace(/(?<![\w*])\*\*(?=\S)([^\n]*?\S)\*\*(?![\w*])/g, "$1")
    .replace(/(?<![\w_])__(?=\S)([^\n]*?\S)__(?![\w_])/g, "$1")
    .replace(/(?<![\w~])~~(?=\S)([^\n]*?\S)~~(?![\w~])/g, "$1")
    .replace(/(?<![\w*])\*(?=\S)([^\n*]*?\S)\*(?![\w*])/g, "$1")
    .replace(/(?<![\w_])_(?=\S)([^\n_]*?\S)_(?![\w_])/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return output.replace(/\uE000(\d+)\uE001/g, (_, index) => {
    return protectedCode[Number(index)] ?? "";
  });
}
