<script setup lang="ts">
import { onMounted, ref } from "vue";
import { RefreshCw, Save } from "@lucide/vue";
import { apiRequest, errorMessage, jsonBody } from "../services/api";
import { useSessionStore } from "../stores/session";
import DismissibleMessage from "./DismissibleMessage.vue";
interface Settings {
  trustedFakeIpHosts: string[];
  version: number;
  updatedAt: string;
}
const session = useSessionStore();
const current = ref<Settings | null>(null);
const hosts = ref("");
const busy = ref(false);
const message = ref("");
const failed = ref(false);
function apply(value: Settings) {
  current.value = value;
  hosts.value = value.trustedFakeIpHosts.join("\n");
}
async function load() {
  if (busy.value) return;
  busy.value = true;
  message.value = "";
  try {
    apply(await apiRequest<Settings>("/api/v1/settings/network"));
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
    apply(
      await apiRequest<Settings>("/api/v1/settings/network", {
        method: "PUT",
        body: jsonBody({
          trustedFakeIpHosts: hosts.value.split(/[\s,]+/u).filter(Boolean),
          expectedVersion: current.value.version,
        }),
      }),
    );
    failed.value = false;
    message.value = "外部网络配置已保存。";
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
  <section id="network" class="admin-panel">
    <div class="panel-head">
      <div>
        <p class="card-kicker">NETWORK</p>
        <h2>外部网络</h2>
      </div>
      <button class="button secondary" :disabled="busy" @click="load">
        <RefreshCw :size="16" />刷新
      </button>
    </div>
    <p class="panel-description">
      图片与链接预览、插件 Git 导入、MCP
      连接共用此配置。升级时会自动迁移原图片可信域名。
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
        ><span>可信 Fake-IP 域名（每行一个）</span
        ><textarea
          v-model="hosts"
          rows="5"
          placeholder="github.com&#10;mcp.firecrawl.dev"
          :disabled="busy || !current"
        /><small
          >仅填写可信的精确域名，不含协议、端口、路径或通配符。只允许这些域名使用代理的
          198.18.0.0/15 地址，其他私网地址仍受限制；不会改变代理出口。</small
        ></label
      >
      <p v-if="!session.sensitiveActive" class="panel-description">
        修改外部网络信任范围需要先完成敏感操作验证。
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
