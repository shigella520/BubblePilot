<script setup lang="ts">
import {
  Cable,
  CheckCircle2,
  RefreshCw,
  Save,
  Settings2,
  ShieldCheck,
  XCircle,
} from "@lucide/vue";
import { onMounted, reactive, ref } from "vue";

import SensitiveUnlock from "../components/SensitiveUnlock.vue";
import { apiRequest, errorMessage, jsonBody } from "../services/api";
import { useSessionStore } from "../stores/session";

interface BlueBubblesSettings {
  serverUrl: string;
  accessTokenConfigured: boolean;
  webhookSecretConfigured: boolean;
  sendMethod: "private-api" | "apple-script";
  requestTimeoutMs: number;
  source: "environment" | "database";
  version: number;
  updatedAt: string | null;
}

const session = useSessionStore();
const busy = ref(false);
const saveBusy = ref(false);
const testBusy = ref(false);
const testResult = ref<{
  status: "connected" | "failed";
  durationMs: number;
  code: string | null;
  message: string;
} | null>(null);
const message = ref("");
const messageIsError = ref(false);
const current = ref<BlueBubblesSettings | null>(null);
const form = reactive({
  serverUrl: "",
  accessToken: "",
  webhookSecret: "",
  sendMethod: "private-api",
  requestTimeoutMs: 30_000,
});

function apply(value: BlueBubblesSettings) {
  current.value = value;
  form.serverUrl = value.serverUrl;
  form.accessToken = "";
  form.webhookSecret = "";
  form.sendMethod = value.sendMethod;
  form.requestTimeoutMs = value.requestTimeoutMs;
}

async function load() {
  if (busy.value) return;
  busy.value = true;
  message.value = "";
  try {
    apply(
      await apiRequest<BlueBubblesSettings>("/api/v1/integrations/bluebubbles"),
    );
  } catch (cause) {
    message.value = errorMessage(cause);
    messageIsError.value = true;
  } finally {
    busy.value = false;
  }
}

async function save() {
  if (!session.sensitiveActive || saveBusy.value || current.value === null)
    return;
  saveBusy.value = true;
  message.value = "";
  try {
    const value = await apiRequest<BlueBubblesSettings>(
      "/api/v1/integrations/bluebubbles",
      {
        method: "PUT",
        body: jsonBody({
          serverUrl: form.serverUrl,
          ...(form.accessToken ? { accessToken: form.accessToken } : {}),
          ...(form.webhookSecret ? { webhookSecret: form.webhookSecret } : {}),
          sendMethod: form.sendMethod,
          requestTimeoutMs: form.requestTimeoutMs,
          expectedVersion: current.value.version,
        }),
      },
    );
    apply(value);
    message.value = "BlueBubbles 配置已保存并立即生效。";
    messageIsError.value = false;
  } catch (cause) {
    message.value = errorMessage(cause);
    messageIsError.value = true;
  } finally {
    saveBusy.value = false;
  }
}

async function testConnection() {
  if (!session.sensitiveActive || testBusy.value) return;
  testBusy.value = true;
  testResult.value = null;
  try {
    testResult.value = await apiRequest<typeof testResult.value>(
      "/api/v1/integrations/bluebubbles/test",
      { method: "POST" },
    );
  } catch (cause) {
    message.value = errorMessage(cause);
    messageIsError.value = true;
  } finally {
    testBusy.value = false;
  }
}

onMounted(load);
</script>

<template>
  <main class="page-container split-admin-page reveal">
    <aside class="admin-sidebar">
      <div>
        <p class="eyebrow">SETTINGS</p>
        <h2>系统设置</h2>
      </div>
      <nav>
        <a class="active" href="#bluebubbles"
          ><Cable :size="18" />BlueBubbles</a
        >
      </nav>
      <div class="sidebar-note">
        运行时配置保存在应用数据库中，修改后无需重新部署容器。
      </div>
    </aside>

    <div class="admin-workspace">
      <SensitiveUnlock />
      <p v-if="message" class="form-message" :class="{ error: messageIsError }">
        {{ message }}
      </p>

      <section id="bluebubbles" class="admin-panel">
        <div class="panel-head">
          <div>
            <p class="card-kicker">MESSAGE GATEWAY</p>
            <h1>BlueBubbles 服务</h1>
          </div>
          <button class="button secondary" :disabled="busy" @click="load">
            <RefreshCw :size="16" />{{ busy ? "刷新中…" : "刷新" }}
          </button>
        </div>
        <p class="panel-description">
          配置消息网关地址、访问令牌、Webhook Secret 和发送方式。Secret
          使用服务端密钥加密保存，页面不会回显原值。
        </p>

        <div class="form-actions settings-test-actions">
          <button
            class="button secondary"
            type="button"
            :disabled="!session.sensitiveActive || testBusy"
            @click="testConnection"
          >
            <Cable :size="16" />{{ testBusy ? "验证中…" : "验证服务连接" }}
          </button>
          <span v-if="testResult" class="panel-description">
            <CheckCircle2 v-if="testResult.status === 'connected'" :size="15" />
            <XCircle v-else :size="15" />
            {{ testResult.message }}（{{ testResult.durationMs }} ms<span
              v-if="testResult.code"
              >，{{ testResult.code }}</span
            >）
          </span>
        </div>

        <div v-if="current" class="provider-list settings-status-list">
          <article>
            <div class="provider-main">
              <header>
                <strong>当前配置</strong>
                <span class="table-status healthy">{{
                  current.source === "database" ? "数据库" : "环境变量回退"
                }}</span>
              </header>
              <p>{{ current.serverUrl }}</p>
              <footer>
                <span>{{
                  current.accessTokenConfigured
                    ? "Access Token 已配置"
                    : "Access Token 未配置"
                }}</span>
                <span>{{
                  current.webhookSecretConfigured
                    ? "Webhook Secret 已配置"
                    : "Webhook Secret 未配置"
                }}</span>
                <span>版本 {{ current.version }}</span>
              </footer>
            </div>
          </article>
        </div>

        <form
          v-if="current"
          class="settings-form boxed-form"
          @submit.prevent="save"
        >
          <h3><Settings2 :size="18" />连接配置</h3>
          <div class="field-grid">
            <label class="wide-field"
              ><span>Server URL</span
              ><input v-model.trim="form.serverUrl" type="url" required
            /></label>
            <label
              ><span>发送方式</span
              ><select v-model="form.sendMethod">
                <option value="private-api">Private API</option>
                <option value="apple-script">AppleScript</option>
              </select></label
            >
            <label
              ><span>请求超时（毫秒）</span
              ><input
                v-model.number="form.requestTimeoutMs"
                type="number"
                min="1000"
                max="120000"
                required
            /></label>
            <label class="wide-field"
              ><span>Access Token</span
              ><input
                v-model="form.accessToken"
                type="password"
                autocomplete="new-password"
                placeholder="留空则保留当前值"
            /></label>
            <label class="wide-field"
              ><span>Webhook Secret（至少 32 字符）</span
              ><input
                v-model="form.webhookSecret"
                type="password"
                minlength="32"
                autocomplete="new-password"
                placeholder="留空则保留当前值"
            /></label>
          </div>
          <div class="form-actions">
            <span class="panel-description"
              ><ShieldCheck :size="15" />保存需要敏感操作授权</span
            >
            <button
              class="button primary"
              :disabled="!session.sensitiveActive || saveBusy"
              :aria-busy="saveBusy"
            >
              <Save :size="16" />{{ saveBusy ? "保存中…" : "保存并立即生效" }}
            </button>
          </div>
        </form>
      </section>
    </div>
  </main>
</template>
