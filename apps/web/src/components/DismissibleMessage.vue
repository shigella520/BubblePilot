<script setup lang="ts">
import { X } from "@lucide/vue";
import {
  Comment,
  Text,
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  onUpdated,
  ref,
  useSlots,
  type VNode,
} from "vue";
import { diagnosticSeparator } from "../services/api";

const props = defineProps<{
  error?: boolean;
  inline?: boolean;
  /** Keep a success toast until closed (default: auto-dismiss). */
  persistent?: boolean;
}>();
const emit = defineEmits<{ close: [] }>();
/**
 * An open native <dialog> sits in the browser top layer, above anything in
 * <body>. A toast raised while a dialog is open goes into that dialog so it
 * stays visible (it is position: fixed, so it still sits in the corner).
 * The target is chosen after the current render has finished, so a dialog
 * closed by the same action is already gone and is never picked.
 */
const host = ref<string | HTMLElement>("body");
let watchedDialog: HTMLElement | null = null;
function placeHost() {
  void nextTick(() => {
    const open = Array.from(
      document.querySelectorAll<HTMLElement>("dialog[open]"),
    ).at(-1);
    host.value = open && open.isConnected ? open : "body";
    // If that dialog closes while the toast is still showing, move the
    // toast back to the page instead of letting it vanish with the dialog.
    watchedDialog?.removeEventListener("close", placeHost);
    watchedDialog = open ?? null;
    watchedDialog?.addEventListener("close", placeHost);
  });
}
const slots = useSlots();

/** Success toasts close themselves; errors and inline messages stay. */
const autoDismissMs = 5000;
let timer: ReturnType<typeof setTimeout> | undefined;
function schedule() {
  clearTimeout(timer);
  if (props.error || props.inline || props.persistent) return;
  timer = setTimeout(() => emit("close"), autoDismissMs);
}
onMounted(() => {
  schedule();
  placeHost();
});
// Slot text changed (a new message in the same toast): restart the timer
// and re-check which dialog (if any) is open now.
onUpdated(() => {
  schedule();
  placeHost();
});
onBeforeUnmount(() => {
  clearTimeout(timer);
  watchedDialog?.removeEventListener("close", placeHost);
});

/**
 * errorMessage() appends "诊断：CODE · request id" after a separator. Show the
 * readable part prominently and the diagnostics small, selectable and last.
 */
function slotText(nodes: VNode[]): string | null {
  let text = "";
  for (const node of nodes) {
    if (node.type === Comment) continue;
    if (node.type !== Text || typeof node.children !== "string") return null;
    text += node.children;
  }
  return text;
}
const parts = computed(() => {
  const text = slotText(slots.default?.() ?? []);
  if (text === null) return null;
  const index = text.indexOf(diagnosticSeparator);
  return index < 0
    ? { message: text.trim(), diagnostic: "" }
    : {
        message: text.slice(0, index).trim(),
        diagnostic: text.slice(index + diagnosticSeparator.length).trim(),
      };
});
</script>

<template>
  <Teleport :to="host" :disabled="inline">
    <div
      class="form-message"
      :class="{ error, 'inline-message': inline }"
      :role="error ? 'alert' : 'status'"
      :aria-live="error ? 'assertive' : 'polite'"
    >
      <span v-if="parts" class="form-message-content"
        >{{ parts.message
        }}<small v-if="parts.diagnostic" class="form-message-diagnostic"
          >诊断信息：{{ parts.diagnostic }}</small
        ></span
      >
      <span v-else class="form-message-content"><slot /></span>
      <button
        class="form-message-close"
        type="button"
        aria-label="关闭提示"
        title="关闭提示"
        @click="emit('close')"
      >
        <X :size="15" />
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.inline-message {
  position: static;
  transform: none;
  width: auto;
  max-width: none;
  margin: 0 0 1rem;
}
.form-message-diagnostic {
  display: block;
  margin-top: 4px;
  color: var(--bubblepilot-muted);
  font-family: var(--bubblepilot-font-mono);
  font-size: var(--bubblepilot-text-xs);
  user-select: all;
}
</style>
