import { LocalSigner } from "@setu/protocol";

/**
 * Signing in from a BIP-39 recovery phrase (NIP-06).
 *
 * Its own module rather than another branch in `SessionProvider`, for two reasons.
 * The provider was already at the file-size ceiling — but more usefully, the
 * ordering below is the whole substance of the feature and deserves to be readable
 * in one place.
 *
 * ## Validate, then derive. Never the other way round.
 *
 * Derivation does not fail on a mistyped word. It takes whatever words it is given
 * and produces a real, usable, *different* key — so the user signs in successfully,
 * lands on an empty profile, and concludes their account is gone. The BIP-39
 * checksum is the only thing that catches this, and checking it first is what turns
 * a silent wrong-account into "one of these words is mistyped".
 *
 * ## The phrase is never stored
 *
 * What gets persisted is the derived key, encrypted, exactly as an imported `nsec`
 * would be. A seed phrase is strictly more dangerous than the key it produces: it
 * derives *this* account and every other account at every other index, so storing it
 * would put more at risk than the thing being signed into. It exists in memory for
 * the length of this function and nowhere else.
 *
 * The protocol import is dynamic, matching `createIdentity`: key derivation pulls in
 * BIP-39 wordlists and BIP-32, which no session that signs in another way should pay
 * for in its initial bundle.
 */
export async function seedPhraseSignIn(
  phrase: string,
  passphrase: string,
  adopt: (
    signer: LocalSigner,
    material: string,
    passphrase: string,
  ) => Promise<void>,
): Promise<void> {
  if (passphrase.length < 8) {
    throw new Error("passphrase must be at least 8 characters");
  }

  const {
    deriveFromSeedPhrase,
    encodeNsec,
    seedPhraseMessage,
    validateSeedPhrase,
  } = await import("@setu/protocol");

  const problem = validateSeedPhrase(phrase);
  if (problem) throw new Error(seedPhraseMessage(problem));

  const derived = deriveFromSeedPhrase(phrase);
  // Unreachable for a phrase that validated, but `undefined` here would otherwise
  // become a confusing failure three lines down rather than a stated one.
  if (!derived) throw new Error(seedPhraseMessage("bad-checksum"));

  const nsec = encodeNsec(derived.secretKey);
  if (!nsec) throw new Error("could not encode the derived key");

  await adopt(LocalSigner.fromSecretKey(derived.secretKey), nsec, passphrase);
}
