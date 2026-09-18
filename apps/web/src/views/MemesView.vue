<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
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
  Folder,
  FolderPlus,
  Settings2,
} from "@lucide/vue";
import { useRoute, useRouter, onBeforeRouteLeave } from "vue-router";
import {
  submitMemeBatch,
  reconcileMemeBatch,
  type SelectionItem,
  type BatchAction,
  type BatchResult,
} from "../services/meme-batch";
import { apiRequest } from "../services/api";
import { apiUpload } from "../services/upload";
interface Collection {
  id: string;
  name: string;
  description: string;
  coverMemeId: string | null;
  effectiveCoverMemeId: string | null;
  count: number;
  version: number;
}
interface Meme {
  collectionId: string | null;
  collectionName: string | null;
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
const route = useRoute(),
  router = useRouter();
const collections = ref<Collection[]>([]),
  collection = ref("all"),
  collectionTotal = ref(0),
  unclassified = ref(0),
  collectionError = ref("");
const assetCollection = ref(""),
  collectionModal = ref(false),
  collectionEditing = ref<Collection | null>(null),
  collectionName = ref(""),
  collectionDescription = ref(""),
  collectionCover = ref("");
const selected = ref<Map<string, number>>(new Map()),
  selecting = ref(false),
  bulkBusy = ref(false),
  stopBatch = ref(false),
  bulkResults = ref<BatchResult[]>([]),
  bulkTotal = ref(0),
  bulkTarget = ref(""),
  lastAction = ref<BatchAction | null>(null);
const loadedFilters = ref("");
const filtersPending = computed(
  () => loadedFilters.value !== JSON.stringify(filters()),
);
const currentCollection = computed(() =>
  collections.value.find((c) => c.id === collection.value),
);
const collectionTitle = computed(() =>
  collection.value === "all"
    ? "全部表情"
    : collection.value === "unclassified"
      ? "未分类"
      : (currentCollection.value?.name ?? "合集"),
);
const bulkFailures = computed(() =>
  bulkResults.value.filter((r) => r.status !== "succeeded"),
);
const bulkSucceeded = computed(
  () => bulkResults.value.filter((r) => r.status === "succeeded").length,
);
let restoring = false;
function restoreFilters() {
  restoring = true;
  collection.value =
    typeof route.query.collection === "string" ? route.query.collection : "all";
  query.value = String(route.query.query ?? "");
  enabled.value = ["true", "false"].includes(String(route.query.enabled))
    ? String(route.query.enabled)
    : "";
  status.value = ["pending", "processing", "succeeded", "failed"].includes(
    String(route.query.status),
  )
    ? String(route.query.status)
    : "";
  page.value = Math.max(0, Math.floor(Number(route.query.page) || 1) - 1);
  selected.value.clear();
  restoring = false;
}
restoreFilters();
function filters() {
  return {
    query: query.value,
    collection: collection.value,
    ...(enabled.value ? { enabled: enabled.value === "true" } : {}),
    ...(status.value ? { status: status.value } : {}),
  };
}
function syncUrl() {
  void router.replace({
    path: "/memes",
    query: {
      collection: collection.value,
      ...(query.value ? { query: query.value } : {}),
      ...(enabled.value ? { enabled: enabled.value } : {}),
      ...(status.value ? { status: status.value } : {}),
      ...(page.value ? { page: String(page.value + 1) } : {}),
    },
  });
}
watch(
  [collection, query, enabled, status],
  () => {
    if (!restoring) {
      page.value = 0;
      selected.value.clear();
    }
  },
  { flush: "sync" },
);
watch(
  () => route.query,
  () => {
    const next = {
      collection: String(route.query.collection ?? "all"),
      query: String(route.query.query ?? ""),
      enabled: String(route.query.enabled ?? ""),
      status: String(route.query.status ?? ""),
      page: Math.max(0, Number(route.query.page ?? 1) - 1),
    };
    if (
      next.collection !== collection.value ||
      next.query !== query.value ||
      next.enabled !== enabled.value ||
      next.status !== status.value ||
      next.page !== page.value
    ) {
      restoreFilters();
      void load();
    }
  },
);
let collectionSequence = 0;
async function loadCollections() {
  const seq = ++collectionSequence;
  try {
    const result = await apiRequest<{
      items: Collection[];
      total: number;
      unclassified: number;
    }>("/api/v1/meme-collections");
    if (seq !== collectionSequence) return;
    collections.value = result.items;
    collectionTotal.value = result.total;
    unclassified.value = result.unclassified;
    collectionError.value = "";
  } catch (e) {
    if (seq === collectionSequence)
      collectionError.value = e instanceof Error ? e.message : "合集加载失败";
  }
}
function chooseCollection(id: string) {
  if (bulkBusy.value) return;
  collection.value = id;
  void load();
}
function editCollection(item: Collection | null) {
  collectionEditing.value = item;
  collectionName.value = item?.name ?? "";
  collectionDescription.value = item?.description ?? "";
  collectionCover.value = item?.coverMemeId ?? "";
  collectionModal.value = true;
  error.value = "";
}
async function saveCollection() {
  await perform(async () => {
    const item = collectionEditing.value;
    await apiRequest("/api/v1/meme-collections" + (item ? "/" + item.id : ""), {
      method: item ? "PUT" : "POST",
      body: JSON.stringify({
        name: collectionName.value,
        description: collectionDescription.value,
        coverMemeId: collectionCover.value || null,
        ...(item ? { expectedVersion: item.version } : {}),
      }),
    });
    collectionModal.value = false;
  });
}
async function deleteCollection() {
  const item = collectionEditing.value;
  if (!item) return;
  await loadCollections();
  if (collectionError.value) {
    error.value = collectionError.value;
    return;
  }
  const fresh = collections.value.find((c) => c.id === item.id);
  if (!fresh) {
    error.value = "合集已不存在，请刷新。";
    return;
  }
  if (
    !window.confirm(
      `删除合集“${fresh.name}”？其中 ${fresh.count} 张表情将移入未分类，图片和启用状态不变。`,
    )
  )
    return;
  await perform(async () => {
    await apiRequest("/api/v1/meme-collections/" + item.id, {
      method: "DELETE",
      body: JSON.stringify({ expectedVersion: item.version }),
    });
    collectionModal.value = false;
    if (collection.value === item.id) collection.value = "unclassified";
  });
}
async function setCover() {
  const item = editing.value,
    c = collections.value.find((c) => c.id === item?.collectionId);
  if (!item || !c) return;
  await perform(async () => {
    await apiRequest("/api/v1/meme-collections/" + c.id, {
      method: "PUT",
      body: JSON.stringify({
        name: c.name,
        description: c.description,
        coverMemeId: item.id,
        expectedVersion: c.version,
      }),
    });
  });
}
function toggleSelection(item: Meme) {
  if (filtersPending.value) return;
  if (selected.value.has(item.id)) selected.value.delete(item.id);
  else if (selected.value.size < 5000)
    selected.value.set(item.id, item.version);
  else error.value = "最多选择 5000 张，请缩小范围。";
}
function selectPage() {
  if (filtersPending.value) return;
  for (const item of items.value) {
    if (selected.value.size >= 5000) break;
    selected.value.set(item.id, item.version);
  }
}
async function selectAll() {
  if (selecting.value || bulkBusy.value || filtersPending.value) return;
  selecting.value = true;
  const scope = JSON.stringify(filters());
  try {
    const data = await apiRequest<{ items: SelectionItem[] }>(
      "/api/v1/memes/selection",
      { method: "POST", body: scope },
    );
    if (scope === JSON.stringify(filters()))
      selected.value = new Map(
        data.items.map((i) => [i.id, i.expectedVersion]),
      );
  } catch (e) {
    error.value = e instanceof Error ? e.message : "选择失败";
  } finally {
    selecting.value = false;
  }
}
async function runBatch(action: BatchAction, retry = false) {
  if (bulkBusy.value || bulkFailures.value.some((r) => r.status === "unknown"))
    return;
  let targets: SelectionItem[] = retry
    ? bulkFailures.value
        .filter((r) => r.status !== "unknown")
        .map((r) => ({ id: r.id, expectedVersion: 0 }))
    : [...selected.value].map(([id, expectedVersion]) => ({
        id,
        expectedVersion,
      }));
  if (!targets.length) return;
  if (
    !window.confirm(
      `${action.type === "delete" ? "删除" : action.type === "move" ? "移动" : action.enabled ? "启用" : "停用"}所选的 ${targets.length} 张表情？${action.type === "delete" ? "删除后退出检索，历史投递记录保留。" : ""}`,
    )
  )
    return;
  bulkBusy.value = true;
  stopBatch.value = false;
  error.value = "";
  lastAction.value = action;
  bulkResults.value = [];
  bulkTotal.value = targets.length;
  try {
    if (retry) {
      const fresh: SelectionItem[] = [];
      for (const item of targets) {
        if (stopBatch.value) break;
        try {
          const data = await apiRequest<Meme>("/api/v1/memes/" + item.id, {
            signal: AbortSignal.timeout(10000),
          });
          fresh.push({ id: item.id, expectedVersion: data.version });
        } catch {
          bulkResults.value.push({ id: item.id, status: "unknown" });
        }
      }
      targets = fresh;
    }
    for (
      let offset = 0;
      offset < targets.length && !stopBatch.value;
      offset += 100
    ) {
      const results = await submitMemeBatch(
        targets.slice(offset, offset + 100),
        action,
      );
      bulkResults.value.push(...results);
      for (const result of results)
        if (result.status === "succeeded") selected.value.delete(result.id);
      if (results.some((r) => r.status === "unknown")) {
        stopBatch.value = true;
        error.value = "部分结果暂无法核对，已停止后续批次。请先核对结果。";
      }
    }
  } finally {
    bulkBusy.value = false;
    await load();
    await loadCollections();
  }
}
async function checkUnknown() {
  if (!lastAction.value || bulkBusy.value) return;
  bulkBusy.value = true;
  try {
    const unknown = bulkResults.value.filter((r) => r.status === "unknown");
    const checked = await reconcileMemeBatch(
      unknown.map((r) => ({ id: r.id, expectedVersion: 0 })),
      lastAction.value,
    );
    bulkResults.value = bulkResults.value.map(
      (r) => checked.find((c) => c.id === r.id) ?? r,
    );
    for (const r of checked)
      if (r.status === "succeeded") selected.value.delete(r.id);
  } finally {
    bulkBusy.value = false;
    await load();
    await loadCollections();
  }
}
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
  if (!background) syncUrl();
  if (background && filtersPending.value) return;
  const scope = JSON.stringify(filters());
  const seq = ++sequence;
  if (!background) loading.value = true;
  try {
    const params = new URLSearchParams({
      collection: collection.value,
      query: query.value,
      offset: String(page.value * 24),
      limit: "24",
    });
    if (enabled.value) params.set("enabled", enabled.value);
    if (status.value) params.set("status", status.value);
    const result = await apiRequest<{ items: Meme[]; total: number }>(
      `/api/v1/memes?${params}`,
    );
    if (
      seq === sequence &&
      scope === JSON.stringify(filters()) &&
      (!background || selected.value.size === 0)
    ) {
      const lastPage = Math.max(0, Math.ceil(result.total / 24) - 1);
      if (page.value > lastPage) {
        page.value = lastPage;
        await load();
        return;
      }
      loadedFilters.value = scope;
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
  if (bulkBusy.value) return;
  editing.value = item;
  assetCollection.value =
    item?.collectionId ??
    (item
      ? ""
      : ["all", "unclassified"].includes(collection.value)
        ? ""
        : collection.value);
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
    await loadCollections();
  } catch (e) {
    error.value = e instanceof Error ? e.message : "操作失败，请重试。";
  } finally {
    busy.value = false;
  }
}
async function save() {
  await perform(async () => {
    const data = {
      collectionId: assetCollection.value || null,
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
          ...(summary.value !== (editing.value.summary ?? "")
            ? { summary: summary.value }
            : {}),
          expectedVersion: editing.value.version,
        }),
      });
    } else {
      if (!file.value) throw new Error("请选择图片。");
      const form = new FormData();
      form.set("collectionId", data.collectionId ?? "");
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
      summary.value !== (item.summary ?? "") ||
      tags.value !== item.tags.join("，") ||
      active.value !== item.enabled ||
      assetCollection.value !== (item.collectionId ?? "")) &&
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
function protectBatch(event: BeforeUnloadEvent) {
  if (bulkBusy.value) {
    event.preventDefault();
    event.returnValue = "";
  }
}
onBeforeRouteLeave(() => {
  if (bulkBusy.value) {
    error.value = "批量操作仍在处理，请先停止后续批次并等待当前请求核对完成。";
    return false;
  }
  return true;
});
onMounted(() => {
  void load();
  void loadCollections();
  window.addEventListener("beforeunload", protectBatch);
  timer = setInterval(() => {
    if (
      !modal.value &&
      !collectionModal.value &&
      !busy.value &&
      !loading.value &&
      !bulkBusy.value &&
      !selecting.value &&
      selected.value.size === 0
    ) {
      void load(true);
      void loadCollections();
    }
  }, 5000);
});
onUnmounted(() => {
  window.removeEventListener("beforeunload", protectBatch);
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
    <div class="meme-library-layout">
      <aside class="meme-collections" aria-label="表情合集">
        <div class="meme-collections-heading">
          <strong>我的合集</strong
          ><button
            class="meme-close"
            aria-label="新建合集"
            :disabled="bulkBusy"
            @click="editCollection(null)"
          >
            <FolderPlus :size="18" />
          </button>
        </div>
        <p v-if="collectionError" role="alert">
          {{ collectionError }}
          <button class="button secondary" @click="loadCollections">
            重试
          </button>
        </p>
        <nav class="meme-collection-desktop">
          <button
            :class="{ active: collection === 'all' }"
            :disabled="bulkBusy"
            @click="chooseCollection('all')"
          >
            <Folder :size="18" /><span>全部表情</span
            ><small>{{ collectionTotal }}</small>
          </button>
          <button
            :class="{ active: collection === 'unclassified' }"
            :disabled="bulkBusy"
            @click="chooseCollection('unclassified')"
          >
            <Folder :size="18" /><span>未分类</span
            ><small>{{ unclassified }}</small>
          </button>
          <button
            v-for="c in collections"
            :key="c.id"
            :class="{ active: collection === c.id }"
            :disabled="bulkBusy"
            @click="chooseCollection(c.id)"
          >
            <img
              v-if="c.effectiveCoverMemeId"
              :src="`/api/v1/memes/${c.effectiveCoverMemeId}/thumbnail`"
              alt=""
              loading="lazy"
            /><Folder v-else :size="18" /><span>{{ c.name }}</span
            ><small>{{ c.count }}</small>
          </button>
        </nav>
        <select
          class="meme-collection-mobile"
          aria-label="选择合集"
          :value="collection"
          :disabled="bulkBusy"
          @change="chooseCollection(($event.target as HTMLSelectElement).value)"
        >
          <option value="all">全部表情（{{ collectionTotal }}）</option>
          <option value="unclassified">未分类（{{ unclassified }}）</option>
          <option v-for="c in collections" :key="c.id" :value="c.id">
            {{ c.name }}（{{ c.count }}）
          </option>
        </select>
      </aside>
      <section class="meme-library-content" :aria-label="collectionTitle">
        <div class="meme-collection-title">
          <div>
            <h2>{{ collectionTitle }}</h2>
            <p v-if="currentCollection?.description">
              {{ currentCollection.description }}
            </p>
          </div>
          <button
            v-if="currentCollection"
            class="button secondary"
            :disabled="bulkBusy"
            @click="editCollection(currentCollection)"
          >
            <Settings2 :size="16" />管理合集
          </button>
        </div>
        <form
          class="meme-filters"
          @submit.prevent="
            page = 0;
            load();
          "
        >
          <input
            v-model="query"
            :disabled="bulkBusy"
            placeholder="搜索名称或标签"
            aria-label="搜索名称或标签"
          /><select
            v-model="enabled"
            :disabled="bulkBusy"
            aria-label="启用状态"
          >
            <option value="">全部启用状态</option>
            <option value="true">已启用</option>
            <option value="false">已停用</option></select
          ><select v-model="status" :disabled="bulkBusy" aria-label="摘要状态">
            <option value="">全部摘要状态</option>
            <option v-for="(label, key) in labels" :key="key" :value="key">
              {{ label }}
            </option></select
          ><button
            class="button secondary meme-query"
            :disabled="loading || bulkBusy"
          >
            <LoaderCircle
              v-if="loading"
              :size="16"
              class="meme-spinner"
              aria-hidden="true"
            />{{ loading ? "查询中" : "查询" }}
          </button>
        </form>
        <p v-if="error" role="alert">{{ error }}</p>

        <p v-if="filtersPending && !loading">
          筛选条件已更改，请先查询再选择素材。
        </p>
        <div class="meme-selection-bar">
          <button
            class="button secondary"
            :disabled="loading || filtersPending || bulkBusy || !items.length"
            @click="selectPage"
          >
            选择当前页
          </button>
          <button
            class="button secondary"
            :disabled="
              loading || filtersPending || bulkBusy || selecting || !total
            "
            @click="selectAll"
          >
            {{ selecting ? "正在选择…" : `选择筛选结果全部 ${total} 张` }}
          </button>
          <span>已选 {{ selected.size }} 张</span
          ><button
            v-if="selected.size"
            class="button secondary"
            :disabled="bulkBusy"
            @click="selected.clear()"
          >
            清空
          </button>
        </div>
        <div
          v-if="selected.size || bulkResults.length || bulkBusy"
          class="meme-bulk-panel"
        >
          <div class="meme-bulk-controls">
            <select
              v-model="bulkTarget"
              aria-label="批量移动目标"
              :disabled="bulkBusy"
            >
              <option value="">未分类</option>
              <option v-for="c in collections" :key="c.id" :value="c.id">
                {{ c.name }}
              </option></select
            ><button
              class="button secondary"
              :disabled="
                bulkBusy ||
                !selected.size ||
                bulkFailures.some((r) => r.status === 'unknown')
              "
              @click="
                runBatch({ type: 'move', collectionId: bulkTarget || null })
              "
            >
              移动到</button
            ><button
              class="button secondary"
              :disabled="
                bulkBusy ||
                !selected.size ||
                bulkFailures.some((r) => r.status === 'unknown')
              "
              @click="runBatch({ type: 'enable', enabled: true })"
            >
              启用</button
            ><button
              class="button secondary"
              :disabled="
                bulkBusy ||
                !selected.size ||
                bulkFailures.some((r) => r.status === 'unknown')
              "
              @click="runBatch({ type: 'enable', enabled: false })"
            >
              停用</button
            ><button
              class="button secondary meme-delete"
              :disabled="
                bulkBusy ||
                !selected.size ||
                bulkFailures.some((r) => r.status === 'unknown')
              "
              @click="runBatch({ type: 'delete' })"
            >
              删除
            </button>
          </div>
          <div v-if="bulkTotal" role="status" class="meme-bulk-progress">
            已处理 {{ bulkResults.length }} / {{ bulkTotal }} · 成功
            {{ bulkSucceeded }} · 失败
            {{ bulkFailures.filter((r) => r.status !== "unknown").length }} ·
            待核对
            {{ bulkFailures.filter((r) => r.status === "unknown").length }} ·
            未开始 {{ Math.max(0, bulkTotal - bulkResults.length)
            }}<span v-if="stopBatch"> · 已停止后续批次</span>
          </div>
          <button
            v-if="bulkBusy"
            class="button secondary"
            :disabled="stopBatch"
            @click="stopBatch = true"
          >
            停止后续批次
          </button>
          <template v-else-if="bulkFailures.length"
            ><button
              v-if="bulkFailures.some((r) => r.status === 'unknown')"
              class="button secondary"
              @click="checkUnknown"
            >
              核对未知结果</button
            ><button
              v-if="
                lastAction && bulkFailures.some((r) => r.status !== 'unknown')
              "
              class="button secondary"
              :disabled="bulkFailures.some((r) => r.status === 'unknown')"
              @click="runBatch(lastAction, true)"
            >
              刷新并重试失败项
            </button>
            <details>
              <summary>查看未完成项</summary>
              <ul>
                <li v-for="r in bulkFailures" :key="r.id">
                  {{ r.id }} ·
                  {{
                    r.status === "unknown"
                      ? "结果待核对"
                      : r.status === "missing"
                        ? "素材不存在"
                        : "版本或状态已变化"
                  }}
                </li>
              </ul>
            </details></template
          >
        </div>
        <div class="meme-grid" :aria-busy="loading">
          <article
            v-for="item in items"
            :key="item.id"
            class="meme-card"
            :class="{ 'is-selected': selected.has(item.id) }"
          >
            <label class="meme-card-select"
              ><input
                type="checkbox"
                :checked="selected.has(item.id)"
                :disabled="bulkBusy || filtersPending || loading"
                :aria-label="`选择 ${item.name}`"
                @change="toggleSelection(item)" /></label
            ><button
              class="meme-card-open"
              :disabled="bulkBusy"
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
          </article>
        </div>
        <p v-if="!loading && !items.length">暂无匹配表情。</p>
        <footer class="meme-filters">
          <button
            :disabled="page === 0 || loading || bulkBusy"
            @click="
              page--;
              load();
            "
          >
            上一页</button
          ><span>共 {{ total }} 张 · 第 {{ page + 1 }} 页</span
          ><button
            :disabled="(page + 1) * 24 >= total || loading || bulkBusy"
            @click="
              page++;
              load();
            "
          >
            下一页
          </button>
        </footer>
      </section>
    </div>
    <div
      v-if="collectionModal"
      class="meme-overlay"
      @click.self="!busy && (collectionModal = false)"
    >
      <section
        class="meme-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="collection-title"
      >
        <header class="meme-dialog-heading">
          <div>
            <h2 id="collection-title">
              {{ collectionEditing ? "管理合集" : "新建合集" }}
            </h2>
            <p>按系列整理表情，标签继续用于情绪和场景检索。</p>
          </div>
          <button
            class="meme-close"
            aria-label="关闭合集弹窗"
            :disabled="busy"
            @click="collectionModal = false"
          >
            <X :size="20" />
          </button>
        </header>
        <p v-if="error" role="alert">{{ error }}</p>
        <form @submit.prevent="saveCollection">
          <label
            >合集名称<input
              v-model="collectionName"
              required
              maxlength="120"
              :disabled="busy"
              placeholder="例如：什么猫" /></label
          ><label
            >说明<textarea
              v-model="collectionDescription"
              maxlength="2000"
              :disabled="busy"
              placeholder="简短说明这个系列的特点"
            /></label
          ><label v-if="collectionEditing"
            >封面<select v-model="collectionCover" :disabled="busy">
              <option value="">自动使用最早加入的表情</option>
              <option
                v-if="collectionEditing.coverMemeId"
                :value="collectionEditing.coverMemeId"
              >
                保留指定封面
              </option>
            </select></label
          >
          <p class="meme-summary-hint">
            可在合集内任一表情的编辑弹窗中将其设为封面。
          </p>
          <footer class="meme-dialog-actions">
            <button
              v-if="collectionEditing"
              type="button"
              class="button secondary meme-delete"
              :disabled="busy"
              @click="deleteCollection"
            >
              删除合集</button
            ><button
              type="button"
              class="button secondary"
              :disabled="busy"
              @click="collectionModal = false"
            >
              取消</button
            ><button class="button primary" :disabled="busy">
              {{ busy ? "保存中…" : "保存" }}
            </button>
          </footer>
        </form>
      </section>
    </div>
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
              >所属合集<select v-model="assetCollection" :disabled="busy">
                <option value="">未分类</option>
                <option v-for="c in collections" :key="c.id" :value="c.id">
                  {{ c.name }}
                </option>
              </select></label
            ><button
              v-if="
                editing?.collectionId &&
                assetCollection === editing.collectionId
              "
              type="button"
              class="button secondary"
              :disabled="busy"
              @click="setCover"
            >
              将此表情设为合集封面
            </button>
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

<style scoped>
.meme-library-layout {
  display: grid;
  grid-template-columns: 210px minmax(0, 1fr);
  gap: 28px;
  align-items: start;
}
.meme-library-content {
  min-width: 0;
}
.meme-collections {
  position: sticky;
  top: 110px;
  background: #ffffffa6;
  border: 1px solid #e5e7eb;
  border-radius: 18px;
  padding: 14px;
  max-height: calc(100vh - 140px);
  overflow: auto;
}
.meme-collections-heading,
.meme-collection-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}
.meme-collection-title h2 {
  margin: 0;
  font-size: 20px;
}
.meme-collection-title p {
  font-size: 13px;
  color: #64748b;
}
.meme-collection-desktop {
  display: grid;
  gap: 6px;
}
.meme-collection-desktop button {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 10px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
  min-width: 0;
}
.meme-collection-desktop button.active {
  background: #eaf0ff;
  color: #254eae;
}
.meme-collection-desktop button:hover {
  background: #f1f5f9;
}
.meme-collection-desktop button span {
  flex: 1;
  overflow-wrap: anywhere;
}
.meme-collection-desktop img {
  width: 30px;
  height: 30px;
  object-fit: contain;
  border-radius: 6px;
}
.meme-collection-desktop svg {
  flex-shrink: 0;
}
.meme-collection-desktop small {
  color: #64748b;
}
.meme-collection-mobile {
  display: none;
}
.meme-selection-bar,
.meme-bulk-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}
.meme-selection-bar {
  font-size: 12px;
}
.meme-selection-bar .button,
.meme-bulk-panel .button {
  font-size: 12px;
  padding: 8px 12px;
}
.meme-bulk-panel {
  padding: 16px;
  background: #f1f5fc;
  border: 1px solid #dae3f3;
  border-radius: 14px;
  margin-bottom: 16px;
}
.meme-bulk-controls select {
  width: auto;
  max-width: 220px;
}
.meme-bulk-progress {
  font-size: 13px;
  line-height: 1.8;
  margin: 10px 0;
}
.meme-bulk-panel details {
  font-size: 12px;
  overflow-wrap: anywhere;
}
.meme-bulk-panel ul {
  max-height: 160px;
  overflow: auto;
}
.meme-card {
  position: relative;
  padding: 0;
  display: block;
  overflow: hidden;
}
.meme-card.is-selected {
  border-color: #6383d2;
  box-shadow: 0 0 0 1px #6383d2;
}
.meme-card-open {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  height: 100%;
  padding: 16px;
  border: 0;
  background: transparent;
  text-align: left;
  color: inherit;
  cursor: pointer;
}
.meme-card-select {
  position: absolute;
  top: 8px;
  left: 8px;
  z-index: 1;
  display: grid;
  place-items: center;
  padding: 5px;
  background: #ffffffdb;
  border-radius: 7px;
}
.meme-card-select input {
  width: 16px;
  height: 16px;
  margin: 0;
  accent-color: #2563eb;
}
.meme-delete {
  color: #b24444 !important;
}
@media (max-width: 760px) {
  .meme-library-layout {
    grid-template-columns: minmax(0, 1fr);
    gap: 16px;
  }
  .meme-collections {
    position: static;
    max-height: none;
  }
  .meme-collection-desktop {
    display: none;
  }
  .meme-collection-mobile {
    display: block;
  }
  .meme-page {
    padding: 16px;
  }
  .meme-selection-bar {
    gap: 6px;
  }
  .meme-grid {
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  }
}
</style>
