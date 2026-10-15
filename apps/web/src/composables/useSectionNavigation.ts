import {
  onBeforeUnmount,
  onMounted,
  ref,
  computed,
  watch,
  nextTick,
  type Component,
} from "vue";

import { useRoute, useRouter } from "vue-router";

export function useSectionNavigation(props: {
  items: { id: string; label: string; icon: Component }[];
}) {
  const route = useRoute();
  const router = useRouter();
  const navigation = ref<HTMLElement>();
  const activeId = ref("");
  const sectionOrder = ref<string[]>(props.items.map((item) => item.id));
  const orderedItems = computed(() =>
    [...props.items].sort(
      (a, b) =>
        sectionOrder.value.indexOf(a.id) - sectionOrder.value.indexOf(b.id),
    ),
  );
  const indicator = ref<Record<string, string>>({ opacity: "0" });
  let frame = 0;
  let pendingAnchor = "";
  let trackedAnchor = "";
  let observer: ResizeObserver | undefined;
  let mutationObserver: MutationObserver | undefined;

  function update() {
    frame = 0;
    const nav = navigation.value;
    if (!nav) return;
    restoreAnchor();
    const maxScroll = Math.max(
      0,
      document.documentElement.scrollHeight - window.innerHeight,
    );
    const sections = props.items.flatMap((item) => {
      const section = document.getElementById(item.id);
      const button = Array.from(nav.querySelectorAll("button")).find(
        (candidate) => candidate.getAttribute("aria-controls") === item.id,
      );
      if (!section || !button || !section.getClientRects().length) return [];
      const margin =
        parseFloat(getComputedStyle(section).scrollMarginTop) || 96;
      return [
        {
          id: item.id,
          button,
          documentTop: section.getBoundingClientRect().top + window.scrollY,
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
    // Use physical page order before clamping anchors at the scroll boundary.
    sections.sort((a, b) => a.documentTop - b.documentTop);
    const orderedIds = sections.map((section) => section.id);
    const missingIds = props.items
      .filter((item) => !orderedIds.includes(item.id))
      .map((item) => item.id);
    const nextOrder = [...orderedIds, ...missingIds];
    if (nextOrder.join("\0") !== sectionOrder.value.join("\0")) {
      sectionOrder.value = nextOrder;
      // Measure button positions after Vue has applied the new DOM order.
      schedule();
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

  function scrollToSection(id: string, smooth: boolean): boolean {
    const section = document.getElementById(id);
    if (!section?.getClientRects().length) return false;
    section.scrollIntoView({
      block: "start",
      behavior:
        smooth && !window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "smooth"
          : "instant",
    });
    return true;
  }

  function restoreAnchor() {
    if (pendingAnchor && scrollToSection(pendingAnchor, false)) {
      trackedAnchor = pendingAnchor;
      pendingAnchor = "";
    }
  }

  function layoutChanged() {
    // Async panels above the target can grow after the initial navigation.
    // Only re-anchor on layout changes, never on ordinary scroll events.
    if (trackedAnchor) pendingAnchor = trackedAnchor;
    schedule();
  }

  function releaseAnchor() {
    trackedAnchor = "";
    pendingAnchor = "";
  }

  function requestAnchor() {
    releaseAnchor();
    let id: string;
    try {
      id = decodeURIComponent(route.hash.slice(1));
    } catch {
      return;
    }
    pendingAnchor = props.items.some((item) => item.id === id) ? id : "";
    schedule();
  }

  async function navigate(id: string) {
    // Preserve attention/execution filters and avoid adding a history entry for
    // every sidebar click. Re-clicking the active anchor still repositions it.
    await router.replace({ query: route.query, hash: `#${id}` });
    await nextTick();
    pendingAnchor = "";
    trackedAnchor = id;
    scrollToSection(id, true);
  }

  watch(() => route.hash, requestAnchor, { flush: "post" });
  watch(() => props.items, schedule, { deep: true });

  onMounted(() => {
    requestAnchor();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", layoutChanged);
    for (const event of ["wheel", "touchstart", "pointerdown", "keydown"]) {
      window.addEventListener(event, releaseAnchor, { passive: true });
    }
    observer = new ResizeObserver(layoutChanged);
    if (navigation.value) observer.observe(navigation.value);
    const workspace = navigation.value
      ?.closest("main")
      ?.querySelector(".admin-workspace");
    if (workspace) {
      observer.observe(workspace);
      for (const child of workspace.children) observer.observe(child);
      mutationObserver = new MutationObserver(layoutChanged);
      mutationObserver.observe(workspace, { childList: true, subtree: true });
    }
    schedule();
  });
  onBeforeUnmount(() => {
    window.removeEventListener("scroll", schedule);
    window.removeEventListener("resize", layoutChanged);
    for (const event of ["wheel", "touchstart", "pointerdown", "keydown"]) {
      window.removeEventListener(event, releaseAnchor);
    }
    observer?.disconnect();
    mutationObserver?.disconnect();
    cancelAnimationFrame(frame);
  });

  return { navigation, activeId, orderedItems, indicator, navigate };
}
