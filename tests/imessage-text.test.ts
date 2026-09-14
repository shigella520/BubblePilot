import { describe, expect, it } from "vitest";

import { normalizeIMessageText } from "../modules/integrations/bluebubbles/imessage-text.js";

describe("normalizeIMessageText", () => {
  it("turns common model-generated Markdown into readable plain text", () => {
    const markdown = [
      "### 群成员",
      "1. **锤钰（老大）**：负责组织聊天。",
      "- [群主页](https://example.test/group)",
      "> `兰博`负责整理信息。",
      "- [x] 已确认",
      "- [ ] 待确认",
      "",
      "| 名称 | 身份 |",
      "| --- | --- |",
      "| 兰博 | 助手 |",
      "",
      "```text",
      "不要显示代码围栏",
      "```",
    ].join("\n");

    expect(normalizeIMessageText(markdown)).toBe(
      [
        "群成员",
        "1. 锤钰（老大）：负责组织聊天。",
        "• 群主页：https://example.test/group",
        "兰博负责整理信息。",
        "☑ 已确认",
        "☐ 待确认",
        "",
        "名称 ｜ 身份",
        "兰博 ｜ 助手",
        "",
        "不要显示代码围栏",
      ].join("\n"),
    );
  });

  it("preserves ordinary text, URLs, identifiers and numbered lists", () => {
    const plainText = [
      "访问 https://example.test/a_b?q=x*y",
      "计算 2 * 3，保留 ID foo_bar_baz。",
      "1. 普通数字列表",
    ].join("\n");

    expect(normalizeIMessageText(plainText)).toBe(plainText);
  });

  it("removes code delimiters without changing code content", () => {
    const markdown = [
      "调用 `__init__`：",
      "```python",
      "# comment",
      "value = 2**3**4",
      "```",
    ].join("\n");

    expect(normalizeIMessageText(markdown)).toBe(
      ["调用 __init__：", "# comment", "value = 2**3**4"].join("\n"),
    );
  });
  it("preserves HTML, type syntax and Markdown-like operators inside code", () => {
    const code = [
      '<span class="label">示例</span>',
      "  const values: Array<string> = [];",
      "  if (a < b && b > 0) values.push('**literal**');",
      "",
      "",
      "  // keep blank lines and indentation",
    ].join("\n");
    expect(normalizeIMessageText("代码：\n\n```html\n" + code + "\n```")).toBe(
      "代码：\n\n" + code,
    );
    expect(
      normalizeIMessageText("讨论 `<span>示例</span>` 和 `Array<T>`。"),
    ).toBe("讨论 <span>示例</span> 和 Array<T>。");
    expect(normalizeIMessageText("<span>示例</span>")).toBe(
      "<span>示例</span>",
    );
  });
});
