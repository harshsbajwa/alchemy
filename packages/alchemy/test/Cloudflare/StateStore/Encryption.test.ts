import {
  decryptStateEnvelope,
  encryptStateEnvelope,
  parseStateEncryptionKeyring,
  STATE_ENVELOPE_VERSION,
  StateEnvelopeError,
  type StateEncryptionKey,
  type StateEncryptionKeyring,
} from "@/Cloudflare/StateStore/Encryption.ts";
import { describe, expect, it } from "alchemy-test";

const key = (id: string, byte: string): StateEncryptionKey => ({
  id,
  keyHex: byte.repeat(64),
});

const current = key("current", "1");
const previous = key("previous", "2");
const context = {
  stack: "Web",
  stage: "production",
  fqn: "Workers/Main",
};

const legacyEncrypt = async (
  value: unknown,
  material: StateEncryptionKey,
): Promise<string> => {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(Buffer.from(material.keyHex, "hex")),
    { name: "AES-CTR" },
    false,
    ["encrypt"],
  );
  const counter = crypto.getRandomValues(new Uint8Array(16));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-CTR", counter, length: 64 },
      cryptoKey,
      new TextEncoder().encode(JSON.stringify(value)),
    ),
  );
  return Buffer.concat([counter, ciphertext]).toString("base64");
};

describe("Cloudflare state encryption envelopes", () => {
  it("authenticates a versioned AES-GCM envelope and its context", async () => {
    const keyring: StateEncryptionKeyring = { current, previous: [] };
    const encrypted = await encryptStateEnvelope(
      { release: "r-42" },
      context,
      keyring,
    );
    expect(JSON.parse(encrypted)).toMatchObject({
      version: STATE_ENVELOPE_VERSION,
      algorithm: "A256GCM",
      keyId: current.id,
    });
    await expect(
      decryptStateEnvelope(encrypted, context, keyring),
    ).resolves.toEqual({
      value: { release: "r-42" },
      legacy: false,
    });
    await expect(
      decryptStateEnvelope(
        encrypted,
        { ...context, stage: "preview" },
        keyring,
      ),
    ).rejects.toMatchObject({ _tag: "StateEnvelopeError" });
  });

  it("fails closed when authenticated ciphertext is modified", async () => {
    const keyring: StateEncryptionKeyring = { current, previous: [] };
    const envelope = JSON.parse(
      await encryptStateEnvelope({ healthy: true }, context, keyring),
    ) as { ciphertext: string };
    const ciphertext = Buffer.from(envelope.ciphertext, "base64");
    ciphertext[ciphertext.length - 1] ^= 1;
    envelope.ciphertext = ciphertext.toString("base64");
    await expect(
      decryptStateEnvelope(JSON.stringify(envelope), context, keyring),
    ).rejects.toMatchObject({ _tag: "StateEnvelopeError" });
  });

  it("decrypts envelopes with a previous key during rotation", async () => {
    const beforeRotation: StateEncryptionKeyring = {
      current: previous,
      previous: [],
    };
    const encrypted = await encryptStateEnvelope(
      { phase: "before" },
      context,
      beforeRotation,
    );
    await expect(
      decryptStateEnvelope(encrypted, context, {
        current,
        previous: [previous],
      }),
    ).resolves.toEqual({
      value: { phase: "before" },
      legacy: false,
    });
  });

  it("reads the legacy AES-CTR frame and marks it for migration", async () => {
    const encrypted = await legacyEncrypt({ legacy: true }, previous);
    await expect(
      decryptStateEnvelope(encrypted, context, {
        current,
        previous: [previous],
      }),
    ).resolves.toEqual({
      value: { legacy: true },
      legacy: true,
    });
  });

  it("rejects malformed and duplicate keyrings", () => {
    expect(() => parseStateEncryptionKeyring("{}")).toThrow(StateEnvelopeError);
    expect(() =>
      parseStateEncryptionKeyring(
        JSON.stringify({ current, previous: [current] }),
      ),
    ).toThrow(StateEnvelopeError);
  });
});
