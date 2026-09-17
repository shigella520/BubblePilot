<script setup lang="ts">
import {
  Bot,
  Boxes,
  LayoutDashboard,
  KeyRound,
  LogOut,
  MessagesSquare,
  Settings,
  ShieldCheck,
} from "@lucide/vue";
import { ref, watch } from "vue";
import { useRouter } from "vue-router";

import { errorMessage } from "../services/api";
import { useSessionStore } from "../stores/session";
import DismissibleMessage from "./DismissibleMessage.vue";
import GithubIcon from "./GithubIcon.vue";
import AdminDetailDialog from "./AdminDetailDialog.vue";
import SensitiveUnlock from "./SensitiveUnlock.vue";

const session = useSessionStore();
const router = useRouter();
const unlockOpen = ref(false);
const unlockTrigger = ref<HTMLElement | null>(null);
watch(
  () => session.sensitiveActive,
  (active) => {
    if (active) unlockOpen.value = false;
  },
);
const logoutBusy = ref(false);
const logoutError = ref("");

async function logout() {
  if (logoutBusy.value) return;
  logoutBusy.value = true;
  logoutError.value = "";
  try {
    await session.logout();
    await router.replace("/login");
  } catch (cause) {
    logoutError.value = errorMessage(cause);
  } finally {
    logoutBusy.value = false;
  }
}
</script>

<template>
  <header class="topbar">
    <RouterLink class="brand-mark" to="/" aria-label="BubblePilot 管理台">
      <img class="brand-icon" src="/bubblepilot-icon.png" alt="" />
      <span class="brand-text">BubblePilot</span>
    </RouterLink>
    <nav class="primary-nav" aria-label="主导航">
      <RouterLink to="/"><LayoutDashboard :size="16" />概览</RouterLink>
      <RouterLink to="/messages"><MessagesSquare :size="16" />消息</RouterLink>
      <RouterLink to="/automation"><Boxes :size="16" />自动化</RouterLink>
      <RouterLink to="/ai"><Bot :size="16" />AI 服务</RouterLink>
      <RouterLink to="/executions"
        ><ShieldCheck :size="16" />执行与审计</RouterLink
      >
      <RouterLink to="/settings"><Settings :size="16" />设置</RouterLink>
    </nav>
    <div class="topbar-meta">
      <span class="connection-pill online">
        <span class="status-dot"></span>
        {{ session.sensitiveActive ? "敏感授权有效" : "管理会话有效" }}
      </span>
      <button
        ref="unlockTrigger"
        class="icon-button sensitive-entry"
        :class="{ 'is-unlocked': session.sensitiveActive }"
        type="button"
        aria-haspopup="dialog"
        :aria-expanded="unlockOpen"
        :aria-label="
          session.sensitiveActive
            ? '敏感操作已解锁，查看授权状态'
            : '解锁敏感操作'
        "
        :title="
          session.sensitiveActive
            ? '敏感操作已解锁，查看授权状态'
            : '解锁敏感操作'
        "
        @click="unlockOpen = true"
      >
        <ShieldCheck v-if="session.sensitiveActive" :size="18" />
        <KeyRound v-else :size="18" />
      </button>
      <a
        class="icon-button github-icon"
        href="https://github.com/shigella520/BubblePilot"
        target="_blank"
        rel="noreferrer"
        aria-label="GitHub"
        ><GithubIcon
      /></a>
      <button
        class="icon-button"
        type="button"
        :disabled="logoutBusy"
        :aria-busy="logoutBusy"
        :aria-label="logoutBusy ? '正在退出登录' : '退出登录'"
        :title="logoutBusy ? '正在退出登录' : '退出登录'"
        @click="logout"
      >
        <LogOut :size="18" />
      </button>
    </div>
    <AdminDetailDialog
      v-if="unlockOpen"
      title="敏感操作授权"
      :return-focus="unlockTrigger"
      @close="unlockOpen = false"
    >
      <SensitiveUnlock @verified="unlockOpen = false" />
    </AdminDetailDialog>
    <DismissibleMessage v-if="logoutError" error @close="logoutError = ''">
      {{ logoutError }} 请检查网络或服务状态后重试。
    </DismissibleMessage>
  </header>
</template>

<style scoped>
.sensitive-entry.is-unlocked {
  color: #13865f;
  background: #effaf5;
}
</style>
