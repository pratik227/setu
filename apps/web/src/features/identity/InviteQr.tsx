/**
 * A `nostrconnect://` invitation, rendered as a QR code.
 *
 * Shown *alongside* the copyable text, never instead of it. The two cover different
 * setups and neither covers both: a signer on a phone has a camera and no access to
 * this machine's clipboard, so a QR is the only practical way to move a 200-character
 * URI onto it; a signer running on this same desktop has the clipboard and no camera,
 * and a code on screen is useless to it. Dropping either one makes half the
 * installations unable to pair.
 *
 * ## Nothing is fetched
 *
 * The code is generated in-process and handed to the `<img>` as a `data:` URI, which
 * the shipped CSP permits (`img-src 'self' data: blob: https:`, see
 * `apps/desktop/src-tauri/tauri.conf.json`). The usual shortcut — pointing an `<img>`
 * at a QR-rendering web service — would in fact pass that policy, and it is still
 * unacceptable: the URI carries a one-time secret that authorises signing for the
 * account, so putting it in a request to a third party hands them the credential. The
 * CSP is not what rules that out; this is.
 *
 * ## Fixed black on white, whatever the theme
 *
 * The colours are not themed and must not be. A scanner needs near-maximal contrast
 * and a quiet zone, and a code drawn in `--foreground` on `--muted` in dark mode is a
 * code that photographs as unreadable. The white plate around it is part of the code,
 * not decoration.
 */

import { useEffect, useState } from "react";

/**
 * Pixel size of the generated PNG.
 *
 * Rendered at roughly twice its display size so it stays sharp on a high-density
 * screen — a QR resampled up is exactly the kind of soft edge a phone camera fails on.
 */
const RENDER_PX = 480;

/**
 * Generate a QR code for `text` as a `data:` URI, or `undefined` if it will not fit.
 *
 * Returns rather than throws on failure, and the failure is real: QR codes have a hard
 * capacity, and a user who pastes a long list of relays into the invitation form can
 * produce a URI past the largest version. The copyable text still works in that case,
 * so this has to degrade to "no picture" instead of taking the sign-in screen down
 * with an unhandled rejection.
 */
export async function qrDataUri(text: string): Promise<string | undefined> {
  try {
    const module = await import("qrcode");
    /*
     * `qrcode` is CommonJS with a different entry point per platform (a canvas
     * renderer in the browser, pngjs under Node). Bundlers disagree about whether
     * such a module's exports land on the namespace or under `default`, and getting
     * it wrong here would mean a blank space in the browser and a passing test.
     * Checking both is two lines.
     */
    const toDataURL =
      module.toDataURL ??
      (module as { default?: { toDataURL?: typeof module.toDataURL } }).default
        ?.toDataURL;
    if (!toDataURL) return undefined;
    return await toDataURL(text, {
      // `M` over the maximum `H`: the payload is already long, and pushing error
      // correction up costs modules, which makes each one smaller on screen. A code
      // shown on a lit display and photographed from 30cm is not a damaged label.
      errorCorrectionLevel: "M",
      margin: 2,
      width: RENDER_PX,
      color: { dark: "#000000ff", light: "#ffffffff" },
    });
  } catch {
    return undefined;
  }
}

/** The invitation as a scannable code. Renders nothing if it cannot be made. */
export function InviteQr({ uri }: { uri: string }) {
  const [src, setSrc] = useState<string | undefined>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSrc(undefined);
    setFailed(false);
    void qrDataUri(uri).then((data) => {
      if (cancelled) return;
      if (data) setSrc(data);
      else setFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [uri]);

  // Silently absent rather than an error box: the copyable link directly below is a
  // complete way to finish pairing, so a missing picture is not a problem the user
  // has to be told about or can act on.
  if (failed) return null;

  return (
    <div className="flex justify-center">
      <div className="rounded-xl border border-border bg-white p-3">
        {src ? (
          <img
            src={src}
            alt="QR code for this connection link"
            className="block size-56"
          />
        ) : (
          // Reserves the exact space the code will take, so the panel does not jump
          // when it appears.
          <div className="size-56" />
        )}
      </div>
    </div>
  );
}
