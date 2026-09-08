import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { ContentContainer } from "@/components/layout/ContentContainer";
import { lookupProjectImport, type ProjectImportItem } from "@/lib/projectImports";
import ImportedProjectDetails from "./ImportedProjectDetails";

export default function ImportedProjectRoute() {
  const params = useParams<{ chainId: string; tokenAddress: string }>();
  const chainId = Number(params.chainId || 0);
  const tokenAddress = String(params.tokenAddress || "").trim();
  const [project, setProject] = useState<ProjectImportItem | null>(null);
  const [done, setDone] = useState(false);
  useEffect(() => {
    let cancelled = false; setDone(false); setProject(null);
    void lookupProjectImport(tokenAddress, chainId).then((item) => { if (!cancelled) setProject(item); }).catch(() => { if (!cancelled) setProject(null); }).finally(() => { if (!cancelled) setDone(true); });
    return () => { cancelled = true; };
  }, [chainId, tokenAddress]);
  if (!done) return <ContentContainer className="flex min-h-[40vh] items-center justify-center"><Loader2 className="h-6 w-6 animate-spin" /></ContentContainer>;
  if (!project) return <ContentContainer className="mwz-hud-frame p-5"><h1 className="font-retro text-lg">IMPORTED PROJECT NOT FOUND</h1></ContentContainer>;
  return <ImportedProjectDetails item={project} />;
}
