<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import { Boxes, Plus, RefreshCw, UploadCloud } from "@lucide/vue";
import DismissibleMessage from "../components/DismissibleMessage.vue";
import { pluginErrorMessage, canInspectPlugin } from "../utils/plugin-feedback";
import { apiRequest } from "../services/api";
import { apiUpload } from "../services/upload";
interface Connection {
  url: string;
  allowPrivate: boolean;
  auth: string;
  header: string;
  secret?: string;
  secretConfigured?: boolean;
}
interface Skill {
  contentHash: string;
  body?: string;
  id: string;
  name: string;
  description: string;
  file: string;
  references: string[];
}
interface Tool {
  server: string;
  hash: string;
  definition: { name: string; description: string };
}
interface Package {
  name: string;
  version: string;
  description: string;
  hash: string;
  skills: Skill[];
  servers: Array<{
    name: string;
    url: string;
    headers: Record<string, string>;
  }>;
}
interface Detail {
  id: string;
  name: string;
  version: number;
  enabled: boolean;
  revision: string;
  package: Package;
  config: {
    connections: Record<string, Connection>;
    tools: Tool[];
    disabledSkills: string[];
    disabledTools: string[];
  };
  references: Array<{ workflow_id: string; version: number }>;
  versions: Array<{ hash: string; package_version: string }>;
}
interface ImportTask {
  id: string;
  state: string;
  directories: string[];
  error_code?: string;
  source?: { url?: string; ref?: string; directory?: string; sha?: string };
}
const items = ref<
    Array<{
      id: string;
      name: string;
      enabled: boolean;
      version: number;
      package_version: string;
      metadata: { skills: number; servers: number };
      source: { type?: string; url?: string };
      pending_review?: string[];
    }>
  >([]),
  busy = ref(false),
  error = ref(""),
  showImport = ref(false),
  url = ref(""),
  gitRef = ref(""),
  gitDirectory = ref(""),
  task = ref<ImportTask | null>(null),
  directory = ref(""),
  preview = ref<Package | null>(null),
  selected = ref<Detail | null>(null),
  connections = ref<Record<string, Connection>>({}),
  tools = ref<Tool[]>([]),
  approved = ref<string[]>([]),
  progress = ref(0),
  content = ref(""),
  disabledSkills = ref<string[]>([]),
  disabledTools = ref<string[]>([]),
  tested = ref(false);
const previous = ref<Detail | null>(null);
const changes = computed(() => {
  if (!preview.value || !previous.value) return [];
  const old = previous.value.package,
    next = preview.value;
  return [
    ...next.skills
      .filter((s) => !old.skills.some((o) => o.id === s.id))
      .map((s) => `新增 Skill：${s.name}`),
    ...old.skills
      .filter((s) => !next.skills.some((o) => o.id === s.id))
      .map((s) => `移除 Skill：${s.name}`),
    ...next.skills
      .filter((s) =>
        old.skills.some(
          (o) => o.id === s.id && o.contentHash !== s.contentHash,
        ),
      )
      .map((s) => `修改 Skill：${s.name}`),
    ...next.servers
      .filter(
        (s) => !old.servers.some((o) => o.name === s.name && o.url === s.url),
      )
      .map((s) => `新增／修改 MCP：${s.name} → ${s.url}`),
    ...old.servers
      .filter((s) => !next.servers.some((o) => o.name === s.name))
      .map((s) => `移除 MCP：${s.name}`),
    ...tools.value
      .filter(
        (t) =>
          !previous.value!.config.tools.some(
            (o) => o.server === t.server && o.hash === t.hash,
          ),
      )
      .map((t) => `新增／修改工具：${t.server}/${t.definition.name}`),
  ];
});
let disposed = false;
onBeforeUnmount(() => {
  disposed = true;
});
async function load() {
  items.value = await apiRequest("/api/v1/plugins");
}
async function action(fn: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await fn();
  } catch (e) {
    error.value = pluginErrorMessage(e);
  } finally {
    busy.value = false;
  }
}
onMounted(() => void action(load));
function reset() {
  error.value = "";
  progress.value = 0;
  directory.value = "";
  showImport.value = true;
  task.value = null;
  preview.value = null;
  selected.value = null;
  connections.value = {};
  tools.value = [];
  approved.value = [];
  content.value = "";
  tested.value = false;
  previous.value = null;
}
async function stage(file?: File) {
  await action(async () => {
    task.value = null;
    preview.value = null;
    directory.value = "";
    previous.value = null;
    connections.value = {};
    tools.value = [];
    approved.value = [];
    tested.value = false;
    progress.value = 0;
    task.value = file
      ? await apiUpload<ImportTask>(
          "/api/v1/plugins/imports",
          (() => {
            const f = new FormData();
            f.append("file", file);
            return f;
          })(),
          (p) => (progress.value = p),
        )
      : await apiRequest("/api/v1/plugins/imports", {
          method: "POST",
          body: JSON.stringify({
            url: url.value.trim(),
            ...(gitRef.value.trim() ? { ref: gitRef.value.trim() } : {}),
            ...(gitDirectory.value.trim()
              ? { directory: gitDirectory.value.trim() }
              : {}),
          }),
        });
    while (task.value!.state === "loading" && !disposed) {
      await new Promise((resolve) => setTimeout(resolve, 750));
      task.value = await apiRequest<ImportTask>(
        `/api/v1/plugins/imports/${task.value!.id}`,
      );
    }
    if (disposed) return;
    if (task.value!.state === "failed")
      throw new Error(task.value!.error_code ?? "导入失败");
    directory.value = task.value!.directories[0] ?? "";
  });
}
function upload(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (file) void stage(file);
}
function setup(pkg: Package) {
  connections.value = Object.fromEntries(
    pkg.servers.map((s) => [
      s.name,
      {
        url: s.url,
        allowPrivate: false,
        auth: Object.keys(s.headers).length
          ? Object.keys(s.headers)[0]?.toLowerCase() === "authorization"
            ? "bearer"
            : "header"
          : "none",
        header: Object.keys(s.headers)[0] ?? "X-Api-Key",
      },
    ]),
  );
  tested.value = !pkg.servers.length;
}
async function inspect() {
  if (!canInspectPlugin(task.value, directory.value)) return;
  await action(async () => {
    preview.value = await apiRequest(
      `/api/v1/plugins/imports/${task.value!.id}/inspect`,
      { method: "POST", body: JSON.stringify({ directory: directory.value }) },
    );
    const old = items.value.find((p) => p.name === preview.value!.name);
    previous.value = old
      ? await apiRequest<Detail>(`/api/v1/plugins/${old.id}`)
      : null;
    setup(preview.value!);
  });
}
async function open(id: string) {
  await action(async () => {
    selected.value = await apiRequest(`/api/v1/plugins/${id}`);
    preview.value = null;
    showImport.value = false;
    connections.value = JSON.parse(
      JSON.stringify(selected.value!.config.connections),
    ) as Record<string, Connection>;
    tools.value = selected.value!.config.tools;
    approved.value = tools.value.map(
      (t) => `${t.server}/${t.definition.name}#${t.hash}`,
    );
    disabledSkills.value = [...selected.value!.config.disabledSkills];
    disabledTools.value = [...selected.value!.config.disabledTools];
    tested.value = true;
    content.value = "";
  });
}
function connectionPayload() {
  return Object.fromEntries(
    Object.entries(connections.value).map(([name, c]) => [
      name,
      {
        url: c.url,
        allowPrivate: c.allowPrivate,
        auth: c.auth,
        header: c.header,
        ...(c.secret ? { secret: c.secret } : {}),
      },
    ]),
  );
}
async function test() {
  await action(async () => {
    tools.value = await apiRequest("/api/v1/plugins/connections/test", {
      method: "POST",
      body: JSON.stringify({
        connections: connectionPayload(),
        pluginId: selected.value?.id,
      }),
    });
    approved.value = [];
    tested.value = true;
  });
}
async function install() {
  await action(async () => {
    const existing = items.value.find((p) => p.name === preview.value!.name);
    if (
      existing &&
      !confirm(
        "将安装新版本并切换后续执行。请确认已检查 Skill、工具和服务地址变化。",
      )
    )
      return;
    const data = await apiRequest<Detail>(
      `/api/v1/plugins/imports/${task.value!.id}/install`,
      {
        method: "POST",
        body: JSON.stringify({
          directory: directory.value,
          connections: connectionPayload(),
          approved: approved.value,
          expectedVersion: existing?.version,
        }),
      },
    );
    showImport.value = false;
    preview.value = null;
    selected.value = data;
    await load();
  });
}
async function update(body: Record<string, unknown>) {
  await action(async () => {
    selected.value = await apiRequest(`/api/v1/plugins/${selected.value!.id}`, {
      method: "PUT",
      body: JSON.stringify({
        expectedVersion: selected.value!.version,
        ...body,
      }),
    });
    await load();
  });
}
async function save() {
  await action(async () => {
    selected.value = await apiRequest(
      `/api/v1/plugins/${selected.value!.id}/config`,
      {
        method: "PUT",
        body: JSON.stringify({
          expectedVersion: selected.value!.version,
          connections: connectionPayload(),
          approved: approved.value,
          disabledSkills: disabledSkills.value,
          disabledTools: disabledTools.value,
        }),
      },
    );
    connections.value = JSON.parse(
      JSON.stringify(selected.value!.config.connections),
    ) as Record<string, Connection>;
    await load();
  });
}
async function view(file: string) {
  await action(async () => {
    const r = await apiRequest<{ text: string }>(
      `/api/v1/plugins/${selected.value!.id}/content?file=${encodeURIComponent(file)}`,
    );
    if (!disposed) content.value = r.text;
  });
}
async function remove() {
  if (!confirm("卸载插件？有工作流引用时将阻止卸载，历史文件仍保留。")) return;
  await action(async () => {
    await apiRequest(`/api/v1/plugins/${selected.value!.id}`, {
      method: "DELETE",
      body: JSON.stringify({ expectedVersion: selected.value!.version }),
    });
    selected.value = null;
    await load();
  });
}
</script>
<template>
  <main class="plugins-page">
    <header class="plugin-heading">
      <div>
        <h1><Boxes :size="28" /> 插件</h1>
        <p>
          按需扩展外部能力，支持声明式 Skill 与 HTTP
          MCP；执行类工具须由管理员明确授权。
        </p>
      </div>
      <div class="plugin-actions">
        <button :disabled="busy" @click="action(load)">
          <RefreshCw :size="16" />刷新</button
        ><button :disabled="busy" @click="reset">
          <Plus :size="16" />安装插件
        </button>
      </div>
    </header>
    <DismissibleMessage v-if="error" error @close="error = ''">{{
      error
    }}</DismissibleMessage>
    <div class="plugin-status" role="status">
      <span v-if="busy">正在处理，请稍候…</span>
    </div>
    <div class="plugin-grid">
      <button
        v-for="item in items"
        :key="item.id"
        class="plugin-card"
        :disabled="busy"
        @click="open(item.id)"
      >
        <Boxes /><strong>{{ item.name }}</strong
        ><span
          >{{ item.package_version }} ·
          {{ item.enabled ? "已启用" : "未启用" }}</span
        >
        <span v-if="item.pending_review?.length"
          >工具定义变化，待复核：{{ item.pending_review.join("、") }}</span
        >
      </button>
    </div>
    <p v-if="!items.length && !busy">
      还没有安装插件。导入后检查能力、配置服务，再授权给 AI 节点。
    </p>
    <section v-if="showImport" class="plugin-panel">
      <h2>安装向导</h2>
      <p>支持公开 HTTPS Git 仓库或 ZIP。不会运行包内代码。</p>
      <fieldset :disabled="busy">
        <label
          >Git 仓库或插件目录链接<input
            v-model="url"
            placeholder="https://github.com/example/repo/tree/main/plugins/demo"
        /></label>
        <p>
          支持 GitHub tree／blob
          目录链接，自动识别分支与目录；普通仓库链接仍可选择插件。
        </p>
        <details>
          <summary>高级选项（可选）</summary>
          <label
            >分支／标签／提交<input
              v-model="gitRef"
              placeholder="自动识别，普通仓库默认为 HEAD"
          /></label>
          <label
            >插件目录<input
              v-model="gitDirectory"
              placeholder="普通仓库链接可填，例如 plugins/firecrawl"
          /></label>
        </details>
        <button :disabled="!url.trim()" @click="stage()">读取插件</button
        ><label class="plugin-upload">
          <UploadCloud :size="28" /><strong>选择 ZIP 插件包</strong>
          <span>仅打包插件目录 · 最大 10 MiB</span>
          <input
            class="plugin-file-input"
            type="file"
            accept=".zip"
            aria-label="选择 ZIP 插件包"
            @change="upload"
          /> </label
        ><progress v-if="progress > 0" :value="progress" max="100" />
        <template v-if="task?.state === 'staged' && task.directories.length"
          ><p v-if="task.source?.sha">
            已读取：{{ task.source.url }} · {{ task.source.directory
            }}<br />提交：{{ task.source.sha }}
          </p>
          <label
            >插件目录<select v-model="directory">
              <option v-for="d in task.directories" :key="d">{{ d }}</option>
            </select></label
          ><button
            :disabled="!canInspectPlugin(task, directory)"
            @click="inspect"
          >
            检查兼容性
          </button></template
        >
      </fieldset>
    </section>
    <section v-if="preview || selected" class="plugin-panel">
      <h2>
        {{ (preview ?? selected?.package)?.name }}
        <small>{{ (preview ?? selected?.package)?.version }}</small>
      </h2>
      <p>{{ (preview ?? selected?.package)?.description }}</p>
      <fieldset :disabled="busy">
        <template v-for="(c, name) in connections" :key="name"
          ><h3>MCP · {{ name }}</h3>
          <label
            >服务地址<input v-model="c.url" @input="tested = false" /></label
          ><label
            ><input
              v-model="c.allowPrivate"
              type="checkbox"
              @change="tested = false"
            />明确允许访问此目标的内网地址</label
          ><label
            >认证方式<select v-model="c.auth" @change="tested = false">
              <option value="none">无需认证</option>
              <option value="bearer">Bearer Token</option>
              <option value="header">API Key 请求头</option>
            </select></label
          ><label v-if="c.auth === 'header'"
            >请求头<input v-model="c.header" @input="tested = false" /></label
          ><label v-if="c.auth !== 'none'"
            >凭据<input
              v-model="c.secret"
              type="password"
              autocomplete="new-password"
              :placeholder="
                c.secretConfigured ? '已配置，留空保留' : '填写服务凭据'
              "
              @input="tested = false" /></label
        ></template>
        <button v-if="Object.keys(connections).length" @click="test">
          测试连接并发现工具
        </button>
        <h3 v-if="tools.length">批准工具（请确认用途及副作用）</h3>
        <p v-if="tools.length">
          请确认用途；服务端只读注解不构成权限保证。本轮不支持写入操作。 MCP
          参数通过 JSON 封装传给模型，调用前按服务端原始契约校验。
        </p>
        <label
          v-for="tool in tools"
          :key="tool.server + '/' + tool.definition.name"
          class="tool-choice"
          ><input
            v-model="approved"
            type="checkbox"
            :value="tool.server + '/' + tool.definition.name + '#' + tool.hash"
          /><span
            ><strong>{{ tool.server }} / {{ tool.definition.name }}</strong
            ><small>{{ tool.definition.description }}</small></span
          ></label
        >
        <section v-if="previous && preview">
          <h3>
            升级变更 {{ previous.package.version }} → {{ preview.version }}
          </h3>
          <ul>
            <li v-for="change in changes" :key="change">{{ change }}</li>
          </ul>
          <p v-if="!changes.length">
            未发现 Skill 或 MCP 地址变化，请测试连接后复核工具定义。
          </p>
        </section>
        <section v-if="selected?.references.length">
          <h3>工作流引用</h3>
          <p
            v-for="reference in selected.references"
            :key="reference.workflow_id + ':' + reference.version"
          >
            {{ reference.workflow_id }} · 版本 {{ reference.version }}
          </p>
        </section>
        <h3>Skills</h3>
        <article
          v-for="skill in (preview ?? selected?.package)?.skills"
          :key="skill.id"
        >
          <strong>{{ skill.name }}</strong>
          <p>{{ skill.description }}</p>
          <details v-if="skill.body">
            <summary>查看安装前指令</summary>
            <pre class="plugin-content">{{ skill.body }}</pre>
          </details>
          <template v-if="selected"
            ><label
              ><input
                v-model="disabledSkills"
                type="checkbox"
                :value="skill.id"
              />停用</label
            ><button @click="view(skill.file)">查看指令</button
            ><button
              v-for="file in skill.references"
              :key="file"
              @click="view(file)"
            >
              {{ file }}
            </button></template
          >
        </article>
        <div class="plugin-actions">
          <button v-if="preview" :disabled="!tested" @click="install">
            确认安装</button
          ><template v-if="selected"
            ><button :disabled="!tested" @click="save">保存配置与授权</button
            ><button @click="update({ enabled: !selected.enabled })">
              {{ selected.enabled ? "停用插件" : "启用插件" }}</button
            ><button @click="remove">卸载</button></template
          >
        </div>
        <details v-if="selected">
          <summary>历史版本与回退</summary>
          <p v-for="v in selected.versions" :key="v.hash">
            {{ v.package_version }}
            <button
              :disabled="v.hash === selected.revision"
              @click="update({ revision: v.hash })"
            >
              回退到此版本
            </button>
          </p>
        </details>
      </fieldset>
      <pre v-if="content" class="plugin-content">{{ content }}</pre>
    </section>
  </main>
</template>
<style scoped>
.plugins-page {
  max-width: 1160px;
  margin: auto;
  padding: 24px;
}
.plugin-heading,
.plugin-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.plugin-heading h1 {
  display: flex;
  gap: 10px;
  align-items: center;
}
.plugin-heading p,
.plugin-panel p {
  color: var(--text-muted, #64748b);
}
.plugin-status {
  min-height: 44px;
  padding: 10px 0;
}
.plugin-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: 16px;
}
.plugin-card,
.plugin-panel {
  border: 1px solid var(--border-color, #dce2ea);
  border-radius: 16px;
  background: var(--surface, #fff);
  padding: 22px;
}
.plugin-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 12px;
  text-align: left;
}
.plugin-panel {
  margin-top: 20px;
}
.plugin-panel fieldset {
  border: 0;
  padding: 0;
  display: grid;
  gap: 14px;
  min-width: 0;
}
.plugin-panel label {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.plugin-panel input:not([type="checkbox"]),
.plugin-panel select {
  padding: 10px;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  min-width: 0;
  max-width: 100%;
  flex: 1;
}
.plugin-panel button,
.plugin-heading button {
  padding: 9px 14px;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  cursor: pointer;
}
.plugin-upload {
  padding: 24px;
  border: 2px dashed #b9c8dd;
  border-radius: 12px;
  background: rgba(10, 132, 255, 0.04);
  position: relative;
  flex-direction: column;
  justify-content: center;
  cursor: pointer;
  color: var(--bubblepilot-muted);
}
.plugin-upload strong {
  color: var(--bubblepilot-ink);
}
.plugin-upload span {
  font-size: 12px;
}
.plugin-upload:focus-within {
  outline: 2px solid #0a84ff;
  outline-offset: 3px;
}
.plugin-panel .plugin-file-input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  cursor: pointer;
  padding: 0;
}
.plugin-panel input:disabled {
  cursor: default;
}
.plugin-content {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 480px;
  overflow: auto;
  padding: 16px;
  background: #f1f5f9;
  border-radius: 10px;
}
.tool-choice span {
  display: grid;
  gap: 4px;
}
.tool-choice small {
  color: #64748b;
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
@media (max-width: 640px) {
  .plugins-page {
    padding: 14px;
  }
  .plugin-heading {
    align-items: flex-start;
    flex-direction: column;
  }
  .plugin-actions {
    flex-wrap: wrap;
  }
  .plugin-panel {
    padding: 16px;
  }
}
</style>
