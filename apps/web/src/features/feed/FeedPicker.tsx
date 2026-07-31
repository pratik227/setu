import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@setu/ui";
import { Check, ChevronDown } from "lucide-react";
import { HOME_FEEDS, type HomeFeedId, homeFeedOption } from "./homeFeeds";

/**
 * Which feed Home is showing.
 *
 * A dropdown rather than a tab strip. Tabs advertise their options permanently,
 * which is right when there are two of equal standing and wrong here: these
 * options differ enormously in what they cost to load, and a tab labelled
 * "Global" sitting one click away invites a reader to open the firehose without
 * knowing that is what they are doing. In a menu each option carries a line
 * saying what it actually fetches.
 *
 * The current selection is in the trigger, so the feed you are reading is always
 * named on screen.
 */

export interface FeedPickerProps {
  value: HomeFeedId;
  onChange(id: HomeFeedId): void;
}

export function FeedPicker({ value, onChange }: FeedPickerProps) {
  const current = homeFeedOption(value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 gap-1 font-semibold data-[state=open]:bg-accent"
        >
          {current.label}
          <ChevronDown className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-64">
        {HOME_FEEDS.map((feed) => (
          <DropdownMenuItem
            key={feed.id}
            onSelect={() => onChange(feed.id)}
            className="items-start gap-2"
          >
            {/* The tick occupies its slot whether or not it is shown, so the
                labels do not shift as the selection moves. */}
            <Check
              aria-hidden
              className={feed.id === value ? "mt-0.5" : "mt-0.5 invisible"}
            />
            <span className="flex min-w-0 flex-col">
              <span className="font-medium">{feed.label}</span>
              <span className="text-xs text-muted-foreground">
                {feed.description}
              </span>
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
