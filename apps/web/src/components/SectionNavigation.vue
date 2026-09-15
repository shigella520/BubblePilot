<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, type Component } from "vue";

const props = defineProps<{
  items: { id: string; label: string; icon: Component }[];
}>();
const navigation = ref<HTMLElement>();
const activeId = ref("");
const indicator = ref<Record<string, string>>({ opacity: "0" });
let frame = 0;
let observer: ResizeObserver | undefined;

function update() {
  frame = 0;
  const nav = navigation.value;
  if (!nav) return;
  const maxScroll = Math.max(
    0,
    document.documentElement.scrollHeight - window.innerHeight,
  );
  const sections = props.items.flatMap((item, index) => {
    const section = document.getElementById(item.id);
    const button = nav.querySelectorAll("button")[index];
    if (!section || !button || !section.getClientRects().length) return [];
    const margin = parseFloat(getComputedStyle(section).scrollMarginTop) || 96;
    return [
      {
        id: item.id,
        button,
        top: Math.max(
          0,
          Math.min(
            maxScroll,
            section.getBoundingClientRect().top + window.scrollY - margin,
          ),
        ),
      },
    ];
  });
  if (!sections.length) {
    indicator.value = { opacity: "0" };
    return;
  }
  const position = Math.max(0, window.scrollY);
  let index = 0;
  for (let i = 1; i < sections.length; i++) {
    if (maxScroll > 0 && position >= sections[i].top) index = i;
  }
  const current = sections[index];
  const next = sections[index + 1] ?? current;
  const distance = next.top - current.top;
  const progress =
    distance > 0
      ? Math.max(0, Math.min(1, (position - current.top) / distance))
      : 0;
  activeId.value = current.id;
  const interpolate = (a: number, b: number) => a + (b - a) * progress;
  indicator.value = {
    opacity: "1",
    transform: `translate(${interpolate(current.button.offsetLeft, next.button.offsetLeft)}px, ${interpolate(current.button.offsetTop, next.button.offsetTop)}px)`,
    width: `${interpolate(current.button.offsetWidth, next.button.offsetWidth)}px`,
    height: `${interpolate(current.button.offsetHeight, next.button.offsetHeight)}px`,
  };
}

function schedule() {
  if (!frame) frame = requestAnimationFrame(update);
}

function navigate(id: string) {
  document.getElementById(id)?.scrollIntoView({
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "instant"
      : "smooth",
  });
}

onMounted(() => {
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule);
  observer = new ResizeObserver(schedule);
  if (navigation.value) observer.observe(navigation.value);
  const workspace = navigation.value
    ?.closest("main")
    ?.querySelector(".admin-workspace");
  if (workspace) {
    observer.observe(workspace);
    for (const child of workspace.children) observer.observe(child);
  }
  schedule();
});
onBeforeUnmount(() => {
  window.removeEventListener("scroll", schedule);
  window.removeEventListener("resize", schedule);
  observer?.disconnect();
  cancelAnimationFrame(frame);
});
</script>

<template>
  <nav ref="navigation" class="section-navigation" aria-label="页面模块">
    <span class="section-indicator" :style="indicator" aria-hidden="true" />
    <button
      v-for="item in items"
      :key="item.id"
      type="button"
      :class="{ 'section-current': activeId === item.id }"
      :aria-current="activeId === item.id ? 'location' : undefined"
      :aria-controls="item.id"
      @click="navigate(item.id)"
    >
      <component :is="item.icon" :size="18" />{{ item.label }}
    </button>
  </nav>
</template>

<style scoped>
.section-navigation {
  position: relative;
  isolation: isolate;
}
.section-indicator {
  position: absolute;
  top: 0;
  left: 0;
  z-index: -1;
  pointer-events: none;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.85);
  box-shadow: 0 9px 20px rgba(16, 19, 23, 0.05);
}
.section-navigation button.section-current,
.section-navigation button:hover {
  color: var(--bubblepilot-text);
  background: transparent;
  box-shadow: none;
}
.section-navigation button:focus-visible {
  outline: 2px solid var(--bubblepilot-text);
  outline-offset: -2px;
}
</style>
