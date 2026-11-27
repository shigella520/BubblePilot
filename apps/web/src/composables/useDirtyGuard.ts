import { onBeforeUnmount, onMounted, type Ref } from "vue";
import { onBeforeRouteLeave } from "vue-router";
import { confirmAction } from "../services/confirm";

/**
 * Warns before unsaved edits are lost: in-app navigation asks through the
 * shared confirm dialog, closing/reloading the tab uses the browser prompt.
 */
export function useDirtyGuard(
  dirty: Ref<boolean> | (() => boolean),
  message = "有尚未保存的修改，离开后将丢弃。",
) {
  const isDirty = () => (typeof dirty === "function" ? dirty() : dirty.value);
  onBeforeRouteLeave(async () => {
    if (!isDirty()) return true;
    return confirmAction(message, {
      title: "离开此页面？",
      confirmText: "放弃修改并离开",
      danger: true,
    });
  });
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (!isDirty()) return;
    event.preventDefault();
    // Legacy browsers require a returnValue to show the prompt.
    event.returnValue = "";
  };
  onMounted(() => window.addEventListener("beforeunload", beforeUnload));
  onBeforeUnmount(() =>
    window.removeEventListener("beforeunload", beforeUnload),
  );
}
