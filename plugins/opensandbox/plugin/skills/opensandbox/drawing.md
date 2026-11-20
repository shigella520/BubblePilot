# 绘图与 SVG 渲染

仅用于需要绘图的任务。普通数据计算和文件处理不必先转成 SVG。

以 runtime 清单为准，项目镜像提供 resvg、`bp-render-svg` 和 Noto Sans CJK SC。用 `write_file` 写入原生 SVG 或 Python 绘图脚本，再执行短命令；例如：

```sh
bp-render-svg /workspace/chart.svg /workspace/chart.png --width 2400
```

渲染器的输入和输出都必须是 `/workspace/…` 绝对路径。不要使用 HTML foreignObject 或外部 CSS、图片、字体资源。渲染失败时先检查返回的明确原因，不能靠改扩展名绕过格式校验。

复杂排版可以用已授权 `view_image` 做可选预览；不是每次必须执行，也不替代最终产物。需要发回聊天时为 `prepare_chat_attachment` 留出一次调用和时间；准备成功不代表已发送。不循环修改到预算耗尽。

## GIF 动画交付

只有 `prepare_chat_attachment` 的允许类型包含 `gif` 时才直接准备 `.gif`。用 Pillow 绘制多个栅格帧，或把多个静态 SVG 帧逐帧渲染为 PNG 后再用 Pillow 合成，例如 `frames[0].save("/workspace/result.gif", save_all=True, append_images=frames[1:], duration=100, loop=0)`。`bp-render-svg` 不执行 SVG 动画时间轴，单次渲染只产生静态 PNG；不要把包含 `<animate>` 的 SVG 当成已生成的 GIF。

GIF 最多 8 MiB、200 帧；单帧画布不超过 8192 边长/1600 万像素，画布宽×高×帧数不超过 6400 万。保存后核对 `format`、`n_frames`、`duration`、`loop` 和文件大小；输出超限时减少分辨率或帧数。`view_image` 只看首帧，不能证明整段动画正确。原始 GIF 可直接交付，无需为了传输再包一层 ZIP；未获 GIF 授权时不能通过改扩展名绕过。
