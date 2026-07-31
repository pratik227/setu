import { cn } from "@setu/ui";
import { ImageOff } from "lucide-react";
import { useId, useState } from "react";
import { sanitizeImageUrl } from "./markdownUrl";
import type {
  ArticleFormField,
  ArticleFormState,
} from "./useArticleDraftState";

/**
 * The metadata fields around the body: cover image, title, summary, hashtags.
 *
 * Split out of the editor purely to keep both files readable — there is no state
 * here beyond whether the cover image loaded.
 */

const INPUT_CLASS = cn(
  "w-full rounded-lg border border-input/40 bg-background px-3 py-2",
  "text-sm placeholder:text-muted-foreground",
  "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden",
);

/**
 * A labelled field.
 *
 * The label is associated by `htmlFor`/`id` rather than by wrapping the input.
 * Wrapping works in a browser but only when the control is a literal child — with
 * the control arriving through `children` the association is invisible to
 * tooling, and to anyone reading the component, which is how a field ends up
 * unlabelled for a screen reader without anyone noticing.
 */
function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="block">
      <label
        htmlFor={id}
        className="mb-1 block text-xs font-medium text-muted-foreground"
      >
        {label}
      </label>
      {children}
      {hint ? (
        <p
          id={`${id}-hint`}
          className="mt-1 block text-2xs text-muted-foreground"
        >
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Cover preview.
 *
 * Three states, not two: no URL, a URL that loaded, and a URL that did not. The
 * third is the one that matters — an author who pasted a link that 404s or that a
 * host blocks by referrer needs to find out here rather than from a reader, and a
 * silently blank box does not tell them.
 */
function CoverPreview({ url }: { url: string }) {
  const trimmed = url.trim();
  const [failed, setFailed] = useState<string | undefined>(undefined);

  if (trimmed === "") return null;

  const safe = sanitizeImageUrl(trimmed);
  if (safe === undefined) {
    return (
      <p className="mt-2 flex items-center gap-1.5 text-xs text-destructive">
        <ImageOff className="size-3.5 shrink-0" />
        Only http(s) image URLs can be used as a cover.
      </p>
    );
  }

  if (failed === safe) {
    return (
      <div className="mt-2 flex items-center gap-2 rounded-lg border border-dashed border-border bg-muted/30 px-3 py-4">
        <ImageOff className="size-4 shrink-0 text-muted-foreground" />
        <p className="text-xs text-muted-foreground">
          That image did not load. Readers will see the article without a cover.
        </p>
      </div>
    );
  }

  return (
    <img
      // Keyed by URL so a corrected link re-attempts the load; without this the
      // failed state would stick to the new URL too.
      key={safe}
      src={safe}
      alt=""
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(safe)}
      className="mt-2 max-h-40 w-full rounded-lg border border-border/60 object-cover"
    />
  );
}

export interface ArticleEditorFieldsProps {
  form: ArticleFormState;
  onChange(field: ArticleFormField, value: string): void;
  disabled?: boolean;
}

export function ArticleEditorFields({
  form,
  onChange,
  disabled = false,
}: ArticleEditorFieldsProps) {
  // `useId` rather than fixed strings: the editor can share a page with another
  // form, and two elements with one id silently break both labels.
  const base = useId();
  const fieldId = (name: string) => `${base}-${name}`;

  return (
    <div className="space-y-3">
      <Field id={fieldId("title")} label="Title">
        <input
          id={fieldId("title")}
          value={form.title}
          disabled={disabled}
          onChange={(e) => onChange("title", e.target.value)}
          placeholder="What is this article called?"
          className={cn(INPUT_CLASS, "text-base font-semibold")}
        />
      </Field>

      <Field
        id={fieldId("summary")}
        label="Summary"
        hint="Shown in feeds and article lists instead of the opening lines."
      >
        <input
          id={fieldId("summary")}
          aria-describedby={`${fieldId("summary")}-hint`}
          value={form.summary}
          disabled={disabled}
          onChange={(e) => onChange("summary", e.target.value)}
          placeholder="One or two sentences"
          className={INPUT_CLASS}
        />
      </Field>

      <Field id={fieldId("image")} label="Cover image URL">
        <input
          id={fieldId("image")}
          value={form.image}
          disabled={disabled}
          onChange={(e) => onChange("image", e.target.value)}
          placeholder="https://"
          inputMode="url"
          spellCheck={false}
          className={INPUT_CLASS}
        />
        <CoverPreview url={form.image} />
      </Field>

      <Field
        id={fieldId("hashtags")}
        label="Hashtags"
        hint="Separated by spaces or commas. Tags written in the body are added automatically."
      >
        <input
          id={fieldId("hashtags")}
          aria-describedby={`${fieldId("hashtags")}-hint`}
          value={form.hashtags}
          disabled={disabled}
          onChange={(e) => onChange("hashtags", e.target.value)}
          placeholder="#nostr #relays"
          spellCheck={false}
          className={INPUT_CLASS}
        />
      </Field>
    </div>
  );
}
