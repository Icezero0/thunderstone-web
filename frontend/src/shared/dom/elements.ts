/** Small DOM helpers shared by card regions and player lists. */
export function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string, id?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag); element.className = className;
  if (text !== undefined) element.textContent = text;
  if (id) element.id = id;
  return element;
}
/** Keep retained nodes in place, preserving focus and pointer state across snapshots. */
export function reconcile(parent: HTMLElement, children: readonly HTMLElement[]): void {
  const present = new Set(children);
  for (const child of Array.from(parent.children)) if (!present.has(child as HTMLElement)) child.remove();
  children.forEach((child, index) => {
    if (parent.children[index] !== child) parent.insertBefore(child, parent.children[index] ?? null);
  });
}
