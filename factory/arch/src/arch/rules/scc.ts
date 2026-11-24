/**
 * Tarjan's strongly connected components, deterministic by construction:
 * nodes and each adjacency list are sorted before traversal, and the returned
 * components are sorted by their first member. Only components with more than
 * one member are returned — a self-loop is not a folder cycle.
 */
export function stronglyConnectedComponents(
  nodes: readonly string[],
  edges: readonly (readonly [string, string])[],
): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const node of [...nodes].sort()) {
    adjacency.set(node, []);
  }
  for (const [from, to] of edges) {
    if (from !== to && adjacency.has(from) && adjacency.has(to)) {
      adjacency.get(from)?.push(to);
    }
  }
  for (const targets of adjacency.values()) {
    targets.sort();
  }

  let nextIndex = 0;
  const indexByNode = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];

  const visit = (node: string): void => {
    indexByNode.set(node, nextIndex);
    lowLink.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);

    for (const target of adjacency.get(node) ?? []) {
      if (!indexByNode.has(target)) {
        visit(target);
        lowLink.set(node, Math.min(lowLink.get(node) ?? 0, lowLink.get(target) ?? 0));
      } else if (onStack.has(target)) {
        lowLink.set(node, Math.min(lowLink.get(node) ?? 0, indexByNode.get(target) ?? 0));
      }
    }

    if (lowLink.get(node) === indexByNode.get(node)) {
      const component: string[] = [];
      let member = "";
      do {
        member = stack.pop() ?? "";
        onStack.delete(member);
        component.push(member);
      } while (member !== node);
      components.push(component.sort());
    }
  };

  for (const node of [...nodes].sort()) {
    if (!indexByNode.has(node)) {
      visit(node);
    }
  }

  return components
    .filter((component) => component.length > 1)
    .sort((left, right) => (left[0] ?? "").localeCompare(right[0] ?? ""));
}

/** The total membership across all multi-member components. */
export function componentMembership(components: readonly (readonly string[])[]): number {
  return components.reduce((total, component) => total + component.length, 0);
}
