# 精简前候选镜像漏洞例外审核草案

本文保留精简前镜像的历史评估，不能作为精简后镜像的扫描结果。精简后的实测结果见 [精简复核](trim-review.md)。

评估日期：2026-10-23。**所有条目均未批准；不生成扫描忽略文件，不改变 CI 门槛，不部署。**

## 评估范围与结论

针对本地 amd64 候选镜像 `sha256:69315c28c15530f854292ff3cdb2d2749f0899e570312f84ae0493a54affa7a9`。Trivy 0.69.3 报告 72 条包记录（66 HIGH / 6 CRITICAL），按 CVE 去重为 29 项。本文将漏洞严重性与当前触发条件分开，不将 Debian 的 Minor issue 等同已修复。

- **A：3 项可提交窄范围例外审核**：所需服务/语言绑定缺失，或公告限定的架构不匹配。仅说明当前镜像条件，不是永久安全保证。
- **B：6 项条件性候选，暂不建议批准**：需要核实或新增强制运行限制。当前未完成 NAS 子沙箱权限、内核、cgroup 和挂载核验。
- **C：20 项继续阻断**：相关解析器/库实际存在，可能处理不可信输入，或尚无充分证据证明不可达。

本轮不执行恶意 PoC，不访问生产聊天、不下载恶意文件。通过只读命令核对可执行文件、ELF 位数、动态链接、语言模块和镜像内 fstab；不能据此宣称漏洞已被复现或已完全排除。

## 逐项清单

分类不是批准状态。每项保留原扫描等级，并链接 Debian 官方条目。

| CVE | 等级/分类 | 触发条件 | 本地证据与缺口 | 建议 |
| --- | --- | --- | --- | --- |
| [CVE-2019-16224](https://security-tracker.debian.org/tracker/CVE-2019-16224) | CRITICAL / C | 读取攻击者构造的 data.mdb，md_flags 导致非法写。 | 未装 Python lmdb 或 mdb_dump，但 dig 经 bind9-libs 链接 liblmdb；无法据此排除 C 库调用。 | 保留阻断；确认 BIND 实际调用路径或替换 DNS 工具，不能仅以没有 Python 模块申请例外。 |
| [CVE-2019-16225](https://security-tracker.debian.org/tracker/CVE-2019-16225) | CRITICAL / C | 读取恶意 data.mdb，mp_flags 导致非法写。 | 同上：liblmdb 随 bind9-libs 存在，未证明相关入口不可达。 | 保留阻断；验证调用路径或移除该依赖。 |
| [CVE-2019-16226](https://security-tracker.debian.org/tracker/CVE-2019-16226) | HIGH / C | 恶意 LMDB 节点触发未校验 memmove。 | 库存在，Python 封装缺失并不能证明原生库安全。 | 保留阻断；验证调用路径或移除该依赖。 |
| [CVE-2019-16227](https://security-tracker.debian.org/tracker/CVE-2019-16227) | CRITICAL / C | 恶意 LMDB 游标节点触发非法 memcpy。 | 库存在，经 DNS 工具依赖加载。 | 保留阻断；验证调用路径或移除该依赖。 |
| [CVE-2019-16228](https://security-tracker.debian.org/tracker/CVE-2019-16228) | HIGH / C | 打开恶意 data.mdb，头部零长度字段导致除零。 | 库存在；当前正常 DNS 测试不覆盖恶意数据库入口。 | 保留阻断；验证调用路径或移除该依赖。 |
| [CVE-2025-69720](https://security-tracker.debian.org/tracker/CVE-2025-69720) | HIGH / C | infocmp 分析特制终端描述时发生栈溢出。 | 镜像实际包含 /usr/bin/infocmp。 | 保留阻断；优先评估移除不需要的 infocmp 或升级，不把用途少等同不可触发。 |
| [CVE-2026-12064](https://security-tracker.debian.org/tracker/CVE-2026-12064) | HIGH / B | curl 无 scheme URL + --proto-default sftp/scp，遗漏 SSH 主机验证选项。 | curl -V 明确支持 scp/sftp，路径可能触达；普通显式 https 请求不等于该触发条件。 | 候选条件：强制只允许显式 HTTP(S) 且禁用相关 SSH 路径；当前任意 shell 没有强制控制，暂不批准。 |
| [CVE-2026-16742](https://security-tracker.debian.org/tracker/CVE-2026-16742) | HIGH / A | systemd-homed 管理的本地登录用户借组成员修改提权。 | 镜像没有 systemd-homed 可执行程序，仅有 libsystemd0/libudev1；未配置 homed 服务。 | 可审阅为组件缺失例外；仅限本镜像摘要且禁止后续安装/启动 homed，条件变化立即失效。 |
| [CVE-2026-40467](https://security-tracker.debian.org/tracker/CVE-2026-40467) | HIGH / C | gawk getline 重定向路径的 use-after-free。 | gawk 可直接执行；任务会处理外部文本和生成脚本。 | 保留阻断；替换为其他 awk/Python 或补丁修复。 |
| [CVE-2026-40468](https://security-tracker.debian.org/tracker/CVE-2026-40468) | CRITICAL / C | gawk 整数溢出，可能耗尽内存或覆盖堆元数据。 | 64 位 gawk 存在；512 MiB 不能证明不存在内存破坏。 | 保留阻断；不因短生命周期接受直接可触发解析器问题。 |
| [CVE-2026-40469](https://security-tracker.debian.org/tracker/CVE-2026-40469) | CRITICAL / A | gawk do_sub 整数溢出，公告限定 32 位构建。 | file /usr/bin/gawk 确认为 ELF 64-bit x86-64；getconf LONG_BIT=64。 | 可审阅为架构不适用例外；只绑定已验证 amd64 ELF，禁止套用于其他架构/32 位安装。 |
| [CVE-2026-40553](https://security-tracker.debian.org/tracker/CVE-2026-40553) | HIGH / C | gawk readdir 扩展 ftype 缓冲区溢出。 | dpkg -L 确认存在 /usr/lib/x86_64-linux-gnu/gawk/readdir.so，相关扩展实际随镜像安装。 | 保留阻断；修复或移除对应功能并回归，不能仅靠 Skill 避免加载。 |
| [CVE-2026-54369](https://security-tracker.debian.org/tracker/CVE-2026-54369) | HIGH / C | 特权调用方用 libacl 路径 API 时，可替换路径组件为符号链接。 | libacl 被 coreutils/tar/sed 等依赖；安全 read_file 不覆盖 run_command 任意 shell。 | 保留阻断；需要修复或有效的路径/权限控制证据，禁止把文件工具防链接当作全局保护。 |
| [CVE-2026-58471](https://security-tracker.debian.org/tracker/CVE-2026-58471) | HIGH / C | wget 对服务端文件名做字符集转换时发生堆溢出。 | wget 是预装下载工具，服务端响应是不可信数据。 | 保留阻断；优先换用固定 HTTP 客户端或上游修复版本。 |
| [CVE-2026-58472](https://security-tracker.debian.org/tracker/CVE-2026-58472) | HIGH / C | wget 转换恶意 HTML 属性时整数溢出导致堆溢出。 | 相关内容处理用途可被模型调用；普通下载成功不排除路径。 | 保留阻断；禁用功能须有代码控制，仅 Skill 不足。 |
| [CVE-2026-6653](https://security-tracker.debian.org/tracker/CVE-2026-6653) | CRITICAL / C | libxml2 DTD/实体解析触发 use-after-free。 | dig 经 BIND 动态链接 libxml2；当前没有 Python 绑定，但原生路径未排除。 | 保留阻断；Debian 标记 affected，不能仅凭混合版本号自行判为已修复。 |
| [CVE-2026-74860](https://security-tracker.debian.org/tracker/CVE-2026-74860) | HIGH / A | libxml2 Python SAX 绑定解析特制 DTD 属性时 double-free。 | Python libxml2 与 lxml 均不可导入，未安装对应 Python 绑定。 | 可审阅为相关绑定缺失例外；安装绑定或改变镜像即失效，不覆盖其他原生 libxml2 漏洞。 |
| [CVE-2026-76642](https://security-tracker.debian.org/tracker/CVE-2026-76642) | HIGH / B | mount helper 失败后仍执行特权 post-mount hooks。 | mount 为 SUID；fstab 为空。尚未重新核实 NAS 子沙箱 capabilities 和 no-new-privileges。 | 须移除 SUID/不需要的 mount 路径，并验证无 SYS_ADMIN、无宿主挂载，之后再审例外。 |
| [CVE-2026-78408](https://security-tracker.debian.org/tracker/CVE-2026-78408) | HIGH / B | 特权 nsenter --join-cgroup 泄漏可迁移 cgroup 的文件描述符。 | nsenter 存在；宿主 cgroup 可写性和命名空间隔离未在本轮验证。 | 须证明无法进入宿主命名空间且无可写宿主 cgroup；仅无 Docker Socket 不够。 |
| [CVE-2026-78409](https://security-tracker.debian.org/tracker/CVE-2026-78409) | HIGH / B | Linux 6.15+ 下 fstab X-mount.subdir 中间符号链接逃逸。 | fstab 未配置，但本轮未核实 NAS 内核及运行时挂载能力；不以旧截图代替现状。 | 须核实内核与 mount 权限、无 fstab 授权条目，按实际摘要和部署条件审批。 |
| [CVE-2026-78410](https://security-tracker.debian.org/tracker/CVE-2026-78410) | HIGH / B | SUID mount 使用可竞争替换的 fstab bind 源，可能改变错误路径权限。 | mount 为 SUID；镜像 fstab 为空，运行时配置尚待核实。 | 须移除不需要的特权路径并验证实际容器控制；当前暂不批准。 |
| [CVE-2026-8458](https://security-tracker.debian.org/tracker/CVE-2026-8458) | HIGH / B | libcurl 复用 Negotiate 认证连接时跨 service 误复用。 | curl 具有 GSS-API/SPNEGO；普通无认证 HTTP 不满足该条件，但任意 shell 可启用认证。 | 须明确禁止提供此类凭据及调用路径，且有强制控制或修复；不能只靠提示词。 |
| [CVE-2026-86138](https://security-tracker.debian.org/tracker/CVE-2026-86138) | HIGH / C | libxml2 xmlDictAddQString 整数溢出与堆溢出。 | libxml2 实际存在且被 BIND 链接；未完成函数级可达性证明。 | 保留阻断；升级、去依赖或补充可达性证据。 |
| [CVE-2026-86139](https://security-tracker.debian.org/tracker/CVE-2026-86139) | HIGH / C | libxml2 xmlURIEscapeStr 整数溢出。 | 当前 trixie 被官方标记 open；bookworm 不受影响不代表本候选不受影响。 | 保留阻断；不能借其他发行版状态申请本镜像例外。 |
| [CVE-2026-86140](https://security-tracker.debian.org/tracker/CVE-2026-86140) | HIGH / C | libxml2 校验代码 xmlSnprintfElements 栈溢出。 | 库存在，相关函数是否被现有调用方使用未证明。 | 保留阻断；升级或证明相关功能不可达。 |
| [CVE-2026-86142](https://security-tracker.debian.org/tracker/CVE-2026-86142) | HIGH / C | libxml2 XPointer 长度饱和导致堆溢出。 | 未提供 XPointer 业务入口，但任意 shell 与原生库存在，不等于禁止访问。 | 保留阻断；需代码级禁用/去依赖或补丁。 |
| [CVE-2026-86143](https://security-tracker.debian.org/tracker/CVE-2026-86143) | HIGH / C | libxml2 写回调负长度，影响取决于回调实现。 | 未确认所有 BIND/原生回调调用路径。 | 保留阻断；风险无法仅凭无 Python 绑定排除。 |
| [CVE-2026-86144](https://security-tracker.debian.org/tracker/CVE-2026-86144) | HIGH / C | libxml2 XInclude 未传播解析选项，可能绕过 NONET 导致 SSRF/DoS。 | 库存在；沙箱允许授权联网，Skill 不是网络 ACL。 | 保留阻断；核实 XInclude/资源加载器或修复，不以代理代替 SSRF 防护。 |
| [CVE-2026-9538](https://security-tracker.debian.org/tracker/CVE-2026-9538) | HIGH / C | Perl Archive::Tar 按恶意 tar 头大小分配内存。 | 实际模块版本 3.02_001，小于公告修复版 3.10；Perl 由系统依赖带入。 | 保留阻断；优先升级/移除该模块。512 MiB 只能缓解进程内存耗尽，不能消除漏洞。 |

## 例外审批条件（尚未生效）

建议只先审核 A 类三项：CVE-2026-16742、CVE-2026-40469、CVE-2026-74860。即使批准，也仍有 26 项不满足放行条件，不能据此部署整包。

如未来批准任一例外，必须记录 CVE、受影响包、准确镜像 digest、架构、触发条件与不可达证据、批准人、批准日期和失效时间。建议最长 30 天（若本日批准则至 2026-11-22），到期重新审核而不是自动续期；镜像/架构/运行权限变化、安装相关组件、出现可用修复或新增攻击证据时提前失效。运行期允许任意 shell，模型可能安装库，因此缺失组件类例外还需要约束新增安装；Skill 的“不安装”只是指引，不是强制边界。

不使用全局 `ignore-unfixed`、整包忽略、下调严重性或无期限排除。当前未添加 VEX 或 Trivy 忽略规则，所有候选仍保持发布阻断。

## 下一步优先级

1. 先解决直接面对外部内容的 wget、gawk、libxml2 与 Archive::Tar；评估补丁或替换依赖，不把短生命周期当作修复。
2. DNS 工具通过 bind9-libs 带入 libxml2/liblmdb，优先评估替换 DNS CLI 能否减少依赖；不能直接删除共享库导致 dig 损坏。
3. 对 mount/nsenter 类先核验真实子沙箱权限，再考虑去除不需要的 SUID/命令。MCP 适配服务容器的 cap_drop 并不自动作用于 OpenSandbox 创建的子沙箱。
4. 复核后重新构建、扫描和测试，再提交新的审核清单。当前不修改工具集、镜像或部署配置。

## 证据来源

- [Debian Security Tracker JSON](https://security-tracker.debian.org/tracker/data/json)：各稳定版状态及修复情况；已在[机器清单](security-findings.json)保存逐项摘要。
- 本地检查：`curl -V` 支持 SCP/SFTP 与 GSS-API/SPNEGO；gawk 为 x86-64 ELF，readdir.so 扩展存在；没有 systemd-homed、xmllint、xmlcatalog、mdb_dump；Python 无 libxml2/lxml/lmdb；Archive::Tar 为 3.02_001；mount/umount 带 SUID，nsenter 存在；fstab 未配置；dig 动态依赖 libxml2/liblmdb。
- APT 当前候选仅 tzdata 有升级；trixie 的上述 CVE 均仍 open。部分在 sid/forky 已修复，但 gawk/LMDB/wget 等仍 open，不能将切换发行版当作已验证的解决方案。
- 未核实 NAS 当前内核/子沙箱权限，未做漏洞利用测试，未以代理或 TTL 证明隔离。NAS 历史已知 CPU CFS/PIDs 限额不足会限制资源控制，不能拿 512 MiB 当作完整的宿主保护。
