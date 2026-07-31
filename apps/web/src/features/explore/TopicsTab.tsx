import { EmptyState, Skeleton } from "@setu/ui";
import { Hash } from "lucide-react";
import { TopicChips } from "../discover/TopicChips";
import { useTrendingTopics } from "../discover/useTrendingTopics";

export interface TopicsTabProps {
  onOpenHashtag?(tag: string): void;
}

export function TopicsTab({ onOpenHashtag }: TopicsTabProps) {
  const { topics, sampleSize, loading } = useTrendingTopics({
    sampleSize: 500,
    limit: 60,
    subscribe: true,
  });

  if (loading) {
    return (
      <div className="flex flex-wrap gap-1.5 px-4 py-4">
        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
          <Skeleton key={i} className="h-7 w-20 rounded-md" />
        ))}
      </div>
    );
  }

  if (topics.length === 0) {
    return (
      <EmptyState
        icon={<Hash className="size-6" />}
        title="No topics in your local index"
        description={
          sampleSize === 0
            ? "No notes have reached this client, so there is nothing to rank. The relays are either still answering or unreachable."
            : `Read the newest ${sampleSize} notes in your index and none of them carried a hashtag.`
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      <p className="text-xs text-muted-foreground">
        Hashtags in the newest {sampleSize} notes your relays delivered, ordered
        by how many of those notes mention them. This is a count over your local
        index — not what is trending on the network, which no client can know
        without running its own crawler.
      </p>
      <TopicChips topics={topics} onOpenHashtag={onOpenHashtag} scaled />
    </div>
  );
}
