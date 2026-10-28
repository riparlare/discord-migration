import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import JSONBig from 'json-bigint';

export interface CredentialInput { riparlare_access_token?: unknown; riparlare_api_base_url?: unknown }
export interface SourceAccount { id: string; username: string; display_name?: string }
export interface CredentialScope { key: string; origin: string; userId: string }
interface Encryption {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
const fail = (code: string): never => { throw new Error(code); };
const lossless = JSONBig({ storeAsString: true });

/** The current main-process credential is authoritative; renderer claims alone are not. */
export function credentialScope(input: CredentialInput, currentToken: string | null): CredentialScope {
  if (typeof input?.riparlare_access_token !== 'string' || !currentToken || input.riparlare_access_token !== currentToken || currentToken.length > 8192) return fail('SOURCE_CREDENTIAL_AUTH_REQUIRED');
  let origin: string, userId: string;
  try {
    if (typeof input.riparlare_api_base_url !== 'string') throw new Error();
    const url = new URL(input.riparlare_api_base_url);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !/^\/api\/v1\/?$/.test(url.pathname)) throw new Error();
    origin = `${url.origin}/api/v1`;
    const parts = currentToken.split('.');
    if (parts.length !== 3) throw new Error();
    const claims = lossless.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    userId = String(claims.user_id);
    if (!/^[1-9]\d{0,18}$/.test(userId) || BigInt(userId) > 9223372036854775807n || claims.typ !== 'access' || !Number.isFinite(Number(claims.exp)) || Number(claims.exp) <= Date.now() / 1000) throw new Error();
  } catch { return fail('SOURCE_CREDENTIAL_AUTH_REQUIRED'); }
  return { origin, userId, key: createHash('sha256').update(`${origin}\0${userId}`).digest('hex') };
}

/** Dedicated ciphertext file: deliberately unrelated to generic secure-store IPC. */
export class DiscordCredentialVault {
  constructor(private readonly filename: string, private readonly encryption: Encryption, private readonly platform = process.platform) {}
  available() {
    try { return this.encryption.isEncryptionAvailable() && !(this.platform === 'linux' && this.encryption.getSelectedStorageBackend?.() === 'basic_text'); }
    catch { return false; }
  }
  private requireEncryption() { if (!this.available()) fail('SOURCE_CREDENTIAL_STORAGE_UNAVAILABLE'); }
  private entries(): Record<string, string> {
    try {
      if (fs.statSync(this.filename).size > 1024 * 1024) return {};
      const file = JSON.parse(fs.readFileSync(this.filename, 'utf8'));
      return file?.version === 1 && file.entries && typeof file.entries === 'object' && !Array.isArray(file.entries) ? file.entries : {};
    } catch { return {}; }
  }
  private write(entries: Record<string, string>) {
    const temporary = `${this.filename}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      const serialized = JSON.stringify({ version: 1, entries });
      if (Buffer.byteLength(serialized) > 1024 * 1024) throw new Error();
      fs.mkdirSync(path.dirname(this.filename), { recursive: true, mode: 0o700 });
      fs.writeFileSync(temporary, serialized, { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, this.filename);
      fs.chmodSync(this.filename, 0o600);
    } catch { try { fs.unlinkSync(temporary); } catch { /* No secret error details cross IPC. */ } fail('SOURCE_CREDENTIAL_STORE_FAILED'); }
  }
  read(scope: CredentialScope): { token: string; account: SourceAccount } | null {
    this.requireEncryption();
    try {
      const encrypted = this.entries()[scope.key];
      if (typeof encrypted !== 'string') return null;
      const data = JSON.parse(this.encryption.decryptString(Buffer.from(encrypted, 'base64')));
      if (data.origin !== scope.origin || data.userId !== scope.userId || typeof data.token !== 'string' || !data.token.trim() || data.token.length > 4096 || !/^[1-9]\d{0,19}$/.test(data.account?.id) || typeof data.account?.username !== 'string') return null;
      return { token: data.token, account: { id: data.account.id, username: data.account.username.slice(0, 128), ...(typeof data.account.display_name === 'string' ? { display_name: data.account.display_name.slice(0, 128) } : {}) } };
    } catch { return null; }
  }
  save(scope: CredentialScope, token: string, account: SourceAccount) {
    this.requireEncryption();
    if (!token.trim() || token.length > 4096 || !/^[1-9]\d{0,19}$/.test(account?.id) || typeof account.username !== 'string') fail('SOURCE_CREDENTIAL_STORE_FAILED');
    try {
      const entries = this.entries();
      entries[scope.key] = this.encryption.encryptString(JSON.stringify({ origin: scope.origin, userId: scope.userId, token, account: { id: account.id, username: account.username.slice(0,128), display_name: account.display_name?.slice(0,128) } })).toString('base64');
      this.write(entries);
    } catch { fail('SOURCE_CREDENTIAL_STORE_FAILED'); }
  }
  forget(scope: CredentialScope) {
    const entries = this.entries();
    if (!(scope.key in entries)) return;
    delete entries[scope.key];
    this.write(entries);
  }
}
