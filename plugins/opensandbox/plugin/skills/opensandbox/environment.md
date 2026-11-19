# 网络与运行环境

使用 prepare_sandbox 或导入返回的 runtime 清单确认预装能力；短任务不临时安装依赖。项目镜像提供 Python 3.12、常用 CLI、HTTP、表格、PDF 文本和图片处理能力，不提供浏览器或 OCR。

项目镜像不预装 curl、wget、git、gawk、dig。HTTP 和下载可用 Python httpx，文本处理用 Python、grep 或 sed；不是所有任务都需要命令行外部工具。

HTTP 请求可以使用管理员配置的代理。普通 ping 和 DNS 不走 HTTP 代理，ping 还取决于内核权限；基本 DNS 可用 Python socket，不等于 dig 的完整诊断能力。只访问用户授权的目标，不为网络诊断扩大权限。
