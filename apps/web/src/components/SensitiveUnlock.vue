<script setup lang="ts">
import { KeyRound, ShieldCheck } from "@lucide/vue";
import { onBeforeUnmount, ref } from "vue";

import { errorMessage } from "../services/api";
import DismissibleMessage from "./DismissibleMessage.vue";
import { useSessionStore } from "../stores/session";

const emit = defineEmits<{ verified: [] }>();
const session = useSessionStore();
const password = ref("");
const busy = ref(false);
const message = ref("");

let alive = true;
onBeforeUnmount(() => {
  alive = false;
  password.value = "";
});

async function verify() {
  if (busy.value) return;
  busy.value = true;
  message.value = "";
  try {
    await session.verifySensitive(password.value);
    password.value = "";
    if (alive) emit("verified");
  } catch (cause) {
    if (alive) message.value = errorMessage(cause);
  } finally {
    password.value = "";
    busy.value = false;
  }
}
</script>

<template>
  <div v-if="session.sensitiveActive" class="sensitive-status is-active">
    <ShieldCheck :size="18" />
    <div>
      <strong>敏感操作已解锁</strong
      ><span>授权仅绑定当前会话，并会自动过期。</span>
      <span v-if="session.session?.sensitiveUntil"
        >有效期至
        {{ new Date(session.session.sensitiveUntil).toLocaleString() }}</span
      >
    </div>
  </div>
  <form v-else class="sensitive-unlock" @submit.prevent="verify">
    <KeyRound :size="20" />
    <div>
      <strong>需要二次验证</strong
      ><span>查看正文或修改生产配置前，请输入独立的敏感操作密码。</span>
    </div>
    <input
      v-model="password"
      type="password"
      aria-label="敏感操作密码"
      autofocus
      :disabled="busy"
      autocomplete="current-password"
      placeholder="敏感操作密码"
      required
    />
    <button class="button primary" type="submit" :disabled="busy">
      {{ busy ? "验证中…" : "解锁" }}
    </button>
    <DismissibleMessage v-if="message" error @close="message = ''">{{
      message
    }}</DismissibleMessage>
  </form>
</template>

<style scoped>
.sensitive-unlock {
  grid-template-columns: auto 1fr;
}
.sensitive-unlock input,
.sensitive-unlock .button,
.sensitive-unlock .form-message {
  grid-column: 1 / -1;
  width: 100%;
}
</style>
