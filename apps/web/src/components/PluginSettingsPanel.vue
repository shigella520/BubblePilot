<script setup lang="ts">
import { onMounted, ref } from "vue";
import { RefreshCw, Save } from "@lucide/vue";
import { apiRequest, errorMessage, jsonBody } from "../services/api";
import { useSessionStore } from "../stores/session";
import DismissibleMessage from "./DismissibleMessage.vue";
interface Settings {
  catalogueCharacters: number;
  version: number;
  updatedAt: string;
}
interface Usage {
  characters: number;
  sharedCharacters: number;
  toolCount: number;
  plugins: Array<{
    id: string;
    name: string;
    characters: number;
    toolCount: number;
  }>;
}
const session = useSessionStore();
const current = ref<Settings | null>(null);
const usage = ref<Usage | null>(null);
const limit = ref(64000);
const busy = ref(false);
const message = ref("");
const failed = ref(false);
async function load() {
  if (busy.value) return;
  busy.value = true;
  message.value = "";
  try {
    const value = await apiRequest<Settings & { usage: Usage }>(
      "/api/v1/settings/plugins",
    );
    current.value = value;
    usage.value = value.usage;
    limit.value = value.catalogueCharacters;
  } catch (e) {
    failed.value = true;
    message.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
async function save() {
  if (busy.value || !current.value || !session.sensitiveActive) return;
  busy.value = true;
  message.value = "";
  try {
    current.value = await apiRequest<Settings>("/api/v1/settings/plugins", {
      method: "PUT",
      body: jsonBody({
        catalogueCharacters: limit.value,
        expectedVersion: current.value.version,
      }),
    });
    limit.value = current.value.catalogueCharacters;
    failed.value = false;
    message.value = "插件工具预算已保存，对后续校验和新执行生效。";
  } catch (e) {
    failed.value = true;
    message.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
onMounted(load);
</script>
<template>
  <section id="plugin-budget" class="admin-panel">
    <div class="panel-head">
      <div>
        <p class="card-kicker">PLUGINS</p>
        <h2>插件工具预算</h2>
      </div>
      <button class="button secondary" :disabled="busy" @click="load">
        <RefreshCw :size="16" />刷新
      </button>
    </div>
    <p class="panel-description">
      限制每次执行所选插件的工具定义和 Skill
      目录字符数，不含聊天上下文、角色提示词、内置工具或工具返回结果。字符数不是
      Token 数；启用更多工具会增加模型输入成本。
    </p>
    <DismissibleMessage
      v-if="message"
      :error="failed"
      inline
      @close="message = ''"
      >{{ message }}</DismissibleMessage
    >
    <form @submit.prevent="save">
      <label
        ><span>插件目录字符上限</span
        ><input
          v-model.number="limit"
          type="number"
          min="8000"
          max="256000"
          step="1"
          required
          :disabled="busy || !current"
        /><small
          >默认 64,000，可设置
          8,000–256,000。已运行的会话不会被中途截断。</small
        ></label
      >
      <div v-if="usage && current" class="panel-description">
        <p>
          全部已启用插件合计：{{ usage.characters.toLocaleString() }} /
          {{ current.catalogueCharacters.toLocaleString() }} 字符，{{
            usage.toolCount
          }}
          个工具（含 Skill 加载工具）。实际按各工作流选择的插件校验。
        </p>
        <p v-for="plugin in usage.plugins" :key="plugin.id">
          {{ plugin.name }}：{{ plugin.characters.toLocaleString() }} 字符 ·
          {{ plugin.toolCount }} 个 MCP 工具
        </p>
        <p>
          共享加载工具与序列化开销：{{
            usage.sharedCharacters.toLocaleString()
          }}
          字符。已排除停用项及输出 Schema。
        </p>
        <p v-if="usage.characters > current.catalogueCharacters">
          所有插件一起使用将超限，可减少单个工作流所选插件或调整上限。
        </p>
      </div>
      <p v-if="!session.sensitiveActive" class="panel-description">
        修改预算需要先完成敏感操作验证。
      </p>
      <div class="form-actions">
        <button
          class="button primary"
          :disabled="busy || !current || !session.sensitiveActive"
          :aria-busy="busy"
        >
          <Save :size="16" />保存配置
        </button>
      </div>
    </form>
  </section>
</template>
