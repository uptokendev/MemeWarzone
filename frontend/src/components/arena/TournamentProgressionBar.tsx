import { cn } from "@/lib/utils";

type Node = {
  size: number;
  key: string;
  label: string;
  shortLabel: string;
  complete: boolean;
  current: boolean;
};

export function TournamentProgressionBar({
  nodes,
}: {
  nodes: Node[];
}) {
  if (!Array.isArray(nodes) || !nodes.length) return null;

  return (
    <div data-tournament-progression="true" className="mt-4">
      <div className="flex items-start">
        {nodes.map((node, index) => (
          <div key={`${node.size}-${node.key}`} className="flex min-w-0 flex-1 flex-col items-center">
            <div className="w-full text-center text-[11px] font-black tabular-nums text-white/80">{node.size}</div>
            <div className="relative mt-1 flex h-3 w-full items-center">
              {index > 0 ? (
                <div
                  className={cn(
                    "absolute left-0 right-1/2 h-px",
                    nodes[index - 1]?.complete ? "bg-orange-400" : "bg-white/18",
                  )}
                />
              ) : null}
              {index < nodes.length - 1 ? (
                <div
                  className={cn("absolute left-1/2 right-0 h-px", node.complete ? "bg-orange-400" : "bg-white/18")}
                />
              ) : null}
              <div
                data-tournament-progression-node={node.key}
                data-complete={node.complete ? "true" : undefined}
                data-current={node.current ? "true" : undefined}
                className={cn(
                  "relative z-10 mx-auto h-2.5 w-2.5 rounded-full border",
                  node.complete && "border-orange-400 bg-orange-400",
                  node.current && !node.complete && "border-orange-300 bg-orange-300/80",
                  !node.complete && !node.current && "border-white/30 bg-transparent",
                )}
              />
            </div>
            <div
              className={cn(
                "mt-1 text-center text-[9px] uppercase tracking-[0.12em]",
                node.complete || node.current ? "text-orange-200" : "text-white/35",
              )}
            >
              {node.shortLabel}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
