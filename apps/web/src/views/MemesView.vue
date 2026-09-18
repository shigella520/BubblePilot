<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { apiRequest } from "../services/api";
import { apiUpload } from "../services/upload";
interface Meme {
  id: string;
  name: string;
  description: string;
  tags: string[];
  summary: string | null;
  candidateSummary: string | null;
  summaryStatus: string;
  summaryError: string | null;
  enabled: boolean;
  version: number;
  mimeType: string;
}
const items = ref<Meme[]>([]),
  total = ref(0),
  page = ref(0),
  query = ref(""),
  enabled = ref(""),
  status = ref(""),
  loading = ref(false),
  busy = ref(false),
  error = ref(""),
  modal = ref(false),
  editing = ref<Meme | null>(null),
  progress = ref(0),
  play = ref(false);
const name = ref(""),
  description = ref(""),
  tags = ref(""),
  summary = ref(""),
  active = ref(true),
  file = ref<File | null>(null);
const labels: Record<string, string> = {
  pending: "等待摘要",
  processing: "摘要生成中",
  succeeded: "摘要已生成",
  failed: "摘要失败",
};
function summaryErrorMessage(code: string | null) {
  if (code === "MEME_SUMMARY_ROUTE_UNAVAILABLE")
    return "没有启用且已验证图片能力的 AI 路由，请在 AI 服务中配置后重试。";
  return code ? `摘要暂未完成（${code}），可重试或手动编辑摘要。` : "";
}
let sequence = 0;
let timer: ReturnType<typeof setInterval> | undefined;
async function load() {
  const seq = ++sequence;
  loading.value = true;
  try {
    const params = new URLSearchParams({
      query: query.value,
      offset: String(page.value * 24),
      limit: "24",
    });
    if (enabled.value) params.set("enabled", enabled.value);
    if (status.value) params.set("status", status.value);
    const result = await apiRequest<{ items: Meme[]; total: number }>(
      `/api/v1/memes?${params}`,
    );
    if (seq === sequence) {
      items.value = result.items;
      total.value = result.total;
      error.value = "";
    }
  } catch (e) {
    if (seq === sequence)
      error.value = e instanceof Error ? e.message : "加载失败，请重试。";
  } finally {
    if (seq === sequence) loading.value = false;
  }
}
function open(item: Meme | null) {
  editing.value = item;
  name.value = item?.name ?? "";
  description.value = item?.description ?? "";
  tags.value = item?.tags.join("，") ?? "";
  summary.value = item?.summary ?? "";
  active.value = item?.enabled ?? true;
  file.value = null;
  play.value = false;
  progress.value = 0;
  modal.value = true;
  error.value = "";
}
async function perform(action: () => Promise<unknown>) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await action();
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : "操作失败，请重试。";
  } finally {
    busy.value = false;
  }
}
async function save() {
  await perform(async () => {
    const data = {
      name: name.value,
      description: description.value,
      tags: tags.value
        .split(/[,，]/u)
        .map((t) => t.trim())
        .filter(Boolean),
    };
    if (editing.value) {
      await apiRequest(`/api/v1/memes/${editing.value.id}`, {
        method: "PUT",
        body: JSON.stringify({
          ...data,
          enabled: active.value,
          ...(summary.value !== editing.value.summary
            ? { summary: summary.value }
            : {}),
          expectedVersion: editing.value.version,
        }),
      });
    } else {
      if (!file.value) throw new Error("请选择图片。");
      const form = new FormData();
      form.set("name", data.name);
      form.set("description", data.description);
      form.set("tags", JSON.stringify(data.tags));
      form.set("file", file.value);
      await apiUpload("/api/v1/memes", form, (p) => (progress.value = p));
    }
    modal.value = false;
  });
}
async function refreshEditing() {
  const item = editing.value;
  if (!item) return;
  if (
    (name.value !== item.name ||
      description.value !== item.description ||
      summary.value !== (item.summary ?? "")) &&
    !window.confirm("刷新会丢弃未保存的修改，继续？")
  )
    return;
  await perform(async () => {
    open(await apiRequest<Meme>(`/api/v1/memes/${item.id}`));
  });
}
async function generate() {
  const item = editing.value;
  if (!item) return;
  await perform(async () => {
    editing.value = await apiRequest<Meme>(`/api/v1/memes/${item.id}/summary`, {
      method: "POST",
      body: JSON.stringify({
        expectedVersion: item.version,
        candidate: !!item.summary,
      }),
    });
  });
}
async function adopt() {
  const item = editing.value;
  if (!item) return;
  await perform(async () => {
    const updated = await apiRequest<Meme>(
      `/api/v1/memes/${item.id}/summary/adopt`,
      {
        method: "POST",
        body: JSON.stringify({ expectedVersion: item.version }),
      },
    );
    open(updated);
  });
}
async function remove() {
  const item = editing.value;
  if (!item || !window.confirm(`删除“${item.name}”？已产生的投递记录会保留。`))
    return;
  await perform(async () => {
    await apiRequest(`/api/v1/memes/${item.id}`, {
      method: "DELETE",
      body: JSON.stringify({ expectedVersion: item.version }),
    });
    modal.value = false;
  });
}
function pick(event: Event) {
  file.value = (event.target as HTMLInputElement).files?.[0] ?? null;
}
function drop(event: DragEvent) {
  if (!busy.value) file.value = event.dataTransfer?.files[0] ?? null;
}
onMounted(() => {
  void load();
  timer = setInterval(() => {
    if (!modal.value && !busy.value) void load();
  }, 5000);
});
onUnmounted(() => {
  sequence++;
  clearInterval(timer);
});
</script>
<template>
  <main class="meme-page">
    <header class="meme-heading">
      <div>
        <h1>表情包</h1>
        <p>全局共享表情库。上传后自动生成摘要，在 AI 节点中按需启用。</p>
      </div>
      <button class="button primary" @click="open(null)">上传表情</button>
    </header>
    <form
      class="meme-filters"
      @submit.prevent="
        page = 0;
        load();
      "
    >
      <input
        v-model="query"
        placeholder="搜索名称或标签"
        aria-label="搜索名称或标签"
      /><select v-model="enabled" aria-label="启用状态">
        <option value="">全部启用状态</option>
        <option value="true">已启用</option>
        <option value="false">已停用</option></select
      ><select v-model="status" aria-label="摘要状态">
        <option value="">全部摘要状态</option>
        <option v-for="(label, key) in labels" :key="key" :value="key">
          {{ label }}
        </option></select
      ><button class="button secondary" :disabled="loading">查询</button>
    </form>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="loading">加载中…</p>
    <div class="meme-grid">
      <button
        v-for="item in items"
        :key="item.id"
        class="meme-card"
        @click="open(item)"
      >
        <img
          :src="`/api/v1/memes/${item.id}/thumbnail`"
          :alt="item.name"
          loading="lazy"
        /><strong>{{ item.name }}</strong
        ><span>{{ item.tags.join(" · ") || "无标签" }}</span
        ><small
          >{{ item.enabled ? "已启用" : "已停用" }} ·
          {{ labels[item.summaryStatus] }}</small
        >
      </button>
    </div>
    <p v-if="!loading && !items.length">暂无匹配表情。</p>
    <footer class="meme-filters">
      <button
        :disabled="page === 0 || loading"
        @click="
          page--;
          load();
        "
      >
        上一页</button
      ><span>共 {{ total }} 张 · 第 {{ page + 1 }} 页</span
      ><button
        :disabled="(page + 1) * 24 >= total || loading"
        @click="
          page++;
          load();
        "
      >
        下一页
      </button>
    </footer>
    <div
      v-if="modal"
      class="meme-overlay"
      @click.self="!busy && (modal = false)"
    >
      <section
        class="meme-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="meme-title"
      >
        <h2 id="meme-title">{{ editing ? "编辑表情" : "上传表情" }}</h2>
        <p v-if="error" role="alert">{{ error }}</p>
        <form @submit.prevent="save">
          <template v-if="editing"
            ><img
              class="meme-preview"
              :src="`/api/v1/memes/${editing.id}/${play ? 'file' : 'thumbnail'}`"
              :alt="editing.name"
            /><button
              v-if="editing.mimeType === 'image/gif'"
              type="button"
              @click="play = !play"
            >
              {{ play ? "停止播放" : "播放 GIF" }}
            </button></template
          >
          <div v-else class="meme-drop" @dragover.prevent @drop.prevent="drop">
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              :disabled="busy"
              @change="pick"
            />
            <p>
              {{
                file?.name ||
                "选择或拖入一张图片，最大 10 MiB；不支持动态 WebP。"
              }}
            </p>
            <progress v-if="busy" :value="progress" max="100" /><span
              v-if="busy"
              >{{ progress }}%
              {{ progress === 100 ? "正在处理图片…" : "" }}</span
            >
          </div>
          <label
            >名称<input
              v-model="name"
              required
              maxlength="120"
              :disabled="busy" /></label
          ><label
            >描述<textarea
              v-model="description"
              maxlength="2000"
              :disabled="busy"
            /></label
          ><label
            >标签（逗号分隔）<input v-model="tags" :disabled="busy"
          /></label>
          <template v-if="editing"
            ><label
              >摘要<textarea
                v-model="summary"
                maxlength="2400"
                :disabled="busy"
              /></label
            ><label
              ><input
                v-model="active"
                type="checkbox"
                :disabled="busy"
              />启用</label
            >
            <p>
              {{ labels[editing.summaryStatus] }}
              {{ summaryErrorMessage(editing.summaryError) }}
            </p>
            <button
              type="button"
              :disabled="
                busy ||
                ['pending', 'processing'].includes(editing.summaryStatus)
              "
              @click="generate"
            >
              {{ editing.summary ? "重新生成候选" : "重试摘要" }}
            </button>
            <button
              class="button secondary"
              type="button"
              :disabled="busy"
              @click="refreshEditing"
            >
              刷新摘要状态
            </button>
            <div v-if="editing.candidateSummary">
              <p>新摘要候选：{{ editing.candidateSummary }}</p>
              <button
                class="button secondary"
                type="button"
                :disabled="busy"
                @click="adopt"
              >
                采用候选摘要
              </button>
            </div></template
          >
          <footer class="meme-filters">
            <button
              class="button secondary"
              type="button"
              :disabled="busy"
              @click="modal = false"
            >
              取消</button
            ><button class="button primary" :disabled="busy">
              {{ busy ? "处理中…" : "保存" }}</button
            ><button
              v-if="editing"
              type="button"
              :disabled="busy"
              @click="remove"
            >
              删除
            </button>
          </footer>
        </form>
      </section>
    </div>
  </main>
</template>
<style scoped>
.meme-filters > input {
  flex: 1;
  min-width: 180px;
  width: auto;
}
.meme-filters > select {
  width: auto;
}
.meme-page {
  max-width: 1200px;
  margin: auto;
  padding: 24px;
}
.meme-heading,
.meme-filters {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 20px;
}
.meme-heading {
  justify-content: space-between;
}
.meme-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 16px;
}
.meme-card {
  display: flex;
  flex-direction: column;
  align-items: start;
  gap: 8px;
  padding: 14px;
  border: 1px solid var(--border, #ddd);
  border-radius: 16px;
  background: var(--surface, #fff);
  color: inherit;
  text-align: left;
}
.meme-card img {
  width: 100%;
  height: 150px;
  object-fit: contain;
}
.meme-card span {
  overflow-wrap: anywhere;
}
.meme-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: #0007;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}
.meme-dialog {
  background: var(--surface, #fff);
  color: var(--text, #222);
  border-radius: 18px;
  padding: 24px;
  width: 600px;
  max-width: 100%;
  max-height: 90vh;
  overflow: auto;
}
.meme-dialog label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 12px 0;
}
.meme-dialog input:not([type="checkbox"]),
.meme-dialog textarea {
  width: 100%;
  box-sizing: border-box;
}
.meme-preview {
  max-width: 100%;
  height: 200px;
  object-fit: contain;
}
.meme-drop {
  padding: 20px;
  border: 1px dashed #999;
  border-radius: 12px;
}
.meme-filters {
  margin-top: 20px;
}
</style>
