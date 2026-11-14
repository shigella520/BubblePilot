# 单任务沙箱基础风险接受记录

批准日期：2026-10-23。用户在查看基础镜像对比和有条件发布流程后授权继续处理。有效期至 2026-11-22 00:00 UTC；不是无期限的安全豁免。

## 适用范围

仅适用于固定 Python slim 基础镜像上的本项目 amd64 精简运行镜像、单次任务生命周期、512 MiB、单并发、600 秒 TTL，无宿主数据/凭据/Docker Socket 注入。不得用于公网服务、多租户不可信任代码托管或长期保存数据。源码输入哈希和具体 CVE/包/版本绑定见 [risk-baseline.json](risk-baseline.json)；最终部署镜像 digest 另在部署记录保存。

同库复扫证实基础镜像和精简镜像均为 8 个 CVE、44 条 HIGH、0 CRITICAL，受影响包版本一致。本次接受已知基础风险，不宣称不存在未知漏洞或逃逸风险。

## 逐项判断

| CVE | 判断与接受理由 |
| --- | --- |
| CVE-2026-16742 | systemd-homed 不在镜像中，也未启动对应服务。 |
| CVE-2026-9538 | 精简后 Archive::Tar 模块缺失；保留 perl-base 导致扫描仍报告。 |
| CVE-2026-78409 | 公告涉及 Linux 6.15+；NAS 实测内核 5.10.55+，并无 SYS_ADMIN。 |
| CVE-2026-76642、CVE-2026-78408、CVE-2026-78410 | 已验证非特权、no-new-privileges、无 SYS_ADMIN、无宿主挂载、独立 PID/IPC、cgroup 控制器只读；不声称工具不存在。 |
| CVE-2025-69720、CVE-2026-54369 | 相关解析器/库仍存在，不能证明不可触发；在本来允许任务执行任意代码的临时容器内接受剩余风险。安全边界依赖容器隔离而不是提示词，短生命周期不等于修复。 |

所有项目未执行漏洞利用验证。root 在容器内运行、根文件系统可写、NAS 缺少 CPU CFS/PIDs 限额、网络可访问内网仍是已知限制；不能据此向用户承诺强隔离。

## 实际隔离核验与部署前置条件

2026-10-23 经生产 MCP 适配服务创建虚构测试任务：Privileged=false、无 Bind/设备、no-new-privileges=true、SYS_ADMIN/SYS_PTRACE/NET_ADMIN/NET_RAW 等已移除，内存 536870912 字节；中文文件读写、会话复用、容量隔离、代理 HTTP 200 与会话结束清理通过。

发现 OpenSandbox 1.1.0 忽略已有 publish_host 配置，临时端口仍绑定 0.0.0.0。部署必须升级至支持该字段的稳定版 1.1.1，并实测仅绑定 Docker 内部网关后才可放行；不得把写入配置等同生效。此处指沙箱子容器，不是 MCP 适配容器。

## 发布检查

完整 Trivy JSON 作为 CI 证据保留。check-scan.mjs 仅接受上述固定 CVE/包/版本的 HIGH，拒绝新增发现、CRITICAL、已提供 FixedVersion、过期基线、构建源码输入变化及不完整扫描。没有全局 ignore-unfixed 或通配忽略。更换基础镜像、依赖、能力清单时须重新审阅；运行时安装软件会改变适用条件，Skill 不等同强制禁止。

发布后保留原镜像与配置备份；部署核验失败回滚。到期重新扫描评估，不自动续期。

实际前置核验已完成：NAS 已备份到 opensandbox/backups/runtime-release-20261023，server 固定为 opensandbox/server@sha256:bcd5f264101262cebfa7e1ff9cd0424403e42f31a6596e4364cf90d8cb5c936b。新版虚构测试沙箱的 44772/8080 端口均只绑定 172.17.0.1，非特权、no-new-privileges 和无挂载保持。四工具、中文文件、会话复用/容量隔离、代理 HTTP 200、任务结束 remaining=0 均通过。首次创建 25.1 秒；测试人为保留的 45 秒不计入创建速度。运行镜像/适配器升级仍由后续镜像流水线及部署核验决定。

## 2026-10-31 修复更新

发布扫描新增 pypdf CVE-2026-119203 至 CVE-2026-119209（恶意 PDF 导致无限循环或内存耗尽）。将 pypdf 从 6.21.2 升级到 6.21.4，wheel/sdist 哈希取自 PyPI 版本元数据。仅同步锁文件源哈希；既有 Debian 风险例外条目、批准时间、有效期与阻断规则不变，不豁免上述 Python 漏洞。更新镜像须重新通过冒烟测试及实际候选扫描。

## 2026-11-03 SQLite 修复

CVE-2026-119373 是启用 FTS5 时 `detail=none`、负 rowid 和前缀查询合并中的堆溢出。Debian tracker 当日尚未提供发行版修复包，上游已在 3.54.0 修复。固定官方 3.54.1 源码，独立构建阶段产出 `bubblepilot-sqlite` Debian 包，提供并替换 `libsqlite3-0` 和 `sqlite3`，维持 liblastlog2 的共享库依赖。最终镜像不保留旧库或编译器。不是仅改变包版本或删除扫描元数据。

源码：https://www.sqlite.org/2026/sqlite-autoconf-3540100.tar.gz 。官方 SHA3-256：`b6ced585c750916b1052667239a12c25a7ff34e7f06e1e6e01ecb0427657d9c4`；下载后交叉核对并固定 SHA-256：`926ef8d3eab93fbf6e06011901273eec076b25594a4e1cdadd50c987f4f6d64e`。

依据：https://security-tracker.debian.org/tracker/CVE-2026-119373 。Python sqlite3 和命令行均断言 3.54.1，运行负 rowid 的 FTS5 前缀查询回归。自编译包不属于 Debian 官方漏洞映射，不能只凭 Trivy 不再列出原包认定修复；版本、来源哈希和功能回归共同作为证据。后续须跟踪 SQLite 上游安全更新。仅更新 Dockerfile 源哈希，不新增 CVE 例外或延长有效期。

## 2026-11-05 APT 与 zlib 修复

PR #56 完整扫描新增 APT CVE-2026-109518（apt、libapt-pkg7.0）与 zlib CVE-2026-76844，原风险门禁保持阻断。构建阶段及最终阶段先经 HTTPS、`Acquire::Retries=0` 升级 APT 至 Debian 官方安全更新 3.0.4 或更高，再安装其余依赖；避免未修复 APT 的重定向／重试硬链接复用条件。

Debian trixie 当日仍无 zlib 修复包；采用上游正式版 1.4，与 SQLite 一样制作独立 `bubblepilot-zlib` Debian 包，替换旧 `zlib1g` 并提供版本化依赖，不保留旧系统共享库或编译器。官方发布资产 SHA-256 与下载交叉核对：`02dd159783677a749c04adbdd02b55b8a2bcc7e054f51b76b549199a916ad584`，在 Dockerfile 中固定。构建运行上游 `make check`；最终镜像验证 Python 和系统加载器均为 1.4、APT 最低修复版本、gzip/zlib 往返，以及 `/dev/full` 写失败→清除错误→不同缓冲区再次写入的回归。

依据：[Debian APT 公告](https://lists.debian.org/debian-security-announce/2026/msg00526.html)、[Debian zlib tracker](https://security-tracker.debian.org/tracker/CVE-2026-76844)、[zlib 1.4 正式发布](https://github.com/madler/zlib/releases/tag/v1.4)、[上游修复](https://github.com/madler/zlib/commit/df84af25dc1942490e1d1c899a07619152a46148)。Tracker 明确 CVE-2026-76844 与 CVE-2026-85091 使用同一修复。

自编译库的安全证据包含来源、哈希、实际加载版本与功能回归，不以扫描器不再列出 Debian 包作为唯一依据。仅同步 Dockerfile 源哈希，不新增风险例外或延长有效期。此次修复随代码合并；已部署的 NAS 运行镜像不会随合并自动更新，后续需单独发布运行镜像并切换 digest。

## 2026-11-12 Kerberos 修复

PR #58 的完整 CI 扫描发现 14 个新的 HIGH CVE、56 条包记录，来自 `iproute2 → libtirpc3t64 → libgssapi-krb5-2` 引入的四个 Kerberos 库。Debian trixie 的 1.21.3-5+deb13u1 当日尚无对应修复包；不扩大原风险例外，不因未启动 KDC 服务而忽略库漏洞。

采用 [MIT 官方 1.22.3](https://web.mit.edu/kerberos/krb5-1.22/)（2026-11-09 发布），其修复说明覆盖 CVE-2026-107364、CVE-2026-112315—112323、CVE-2026-118380、CVE-2026-119079、CVE-2026-71199、CVE-2026-71200。源码从 [MIT 分发站](https://kerberos.org/dist/index.html)获取；发行签名验证通过，签名指纹 `C4493CB739F4A89F9852CBC20CBA08575F8372DF` 与官方分发页一致。固定源码 SHA-256：`fe90af8441ad9fa9b064b8e53077cefb782a96f8a68276b031dc54af1789ff0b`。

独立构建阶段制作 `bubblepilot-krb5` Debian 包，替换 `libgssapi-krb5-2`、`libkrb5-3`、`libk5crypto3`、`libkrb5support0`，通过版本化 Provides 维持 libtirpc 和 iproute2 的依赖；最终镜像仅包含这四个运行库，不新增 Kerberos 服务、命令或编译器。沿用现有 libcom-err2、OpenSSL 和 keyutils 依赖；构建运行上游 ASN.1 与密码算法测试。

验收要求包括：旧包不残留、动态加载库版本为 1.22.3、Kerberos context 与 GSS 机制初始化、普通权限下 ip/ss 只读诊断，以及既有 512 MiB 冒烟和完整漏洞扫描。自编译包不完全属于 Debian 公告映射，不能只凭扫描项消失宣称修复；签名来源、真实库替换与功能验证共同作为证据。仅更新 Dockerfile 源哈希，风险例外条目和有效期不变。

本次为合并前源码修复，不发布镜像或修改 NAS；现有 NAS 运行镜像需后续单独授权构建发布、扫描并切换 digest 才能获得修复。

## 2026-11-13 Soup Sieve 修复

完整 CI 扫描发现 [CVE-2026-126190](https://github.com/facelessuser/soupsieve/security/advisories/GHSA-mmhr-3c5m-f64f)：对不可信的深层嵌套 HTML 执行后代选择器可能长时间占用 CPU。将 Beautiful Soup 的间接依赖 Soup Sieve 从 3.0.4 升级到官方修复版 4.0，并使用 PyPI 版本元数据固定 wheel 与源码包哈希。Beautiful Soup 的现有依赖约束兼容该版本；镜像冒烟测试覆盖正常选择及公告中的深层未命中场景。

4.0 的默认选择器启用修复缓存；显式使用上游 `NOCACHE` 选项仍会保留旧行为，不应对不可信内容使用该选项。仅同步锁文件源哈希，现有 Debian 风险例外、批准时间及有效期不变；新镜像须重新通过 512 MiB 冒烟和完整扫描。NAS 已有运行镜像不会因源码修复而自动更新。
