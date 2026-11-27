<script setup lang="ts">
import { Puzzle, Smile } from "@lucide/vue";

/** Shared sidebar for the plugins and memes pages (one navigation area). */
defineProps<{ note?: string }>();
</script>

<template>
  <aside class="admin-sidebar">
    <div>
      <p class="eyebrow">扩展</p>
      <h1>插件与表情包</h1>
    </div>
    <nav aria-label="插件与表情包">
      <RouterLink to="/plugins" active-class="active"
        ><Puzzle :size="18" />插件</RouterLink
      >
      <RouterLink to="/memes" active-class="active"
        ><Smile :size="18" />表情包</RouterLink
      >
    </nav>
    <div v-if="note" class="sidebar-note">{{ note }}</div>
  </aside>
</template>
