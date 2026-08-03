<script setup lang="ts">
import { onMounted, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import AppHeader from "./components/AppHeader.vue";
import { useSessionStore } from "./stores/session";

const session = useSessionStore();
const route = useRoute();
const router = useRouter();

watch(
  () => [session.checked, session.authenticated, route.path] as const,
  async ([checked, authenticated, path]) => {
    if (!checked) return;
    if (!authenticated && path !== "/login") await router.replace("/login");
    if (authenticated && path === "/login") await router.replace("/");
  },
);

onMounted(() => session.restore());
</script>

<template>
  <div class="app-shell">
    <div class="backdrop-grid" aria-hidden="true"></div>
    <AppHeader v-if="session.authenticated" />
    <div v-if="!session.checked" class="loading-screen">
      正在连接 BubblePilot…
    </div>
    <RouterView v-else />
  </div>
</template>
