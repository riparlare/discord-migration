import { app, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { DiscordCollector, SourceError, type CollectorSelection } from '../../collector.mjs';
import https from 'node:https';
import { DiscordCredentialVault, credentialScope, type CredentialInput, type CredentialScope, type SourceAccount } from './discord-credentials';

// Only fixed codes cross IPC; source bodies, credentials and arbitrary errors do not.
function sourceFailure(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : '';
  const codes: Record<string, string> = {
    SOURCE_CREDENTIAL_STORAGE_UNAVAILABLE: 'SOURCE_CREDENTIAL_STORAGE_UNAVAILABLE',
    SOURCE_SAVED_CREDENTIAL_UNAVAILABLE: 'SOURCE_SAVED_CREDENTIAL_UNAVAILABLE',
    SOURCE_CREDENTIAL_AUTH_REQUIRED: 'SOURCE_CREDENTIAL_AUTH_REQUIRED',
    SOURCE_CREDENTIAL_STORE_FAILED: 'SOURCE_CREDENTIAL_STORE_FAILED',
    SOURCE_AUTH_FAILED: 'SOURCE_AUTH_FAILED',
    'Message count limit reached; choose fewer channels': 'SOURCE_MESSAGE_LIMIT',
    'Local inspection limit reached; choose fewer channels': 'SOURCE_INSPECTION_LIMIT',
    'Archive size limit reached; choose fewer channels': 'SOURCE_ARCHIVE_LIMIT',
    'Archive entry limit reached; choose fewer channels': 'SOURCE_ENTRY_LIMIT',
    'Rescan required to include messages': 'SOURCE_RESCAN_REQUIRED',
    'Source not inspected; choose the source again': 'SOURCE_RESCAN_REQUIRED',
    SOURCE_RESCAN_REQUIRED: 'SOURCE_RESCAN_REQUIRED', SOURCE_TIMEOUT: 'SOURCE_TIMEOUT',
  };
  return new Error(error instanceof SourceError && error.status === 401 ? 'SOURCE_AUTH_FAILED' : codes[message] ?? fallback);
}
function validateSelection(selection: CollectorSelection) {
  if (!selection || !Array.isArray(selection.channel_ids) || !Array.isArray(selection.guild_ids)) throw new Error('Geçersiz seçim.');
  if (selection.channel_ids.length > 3000) throw new Error('SOURCE_CHANNEL_LIMIT');
  if (selection.guild_ids.length > 2000) throw new Error('SOURCE_GUILD_LIMIT');
}

function verifyAccount(token: string, riparlareToken: string, expectedId: string) {
  return new Promise<unknown>((resolve, reject) => {
    const body = JSON.stringify({ discord_token: token, expected_discord_id: expectedId });
    const req = https.request('https://riparlare.com/api/v1/discord-identity/verify', {
      method: 'POST', timeout: 15_000,
      headers: { Authorization: `Bearer ${riparlareToken}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      const chunks: Buffer[] = []; let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 64 * 1024) { req.destroy(); reject(new Error('Hesap doğrulaması yanıt sınırını aştı.')); }
        else chunks.push(chunk);
      });
      res.on('end', () => {
        if (res.statusCode !== 200) { reject(new Error(res.statusCode === 409 ? 'Bu Discord hesabı başka bir Riparlare hesabına bağlı.' : 'Discord hesabı doğrulanamadı; aktarım bağımsız devam edebilir.')); return; }
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (result.discord_id !== expectedId || result.linked !== true) throw new Error();
          resolve({ discord_id: result.discord_id, username: result.username, linked: true });
        } catch { reject(new Error('Hesap doğrulaması geçersiz yanıt verdi.')); }
      });
      res.on('error', () => reject(new Error('Hesap doğrulaması kesildi.')));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => reject(new Error('Hesap doğrulama sunucusuna ulaşılamadı.')));
    req.end(body);
  });
}

// This capability is available only to the bundled top-level app renderer.
// Remembered credentials use a dedicated OS-encrypted vault, never generic
// secureStore/networking IPC, logs or archive bytes. Normal collection stays on-device; separately opted-in
// account verification sends the credential once to the fixed identity endpoint.
export function registerDiscordMigration(getWindow: () => BrowserWindow | null, credentials?: { vault: DiscordCredentialVault; readNativeToken: () => string | null }) {
  let collector: DiscordCollector | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let collecting = false;
  let activeScope: CredentialScope | null = null;
  const disconnect = () => {
    generation++;
    collector?.cancel(); collector = null;
    collecting = false;
    activeScope = null;
    if (timer) clearTimeout(timer);
  };
  const scopeFor = (input: CredentialInput) => {
    if (!credentials) throw new Error('SOURCE_CREDENTIAL_STORAGE_UNAVAILABLE');
    return credentialScope(input, credentials.readNativeToken());
  };
  const expireUnauthorized = (error: unknown, activeGeneration: number) => {
    if (error instanceof SourceError && error.status === 401 && generation === activeGeneration) {
      try { if (activeScope) credentials?.vault.forget(activeScope); }
      finally { disconnect(); }
    }
  };
  const checkResultScope = (expectedGeneration: number, expectedScope: CredentialScope | null) => {
    if (expectedScope) {
      const token = credentials?.readNativeToken() ?? null;
      try {
        if (credentialScope({ riparlare_access_token: token, riparlare_api_base_url: expectedScope.origin }, token).key !== expectedScope.key) throw new Error();
      } catch {
        if (generation === expectedGeneration) disconnect();
        throw new Error('SOURCE_CREDENTIAL_AUTH_REQUIRED');
      }
    }
    if (generation !== expectedGeneration) throw new Error('Collection cancelled');
  };
  const requireCollectorScope = () => {
    if (!activeScope) return;
    const token = credentials?.readNativeToken() ?? null;
    try {
      if (credentialScope({ riparlare_access_token: token, riparlare_api_base_url: activeScope.origin }, token).key !== activeScope.key) throw new Error();
    } catch { disconnect(); throw new Error('SOURCE_CREDENTIAL_AUTH_REQUIRED'); }
  };
  const checkFailedScope = (expectedGeneration: number, expectedScope: CredentialScope | null) => {
    try { checkResultScope(expectedGeneration, expectedScope); }
    catch (error) { if (error instanceof Error && error.message === 'SOURCE_CREDENTIAL_AUTH_REQUIRED') throw error; }
  };
  ipcMain.handle('discord-migration:saved-credential-status', (event, input: CredentialInput) => {
    trusted(event);
    try {
      const scope = scopeFor(input);
      if (!credentials!.vault.available()) return { available: false, remembered: false };
      const saved = credentials!.vault.read(scope);
      return { available: true, remembered: !!saved, ...(saved ? { account: saved.account } : {}) };
    } finally { if (input) input.riparlare_access_token = undefined; }
  });
  ipcMain.handle('discord-migration:forget-saved-credential', (event, input: CredentialInput) => {
    trusted(event);
    try {
      const scope = scopeFor(input);
      credentials!.vault.forget(scope);
      if (activeScope?.key === scope.key) disconnect();
    } finally { if (input) input.riparlare_access_token = undefined; }
  });
  const trusted = (event: IpcMainInvokeEvent) => {
    const window = getWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('Migration is restricted to the application window');
    }
  };
  ipcMain.handle('discord-migration:connect', async (event, input: CredentialInput & {token?: unknown; useSaved?: unknown; remember?: unknown; acceptedRisk?: unknown}) => {
    trusted(event);
    disconnect();
    const activeGeneration = generation;
    let sourceToken = '';
    let connectionScope: CredentialScope | null = null;
    try {
      if (input?.acceptedRisk !== true || (typeof input.token === 'string') === (input.useSaved === true) || (input.useSaved !== undefined && input.useSaved !== true) || (input.remember !== undefined && typeof input.remember !== 'boolean')) throw new Error('Accept the account risk before connecting');
      if (input.useSaved === true || input.remember === true) {
        activeScope = scopeFor(input);
        if (!credentials!.vault.available()) throw new Error('SOURCE_CREDENTIAL_STORAGE_UNAVAILABLE');
      } else if (credentials) {
        // Legacy token+risk callers bind to the primary app account without
        // requiring source-credential persistence or OS encryption.
        const nativeToken = credentials.readNativeToken();
        activeScope = credentialScope({
          riparlare_access_token: input.riparlare_access_token ?? nativeToken,
          riparlare_api_base_url: input.riparlare_api_base_url ?? 'https://riparlare.com/api/v1',
        }, nativeToken);
      }
      if (input.useSaved === true) {
        const saved = credentials!.vault.read(activeScope!);
        if (!saved) throw new Error('SOURCE_SAVED_CREDENTIAL_UNAVAILABLE');
        sourceToken = saved.token;
      } else sourceToken = typeof input.token === 'string' ? input.token.trim() : '';
      if (!sourceToken || sourceToken.length > 4096) throw new Error('SOURCE_AUTH_FAILED');
      input.token = undefined;
      connectionScope = activeScope;
      const current = new DiscordCollector(sourceToken, { retainAfterCollect: true, progress: (progress) => {
        try { checkResultScope(activeGeneration, connectionScope); } catch { return; }
        if (generation === activeGeneration && !event.sender.isDestroyed()) event.sender.send('discord-migration:progress', progress);
      } });
      collector = current;
      const inventory = await current.discover();
      checkResultScope(activeGeneration, connectionScope);
      if (input.remember === true && activeScope) {
        const account = (inventory as { account?: SourceAccount })?.account;
        if (!account) throw new Error('SOURCE_CREDENTIAL_STORE_FAILED');
        credentials!.vault.save(activeScope, sourceToken, account);
      }
      timer = setTimeout(disconnect, 10 * 60 * 1000);
      return inventory;
    } catch (error) {
      checkFailedScope(activeGeneration, connectionScope);
      expireUnauthorized(error, activeGeneration);
      if (generation === activeGeneration) disconnect();
      throw sourceFailure(error, 'Discord listesi alınamadı. Oturumunu ve erişim izinlerini kontrol et.');
    } finally {
      sourceToken = '';
      if (input) { input.token = undefined; input.riparlare_access_token = undefined; }
    }
  });
  ipcMain.handle('discord-migration:inspect-guild', async (event, guildId: unknown) => {
    trusted(event);
    requireCollectorScope();
    if (!collector || collecting) throw new Error('Önce Discord hesabını bağla.');
    if (typeof guildId !== 'string' || !/^[1-9]\d{0,19}$/.test(guildId)) throw new Error('Geçersiz sunucu seçimi.');
    const current = collector, activeGeneration = generation, expectedScope = activeScope;
    collecting = true;
    if (timer) clearTimeout(timer);
    try {
      const result = await current.inspectGuild(guildId);
      checkResultScope(activeGeneration, expectedScope);
      return result;
    } catch (error) {
      checkFailedScope(activeGeneration, expectedScope);
      expireUnauthorized(error, activeGeneration);
      throw sourceFailure(error, 'Sunucunun kanal listesi alınamadı. Erişimini kontrol edip tekrar dene.');
    } finally {
      if (generation === activeGeneration) { collecting = false; timer = setTimeout(disconnect, 10 * 60 * 1000); }
    }
  });
  ipcMain.handle('discord-migration:collect', async (event, selection: CollectorSelection) => {
    trusted(event);
    requireCollectorScope();
    if (!collector || collecting) throw new Error('Önce Discord hesabını bağla.');
    validateSelection(selection);
    const activeGeneration = generation, current = collector, expectedScope = activeScope;
    collecting = true;
    if (timer) clearTimeout(timer);
    try {
      const bytes = await current.collect(selection);
      checkResultScope(activeGeneration, expectedScope);
      return bytes;
    } catch (error) {
      checkFailedScope(activeGeneration, expectedScope);
      expireUnauthorized(error, activeGeneration);
      throw sourceFailure(error, 'İçerik alınamadı. Daha az kanal seçerek tekrar dene; erişilemeyen içerikler atlanır.');
    } finally {
      if (generation === activeGeneration) {
        // Renderer releases this source after upload acknowledgement. A failed
        // upload can reuse/re-filter inspected data until idle expiry/cancel.
        collecting = false; timer = setTimeout(disconnect, 10 * 60 * 1000);
      }
    }
  });
  ipcMain.handle('discord-migration:scan', async (event, selection: CollectorSelection) => {
    trusted(event);
    requireCollectorScope();
    if (!collector || collecting) throw new Error('Önce Discord hesabını bağla.');
    validateSelection(selection);
    collecting = true;
    const current = collector, activeGeneration = generation, expectedScope = activeScope;
    if (timer) clearTimeout(timer);
    try {
      const result = await current.scan(selection);
      checkResultScope(activeGeneration, expectedScope);
      return result;
    } catch (error) {
      checkFailedScope(activeGeneration, expectedScope);
      expireUnauthorized(error, activeGeneration);
      throw sourceFailure(error, 'Seçili içerik incelenemedi. Kaynağı yeniden seçerek tekrar dene.');
    } finally {
      if (generation === activeGeneration) { collecting = false; timer = setTimeout(disconnect, 10 * 60 * 1000); }
    }
  });
  ipcMain.handle('discord-migration:verify-account', async (event, input: {riparlare_access_token?: unknown; expected_discord_id?: unknown; accepted_server_verification?: unknown}) => {
    trusted(event);
    requireCollectorScope();
    if (!collector || collecting || input?.accepted_server_verification !== true || typeof input.riparlare_access_token !== 'string' || typeof input.expected_discord_id !== 'string'
      || input.riparlare_access_token.length > 8192 || !/^[1-9]\d{0,19}$/.test(input.expected_discord_id)) throw new Error('Ayrı hesap doğrulama onayı gerekiyor.');
    const riparlareToken = input.riparlare_access_token, expectedId = input.expected_discord_id;
    input.riparlare_access_token = undefined;
    const activeGeneration = generation, expectedScope = activeScope;
    try {
      const result = await collector.verifyWith(async (token, sourceId) => {
        checkResultScope(activeGeneration, expectedScope);
        if (sourceId !== expectedId) throw new Error('Discord kaynak hesabı değişti.');
        return verifyAccount(token, riparlareToken, expectedId);
      });
      checkResultScope(activeGeneration, expectedScope);
      return result;
    } catch (error) { checkFailedScope(activeGeneration, expectedScope); throw error; }
  });
  for (const action of ['cancel', 'disconnect']) {
    ipcMain.handle(`discord-migration:${action}`, (event) => { trusted(event); disconnect(); });
  }
  app.on('before-quit', disconnect);
  return Object.assign(disconnect, { checkNativeAccount: () => { try { requireCollectorScope(); } catch { /* Cancel immediately; in-flight result reports the fixed scope error. */ } } });
}
