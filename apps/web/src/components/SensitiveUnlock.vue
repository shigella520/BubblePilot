<script setup lang="ts">
import { KeyRound, ShieldCheck } from "@lucide/vue";
import { ref } from "vue";

import { errorMessage } from "../services/api";
import { useSessionStore } from "../stores/session";

const emit = defineEmits<{ verified: [] }>();
const session = useSessionStore();
const password = ref("");
const busy = ref(false);
const message = ref("");

async function verify() {
  busy.value = true;
  message.value = "";
  try {
    await session.verifySensitive(password.value);
    password.value = "";
    emit("verified");
  } catch (cause) {
    message.value = errorMessage(cause);
  } finally {
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
      autocomplete="current-password"
      placeholder="敏感操作密码"
      required
    />
    <button class="button primary" type="submit" :disabled="busy">
      {{ busy ? "验证中…" : "解锁" }}
    </button>
    <p v-if="message" class="form-message error">{{ message }}</p>
  </form>
</template>
