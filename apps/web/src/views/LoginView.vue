<script setup lang="ts">
import { ArrowRight, LockKeyhole } from "@lucide/vue";
import { ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { safeRedirect } from "../utils/login-redirect";

import { errorMessage } from "../services/api";
import DismissibleMessage from "../components/DismissibleMessage.vue";
import { useSessionStore } from "../stores/session";

const session = useSessionStore();
const router = useRouter();
const route = useRoute();
const password = ref("");
const busy = ref(false);
const message = ref("");

async function login() {
  busy.value = true;
  message.value = "";
  try {
    await session.login(password.value);
    password.value = "";
    // Return to the page that required login.
    await router.replace(safeRedirect(route.query.redirect));
  } catch (cause) {
    message.value = errorMessage(cause);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <main class="login-page page-container reveal">
    <section class="login-card">
      <img src="/bubblepilot-icon.png" alt="BubblePilot" />
      <p class="eyebrow">自托管自动化</p>
      <h1>欢迎回到 BubblePilot</h1>
      <p>登录只建立管理会话；正文和生产配置仍由短时效的敏感操作授权保护。</p>
      <form @submit.prevent="login">
        <label>
          <span>登录密码</span>
          <div class="input-with-icon">
            <LockKeyhole :size="18" /><input
              v-model="password"
              type="password"
              autocomplete="current-password"
              required
              autofocus
            />
          </div>
        </label>
        <button class="button primary large" type="submit" :disabled="busy">
          {{ busy ? "登录中…" : "进入管理台" }}<ArrowRight :size="18" />
        </button>
        <DismissibleMessage v-if="message" error @close="message = ''">{{
          message
        }}</DismissibleMessage>
      </form>
    </section>
  </main>
</template>
