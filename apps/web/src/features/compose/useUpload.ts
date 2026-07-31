import { useCallback, useState } from "react";
import { useSession } from "../identity/SessionProvider";
import { UploadError, type UploadedMedia, uploadMedia } from "./nip96";

/**
 * The media host uploads go to.
 *
 * One default rather than a picker, for now, and named here rather than buried in
 * the call site so Settings has one place to make it configurable. Uploading is
 * inherently a choice to trust a third party with a file and a signature, which is
 * why the host is stated in the composer's own copy rather than implied.
 */
export const DEFAULT_MEDIA_HOST = "https://nostr.build";

/** Types we offer to upload. GIF is in the list because GIFs are the point. */
export const ACCEPTED_MEDIA =
  "image/png,image/jpeg,image/gif,image/webp,image/avif,video/mp4,video/webm";

export type UploadState =
  | { readonly status: "idle" }
  | { readonly status: "uploading"; readonly name: string }
  | { readonly status: "error"; readonly message: string };

export interface UploadApi {
  readonly state: UploadState;
  /** Resolves to the media, or undefined when it failed; `state` holds why. */
  upload(file: File): Promise<UploadedMedia | undefined>;
  reset(): void;
}

/**
 * Upload one file and hand back its URL.
 *
 * Requires a signer: NIP-98 auth means the request carries a signed event, so a
 * read-only session cannot upload. That is surfaced as a message rather than a
 * silent no-op, because "I pressed attach and nothing happened" is the worst
 * possible reading of a permission problem.
 */
export function useUpload(host = DEFAULT_MEDIA_HOST): UploadApi {
  const { session } = useSession();
  const [state, setState] = useState<UploadState>({ status: "idle" });

  const upload = useCallback(
    async (file: File): Promise<UploadedMedia | undefined> => {
      if (!session?.canSign) {
        setState({
          status: "error",
          message: "Uploading needs a signer — unlock or sign in with a key.",
        });
        return undefined;
      }
      setState({ status: "uploading", name: file.name });
      try {
        const media = await uploadMedia(
          { host, file },
          {
            fetch: (...args) => globalThis.fetch(...args),
            sign: (template) => session.signer.signEvent(template),
          },
        );
        setState({ status: "idle" });
        return media;
      } catch (error) {
        setState({
          status: "error",
          // An UploadError already carries a sentence written for a reader; a
          // network failure does not, so it gets one here.
          message:
            error instanceof UploadError
              ? error.message
              : `Could not reach ${new URL(host).hostname}. The file was not uploaded.`,
        });
        return undefined;
      }
    },
    [host, session],
  );

  const reset = useCallback(() => setState({ status: "idle" }), []);

  return { state, upload, reset };
}
