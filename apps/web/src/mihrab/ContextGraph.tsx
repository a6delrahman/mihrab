import { useEffect, useMemo } from "react";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type {
  RetrievalTrace,
  SourceNode,
  TraceNode,
} from "../../../../packages/shared/src/mihrab";
import type { Strings } from "./i18n";
import { citationLabel, typeClass } from "./sources";

type CardData = {
  node: TraceNode;
  title: string;
  typeLabel: string;
  selected: boolean;
  cited: boolean;
};
type LaneData = { label: string };

const W = 210,
  GAP_X = 260,
  GAP_Y = 74;
const lane = (n: TraceNode) => (n.type === "Surah" || n.type === "Category" ? 3 : n.hop);

function Card({ data }: NodeProps<Node<CardData>>) {
  const d = data;
  return (
    <div
      className={`mh-gnode ${typeClass(d.node.type)}${d.selected ? " is-selected" : ""}${d.cited ? " is-cited" : ""}`}
      style={{ width: W }}
      title={`${d.title}\n${d.node.id}${d.node.via ? "\nfound by: " + d.node.via.join(", ") : ""}`}
    >
      {(["left", "right"] as const).map((side) => (
        <span key={side}>
          <Handle id={side + "-s"} type="source" position={side === "left" ? Position.Left : Position.Right} />
          <Handle id={side + "-t"} type="target" position={side === "left" ? Position.Left : Position.Right} />
        </span>
      ))}
      <span className="mh-gnode__type">{d.typeLabel}</span>
      <span className="mh-gnode__title">{d.title}</span>
      <code className="mh-gnode__id">{citationLabel(d.node.id)}</code>
    </div>
  );
}
function Lane({ data }: NodeProps<Node<LaneData>>) {
  return <div className="mh-glane">{data.label}</div>;
}
const nodeTypes = { card: Card, lane: Lane };
const EDGE_CLASS: Record<string, string> = {
  EXPLAINS_AYAH: "is-explains",
  CITES_AYAH: "is-cites",
  BELONGS_TO_SURAH: "is-belongs",
  IN_CATEGORY: "is-category",
};

function Graph(props: {
  trace: RetrievalTrace;
  sources: Record<string, SourceNode>;
  cited: Set<string>;
  selected: string | null;
  onSelect: (id: string) => void;
  t: Strings;
}) {
  const { trace, selected } = props;
  const flow = useReactFlow();
  const { nodes, edges } = useMemo(() => {
    const lanes = new Map<number, TraceNode[]>();
    for (const n of trace.nodes) lanes.set(lane(n), [...(lanes.get(lane(n)) || []), n]);
    const order = ["Ayah", "TafsirEntry", "HadeethEncItem", "CanonicalHadith", "Surah", "Category"];
    const pos = new Map<string, { x: number; y: number; lane: number }>();
    const used = [...lanes.keys()].sort((a, b) => a - b);
    const nodes: Node[] = [];
    const laneNames = ["Hop 0 · entry points", "Hop 1 · Tafsir & context", "Hop 2 · cross-references", "Surah & category"];
    used.forEach((l, col) => {
      const list = lanes
        .get(l)!
        .sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type) || (b.score || 0) - (a.score || 0) || a.id.localeCompare(b.id, "en", { numeric: true }));
      nodes.push({
        id: "lane-" + l,
        type: "lane",
        position: { x: col * GAP_X, y: -50 },
        data: { label: laneNames[l] },
        draggable: false,
        selectable: false,
      });
      list.forEach((n, i) => {
        pos.set(n.id, { x: col * GAP_X, y: i * GAP_Y, lane: col });
        nodes.push({
          id: n.id,
          type: "card",
          position: { x: col * GAP_X, y: i * GAP_Y },
          data: {
            node: n,
            title: props.sources[n.id]?.title || n.label,
            typeLabel: props.t.types[n.type],
            selected: selected === n.id,
            cited: props.cited.has(n.id),
          } satisfies CardData,
        });
      });
    });
    const edges: Edge[] = trace.edges
      .filter((e) => pos.has(e.from) && pos.has(e.to))
      .map((e) => {
        const a = pos.get(e.from)!,
          b = pos.get(e.to)!;
        const forward = a.lane <= b.lane;
        const hot = selected === e.from || selected === e.to;
        return {
          id: `${e.from}>${e.to}>${e.type}`,
          source: e.from,
          target: e.to,
          sourceHandle: (forward ? "right" : "left") + "-s",
          targetHandle: (forward ? "left" : "right") + "-t",
          className: `mh-gedge ${EDGE_CLASS[e.type]}${hot ? " is-hot" : ""}${e.coverage === "passage" ? " is-passage" : ""}`,
          label: hot ? e.type + (e.coverage === "passage" ? " (passage)" : "") : undefined,
          animated: hot,
          markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
        };
      });
    return { nodes, edges };
  }, [trace, props.sources, props.cited, selected, props.t]);

  useEffect(() => {
    if (selected && nodes.some((n) => n.id === selected))
      void flow.fitView({ nodes: [{ id: selected }], duration: 450, maxZoom: 1.15 });
  }, [selected]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodeClick={(_, n) => n.type === "card" && props.onSelect(n.id)}
      fitView
      fitViewOptions={{ padding: 0.15 }}
      minZoom={0.2}
      maxZoom={1.6}
      nodesConnectable={false}
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={22} size={1} />
      <Controls showInteractive={false} position="bottom-right" />
    </ReactFlow>
  );
}

export function ContextGraph(props: Parameters<typeof Graph>[0]) {
  return (
    <div className="mh-graph">
      <ReactFlowProvider>
        <Graph {...props} />
      </ReactFlowProvider>
      <div className="mh-graph__legend" aria-hidden>
        {(["Ayah", "TafsirEntry", "HadeethEncItem", "CanonicalHadith", "Category"] as const).map((type) => (
          <span key={type} className={typeClass(type)}>
            <i /> {props.t.types[type]}
          </span>
        ))}
      </div>
    </div>
  );
}
