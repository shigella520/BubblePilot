<script setup lang="ts">
import {
  Bot,
  KeyRound,
  LayoutDashboard,
  LogOut,
  MessagesSquare,
  Puzzle,
  ScrollText,
  Settings,
  ShieldCheck,
  Workflow,
} from "@lucide/vue";
import { computed, onMounted, onBeforeUnmount, ref, watch } from "vue";
import { useRouter } from "vue-router";

import { errorMessage } from "../services/api";
import { useSessionStore } from "../stores/session";
import DismissibleMessage from "./DismissibleMessage.vue";
import GithubIcon from "./GithubIcon.vue";
import AdminDetailDialog from "./AdminDetailDialog.vue";
import SensitiveUnlock from "./SensitiveUnlock.vue";

const session = useSessionStore();
const router = useRouter();
/** One entry per area; sub-pages (canvas, memes) highlight their parent. */
const navItems = [
  { to: "/", label: "概览", icon: LayoutDashboard, prefixes: [] as string[] },
  {
    to: "/messages",
    label: "消息",
    icon: MessagesSquare,
    prefixes: ["/messages"],
  },
  {
    to: "/automation",
    label: "自动化",
    icon: Workflow,
    prefixes: ["/automation"],
  },
  { to: "/ai", label: "AI 服务", icon: Bot, prefixes: ["/ai"] },
  {
    to: "/plugins",
    label: "插件与表情包",
    icon: Puzzle,
    prefixes: ["/plugins", "/memes"],
  },
  {
    to: "/executions",
    label: "执行与审计",
    icon: ScrollText,
    prefixes: ["/executions"],
  },
  { to: "/settings", label: "设置", icon: Settings, prefixes: ["/settings"] },
];
function isCurrent(item: (typeof navItems)[number]) {
  const path = router.currentRoute.value.path;
  return item.prefixes.length
    ? item.prefixes.some(
        (prefix) => path === prefix || path.startsWith(`${prefix}/`),
      )
    : path === item.to;
}
const navigation = ref<HTMLElement | null>(null);
// Scroll only the navigation strip; changing routes must not move page content.
function revealCurrentNavigation() {
  const nav = navigation.value;
  const active = nav?.querySelector<HTMLElement>(".is-current");
  if (!nav || !active || nav.scrollWidth <= nav.clientWidth) return;
  const container = nav.getBoundingClientRect();
  const item = active.getBoundingClientRect();
  if (item.left < container.left + 8)
    nav.scrollLeft += item.left - container.left - 8;
  else if (item.right > container.right - 8)
    nav.scrollLeft += item.right - container.right + 8;
}
watch(() => router.currentRoute.value.path, revealCurrentNavigation, {
  flush: "post",
});
let navigationObserver: ResizeObserver | undefined;
onMounted(() => {
  revealCurrentNavigation();
  navigationObserver = new ResizeObserver(revealCurrentNavigation);
  if (navigation.value) navigationObserver.observe(navigation.value);
});
onBeforeUnmount(() => navigationObserver?.disconnect());
const unlockOpen = ref(false);
const unlockTrigger = ref<HTMLElement | null>(null);
// Pages call session.requestUnlock() instead of pointing at the header.
watch(
  () => session.unlockRequests,
  () => {
    if (!session.sensitiveActive) unlockOpen.value = true;
  },
);
// Minute-level clock for the remaining authorization time.
const now = ref(Date.now());
let clock: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  clock = setInterval(() => (now.value = Date.now()), 30_000);
});
onBeforeUnmount(() => clearInterval(clock));
const sensitiveMinutesLeft = computed(() => {
  const until = session.session?.sensitiveUntil;
  if (!session.sensitiveActive || !until) return null;
  return Math.max(1, Math.ceil((Date.parse(until) - now.value) / 60_000));
});
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
    <nav ref="navigation" class="primary-nav" aria-label="主导航">
      <RouterLink
        v-for="item in navItems"
        :key="item.to"
        :to="item.to"
        :class="{ 'is-current': isCurrent(item) }"
        :aria-current="isCurrent(item) ? 'page' : undefined"
        ><component :is="item.icon" :size="16" />{{ item.label }}</RouterLink
      >
    </nav>
    <div class="topbar-meta">
      <span
        class="connection-pill"
        :class="session.sensitiveActive ? 'online' : 'locked'"
      >
        <span class="status-dot"></span>
        {{
          sensitiveMinutesLeft !== null
            ? `敏感操作授权 · 剩余 ${sensitiveMinutesLeft} 分钟`
            : "敏感操作未解锁"
        }}
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
      size="md"
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
