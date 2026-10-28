import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { credentialScope, DiscordCredentialVault } from './discord-credentials';

const folders: string[] = [];
const jwt = (id: string, extra = '') => `header.${Buffer.from(`{"user_id":${id},"typ":"access","exp":4102444800${extra}}`).toString('base64url')}.signature`;
const scope = (id = '2377251932625436672', origin = 'https://riparlare.com/api/v1') => {
  const token = jwt(id);
  return credentialScope({ riparlare_access_token: token, riparlare_api_base_url: origin }, token);
};
function fixture() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'riparlare-vault-test-')); folders.push(folder);
  const filename = path.join(folder, 'discord-credentials.enc.json');
  const key = randomBytes(32);
  const encryption = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (text: string) => {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      const bytes = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
    },
    decryptString: (bytes: Buffer) => {
      const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
    },
  };
  return { filename, encryption, vault: new DiscordCredentialVault(filename, encryption, 'linux') };
}
afterEach(() => { for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true }); });

describe('dedicated Discord credential vault', () => {
  it('persists encrypted bytes across restart and isolates exact int64 users and API origins', () => {
    const { filename, encryption, vault } = fixture();
    const first = scope(), adjacent = scope('2377251932625436673'), otherOrigin = scope(undefined, 'https://other.test/api/v1');
    expect(first.userId).toBe('2377251932625436672'); expect(first.key).not.toBe(adjacent.key);
    vault.save(first, 'source-credential-private-marker', { id: '123', username: 'source-user' });
    const disk = fs.readFileSync(filename, 'utf8');
    expect(disk).not.toContain('source-credential-private-marker'); expect(disk).not.toContain('source-user');
    const restarted = new DiscordCredentialVault(filename, encryption, 'linux');
    expect(restarted.read(first)).toEqual({ token: 'source-credential-private-marker', account: { id: '123', username: 'source-user' } });
    expect(restarted.read(adjacent)).toBeNull(); expect(restarted.read(otherOrigin)).toBeNull();
    if (process.platform !== 'win32') expect(fs.statSync(filename).mode & 0o777).toBe(0o600);
    restarted.save(adjacent, 'other-secret', { id: '124', username: 'other' });
    restarted.forget(first);
    expect(restarted.read(first)).toBeNull(); expect(restarted.read(adjacent)?.token).toBe('other-secret');
  });
  it('fails closed on unavailable OS encryption or Linux plaintext backend', () => {
    const { filename, encryption } = fixture();
    for (const adapter of [{ ...encryption, isEncryptionAvailable: () => false }, { ...encryption, getSelectedStorageBackend: () => 'basic_text' }]) {
      const vault = new DiscordCredentialVault(filename, adapter, 'linux');
      expect(vault.available()).toBe(false);
      expect(() => vault.save(scope(), 'secret', { id: '123', username: 'u' })).toThrow('SOURCE_CREDENTIAL_STORAGE_UNAVAILABLE');
      expect(fs.existsSync(filename)).toBe(false);
    }
  });
  it('returns no credential for corrupt ciphertext and emits only a safe atomic-write failure', () => {
    const { filename, encryption, vault } = fixture();
    fs.writeFileSync(filename, JSON.stringify({ version: 1, entries: { [scope().key]: 'corrupt' } }));
    expect(vault.read(scope())).toBeNull();
    const blocked = new DiscordCredentialVault(path.join(filename, 'not-a-directory'), encryption, 'linux');
    expect(() => blocked.save(scope(), 'private-marker', { id: '123', username: 'u' })).toThrow('SOURCE_CREDENTIAL_STORE_FAILED');
    expect(fs.readdirSync(path.dirname(filename))).toEqual(['discord-credentials.enc.json']);
  });
  it('requires the exact currently stored native JWT and a clean HTTPS API base', () => {
    const token = jwt('2377251932625436672');
    for (const base of ['http://riparlare.com/api/v1', 'https://u:p@riparlare.com/api/v1', 'https://riparlare.com/api/v1?q=x', 'https://riparlare.com/api/v1#x', 'https://riparlare.com/other']) {
      expect(() => credentialScope({ riparlare_access_token: token, riparlare_api_base_url: base }, token)).toThrow('SOURCE_CREDENTIAL_AUTH_REQUIRED');
    }
    expect(() => credentialScope({ riparlare_access_token: token, riparlare_api_base_url: 'https://riparlare.com/api/v1' }, jwt('2377251932625436673'))).toThrow('SOURCE_CREDENTIAL_AUTH_REQUIRED');
    const expired = `h.${Buffer.from('{"user_id":123,"typ":"access","exp":1}').toString('base64url')}.s`;
    expect(() => credentialScope({ riparlare_access_token: expired, riparlare_api_base_url: 'https://riparlare.com/api/v1' }, expired)).toThrow('SOURCE_CREDENTIAL_AUTH_REQUIRED');
  });
});
