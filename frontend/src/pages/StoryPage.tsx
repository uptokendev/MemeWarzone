import { Loader2 } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { StoryPlayer } from "@/components/story/StoryPlayer";
import { useStory } from "@/lib/story/storyApi";

export default function StoryPage() {
  const { chainId, token } = useParams<{ chainId: string; token: string }>();
  const navigate = useNavigate();
  const { story, loading } = useStory(Number(chainId || 0), token || "");

  if (loading) {
    return (
      <div className="flex h-full min-h-[60dvh] w-full items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  if (!story) {
    const back = token ? `/token/${encodeURIComponent(token)}${chainId ? `?chainId=${encodeURIComponent(chainId)}` : ""}` : "/";
    return (
      <div className="flex h-full min-h-[60dvh] w-full flex-col items-center justify-center gap-3 px-4 text-center">
        <p>No story yet for this coin.</p>
        <Link to={back}>Close</Link>
      </div>
    );
  }

  return <StoryPlayer story={story} onClose={() => navigate(story.coin.tokenPath)} />;
}
