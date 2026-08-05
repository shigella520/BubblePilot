import { computed, ref, shallowRef } from "vue";

import type { ApiPage } from "../services/api";

export function useCursorPager<T>(
  fetchPage: (cursor: string | null) => Promise<ApiPage<T[]>>,
) {
  const items = shallowRef<T[]>([]);
  const pageIndex = ref(0);
  const cursors = ref<Array<string | null>>([null]);
  const nextCursor = ref<string | null>(null);
  const busy = ref(false);
  let requestId = 0;

  async function loadAt(
    targetPage: number,
    cursor: string | null,
  ): Promise<boolean> {
    const currentRequest = ++requestId;
    busy.value = true;
    try {
      const result = await fetchPage(cursor);
      if (currentRequest !== requestId) return false;
      items.value = [...result.data];
      pageIndex.value = targetPage;
      cursors.value = cursors.value.slice(0, targetPage + 1);
      cursors.value[targetPage] = cursor;
      nextCursor.value = result.page.nextCursor;
      return true;
    } finally {
      if (currentRequest === requestId) busy.value = false;
    }
  }

  function first(): Promise<boolean> {
    return loadAt(0, null);
  }

  function refresh(): Promise<boolean> {
    return loadAt(pageIndex.value, cursors.value[pageIndex.value] ?? null);
  }

  function next(): Promise<boolean> {
    if (nextCursor.value === null) return Promise.resolve(false);
    return loadAt(pageIndex.value + 1, nextCursor.value);
  }

  function previous(): Promise<boolean> {
    if (pageIndex.value === 0) return Promise.resolve(false);
    const targetPage = pageIndex.value - 1;
    return loadAt(targetPage, cursors.value[targetPage] ?? null);
  }

  function clear() {
    requestId += 1;
    items.value = [];
    pageIndex.value = 0;
    cursors.value = [null];
    nextCursor.value = null;
    busy.value = false;
  }

  return {
    items,
    busy,
    pageNumber: computed(() => pageIndex.value + 1),
    hasPrevious: computed(() => pageIndex.value > 0),
    hasNext: computed(() => nextCursor.value !== null),
    first,
    refresh,
    next,
    previous,
    clear,
  };
}
