/** Query-only updates (filters, paging, detail links) should not reset the page. */
export function pageScrollPosition(
  to: { path: string; hash: string },
  from: { path: string },
  saved: { left: number; top: number } | null,
): { left: number; top: number } | false {
  if (saved) return saved;
  // SectionNavigation owns section anchors, including targets rendered later.
  if (to.hash || to.path === from.path) return false;
  return { left: 0, top: 0 };
}
