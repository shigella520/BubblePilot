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

/** Several short sections may share the same clamped scroll position near the footer. */
export function sectionIndexAtScroll(
  sections: readonly { id: string; top: number }[],
  position: number,
  maxScroll: number,
  trackedAnchor: string,
): number {
  let index = 0;
  for (const [i, section] of sections.entries()) {
    if (i > 0 && maxScroll > 0 && position >= section.top) index = i;
  }
  const anchoredIndex = sections.findIndex(
    (section) => section.id === trackedAnchor,
  );
  const anchored = sections[anchoredIndex];
  const current = sections[index];
  if (
    anchored &&
    current &&
    Math.abs(position - anchored.top) < 1 &&
    Math.abs(current.top - anchored.top) < 1
  ) {
    return anchoredIndex;
  }
  return index;
}
