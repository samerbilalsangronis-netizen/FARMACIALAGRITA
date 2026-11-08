import Dexie, { type Table } from "dexie";
import type { Grant, Profile, QueuedSale } from "./domain";

export type Vault = { profile: Profile; grant: Grant; sales: QueuedSale[]; clockOffset: number; lastActivity: number; lastSync: string | null };
type Envelope = { id: string; salt: Uint8Array<ArrayBuffer>; iv: Uint8Array<ArrayBuffer>; cipher: ArrayBuffer; revision: number };
export type VaultSession = { key: CryptoKey; row: Envelope; vault: Vault };

class LocalStore extends Dexie {
  envelopes!: Table<Envelope, string>;
  constructor() {
    super("FarmaciaLaGrita");
    this.version(1).stores({ envelopes: "id" });
  }
}

const db = new LocalStore();
const encode = new TextEncoder();
const decode = new TextDecoder();

async function keyFor(passphrase: string, salt: Uint8Array<ArrayBuffer>) {
  const input = await crypto.subtle.importKey("raw", encode.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 600_000, hash: "SHA-256" }, input,
    { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function unlock(id: string, passphrase: string): Promise<VaultSession> {
  const row = await db.envelopes.get(id);
  if (!row) throw new Error("Este usuario aún debe preparar el dispositivo con internet.");
  const key = await keyFor(passphrase, row.salt);
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: row.iv, additionalData: encode.encode(id) }, key, row.cipher);
    return { key, row, vault: JSON.parse(decode.decode(plain)) };
  } catch {
    throw new Error("La clave del dispositivo es incorrecta.");
  }
}

export async function persist(session: VaultSession, vault: Vault): Promise<VaultSession> {
  const id = session.row.id;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encode.encode(id) }, session.key, encode.encode(JSON.stringify(vault)));
  const row = { ...session.row, iv, cipher, revision: session.row.revision + 1 };
  await db.transaction("rw", db.envelopes, async () => {
    const current = await db.envelopes.get(id);
    if ((current?.revision ?? 0) !== session.row.revision) {
      throw new Error("Otra pestaña modificó el dispositivo. Bloquea y vuelve a abrir para recargar los datos.");
    }
    await db.envelopes.put(row);
  });
  return { key: session.key, row, vault };
}

export async function enroll(profile: Profile, passphrase: string, grant: Grant) {
  if (passphrase.length < 12) throw new Error("Usa una clave del dispositivo de al menos 12 caracteres.");
  const id = profile.username;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await keyFor(passphrase, salt);
  const now = Date.now();
  const vault = { profile, grant, sales: [], clockOffset: Date.parse(grant.issued_at) - now, lastActivity: now, lastSync: null };
  return persist({ key, row: { id, salt, iv: new Uint8Array(), cipher: new ArrayBuffer(0), revision: 0 }, vault }, vault);
}

export async function hasVault(username: string) { return Boolean(await db.envelopes.get(username)); }
export function adjustedNow(vault: Vault) { return Date.now() + vault.clockOffset; }
export function expired(vault: Vault) {
  return Date.now() < vault.lastActivity - 60_000 || adjustedNow(vault) >= Date.parse(vault.grant.expires_at);
}
