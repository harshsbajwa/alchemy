import * as Data from "effect/Data";

export const STATE_ENVELOPE_VERSION = 2 as const;
const GCM_IV_BYTES = 12;
const LEGACY_CTR_BYTES = 16;

export interface StateEncryptionKey {
  id: string;
  keyHex: string;
}

export interface StateEncryptionKeyring {
  current: StateEncryptionKey;
  previous: StateEncryptionKey[];
}

export interface StateEnvelopeContext {
  stack: string;
  stage: string;
  fqn: string;
}

interface StateEnvelopeV2 {
  version: typeof STATE_ENVELOPE_VERSION;
  algorithm: "A256GCM";
  keyId: string;
  iv: string;
  ciphertext: string;
}

export interface DecryptedStateEnvelope {
  value: unknown;
  legacy: boolean;
}

export class StateEnvelopeError extends Data.TaggedError("StateEnvelopeError")<{
  message: string;
  cause?: unknown;
}> {}

const ownedBytes = (
  input: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBuffer> => {
  const output = new Uint8Array(new ArrayBuffer(input.byteLength));
  output.set(input);
  return output;
};

const decodeHexKey = (key: StateEncryptionKey): Uint8Array<ArrayBuffer> => {
  if (!/^[a-f0-9]{64}$/i.test(key.keyHex)) {
    throw new StateEnvelopeError({
      message: `State encryption key '${key.id}' must be 32 bytes encoded as 64 hexadecimal characters.`,
    });
  }
  return ownedBytes(new Uint8Array(Buffer.from(key.keyHex, "hex")));
};

const associatedData = (
  context: StateEnvelopeContext,
): Uint8Array<ArrayBuffer> =>
  ownedBytes(
    new TextEncoder().encode(
      JSON.stringify({
        stack: context.stack,
        stage: context.stage,
        fqn: context.fqn,
      }),
    ),
  );

const encodeBase64 = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64");

const decodeBase64 = (value: string): Uint8Array<ArrayBuffer> =>
  ownedBytes(new Uint8Array(Buffer.from(value, "base64")));

const importGcmKey = (key: StateEncryptionKey) =>
  crypto.subtle.importKey(
    "raw",
    decodeHexKey(key),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );

const importLegacyCtrKey = (key: StateEncryptionKey) =>
  crypto.subtle.importKey(
    "raw",
    decodeHexKey(key),
    { name: "AES-CTR" },
    false,
    ["decrypt"],
  );

export const parseStateEncryptionKeyring = (
  encoded: string,
): StateEncryptionKeyring => {
  try {
    const parsed = JSON.parse(encoded) as Partial<StateEncryptionKeyring>;
    if (
      !parsed.current ||
      typeof parsed.current.id !== "string" ||
      typeof parsed.current.keyHex !== "string" ||
      !Array.isArray(parsed.previous)
    ) {
      throw new Error("missing current key or previous-key array");
    }
    const keys = [parsed.current, ...parsed.previous];
    if (new Set(keys.map((key) => key.id)).size !== keys.length) {
      throw new Error("key IDs must be unique");
    }
    for (const key of keys) decodeHexKey(key);
    return {
      current: parsed.current,
      previous: parsed.previous,
    };
  } catch (cause) {
    if (cause instanceof StateEnvelopeError) throw cause;
    throw new StateEnvelopeError({
      message: "State encryption keyring is invalid.",
      cause,
    });
  }
};

export const encryptStateEnvelope = async (
  value: unknown,
  context: StateEnvelopeContext,
  keyring: StateEncryptionKeyring,
): Promise<string> => {
  try {
    const key = await importGcmKey(keyring.current);
    const iv = crypto.getRandomValues(
      new Uint8Array(new ArrayBuffer(GCM_IV_BYTES)),
    );
    const plaintext = ownedBytes(
      new TextEncoder().encode(JSON.stringify(value)),
    );
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv,
          additionalData: associatedData(context),
          tagLength: 128,
        },
        key,
        plaintext,
      ),
    );
    return JSON.stringify({
      version: STATE_ENVELOPE_VERSION,
      algorithm: "A256GCM",
      keyId: keyring.current.id,
      iv: encodeBase64(iv),
      ciphertext: encodeBase64(ciphertext),
    } satisfies StateEnvelopeV2);
  } catch (cause) {
    if (cause instanceof StateEnvelopeError) throw cause;
    throw new StateEnvelopeError({
      message: "Failed to encrypt state with AES-GCM.",
      cause,
    });
  }
};

const decryptV2 = async (
  envelope: StateEnvelopeV2,
  context: StateEnvelopeContext,
  keyring: StateEncryptionKeyring,
): Promise<unknown> => {
  if (
    envelope.version !== STATE_ENVELOPE_VERSION ||
    envelope.algorithm !== "A256GCM"
  ) {
    throw new StateEnvelopeError({
      message: `Unsupported state envelope version or algorithm: ${envelope.version}/${envelope.algorithm}.`,
    });
  }
  const keyMaterial = [keyring.current, ...keyring.previous].find(
    (key) => key.id === envelope.keyId,
  );
  if (!keyMaterial) {
    throw new StateEnvelopeError({
      message: `State envelope references unavailable key ID '${envelope.keyId}'.`,
    });
  }
  const iv = decodeBase64(envelope.iv);
  if (iv.byteLength !== GCM_IV_BYTES) {
    throw new StateEnvelopeError({
      message: `State envelope IV must be ${GCM_IV_BYTES} bytes.`,
    });
  }
  const key = await importGcmKey(keyMaterial);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: associatedData(context),
      tagLength: 128,
    },
    key,
    decodeBase64(envelope.ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
};

const decryptLegacy = async (
  entry: string,
  keyring: StateEncryptionKeyring,
): Promise<unknown> => {
  const framed = decodeBase64(entry);
  if (framed.byteLength <= LEGACY_CTR_BYTES) {
    throw new StateEnvelopeError({
      message: "Legacy state ciphertext is truncated.",
    });
  }
  const counter = ownedBytes(framed.subarray(0, LEGACY_CTR_BYTES));
  const ciphertext = ownedBytes(framed.subarray(LEGACY_CTR_BYTES));
  let lastCause: unknown;
  for (const candidate of [keyring.current, ...keyring.previous]) {
    try {
      const key = await importLegacyCtrKey(candidate);
      const plaintext = await crypto.subtle.decrypt(
        { name: "AES-CTR", counter, length: 64 },
        key,
        ciphertext,
      );
      return JSON.parse(new TextDecoder().decode(plaintext));
    } catch (cause) {
      lastCause = cause;
    }
  }
  throw new StateEnvelopeError({
    message:
      "Legacy state could not be decrypted with the current or previous keys.",
    cause: lastCause,
  });
};

export const decryptStateEnvelope = async (
  entry: string,
  context: StateEnvelopeContext,
  keyring: StateEncryptionKeyring,
): Promise<DecryptedStateEnvelope> => {
  try {
    if (!entry.trimStart().startsWith("{")) {
      return {
        value: await decryptLegacy(entry, keyring),
        legacy: true,
      };
    }
    const envelope = JSON.parse(entry) as StateEnvelopeV2;
    return {
      value: await decryptV2(envelope, context, keyring),
      legacy: false,
    };
  } catch (cause) {
    if (cause instanceof StateEnvelopeError) throw cause;
    throw new StateEnvelopeError({
      message:
        "State envelope authentication or decoding failed; refusing to treat corrupted state as absent.",
      cause,
    });
  }
};
