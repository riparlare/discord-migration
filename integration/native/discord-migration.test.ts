import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import type { DiscordCredentialVault } from './discord-credentials';
const mock = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>(), progress: null as ((event: unknown) => void) | null, discover: vi.fn(), inspect: vi.fn(), scan: vi.fn(), collect: vi.fn(), cancel: vi.fn(), constructed: vi.fn() }));
vi.mock('electron', () => ({ app: { on: vi.fn() }, ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => mock.handlers.set(name, handler) } }));
vi.mock('../../collector.mjs', () => ({
  SourceError: class extends Error { constructor(public status: number) { super(`Discord HTTP ${status}`); } },
  DiscordCollector: class {
    constructor(token: string, options?: { progress?: (event: unknown) => void }) { mock.constructed(token); mock.progress = options?.progress ?? null; }
    discover = mock.discover; inspectGuild = mock.inspect; scan = mock.scan; collect = mock.collect; cancel = mock.cancel;
  },
}));
import { SourceError } from '../../collector.mjs';
import { registerDiscordMigration } from './discord-migration';
const nativeToken = `h.${Buffer.from('{"user_id":2377251932625436672,"typ":"access","exp":4102444800}').toString('base64url')}.s`;
const auth = () => ({ riparlare_access_token: nativeToken, riparlare_api_base_url: 'https://riparlare.com/api/v1' });
const account = { id: '123', username: 'source-user' };
const selection = { channel_ids: [], guild_ids: [], include_media: false, media_types: [], include_voice_text: false, include_dms: false, include_groups: false };
let stop: ReturnType<typeof registerDiscordMigration>;
let event: IpcMainInvokeEvent;
let vault: { available: ReturnType<typeof vi.fn>; read: ReturnType<typeof vi.fn>; save: ReturnType<typeof vi.fn>; forget: ReturnType<typeof vi.fn> };
let currentNativeToken: string | null;
const invoke = (name: string, input?: unknown, sender = event) => mock.handlers.get(`discord-migration:${name}`)!(sender, input);
beforeEach(() => {
  vi.clearAllMocks(); mock.handlers.clear();
  const contents = { mainFrame: {}, isDestroyed: () => false, send: vi.fn() };
  event = { sender: contents, senderFrame: contents.mainFrame } as unknown as IpcMainInvokeEvent;
  const window = { isDestroyed: () => false, webContents: contents } as unknown as BrowserWindow;
  vault = { available: vi.fn(() => true), read: vi.fn(() => ({ token: 'stored-private-source', account })), save: vi.fn(), forget: vi.fn() };
  currentNativeToken = nativeToken;
  mock.discover.mockResolvedValue({ guilds: [], channels: [], warnings: [], account });
  mock.inspect.mockResolvedValue({}); mock.scan.mockResolvedValue({}); mock.collect.mockResolvedValue(new Uint8Array());
  stop = registerDiscordMigration(() => window, { vault: vault as unknown as DiscordCredentialVault, readNativeToken: () => currentNativeToken });
});
afterEach(() => stop());

describe('trusted native remembered-source capability', () => {
  it('returns safe status only to the current main frame and never returns credential plaintext', () => {
    const input = auth();
    expect(invoke('saved-credential-status', input)).toEqual({ available: true, remembered: true, account });
    expect(input.riparlare_access_token).toBeUndefined();
    expect(() => invoke('saved-credential-status', auth(), { ...event, senderFrame: {} } as IpcMainInvokeEvent)).toThrow('restricted');
    expect(() => invoke('saved-credential-status', { ...auth(), riparlare_access_token: 'other-auth' })).toThrow('SOURCE_CREDENTIAL_AUTH_REQUIRED');
  });
  it('keeps legacy manual connect and requires explicit risk/XOR for stored source use', async () => {
    const input = { token: 'manual-source', acceptedRisk: true };
    expect(await invoke('connect', input)).toMatchObject({ account });
    expect(vault.read).not.toHaveBeenCalled(); expect(vault.save).not.toHaveBeenCalled(); expect(input.token).toBeUndefined();
    await expect(invoke('connect', { ...auth(), useSaved: true, token: 'also-manual', acceptedRisk: true })).rejects.toThrow();
    await expect(invoke('connect', { ...auth(), useSaved: true, acceptedRisk: false })).rejects.toThrow();
    expect(mock.constructed).toHaveBeenCalledTimes(1);
  });
  it('resumes without returning plaintext, saves only explicit remember after successful discovery', async () => {
    const saved = { ...auth(), useSaved: true, acceptedRisk: true };
    expect(await invoke('connect', saved)).not.toHaveProperty('token');
    expect(mock.constructed).toHaveBeenCalledWith('stored-private-source'); expect(vault.save).not.toHaveBeenCalled();
    const manual = { ...auth(), token: 'remember-me', remember: true, acceptedRisk: true };
    await invoke('connect', manual);
    expect(vault.save).toHaveBeenCalledWith(expect.objectContaining({ userId: '2377251932625436672' }), 'remember-me', account);
    expect(manual.token).toBeUndefined(); expect(manual.riparlare_access_token).toBeUndefined();
  });
  it('never saves a cancelled/stale discovery and forget disconnects the matching generation', async () => {
    let finish!: (value: unknown) => void;
    mock.discover.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = invoke('connect', { ...auth(), token: 'remember-me', remember: true, acceptedRisk: true });
    invoke('forget-saved-credential', auth());
    finish({ account });
    await expect(pending).rejects.toThrow();
    expect(vault.forget).toHaveBeenCalledTimes(1); expect(vault.save).not.toHaveBeenCalled(); expect(mock.cancel).toHaveBeenCalled();
  });
  it('disconnects a saved source when the native user logs out before collection', async () => {
    await invoke('connect', { ...auth(), useSaved: true, acceptedRisk: true });
    currentNativeToken = null;
    await expect(invoke('scan', selection)).rejects.toThrow('SOURCE_CREDENTIAL_AUTH_REQUIRED');
    expect(mock.scan).not.toHaveBeenCalled(); expect(mock.cancel).toHaveBeenCalled();
    expect(vault.forget).not.toHaveBeenCalled();
  });
  it('binds unremembered manual source with OS crypto unavailable and blocks delayed data after logout', async () => {
    vault.available.mockReturnValue(false);
    const result = await invoke('connect', { token: 'volatile-source-only', acceptedRisk: true, remember: false, ...auth() });
    expect(result).toMatchObject({ account });
    expect(vault.read).not.toHaveBeenCalled(); expect(vault.save).not.toHaveBeenCalled();
    let finish!: (result: unknown) => void;
    mock.scan.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = invoke('scan', selection);
    currentNativeToken = null;
    stop.checkNativeAccount();
    vi.mocked(event.sender.send).mockClear();
    mock.progress?.({ phase: 'messages', messages: 1, media: 0 });
    expect(event.sender.send).not.toHaveBeenCalled();
    finish({ private: 'manual-source-data' });
    await expect(pending).rejects.toThrow('SOURCE_CREDENTIAL_AUTH_REQUIRED');
    expect(vault.forget).not.toHaveBeenCalled();
  });
  it('requires current native auth for manual sessions when credential integration is registered', async () => {
    currentNativeToken = null;
    await expect(invoke('connect', { token: 'volatile-source-only', acceptedRisk: true })).rejects.toThrow('SOURCE_CREDENTIAL_AUTH_REQUIRED');
    expect(mock.constructed).not.toHaveBeenCalled();
  });
  it.each(['scan', 'collect', 'inspect-guild'])('rejects delayed %s results and suppresses late progress after account change', async method => {
    await invoke('connect', { ...auth(), useSaved: true, acceptedRisk: true });
    let finish!: (result: unknown) => void;
    const operation = method === 'scan' ? mock.scan : method === 'collect' ? mock.collect : mock.inspect;
    operation.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = invoke(method, method === 'inspect-guild' ? '123' : selection);
    currentNativeToken = null;
    stop.checkNativeAccount();
    vi.mocked(event.sender.send).mockClear();
    mock.progress?.({ phase: 'messages', messages: 2, media: 0 });
    expect(event.sender.send).not.toHaveBeenCalled();
    finish(method === 'collect' ? new Uint8Array([1,2]) : { private: 'old-source-data' });
    await expect(pending).rejects.toThrow('SOURCE_CREDENTIAL_AUTH_REQUIRED');
    expect(vault.forget).not.toHaveBeenCalled();
  });
  it('allows same-user JWT refresh during a delayed operation without cancelling source generation', async () => {
    await invoke('connect', { ...auth(), useSaved: true, acceptedRisk: true });
    let finish!: (result: unknown) => void;
    mock.scan.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = invoke('scan', selection);
    currentNativeToken = `h.${Buffer.from('{"user_id":2377251932625436672,"typ":"access","exp":4102444801}').toString('base64url')}.refreshed`;
    mock.cancel.mockClear();
    stop.checkNativeAccount();
    mock.progress?.({ phase: 'messages', messages: 2, media: 0 });
    finish({ retained: true });
    await expect(pending).resolves.toEqual({ retained: true });
    expect(mock.cancel).not.toHaveBeenCalled(); expect(event.sender.send).toHaveBeenCalled();
  });
  it.each(['inspect-guild', 'scan', 'collect'])('clears matching ciphertext on source401 during %s', async method => {
    await invoke('connect', { ...auth(), useSaved: true, acceptedRisk: true });
    const target = method === 'inspect-guild' ? mock.inspect : method === 'scan' ? mock.scan : mock.collect;
    target.mockRejectedValueOnce(new SourceError(401));
    await expect(invoke(method, method === 'inspect-guild' ? '123' : selection)).rejects.toThrow('SOURCE_AUTH_FAILED');
    expect(vault.forget).toHaveBeenCalledTimes(1); expect(mock.cancel).toHaveBeenCalled();
  });
  it('clears discovery401 but retains saved ciphertext after429/network errors', async () => {
    for (const failure of [new SourceError(429), new Error('private-untrusted-source-error')]) {
      mock.discover.mockRejectedValueOnce(failure);
      await expect(invoke('connect', { ...auth(), useSaved: true, acceptedRisk: true })).rejects.not.toThrow('private-untrusted-source-error');
      expect(vault.forget).not.toHaveBeenCalled();
    }
    mock.discover.mockRejectedValueOnce(new SourceError(401));
    await expect(invoke('connect', { ...auth(), useSaved: true, acceptedRisk: true })).rejects.toThrow('SOURCE_AUTH_FAILED');
    expect(vault.forget).toHaveBeenCalledTimes(1);
  });
});
