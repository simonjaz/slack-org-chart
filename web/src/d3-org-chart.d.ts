// d3-org-chart ships without types. This covers the calls the page makes.
declare module 'd3-org-chart' {
  export interface HierarchyNode<T> {
    id: string;
    data: T & { _expanded?: boolean; _centered?: boolean; _highlighted?: boolean };
    width: number;
    height: number;
    depth: number;
    parent: HierarchyNode<T> | null;
    children?: HierarchyNode<T>[];
  }

  export class OrgChart<T = any> {
    container(el: HTMLElement | string): this;
    data(data: T[]): this;
    data(): T[];
    nodeId(fn: (d: T) => string): this;
    parentNodeId(fn: (d: T) => string | null): this;
    nodeWidth(fn: (d: HierarchyNode<T>) => number): this;
    nodeHeight(fn: (d: HierarchyNode<T>) => number): this;
    childrenMargin(fn: (d: HierarchyNode<T>) => number): this;
    compactMarginBetween(fn: (d: HierarchyNode<T>) => number): this;
    compactMarginPair(fn: (d: HierarchyNode<T>) => number): this;
    siblingsMargin(fn: (d: HierarchyNode<T>) => number): this;
    neighbourMargin(fn: (a: HierarchyNode<T>, b: HierarchyNode<T>) => number): this;
    nodeButtonWidth(fn: (d: HierarchyNode<T>) => number): this;
    nodeButtonX(fn: (d: HierarchyNode<T>) => number): this;
    nodeContent(fn: (d: HierarchyNode<T>) => string): this;
    buttonContent(fn: (args: { node: HierarchyNode<T>; state: unknown }) => string): this;
    linkUpdate(fn: (this: SVGPathElement, d: HierarchyNode<T>) => void): this;
    nodeUpdate(fn: (this: SVGGElement, d: HierarchyNode<T>) => void): this;
    onNodeClick(fn: (node: HierarchyNode<T>) => void): this;
    initialZoom(scale: number): this;
    svgHeight(h: number): this;
    duration(ms: number): this;
    compact(flag: boolean): this;
    render(): this;
    update(node?: unknown): this;
    fit(opts?: { animate?: boolean; nodes?: HierarchyNode<T>[]; scale?: boolean }): this;
    setExpanded(id: string, flag?: boolean): this;
    setCentered(id: string): this;
    setHighlighted(id: string): this;
    clearHighlighting(): this;
    expandAll(): this;
    collapseAll(): this;
    zoomIn(): void;
    zoomOut(): void;
    getChartState(): { allNodes: HierarchyNode<T>[] };
    zoomTreeBounds(args: {
      x0: number;
      x1: number;
      y0: number;
      y1: number;
      params?: { animate?: boolean; scale?: boolean; onCompleted?: () => void };
    }): void;
  }
}
