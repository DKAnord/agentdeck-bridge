import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto";

const X25519_PKCS8_PREFIX = Buffer.from(
  "302e020100300506032b656e04220420",
  "hex",
);
const E2E_INFO = Buffer.from("agentdeck-e2e-v1", "utf8");
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

export interface X25519KeyPair {
  publicKey: string;
  privateKey: string;
}

export interface E2eEnvelope {
  type: "e2e";
  roomId: string;
  sender: string;
  seq: number;
  iv: string;
  ct: string;
}

function decodeB64UrlStrict(value: string, label: string): Buffer {
  if (!value || !B64URL_RE.test(value)) {
    throw new Error(`Invalid base64url encoding for ${label}`);
  }
  return Buffer.from(value, "base64url");
}

export function isValidX25519Key(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 43) return false;
  if (!B64URL_RE.test(value)) return false;
  return Buffer.from(value, "base64url").length === 32;
}

export function generateX25519KeyPair(): X25519KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const pubJwk = publicKey.export({ format: "jwk" });
  const privJwk = privateKey.export({ format: "jwk" });
  if (!pubJwk.x || !privJwk.d) {
    throw new Error("Failed to export generated X25519 JWK");
  }
  return { publicKey: pubJwk.x, privateKey: privJwk.d };
}

export function keyPairFromRawPrivateHex(privHex: string): X25519KeyPair {
  const rawPriv = Buffer.from(privHex, "hex");
  if (rawPriv.length !== 32) {
    throw new Error("X25519 raw private key must be 32 bytes");
  }
  const privObj = createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, rawPriv]),
    format: "der",
    type: "pkcs8",
  });
  const pubObj = createPublicKey(privObj);
  const pubJwk = pubObj.export({ format: "jwk" });
  const privJwk = privObj.export({ format: "jwk" });
  if (!pubJwk.x || !privJwk.d) {
    throw new Error("Failed to derive X25519 JWK pair from raw scalar");
  }
  return { publicKey: pubJwk.x, privateKey: privJwk.d };
}

export function derivePublicKeyFromPrivate(privB64Url: string): string {
  const rawPriv = decodeB64UrlStrict(privB64Url, "privateKey");
  if (rawPriv.length !== 32) {
    throw new Error("X25519 private key must decode to 32 bytes");
  }
  const privObj = createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, rawPriv]),
    format: "der",
    type: "pkcs8",
  });
  const pubJwk = createPublicKey(privObj).export({ format: "jwk" });
  if (!pubJwk.x) throw new Error("Failed to derive X25519 public key");
  return pubJwk.x;
}

export function deriveSharedSecret(
  myPrivB64Url: string,
  peerPubB64Url: string,
  myPubB64Url?: string,
): Buffer {
  if (!isValidX25519Key(myPrivB64Url)) {
    throw new Error("Invalid local X25519 private key");
  }
  if (!isValidX25519Key(peerPubB64Url)) {
    throw new Error("Invalid peer X25519 public key");
  }
  const localPub =
    myPubB64Url && isValidX25519Key(myPubB64Url)
      ? myPubB64Url
      : derivePublicKeyFromPrivate(myPrivB64Url);

  const publicKey = createPublicKey({
    key: { kty: "OKP", crv: "X25519", x: peerPubB64Url },
    format: "jwk",
  });
  const privateKey = createPrivateKey({
    key: { kty: "OKP", crv: "X25519", x: localPub, d: myPrivB64Url },
    format: "jwk",
  });
  const shared = diffieHellman({ privateKey, publicKey });
  if (shared.length !== 32 || shared.every((byte) => byte === 0)) {
    throw new Error("Rejected weak or invalid X25519 shared secret");
  }
  return shared;
}

export function deriveRoomAesKey(shared32: Buffer, roomId: string): Buffer {
  if (shared32.length !== 32) {
    throw new Error("X25519 shared secret must be 32 bytes");
  }
  if (!roomId.trim()) {
    throw new Error("roomId must be non-empty for HKDF salt");
  }
  return Buffer.from(
    hkdfSync("sha256", shared32, Buffer.from(roomId, "utf8"), E2E_INFO, 32),
  );
}

export function deriveSessionAesKey(params: {
  myPrivKey: string;
  peerPubKey: string;
  myPubKey?: string;
  roomId: string;
}): Buffer {
  const shared32 = deriveSharedSecret(
    params.myPrivKey,
    params.peerPubKey,
    params.myPubKey,
  );
  return deriveRoomAesKey(shared32, params.roomId);
}

function buildAad(roomId: string, sender: string, seq: number): Buffer {
  return Buffer.from(`${roomId}:${sender}:${seq}`, "utf8");
}

export function encryptE2eEnvelope(params: {
  aesKey: Buffer;
  roomId: string;
  sender: string;
  seq: number;
  plaintext: string | Buffer;
  iv?: Buffer;
}): E2eEnvelope {
  if (params.aesKey.length !== 32) {
    throw new Error("AES-256-GCM key must be 32 bytes");
  }
  const ivBuf = params.iv ?? randomBytes(GCM_IV_BYTES);
  if (ivBuf.length !== GCM_IV_BYTES) {
    throw new Error("AES-256-GCM IV must be 12 bytes");
  }
  const plainBuf = Buffer.isBuffer(params.plaintext)
    ? params.plaintext
    : Buffer.from(params.plaintext, "utf8");
  const cipher = createCipheriv("aes-256-gcm", params.aesKey, ivBuf);
  cipher.setAAD(buildAad(params.roomId, params.sender, params.seq));
  const encrypted = Buffer.concat([
    cipher.update(plainBuf),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return {
    type: "e2e",
    roomId: params.roomId,
    sender: params.sender,
    seq: params.seq,
    iv: ivBuf.toString("base64url"),
    ct: encrypted.toString("base64url"),
  };
}

export function isE2eEnvelope(value: unknown): value is E2eEnvelope {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return (
    obj.type === "e2e" &&
    typeof obj.roomId === "string" &&
    obj.roomId.length > 0 &&
    typeof obj.sender === "string" &&
    obj.sender.length > 0 &&
    typeof obj.seq === "number" &&
    Number.isInteger(obj.seq) &&
    obj.seq >= 0 &&
    typeof obj.iv === "string" &&
    typeof obj.ct === "string"
  );
}

export function decryptE2eEnvelope(params: {
  aesKey: Buffer;
  envelope: E2eEnvelope;
}): string {
  if (params.aesKey.length !== 32) {
    throw new Error("AES-256-GCM key must be 32 bytes");
  }
  const { envelope } = params;
  if (!isE2eEnvelope(envelope)) {
    throw new Error("Invalid E2E envelope structure");
  }
  const ivBuf = decodeB64UrlStrict(envelope.iv, "iv");
  if (ivBuf.length !== GCM_IV_BYTES) {
    throw new Error("Invalid E2E envelope IV length");
  }
  const ctBuf = decodeB64UrlStrict(envelope.ct, "ct");
  if (ctBuf.length < GCM_TAG_BYTES) {
    throw new Error("Invalid E2E ciphertext length");
  }
  const ciphertext = ctBuf.subarray(0, ctBuf.length - GCM_TAG_BYTES);
  const authTag = ctBuf.subarray(ctBuf.length - GCM_TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", params.aesKey, ivBuf);
  decipher.setAAD(buildAad(envelope.roomId, envelope.sender, envelope.seq));
  decipher.setAuthTag(authTag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.toString("utf8");
}

export const VECTOR_BRIDGE_PRIV_HEX =
  "1011111111111111111111111111111111111111111111111111111111111151";
export const VECTOR_CLIENT_PRIV_HEX =
  "2022222222222222222222222222222222222222222222222222222222222262";
export const VECTOR_ROOM_ID = "room_test_vector_01";
export const VECTOR_SEQ = 1;
export const VECTOR_SENDER = "bridge";
export const VECTOR_IV_HEX = "000102030405060708090a0b";
export const VECTOR_PLAINTEXT = '{"kind":"ping","ok":true}';

const vectorBridgePair = keyPairFromRawPrivateHex(VECTOR_BRIDGE_PRIV_HEX);
const vectorClientPair = keyPairFromRawPrivateHex(VECTOR_CLIENT_PRIV_HEX);
const vectorSharedBuf = deriveSharedSecret(
  vectorBridgePair.privateKey,
  vectorClientPair.publicKey,
  vectorBridgePair.publicKey,
);
const vectorAesBuf = deriveRoomAesKey(vectorSharedBuf, VECTOR_ROOM_ID);
const vectorEnvelope = encryptE2eEnvelope({
  aesKey: vectorAesBuf,
  roomId: VECTOR_ROOM_ID,
  sender: VECTOR_SENDER,
  seq: VECTOR_SEQ,
  plaintext: VECTOR_PLAINTEXT,
  iv: Buffer.from(VECTOR_IV_HEX, "hex"),
});

export const VECTOR_BRIDGE_PUB_B64URL = vectorBridgePair.publicKey;
export const VECTOR_CLIENT_PUB_B64URL = vectorClientPair.publicKey;
export const VECTOR_SHARED_HEX = vectorSharedBuf.toString("hex");
export const VECTOR_AES_HEX = vectorAesBuf.toString("hex");
export const VECTOR_CT_B64URL = vectorEnvelope.ct;
