/** Reveal a tree row inside its own scroll area without moving the page or reader. */
export function revealTreeRow(container: HTMLElement, row: HTMLElement, preserveHorizontal = false): void {
  const viewport = container.getBoundingClientRect();
  const target = row.getBoundingClientRect();
  const leading = row.querySelector<HTMLElement>('.ki-tree-arrow, .ki-icon, .ki-tree-icon') ?? row;
  const icon = leading.getBoundingClientRect();
  const top = container.scrollTop + target.top - viewport.top
    - (container.clientHeight - target.height) / 2;
  let left = container.scrollLeft;
  // Align the row's leading symbol, rather than its text: long names must not
  // scroll the file icon or directory expander out of view.
  if (!preserveHorizontal) left += icon.left - viewport.left - 16;
  container.scrollTo({ top, left, behavior: 'instant' });
}
