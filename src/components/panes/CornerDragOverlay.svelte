<script lang="ts">
  import type { LayoutNode } from "../../lib/stores/layout.svelte";
  import { computeHandleSegments, findIntersections, type Intersection } from "../../lib/utils/handle-geometry";
  import { beginCornerDrag } from "../../lib/stores/corner-drag.svelte";

  let {
    node,
    containerEl,
  }: {
    node: LayoutNode;
    containerEl: HTMLDivElement | undefined;
  } = $props();

  // Touch all ratios in the tree so $derived tracks them
  function touchRatios(n: LayoutNode): void {
    if (n.type === "split") {
      void n.ratio;
      touchRatios(n.children[0]);
      touchRatios(n.children[1]);
    }
  }

  interface RelativeIntersection {
    relX: number;
    relY: number;
    intersection: Intersection;
  }

  const relativeIntersections: RelativeIntersection[] = $derived.by(() => {
    if (!containerEl || node.type !== "split") return [];
    touchRatios(node);
    const rect = containerEl.getBoundingClientRect();
    const segments = computeHandleSegments(node, rect);
    const inters = findIntersections(segments);
    return inters.map(inter => ({
      relX: inter.x - rect.left,
      relY: inter.y - rect.top,
      intersection: inter,
    }));
  });

  function handleMouseDown(inter: Intersection, e: MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    beginCornerDrag(inter, e);
  }
</script>

{#each relativeIntersections as { relX, relY, intersection }}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="corner-hotspot"
    style="position: absolute; left: calc({relX}px - var(--btn-sm) / 2); top: calc({relY}px - var(--btn-sm) / 2); width: var(--btn-sm); height: var(--btn-sm); z-index: 20; cursor: move;"
    onmousedown={(e) => handleMouseDown(intersection, e)}
  ></div>
{/each}
