# 沙箱运行镜像精简复核

日期：2026-10-23。仅本地构建验证，未发布镜像、未更新 NAS，未批准风险例外。

## 调整及结果

| 项目 | 精简前 | 精简后 |
| --- | --- | --- |
| 新增可选工具 | 含 gawk、curl、wget、dnsutils、git | 移除以上五项 |
| HIGH 包记录 | 66 | 44 |
| CRITICAL 包记录 | 6 | 0 |
| 去重 CVE | 29 | 8 |
| 镜像展开大小 | 624,588,931 字节 | 473,182,973 字节 |
| 发布门禁 | 阻断 | 仍阻断 |

移除了 21 个 CVE 对应的受影响组件，不表示修复了这些组件的上游漏洞。libcurl、libxml2、liblmdb0、完整 Perl 及其模块等可避免依赖已不在镜像中；基础镜像自带的 perl-base 保留。

HTTP 请求及下载使用 httpx；文本处理使用 Python、grep、sed；基础域名解析使用 socket，不经过 HTTP 代理。不再提供 Git 克隆和 dig 完整诊断。其他 CLI 和八项 Python 直接依赖保持。

## 剩余风险

以下受影响包均已存在于固定的 Python slim 基础镜像。此列表来自精简后的扫描，不能以移除新增 CLI 消除这些风险；无 HIGH/CRITICAL Python 依赖发现。

| CVE | 镜像中受影响包 |
| --- | --- |
| CVE-2025-69720 | libncursesw6, libtinfo6, ncurses-base, ncurses-bin |
| CVE-2026-16742 | libsystemd0, libudev1 |
| CVE-2026-54369 | libacl1 |
| CVE-2026-76642 | bsdutils, libblkid1, liblastlog2-2, libmount1, libsmartcols1, libuuid1, login, mount, util-linux |
| CVE-2026-78408 | bsdutils, libblkid1, liblastlog2-2, libmount1, libsmartcols1, libuuid1, login, mount, util-linux |
| CVE-2026-78409 | bsdutils, libblkid1, liblastlog2-2, libmount1, libsmartcols1, libuuid1, login, mount, util-linux |
| CVE-2026-78410 | bsdutils, libblkid1, liblastlog2-2, libmount1, libsmartcols1, libuuid1, login, mount, util-linux |
| CVE-2026-9538 | perl-base |

机器清单：[精简后扫描](security-findings-trimmed.json)。旧候选的[扫描](security-findings.json)和[风险审核草案](risk-review.md)保留作历史证据；风险分析未经漏洞利用验证，也没有批准任何例外。发布继续按 HIGH/CRITICAL 阻断，未使用 ignore-unfixed 或忽略列表。

## 验证

- amd64 镜像重新构建成功，镜像 ID 为 `sha256:ae801d626322bffbff99b0912507db95617f78f6555454bd6565ab529d7aaf96`。
- 无外网、512 MiB、移除全部 capabilities 的冒烟测试通过；CLI/库、pip check、CSV、Excel、PDF 文本、HTML/YAML、图片、SQLite、解压、本地 HTTP 请求/错误/流式下载、localhost 解析均通过。检查移除组件未被间接装回。
- 同容器文件复用、新容器不继承通过。冒烟峰值 RSS 135,864 KiB，未 OOM。
- 本机 ARM Docker Desktop 模拟 amd64，缓存启动至 Python 可用三次：基础镜像 280/273/272 ms，精简镜像 277/240/243 ms。精简镜像空闲 4.582 MiB；不代表 NAS OpenSandbox 全链路或稳定性能结论。
- 适配器 16 项测试、类型及构建通过；格式、文档链接、应用依赖安全检查和两份 Compose 校验通过（应用依赖已有 1 项 LOW）。
- 此轮只调整运行镜像与指引；之前完整 pnpm verify 及独立 PostgreSQL 的通过记录仍保留，本轮未重复数据库集成测试。

## 与基础镜像同库复扫

2026-10-23 使用同一 Trivy 容器先扫描固定基础镜像，再以 skip-db-update 扫描精简候选，保证两次使用同一漏洞库。按 CVE、包名、安装版本和严重性比较：两者均为 44 HIGH 包记录、8 个独立 CVE、0 CRITICAL，差集为空。详见[对比记录](baseline-comparison.json)。这是已知 HIGH/CRITICAL 发现一致，不证明整体攻击面完全相同或没有未知漏洞。

额外复核：精简后 perl -MArchive::Tar 无法加载模块，旧候选中 Archive::Tar 存在的证据不再适用；已修正精简扫描清单的风险说明。systemd-homed 亦不存在。mount/umount 仍为 SUID，nsenter 和 infocmp 仍存在，实际 NAS 子容器隔离条件尚未重新核验。

针对单任务、无公网监听的沙箱，建议未来将全量 HIGH 阻断调整为经审核的基础风险基线加新增风险检查，结合真实子容器权限、宿主挂载、内网访问及资源限制决定例外。短生命周期减小驻留时间，无公网入口减小入站暴露，但外部下载与模型生成命令仍可触达漏洞。当前仅提出建议，未改动 CI 门禁或批准例外。
