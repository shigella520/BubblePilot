# 绘图与 SVG 渲染

仅用于需要绘图的任务。普通数据计算和文件处理不必先转成 SVG。

以 runtime 清单为准，项目镜像提供 resvg、`bp-render-svg` 和 Noto Sans CJK SC。用 `write_file` 写入原生 SVG 或 Python 绘图脚本，再执行短命令；例如：

```sh
bp-render-svg /workspace/chart.svg /workspace/chart.png --width 2400
```

渲染器的输入和输出都必须是 `/workspace/…` 绝对路径。不要使用 HTML foreignObject 或外部 CSS、图片、字体资源。渲染失败时先检查返回的明确原因，不能靠改扩展名绕过格式校验。

复杂排版可以用已授权 `view_image` 做可选预览；不是每次必须执行，也不替代最终产物。需要发回聊天时为 `prepare_chat_attachment` 留出一次调用和时间；准备成功不代表已发送。不循环修改到预算耗尽。
