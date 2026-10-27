import { app, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { DiscordCollector, SourceError, type CollectorSelection } from '../../collector.mjs';
import https from 'node:https';

// Only fixed codes cross IPC; source bodies, credentials and arbitrary errors do not.
function sourceFailure(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : '';
  const codes: Record<string, string> = {
    'Message count limit reached; choose fewer channels': 'SOURCE_MESSAGE_LIMIT',
    'Local inspection limit reached; choose fewer channels': 'SOURCE_INSPECTION_LIMIT',
    'Archive size limit reached; choose fewer channels': 'SOURCE_ARCHIVE_LIMIT',
    'Archive entry limit reached; choose fewer channels': 'SOURCE_ENTRY_LIMIT',
    'Rescan required to include messages': 'SOURCE_RESCAN_REQUIRED',
    'Source not inspected; choose the source again': 'SOURCE_RESCAN_REQUIRED',
    SOURCE_RESCAN_REQUIRED: 'SOURCE_RESCAN_REQUIRED', SOURCE_TIMEOUT: 'SOURCE_TIMEOUT',
  };
  return new Error(codes[message] ?? fallback);
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
// Credentials never enter userData/secureStore, logs, generic networking IPC,
// or archive bytes. Normal collection stays on-device; separately opted-in
// account verification sends the credential once to the fixed identity endpoint.
export function registerDiscordMigration(getWindow: () => BrowserWindow | null) {
  let collector: DiscordCollector | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let collecting = false;
  const disconnect = () => {
    generation++;
    collector?.cancel(); collector = null;
    collecting = false;
    if (timer) clearTimeout(timer);
  };
  const trusted = (event: IpcMainInvokeEvent) => {
    const window = getWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('Migration is restricted to the application window');
    }
  };
  ipcMain.handle('discord-migration:connect', async (event, input: {token?: unknown; acceptedRisk?: unknown}) => {
    trusted(event);
    disconnect();
    if (input?.acceptedRisk !== true || typeof input.token !== 'string') throw new Error('Accept the account risk before connecting');
    const activeGeneration = generation;
    const current = new DiscordCollector(input.token, { progress: (progress) => {
      if (generation === activeGeneration && !event.sender.isDestroyed()) event.sender.send('discord-migration:progress', progress);
    } });
    input.token = undefined;
    collector = current;
    // Bound idle credentials. An active collection owns its own request timeouts.
    try {
      const inventory = await current.discover();
      if (generation !== activeGeneration) throw new Error('Collection cancelled');
      timer = setTimeout(disconnect, 10 * 60 * 1000);
      return inventory;
    } catch (error) {
      if (generation === activeGeneration) disconnect();
      throw sourceFailure(error, 'Discord listesi alınamadı. Oturumunu ve erişim izinlerini kontrol et.');
    }
  });
  ipcMain.handle('discord-migration:inspect-guild', async (event, guildId: unknown) => {
    trusted(event);
    if (!collector || collecting) throw new Error('Önce Discord hesabını bağla.');
    if (typeof guildId !== 'string' || !/^[1-9]\d{0,19}$/.test(guildId)) throw new Error('Geçersiz sunucu seçimi.');
    const current = collector, activeGeneration = generation;
    collecting = true;
    if (timer) clearTimeout(timer);
    try {
      const result = await current.inspectGuild(guildId);
      if (generation !== activeGeneration) throw new Error('Collection cancelled');
      return result;
    } catch (error) {
      if (error instanceof SourceError && error.status === 401 && generation === activeGeneration) disconnect();
      throw sourceFailure(error, 'Sunucunun kanal listesi alınamadı. Erişimini kontrol edip tekrar dene.');
    } finally {
      if (generation === activeGeneration) { collecting = false; timer = setTimeout(disconnect, 10 * 60 * 1000); }
    }
  });
  ipcMain.handle('discord-migration:collect', async (event, selection: CollectorSelection) => {
    trusted(event);
    if (!collector || collecting) throw new Error('Önce Discord hesabını bağla.');
    validateSelection(selection);
    const activeGeneration = generation, current = collector;
    collecting = true;
    if (timer) clearTimeout(timer);
    let completed = false;
    try {
      const bytes = await current.collect(selection);
      if (generation !== activeGeneration) throw new Error('Collection cancelled');
      completed = true;
      return bytes;
    } catch (error) {
      if (error instanceof SourceError && error.status === 401 && generation === activeGeneration) disconnect();
      throw sourceFailure(error, 'İçerik alınamadı. Daha az kanal seçerek tekrar dene; erişilemeyen içerikler atlanır.');
    } finally {
      if (generation === activeGeneration) {
        if (completed) disconnect();
        else { collecting = false; timer = setTimeout(disconnect, 10 * 60 * 1000); }
      }
    }
  });
  ipcMain.handle('discord-migration:scan', async (event, selection: CollectorSelection) => {
    trusted(event);
    if (!collector || collecting) throw new Error('Önce Discord hesabını bağla.');
    validateSelection(selection);
    collecting = true;
    const current = collector, activeGeneration = generation;
    if (timer) clearTimeout(timer);
    try {
      const result = await current.scan(selection);
      if (generation !== activeGeneration) throw new Error('Collection cancelled');
      return result;
    } catch (error) {
      if (error instanceof SourceError && error.status === 401 && generation === activeGeneration) disconnect();
      throw sourceFailure(error, 'Seçili içerik incelenemedi. Kaynağı yeniden seçerek tekrar dene.');
    } finally {
      if (generation === activeGeneration) { collecting = false; timer = setTimeout(disconnect, 10 * 60 * 1000); }
    }
  });
  ipcMain.handle('discord-migration:verify-account', async (event, input: {riparlare_access_token?: unknown; expected_discord_id?: unknown; accepted_server_verification?: unknown}) => {
    trusted(event);
    if (!collector || collecting || input?.accepted_server_verification !== true || typeof input.riparlare_access_token !== 'string' || typeof input.expected_discord_id !== 'string'
      || input.riparlare_access_token.length > 8192 || !/^[1-9]\d{0,19}$/.test(input.expected_discord_id)) throw new Error('Ayrı hesap doğrulama onayı gerekiyor.');
    const riparlareToken = input.riparlare_access_token, expectedId = input.expected_discord_id;
    input.riparlare_access_token = undefined;
    return collector.verifyWith(async (token, sourceId) => {
      if (sourceId !== expectedId) throw new Error('Discord kaynak hesabı değişti.');
      return verifyAccount(token, riparlareToken, expectedId);
    });
  });
  for (const action of ['cancel', 'disconnect']) {
    ipcMain.handle(`discord-migration:${action}`, (event) => { trusted(event); disconnect(); });
  }
  app.on('before-quit', disconnect);
  return disconnect;
}
