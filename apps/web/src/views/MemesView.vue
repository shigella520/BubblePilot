<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from "vue";
import {
  UploadCloud,
  ImagePlus,
  X,
  Check,
  LoaderCircle,
  Play,
  Square,
  Sparkles,
  RefreshCw,
  Trash2,
} from "@lucide/vue";
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
const fileInput = ref<HTMLInputElement | null>(null);
const previewUrl = ref("");
const dragging = ref(false);
function releasePreview() {
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value);
  previewUrl.value = "";
}
watch(file, (value) => {
  releasePreview();
  if (value) previewUrl.value = URL.createObjectURL(value);
});
watch(modal, (value) => {
  if (!value) {
    file.value = null;
    dragging.value = false;
  }
});
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
async function load(background = false) {
  const seq = ++sequence;
  if (!background) loading.value = true;
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
function chooseFiles(files: FileList | null | undefined) {
  if (busy.value || !files?.length) return;
  if (files.length !== 1) {
    error.value = "每次请选择一张图片。";
    return;
  }
  const candidate = files[0];
  if (
    !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(
      candidate.type,
    )
  ) {
    error.value = "请选择 JPEG、PNG、静态 WebP 或 GIF 图片。";
    return;
  }
  if (candidate.size > 10 * 1024 * 1024) {
    error.value = "图片超过 10 MiB，请选择更小的文件。";
    return;
  }
  error.value = "";
  file.value = candidate;
}
function pick(event: Event) {
  const input = event.target as HTMLInputElement;
  chooseFiles(input.files);
  input.value = "";
}
function drop(event: DragEvent) {
  dragging.value = false;
  chooseFiles(event.dataTransfer?.files);
}
onMounted(() => {
  void load();
  timer = setInterval(() => {
    if (!modal.value && !busy.value && !loading.value) void load(true);
  }, 5000);
});
onUnmounted(() => {
  sequence++;
  releasePreview();
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
      <button class="button primary" @click="open(null)">
        <ImagePlus :size="18" aria-hidden="true" />上传表情
      </button>
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
      ><button class="button secondary meme-query" :disabled="loading">
        <LoaderCircle
          v-if="loading"
          :size="16"
          class="meme-spinner"
          aria-hidden="true"
        />{{ loading ? "查询中" : "查询" }}
      </button>
    </form>
    <p v-if="error" role="alert">{{ error }}</p>

    <div class="meme-grid" :aria-busy="loading">
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
        :class="{ 'is-editing': editing }"
        role="dialog"
        aria-modal="true"
        aria-labelledby="meme-title"
      >
        <header class="meme-dialog-heading">
          <div>
            <h2 id="meme-title">{{ editing ? "编辑表情" : "上传表情" }}</h2>
            <p>
              {{
                editing
                  ? "完善素材信息，让 AI 更容易找到它。"
                  : "收藏一个表情，让聊天多一点趣味。"
              }}
            </p>
          </div>
          <button
            type="button"
            class="meme-close"
            aria-label="关闭表情弹窗"
            :disabled="busy"
            @click="modal = false"
          >
            <X :size="20" />
          </button>
        </header>
        <p v-if="error" role="alert">{{ error }}</p>
        <form class="meme-editor" @submit.prevent="save">
          <aside v-if="editing" class="meme-media-panel">
            <div class="meme-preview-stage">
              <img
                class="meme-preview"
                :src="`/api/v1/memes/${editing.id}/${play ? 'file' : 'thumbnail'}`"
                :alt="editing.name"
              />
            </div>
            <div class="meme-preview-toolbar">
              <span class="meme-format">{{
                editing.mimeType.split("/")[1].toUpperCase()
              }}</span>
              <button
                v-if="editing.mimeType === 'image/gif'"
                type="button"
                class="button secondary"
                :aria-pressed="play"
                @click="play = !play"
              >
                <Square v-if="play" :size="15" aria-hidden="true" />
                <Play v-else :size="15" aria-hidden="true" />
                {{ play ? "停止播放" : "播放 GIF" }}
              </button>
            </div>
            <p class="meme-media-note">发送时使用原图，GIF 保留动画。</p>
            <div class="meme-availability">
              <div>
                <strong>允许 AI 使用</strong>
                <p>
                  {{
                    active
                      ? "可被检索并用于聊天回复"
                      : "已停用，不会出现在检索结果中"
                  }}
                </p>
              </div>
              <button
                type="button"
                class="meme-switch"
                role="switch"
                aria-label="允许 AI 使用"
                :aria-checked="active"
                :disabled="busy"
                @click="active = !active"
              >
                <span />
              </button>
            </div>
          </aside>
          <div
            v-else
            class="meme-drop"
            :class="{ 'is-dragging': dragging, 'has-file': file }"
            @dragover.prevent="dragging = !busy"
            @dragleave.self="dragging = false"
            @drop.prevent="drop"
          >
            <input
              ref="fileInput"
              class="meme-file-input"
              type="file"
              tabindex="-1"
              aria-label="选择表情图片"
              accept="image/jpeg,image/png,image/webp,image/gif"
              :disabled="busy"
              @change="pick"
            />
            <template v-if="file">
              <img
                class="meme-upload-preview"
                :src="previewUrl"
                alt="待上传表情预览"
              />
              <div class="meme-file-info">
                <Check :size="16" aria-hidden="true" /><strong>{{
                  file.name
                }}</strong
                ><span>{{
                  file.size < 1024 * 1024
                    ? `${Math.max(1, Math.round(file.size / 1024))} KiB`
                    : `${(file.size / 1024 / 1024).toFixed(2)} MiB`
                }}</span>
              </div>
            </template>
            <template v-else>
              <div class="meme-upload-icon">
                <UploadCloud
                  :size="30"
                  :stroke-width="1.6"
                  aria-hidden="true"
                />
              </div>
              <strong>{{
                dragging ? "松开鼠标，添加这张表情" : "把表情拖到这里"
              }}</strong>
              <span class="meme-drop-subtitle"
                >也可以从设备中选择一张喜欢的图片</span
              >
            </template>
            <button
              type="button"
              class="button secondary meme-choose"
              :disabled="busy"
              @click="fileInput?.click()"
            >
              <ImagePlus :size="18" aria-hidden="true" />{{
                file ? "重新选择" : "选择图片"
              }}
            </button>
            <small>JPEG、PNG、静态 WebP、GIF · 最大 10 MiB</small>
            <div
              v-if="busy"
              class="meme-upload-progress"
              role="status"
              aria-live="polite"
            >
              <progress :value="progress" max="100" aria-label="图片上传进度" />
              <span>{{
                progress === 100
                  ? "上传完成，正在处理图片…"
                  : `正在上传 ${progress}%`
              }}</span>
            </div>
          </div>
          <div class="meme-editor-fields">
            <label
              ><span>名称 <span class="meme-field-hint">必填</span></span
              ><input
                v-model="name"
                required
                maxlength="120"
                placeholder="例如：小狗跳舞"
                :disabled="busy" /></label
            ><label
              >描述<textarea
                v-model="description"
                maxlength="2000"
                placeholder="描述表情的含义或适用场景，例如：开心到跳起来"
                :disabled="busy"
              /></label
            ><label
              >标签（逗号分隔）<input
                v-model="tags"
                placeholder="例如：开心，兴奋，卖萌"
                :disabled="busy"
            /></label>
            <section v-if="editing" class="meme-summary-panel">
              <div class="meme-summary-heading">
                <h3><Sparkles :size="17" aria-hidden="true" />AI 摘要</h3>
                <span class="meme-status">{{
                  labels[editing.summaryStatus]
                }}</span>
              </div>
              <p class="meme-summary-hint">
                帮助 AI
                理解画面和使用场景，可直接编辑。重新生成的候选需确认后才会替换。
              </p>
              <label
                ><span class="meme-field-hint">当前摘要</span
                ><textarea
                  v-model="summary"
                  maxlength="2400"
                  :disabled="busy"
                  rows="5"
                />
              </label>
              <p
                v-if="editing.summaryError"
                class="meme-summary-hint"
                role="status"
              >
                {{ summaryErrorMessage(editing.summaryError) }}
              </p>
              <div class="meme-summary-actions">
                <button
                  class="button secondary"
                  type="button"
                  :disabled="
                    busy ||
                    ['pending', 'processing'].includes(editing.summaryStatus)
                  "
                  @click="generate"
                >
                  <Sparkles :size="16" aria-hidden="true" />{{
                    editing.summary ? "重新生成候选" : "重试摘要"
                  }}
                </button>
                <button
                  class="button secondary"
                  type="button"
                  :disabled="busy"
                  @click="refreshEditing"
                >
                  <RefreshCw :size="16" aria-hidden="true" />刷新状态
                </button>
              </div>
              <div v-if="editing.candidateSummary" class="meme-candidate">
                <strong>新摘要候选</strong>
                <p>{{ editing.candidateSummary }}</p>
                <button
                  class="button secondary"
                  type="button"
                  :disabled="busy"
                  @click="adopt"
                >
                  采用候选摘要
                </button>
              </div>
            </section>
            <p v-if="!editing" class="meme-summary-hint">
              上传后自动生成 AI 摘要；名称、描述和标签帮助 AI 理解与检索表情。
            </p>
          </div>
          <footer class="meme-dialog-actions">
            <button
              v-if="editing"
              class="button secondary meme-delete"
              type="button"
              :disabled="busy"
              @click="remove"
            >
              <Trash2 :size="16" aria-hidden="true" />删除表情
            </button>
            <button
              class="button secondary"
              type="button"
              :disabled="busy"
              @click="modal = false"
            >
              取消</button
            ><button
              class="button primary"
              :disabled="busy || (!editing && !file)"
            >
              <LoaderCircle
                v-if="busy"
                :size="18"
                class="meme-spinner"
                aria-hidden="true"
              />
              <UploadCloud v-else-if="!editing" :size="18" aria-hidden="true" />
              {{ busy ? "处理中…" : editing ? "保存修改" : "上传表情" }}
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

<style scoped>
.meme-dialog-heading {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 22px;
}
.meme-dialog-heading h2 {
  margin: 0 0 8px;
}
.meme-dialog-heading p,
.meme-summary-hint {
  color: #6b7280;
  font-size: 13px;
  line-height: 1.6;
  margin: 0;
}
.meme-close {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 34px;
  height: 34px;
  border: 1px solid #e5e7eb;
  border-radius: 50%;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.meme-drop {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 26px 18px;
  background: #f8fafc;
  border: 1.5px dashed #cbd5e1;
  transition:
    background 0.15s,
    border-color 0.15s;
  text-align: center;
}
.meme-drop.is-dragging {
  border-color: #2563eb;
  background: #eff6ff;
}
.meme-upload-icon {
  display: grid;
  place-items: center;
  width: 60px;
  height: 60px;
  border-radius: 18px;
  color: #2563eb;
  background: #eaf1ff;
}
.meme-drop-subtitle,
.meme-drop small {
  color: #64748b;
  font-size: 12px;
}
.meme-file-input {
  display: none;
}
.meme-upload-preview {
  width: 100%;
  max-height: 160px;
  object-fit: contain;
  border-radius: 10px;
}
.meme-file-info {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  font-size: 12px;
  color: #64748b;
}
.meme-file-info strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #334155;
}
.meme-file-info span {
  white-space: nowrap;
}
.meme-file-info svg {
  color: #059669;
  flex-shrink: 0;
}
.meme-dialog .meme-choose {
  background: white;
  border: 1px solid #dbe2ea;
  min-height: 40px;
}
.meme-upload-progress {
  width: 100%;
  display: grid;
  gap: 8px;
  font-size: 12px;
  color: #475569;
}
.meme-upload-progress progress {
  width: 100%;
  accent-color: #2563eb;
}
.meme-field-hint {
  color: #9ca3af;
  font-size: 11px;
}
.meme-dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 20px;
  padding-top: 18px;
  border-top: 1px solid #e5e7eb;
  flex-wrap: wrap;
}
.meme-spinner {
  animation: meme-spin 1s linear infinite;
}
@keyframes meme-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .meme-spinner {
    animation: none;
  }
}
@media (max-width: 600px) {
  .meme-dialog {
    padding: 20px;
  }
  .meme-overlay {
    padding: 12px;
  }
  .meme-drop {
    padding: 20px 12px;
  }
}
</style>

<style scoped>
.meme-dialog.is-editing {
  width: 920px;
}
.is-editing .meme-editor {
  display: grid;
  grid-template-columns: 260px minmax(0, 1fr);
  gap: 0 28px;
}
.meme-editor-fields {
  min-width: 0;
}
.meme-media-panel {
  padding-top: 12px;
}
.meme-preview-stage {
  display: grid;
  place-items: center;
  aspect-ratio: 1;
  padding: 16px;
  border: 1px solid #e5e7eb;
  border-radius: 18px;
  background: #f6f7f9;
  overflow: hidden;
}
.meme-preview-stage .meme-preview {
  width: 100%;
  height: 100%;
  min-height: 0;
  border-radius: 10px;
}
.meme-preview-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 12px;
  gap: 12px;
}
.meme-preview-toolbar .button {
  padding: 8px 12px;
  font-size: 12px;
}
.meme-format,
.meme-status {
  padding: 5px 9px;
  border-radius: 7px;
  background: #f0f3f7;
  color: #536174;
  font-size: 11px;
  font-weight: 600;
}
.meme-media-note,
.meme-availability p {
  font-size: 12px;
  color: #6b7280;
  line-height: 1.6;
}
.meme-availability {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border-top: 1px solid #e5e7eb;
  margin-top: 20px;
  padding-top: 20px;
}
.meme-availability strong {
  font-size: 13px;
}
.meme-availability p {
  margin: 6px 0 0;
}
.meme-switch {
  width: 38px;
  height: 23px;
  padding: 3px;
  border: 0;
  border-radius: 20px;
  background: #cbd5e1;
  flex-shrink: 0;
  cursor: pointer;
}
.meme-switch span {
  display: block;
  width: 17px;
  height: 17px;
  background: white;
  border-radius: 50%;
  box-shadow: 0 1px 3px #0002;
  transition: transform 0.15s;
}
.meme-switch[aria-checked="true"] {
  background: #2563eb;
}
.meme-switch[aria-checked="true"] span {
  transform: translateX(15px);
}
.meme-summary-panel {
  margin-top: 22px;
  padding-top: 20px;
  border-top: 1px solid #e5e7eb;
}
.meme-summary-heading,
.meme-summary-heading h3,
.meme-summary-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.meme-summary-heading {
  justify-content: space-between;
  margin-bottom: 10px;
}
.meme-summary-heading h3 {
  font-size: 14px;
  margin: 0;
}
.meme-summary-heading h3 svg {
  color: #6374c4;
}
.meme-summary-actions {
  flex-wrap: wrap;
}
.meme-summary-actions .button {
  font-size: 12px;
  padding: 9px 13px;
}
.meme-dialog textarea {
  line-height: 1.65;
  resize: vertical;
}
.meme-candidate {
  background: #f5f7fb;
  border: 1px solid #e3e8f2;
  border-radius: 12px;
  padding: 14px;
  margin-top: 16px;
  font-size: 13px;
}
.meme-candidate p {
  white-space: pre-wrap;
  line-height: 1.7;
}
.is-editing .meme-dialog-actions {
  grid-column: 1 / -1;
}
.meme-dialog-actions .meme-delete {
  margin-right: auto;
  color: #b24444;
  background: transparent;
  box-shadow: none;
}
.meme-dialog button:focus-visible {
  outline: 2px solid #2563eb;
  outline-offset: 3px;
}
@media (max-width: 700px) {
  .is-editing .meme-editor {
    grid-template-columns: minmax(0, 1fr);
  }
  .meme-media-panel {
    padding: 0 0 12px;
  }
  .meme-preview-stage {
    aspect-ratio: auto;
    height: 190px;
  }
  .meme-availability {
    margin-top: 12px;
    padding-top: 12px;
  }
}
</style>

<style scoped>
.meme-query {
  min-width: 100px;
}
.meme-grid {
  min-height: 240px;
  align-content: start;
}
</style>
