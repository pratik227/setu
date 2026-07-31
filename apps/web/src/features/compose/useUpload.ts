import { useCallback, useState } from "react";
import { useSession } from "../identity/SessionProvider";
import { useDeviceSettings } from "../sync/localSettings";
import { DEFAULT_MEDIA_HOST } from "../sync/settingsDocument";
import { UploadError, type UploadedMedia, uploadMedia } from "./nip96";

/**
 * The default media host.
 *
 * Re-exported rather than defined here: it is a synced preference now, so the
 * default has to be the same constant the sync layer compares against, and the
 * composer's copy ("attachments go to …") reads it from the same place. Two
 * definitions of "the default" is how a device decides it has unsaved settings
 * forever. Uploading is inherently a choice to trust a third party with a file and a
 * signature, which is why the host is stated in the composer's own copy rather than
 * implied.
 */
export { DEFAULT_MEDIA_HOST };

/** Types we offer to upload. GIF is in the list because GIFs are the point. */
export const ACCEPTED_MEDIA =
  "image/png,image/jpeg,image/gif,image/webp,image/avif,video/mp4,video/webm";

/**
 * A host for a message, without trusting it to be a parseable URL.
 *
 * `new URL(host).hostname` throws on a host the user typed badly — and it would
 * throw *inside the error handler*, replacing "could not reach that server" with an
 * unhandled exception during a failed upload.
 *
 * Exported for the same reason it exists. The composer names the host mid-upload,
 * and a settings document written by another device carries `mediaHost` as an
 * unvalidated string, so the bare `new URL()` this replaced was an unhandled throw
 * *during render* — blanking the composer, with the user's text in it, at the moment
 * their file was in flight.
 */
export function hostLabel(host: string): string {
  try {
    return new URL(host).hostname;
  } catch {
    return host;
  }
}

export type UploadState =
  | { readonly status: "idle" }
  | { readonly status: "uploading"; readonly name: string }
  | { readonly status: "error"; readonly message: string };

export interface UploadApi {
  readonly state: UploadState;
  /**
   * The host this hook will actually upload to.
   *
   * Exposed because it is now a preference that can differ from the default and can
   * arrive from another device. A composer that names the built-in default while
   * uploading somewhere else is telling the reader the wrong thing about where their
   * file went, which is the one detail about an upload they cannot verify afterwards.
   */
  readonly host: string;
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
 *
 * With no argument the host comes from the device's settings, which sync carries
 * between devices. Read from the local store rather than the relay document on
 * purpose: an upload must not wait on, or fail because of, a settings fetch.
 */
export function useUpload(host?: string): UploadApi {
  const { session } = useSession();
  const { mediaHost } = useDeviceSettings();
  const target = host ?? mediaHost;
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
          { host: target, file },
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
              : `Could not reach ${hostLabel(target)}. The file was not uploaded.`,
        });
        return undefined;
      }
    },
    [target, session],
  );

  const reset = useCallback(() => setState({ status: "idle" }), []);

  return { state, host: target, upload, reset };
}
