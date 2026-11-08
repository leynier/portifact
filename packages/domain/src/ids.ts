import { ARTIFACT_ID_ALPHABET, ArtifactId } from "@portifact/contracts";

const ID_LENGTH = 10;

/**
 * Generates a random artifact ID. 32 symbols divide 256 evenly, so taking each byte modulo 32
 * keeps the distribution uniform. Uses the platform CSPRNG.
 */
export function generateArtifactId(
  random: (bytes: Uint8Array<ArrayBuffer>) => void = (b) => crypto.getRandomValues(b),
): string {
  const bytes = new Uint8Array(ID_LENGTH);
  random(bytes);
  let id = "";
  for (const byte of bytes) id += ARTIFACT_ID_ALPHABET[byte % ARTIFACT_ID_ALPHABET.length];
  return id;
}

export function isArtifactId(value: string): boolean {
  return ArtifactId.safeParse(value).success;
}
