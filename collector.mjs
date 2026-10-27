// Public, dependency-free collection engine used by the Riparlare desktop bridge.
// Network requests are read-only and fixed-origin. No credential or real data is persisted.
import https from 'node:https';
import { setTimeout as pause } from 'node:timers/promises';

const API = 'https://discord.com/api/v10';
const MAX_ZIP = 64 * 1024 * 1024;
const MAX_RESPONSE = 8 * 1024 * 1024;
const ROUTE = /^\/(users\/@me(?:\/guilds|\/channels)?|guilds\/\d+(?:\/roles|\/channels|\/threads\/active)?|channels\/\d+(?:\/messages)?)$/;
const TYPES = new Set([0, 1, 2, 3, 5, 10, 11, 12, 13]);
const CDN = new Set(['cdn.discordapp.com', 'media.discordapp.net']);
export const id = (value) => {
  if (typeof value !== 'string' || !/^[1-9]\d{0,19}$/.test(value) || BigInt(value) >= 2n ** 64n) throw new Error('Invalid source identifier');
  return value;
};

function duration(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 3600) throw new Error('Rate limit requires a later retry');
  return Math.ceil(seconds * 1000) + 100;
}

export function request(url, headers, signal, limit, deadlineMs = 30_000) {
  return new Promise((resolve, reject) => {
    let req, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(deadline);
      if (error) reject(error); else resolve(value);
    };
    // Socket inactivity alone does not cover a stalled DNS/TLS connection.
    const deadline = setTimeout(() => {
      finish(new Error('SOURCE_TIMEOUT')); req?.destroy();
    }, deadlineMs);
    try { req = https.get(url, { headers, signal, timeout: deadlineMs }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (data) => {
        size += data.length;
        if (size > limit) {
          finish(new Error('Source response exceeds the size limit')); req.destroy(); return;
        }
        chunks.push(data);
      });
      res.on('end', () => finish(null, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', () => finish(new Error('Source download interrupted')));
      res.on('aborted', () => finish(new Error('Source download interrupted')));
    }); } catch { finish(new Error('Source connection failed')); return; }
    req.on('timeout', () => { finish(new Error('SOURCE_TIMEOUT')); req.destroy(); });
    req.on('error', () => finish(new Error(signal?.aborted ? 'Collection cancelled' : 'Source connection failed')));
  });
}

export class SourceError extends Error {
  constructor(status) { super(`Discord HTTP ${status}`); this.status = status; }
}

export class DiscordCollector {
  #token;
  #request;
  #wait;
  #controller = new AbortController();
  #inventory;
  #snapshots = new Map();
  #active = false;
  #scanned;
  #channels = new Map();
  #lastProgress = { phase: 'discovery', messages: 0, media: 0 };
  #retainAfterCollect;
  constructor(token, { transport = request, sleep = pause, progress = () => {}, retainAfterCollect = false } = {}) {
    if (typeof token !== 'string' || !token || token.length > 4096 || /\s/.test(token)) throw new Error('Invalid credential input');
    this.#token = token;
    this.#request = transport;
    this.#wait = sleep;
    this.progress = progress;
    this.#retainAfterCollect = retainAfterCollect === true;
  }
  cancel() { this.#controller.abort(); this.#token = undefined; this.#scanned = undefined; }
  #report(event) {
    this.#lastProgress = { ...(event.phase === this.#lastProgress.phase ? this.#lastProgress : {}), waiting_ms: 0, ...event };
    this.progress(this.#lastProgress);
  }
  #addChannels(rows, guildId) {
    if (!Array.isArray(rows)) throw new Error('Invalid channel inventory');
    for (const channel of rows) {
      id(channel.id);
      if (!TYPES.has(channel.type) && ![4, 15, 16].includes(channel.type)) continue;
      this.#channels.set(channel.id, { id: channel.id, guild_id: guildId, parent_id: channel.parent_id ?? undefined,
        name: channel.name || channel.recipients?.map((r) => r.global_name || r.username).join(', ') || 'Özel sohbet',
        type: channel.type, position: channel.position ?? 0, message_count: 0, media_count: 0, authors: [], counts_known: false });
    }
  }
  // The desktop host may offer a separate, explicit one-time identity-verification
  // capability. Collection itself never sends credentials to Riparlare.
  async verifyWith(verify) {
    this.#check();
    if (!this.#inventory || this.#active) throw new Error('Discover the account before verifying');
    return verify(this.#token, this.#inventory.account.id);
  }
  #check() { if (this.#controller.signal.aborted || !this.#token) throw new Error('Collection cancelled'); }
  async #sleep(ms) { await this.#wait(ms, undefined, { signal: this.#controller.signal }); this.#check(); }
  async #get(path, params = {}) {
    this.#check();
    if (!ROUTE.test(path)) throw new Error('Unsupported read endpoint');
    const query = new URLSearchParams(params).toString();
    for (let attempt = 0; attempt < 6; attempt++) {
      const result = await this.#request(`${API}${path}${query ? '?' + query : ''}`, {
        Authorization: this.#token, 'User-Agent': 'RiparlareDiscordMigration/0.2 (+https://github.com/riparlare/discord-migration)',
      }, this.#controller.signal, MAX_RESPONSE);
      this.#check();
      // Never follow redirects or include raw server bodies in errors.
      if (result.status === 429) {
        let body; try { body = JSON.parse(result.body.toString('utf8')); } catch { throw new Error('Invalid rate limit response'); }
        const waiting = duration(body.retry_after ?? result.headers['retry-after'] ?? 1);
        this.#report({ ...this.#lastProgress, waiting_ms: waiting });
        await this.#sleep(waiting);
        this.#report({ ...this.#lastProgress, waiting_ms: 0 }); continue;
      }
      if ([500, 502, 503, 504].includes(result.status) && attempt < 5) { await this.#sleep(1000 * 2 ** attempt); continue; }
      if (result.status !== 200) throw new SourceError(result.status);
      let body; try { body = JSON.parse(result.body.toString('utf8')); } catch { throw new Error('Invalid source response'); }
      const waiting = result.headers['x-ratelimit-remaining'] === '0' ? duration(result.headers['x-ratelimit-reset-after'] ?? 1) : 0;
      if (waiting) this.#report({ ...this.#lastProgress, waiting_ms: waiting });
      await this.#sleep(waiting || 350);
      if (waiting) this.#report({ ...this.#lastProgress, waiting_ms: 0 });
      return body;
    }
    throw new Error('Repeated source rate limits; retry later');
  }
  async discover() {
    if (this.#active || this.#inventory) throw new Error('A collection is already active');
    this.#active = true;
    try {
      const me = await this.#get('/users/@me'); id(me.id);
      const guilds = [], warnings = [];
      this.#channels.clear(); this.#snapshots.clear();
      this.#report({ phase: 'discovery', messages: 0, media: 0, guilds_discovered: 0 });
      try { this.#addChannels(await this.#get('/users/@me/channels')); } catch (error) {
        if (!(error instanceof SourceError) || error.status === 401) throw error;
        warnings.push(`Özel sohbet listesi alınamadı (HTTP ${error.status}).`);
      }
      let after;
      for (let page = 0; page < 100; page++) {
        const batch = await this.#get('/users/@me/guilds', { limit: '200', ...(after ? { after } : {}) });
        if (!Array.isArray(batch) || batch.length > 200) throw new Error('Invalid guild inventory');
        if (!batch.length) break;
        for (const guild of batch) {
          id(guild.id);
          if (after && BigInt(guild.id) <= BigInt(after)) throw new Error('Guild pagination did not advance');
          if (this.#snapshots.has(guild.id)) throw new Error('Duplicate source guild');
          this.#snapshots.set(guild.id, { guild, roles: [], channels: [], loaded: false, ownership_verified: false });
          guilds.push({ id: guild.id, name: guild.name, roles: [], channels_loaded: false });
          this.#report({ phase: 'discovery', messages: 0, media: 0, guilds_discovered: guilds.length });
        }
        after = batch.map((g) => g.id).reduce((a, b) => BigInt(a) > BigInt(b) ? a : b);
        if (page === 99) throw new Error('Guild inventory limit reached');
      }
      warnings.push('Liste keşfedilebilen içerikle sınırlıdır; kapalı özel sohbetler ve arşivlenmiş konular eksik olabilir.');
      this.#inventory = { guilds, channels: [...this.#channels.values()], warnings,
        account: { id: me.id, username: me.username || '', display_name: me.global_name || undefined } };
      return this.#inventory;
    } finally { this.#active = false; }
  }
  async inspectGuild(guildId) {
    this.#check(); id(guildId);
    if (!this.#inventory || this.#active) throw new Error('Discover sources before inspecting');
    const snapshot = this.#snapshots.get(guildId);
    if (!snapshot) throw new Error('Unknown source guild');
    if (snapshot.loaded) return this.#inventory;
    this.#active = true;
    this.#report({ phase: 'discovery', guild_id: guildId, guild_name: snapshot.guild.name, messages: 0, media: 0 });
    try {
      let roles = [], threads = [];
      const warn = (part, status) => {
        const value = `${snapshot.guild.name}: ${part} alınamadı (HTTP ${status}); erişilebilen içerik kullanılacak.`;
        if (!this.#inventory.warnings.includes(value)) this.#inventory.warnings.push(value);
      };
      try { roles = await this.#get(`/guilds/${guildId}/roles`); }
      catch (error) { if (!(error instanceof SourceError) || error.status === 401) throw error; warn('rol listesi', error.status); }
      // Optional role access must not prevent reading accessible channels.
      const channels = await this.#get(`/guilds/${guildId}/channels`);
      if (!Array.isArray(roles) || !Array.isArray(channels)) throw new Error('Invalid guild structure');
      try { const active = await this.#get(`/guilds/${guildId}/threads/active`); threads = active.threads ?? []; }
      catch (error) { if (!(error instanceof SourceError) || error.status === 401) throw error; warn('açık başlık listesi', error.status); }
      this.#check();
      if (!Array.isArray(threads)) throw new Error('Invalid source threads');
      this.#addChannels([...channels, ...threads], guildId);
      this.#snapshots.set(guildId, { ...snapshot, roles, channels: [...channels, ...threads], loaded: true });
      this.#inventory.guilds = this.#inventory.guilds.map(guild => guild.id === guildId ? { ...guild, roles, channels_loaded: true } : guild);
      this.#inventory.channels = [...this.#channels.values()];
      return this.#inventory;
    } finally { this.#active = false; }
  }
  #selected(selection) {
    this.#check();
    if (!this.#inventory || this.#active) throw new Error('Discover sources before collecting');
    if (!Array.isArray(selection.channel_ids) || !Array.isArray(selection.guild_ids)) throw new Error('Invalid selection');
    const known = new Map(this.#inventory.channels.map((c) => [c.id, c]));
    const guildIds = new Set(selection.guild_ids.map(id));
    for (const key of guildIds) {
      if (!this.#snapshots.has(key)) throw new Error('Unknown source guild');
      if (!this.#snapshots.get(key).loaded) throw new Error('SOURCE_RESCAN_REQUIRED');
    }
    const selected = [...new Set(selection.channel_ids.map(id))].map((key) => {
      if (!known.has(key)) throw new Error('Unknown source channel'); return known.get(key);
    }).filter((c) => (TYPES.has(c.type) || [4, 15, 16].includes(c.type)) && (!c.guild_id || guildIds.has(c.guild_id)) &&
      (c.type !== 1 || selection.include_dms) && (c.type !== 3 || selection.include_groups));
    return { selected, guildIds };
  }
  async scan(selection) {
    const { selected, guildIds } = this.#selected(selection);
    this.#active = true;
    const records = new Map(), failures = [], states = [], authors = new Map();
    let count = 0, bytes = 0;
    try {
      for (const channel of selected) {
        let cursor, exhausted = false;
        const scanHistory = selection.include_messages !== false && TYPES.has(channel.type) && (![2, 13].includes(channel.type) || selection.include_voice_text);
        // Keep already-listed structure even when channel access was revoked.
        // A failed read is recorded explicitly; it never permits another history read.
        const record = { metadata: { ...(this.#snapshots.get(channel.guild_id)?.channels.find((c) => c.id === channel.id) ?? channel) }, pages: [], scannedHistory: scanHistory };
        records.set(channel.id, record);
        try {
          const structural = [4, 15, 16].includes(channel.type);
          const metadata = structural ? { ...(this.#snapshots.get(channel.guild_id)?.channels.find((c) => c.id === channel.id) ?? channel) } : await this.#get(`/channels/${channel.id}`);
          if (metadata.id !== channel.id) throw new Error('Channel identity changed');
          metadata.name ||= channel.name;
          record.metadata = metadata;
          const pages = record.pages;
          for (let page = 0; scanHistory && page < 1000; page++) {
            const rows = await this.#get(`/channels/${channel.id}/messages`, { limit: '100', ...(cursor ? { before: cursor } : {}) });
            if (!Array.isArray(rows) || rows.length > 100) throw new Error('Invalid message page');
            if (!rows.length) { exhausted = true; break; }
            const seen = new Set();
            for (const message of rows) {
              id(message.id);
              if (message.channel_id !== channel.id || seen.has(message.id) || (cursor && BigInt(message.id) >= BigInt(cursor))) throw new Error('Invalid message pagination');
              seen.add(message.id);
              if (!message.author?.id) throw new Error('Missing source author');
              id(message.author.id);
              const author = authors.get(message.author.id) ?? { id: message.author.id, name: message.author.username || message.author.id,
                display_name: message.author.global_name || undefined, message_count: 0, unclaimed: true };
              author.message_count++; authors.set(author.id, author);
              count++; if (count > 100000) throw new Error('Message count limit reached; choose fewer channels');
            }
            bytes += Buffer.byteLength(JSON.stringify(rows));
            if (bytes > 32 * 1024 * 1024) throw new Error('Local inspection limit reached; choose fewer channels');
            pages.push(rows);
            cursor = rows.map((m) => m.id).reduce((a, b) => BigInt(a) < BigInt(b) ? a : b);
            this.#report({ phase: 'messages', channel_id: channel.id, messages: count, media: 0 });
          }
        } catch (error) {
          if (!(error instanceof SourceError) || error.status === 401) throw error;
          failures.push({ channel_id: channel.id, code: `http_${error.status}` });
        }
        states.push({ id: channel.id, pagination_exhausted: exhausted, history_access_verified: false });
      }
      const included = new Set(selected.map((c) => c.id));
      for (const channel of selected) {
        const seen = new Set(); let parent = channel.parent_id;
        while (parent && !seen.has(parent)) {
          seen.add(parent); included.add(parent); parent = this.#inventory.channels.find((c) => c.id === parent)?.parent_id;
        }
      }
      const channels = this.#inventory.channels.filter((c) => included.has(c.id)).map((c) => {
        if (!records.has(c.id) && [4, 15, 16].includes(c.type)) {
          records.set(c.id, { metadata: { ...(this.#snapshots.get(c.guild_id)?.channels.find((raw) => raw.id === c.id) ?? c) }, pages: [], scannedHistory: false });
        }
        const rows = records.get(c.id)?.pages.flat() ?? [], channelAuthors = new Map();
        for (const message of rows) channelAuthors.set(message.author.id, (channelAuthors.get(message.author.id) ?? 0) + 1);
        return { ...c, message_count: rows.length, media_count: rows.reduce((n, m) => n + (m.attachments?.length ?? 0), 0),
          authors: [...channelAuthors].map(([key, value]) => ({ id: key, count: value })), counts_known: true };
      });
      this.#scanned = { records, failures, states, guildIds, includesMessages: selection.include_messages !== false };
      return { id: 'local-selection', status: 'local', source_hash: 'local',
        account: this.#inventory.account, guilds: this.#inventory.guilds.filter((g) => guildIds.has(g.id)),
        channels, authors: [...authors.values()], warnings: [...this.#inventory.warnings,
          'İçerik yalnızca bu cihazda incelendi; kişi ve içerik seçimlerinden sonra yüklenir.',
          ...failures.map((f) => `${f.channel_id}: ${f.code}`)] };
    } finally { this.#active = false; }
  }
  async collect(selection) {
    if (!this.#scanned) await this.scan(selection);
    const { selected, guildIds } = this.#selected(selection);
    const scanned = this.#scanned;
    if (selection.include_messages !== false && !scanned.includesMessages) throw new Error('Rescan required to include messages');
    for (const c of selected) {
      if (!scanned.records.has(c.id)) throw new Error('Source not inspected; choose the source again');
      if (selection.include_messages !== false && TYPES.has(c.type) && (![2, 13].includes(c.type) || selection.include_voice_text) && !scanned.records.get(c.id).scannedHistory) throw new Error('Rescan required to include messages');
    }
    const excluded = new Set(selection.excluded_author_ids ?? []);
    const after = selection.after ? Date.parse(selection.after) : -Infinity, before = selection.before ? Date.parse(selection.before) : Infinity;
    if (Number.isNaN(after) || Number.isNaN(before) || after >= before) throw new Error('Invalid date range');
    this.#active = true;
    const zip = new StoredZip(MAX_ZIP), failures = [...scanned.failures];
    let count = 0, mediaCount = 0, downloaded = 0, completed = false;
    try {
      const included = new Set(selection.channel_ids);
      for (const c of selected) {
        const seen = new Set(); let parent = c.parent_id;
        while (parent && !seen.has(parent)) { seen.add(parent); included.add(parent); parent = this.#inventory.channels.find((c) => c.id === parent)?.parent_id; }
      }
      for (const guildId of guildIds) {
        const original = this.#snapshots.get(guildId);
        const roleIds = selection.role_ids?.[guildId];
        zip.add(`guilds/${guildId}.json`, JSON.stringify({ ...original,
          // A channel may change between discovery and inspection. Serialize
          // the same inspected snapshot used by its message envelopes.
          channels: original.channels.filter((c) => included.has(c.id)).map(c => scanned.records.get(c.id)?.metadata ?? c),
          roles: selection.include_roles === false ? [] : original.roles.filter((r) => !roleIds || roleIds.includes(r.id)) }));
      }
      for (const channel of selected) {
        const { metadata, pages } = scanned.records.get(channel.id);
        // An empty envelope retains empty DM/group/voice channels in the parser.
        zip.add(`channels/${channel.id}/metadata.json`, JSON.stringify({ channel: metadata, messages: [] }));
        const localExcluded = new Set(selection.channel_excluded_author_ids?.[channel.id] ?? []);
        for (const [page, rows] of pages.entries()) {
          const retained = [];
          for (const raw of rows) {
            const timestamp = Date.parse(raw.timestamp);
            if (selection.include_messages === false || ([2, 13].includes(channel.type) && !selection.include_voice_text) || excluded.has(raw.author.id) || localExcluded.has(raw.author.id) || timestamp < after || timestamp >= before) continue;
            if (!Number.isFinite(timestamp)) throw new Error('Invalid source timestamp');
            // Do not include referenced_message/message_snapshots: they can carry
            // excluded authors' quoted content/media outside the selected message.
            const message = { id: raw.id, channel_id: raw.channel_id, guild_id: raw.guild_id,
              timestamp: raw.timestamp, content: raw.content || '', author: raw.author,
              message_reference: raw.message_reference,
              attachments: selection.include_media ? (raw.attachments ?? []).filter((a) => allowedMedia(a, selection.media_types)).map((a) => ({ ...a })) : [] };
            for (const attachment of message.attachments) {
                try {
                  const url = new URL(attachment.url);
                  if (url.protocol !== 'https:' || !CDN.has(url.hostname) || url.port || url.username || url.password || !url.pathname.startsWith('/attachments/')) throw new Error('Unsupported media origin');
                  if (!Number.isSafeInteger(attachment.size) || attachment.size < 0 || attachment.size > 16 * 1024 * 1024 || downloaded + attachment.size > 32 * 1024 * 1024) throw new Error('Media size limit');
                  // Reserve the entire request allowance first: interrupted and
                  // over-limit transports must still consume the network budget.
                  const allowance = Math.min(attachment.size + 1, 16 * 1024 * 1024, 32 * 1024 * 1024 - downloaded);
                  downloaded += allowance;
                  const result = await this.#request(url.href, { 'User-Agent': 'RiparlareDiscordMigration/0.2' }, this.#controller.signal, allowance);
                  downloaded -= allowance - result.body.length;
                  if (result.status !== 200 || result.body.length !== attachment.size) throw new Error('Media unavailable');
                  const location = `media/${channel.id}/${message.id}/${id(attachment.id)}.bin`;
                  zip.add(location, result.body); attachment.localpath = location; mediaCount++;
                } catch {
                  this.#check(); failures.push({ channel_id: channel.id, message_id: message.id, attachment_id: attachment.id, code: 'media_unavailable_or_limit' });
                }
              this.#report({ phase: 'media', channel_id: channel.id, messages: count, media: mediaCount });
            }
            retained.push(message); count++;
          }
          if (retained.length) zip.add(`channels/${channel.id}/${String(page).padStart(8, '0')}.json`, JSON.stringify({ channel: metadata, messages: retained }));
        }
      }
      this.#report({ phase: 'packing', messages: count, media: mediaCount });
      zip.add('migration-manifest.json', JSON.stringify({ schema: 1, source: 'device_user_token_export',
        account: this.#inventory.account,
        attribution_trusted: false, completeness: 'not_proven', warnings: this.#inventory.warnings,
        requested_channel_ids: selected.map((c) => c.id), channels: scanned.states.filter((s) => included.has(s.id)), failures }));
      const bytes = zip.finish(); completed = true;
      return bytes;
    } finally {
      // A bounded packing error must not discard the inspected history. The host
      // retains it only until idle expiry/cancel, allowing a smaller retry.
      if (completed && !this.#retainAfterCollect) this.cancel();
      this.#active = false;
    }
  }
}

export function allowedMedia(attachment, types = []) {
  const mime = attachment.content_type || '';
  const name = (attachment.filename || '').toLowerCase();
  const type = mime ? (mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'file') :
    /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/.test(name) ? 'image' : /\.(mp4|webm|mov|mkv|avi)$/.test(name) ? 'video' :
    /\.(mp3|wav|ogg|m4a|flac|opus)$/.test(name) ? 'audio' : 'file';
  return Array.isArray(types) && types.includes(type);
}

// A small bounded ZIP writer using STORE entries. Avoids external dependencies
// and compression-bomb ratios for archive normalization. No ZIP64 output.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0;
});
function crc32(bytes) { let crc = 0xffffffff; for (const b of bytes) crc = crcTable[(crc ^ b) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }

export class StoredZip {
  #parts = [];
  #central = [];
  #offset = 0;
  #names = new Set();
  constructor(limit = MAX_ZIP) { this.limit = limit; }
  add(name, input) {
    if (!/^(?:guilds\/[1-9]\d*\.json|channels\/[1-9]\d*\/(?:\d{8}\.json|metadata\.json)|media\/[1-9]\d*\/[1-9]\d*\/[1-9]\d*\.bin|migration-manifest\.json)$/.test(name)) throw new Error('Unsafe archive entry');
    if (this.#names.has(name) || this.#names.size >= 4095) throw new Error('Archive entry limit reached; choose fewer channels');
    const data = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
    const filename = Buffer.from(name, 'utf8');
    const extra = 30 + 46 + filename.length * 2 + data.length;
    if (this.#offset + this.#central.reduce((n, b) => n + b.length, 0) + extra + 22 > this.limit) throw new Error('Archive size limit reached; choose fewer channels');
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt32LE(crc32(data), 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8);
    central.writeUInt32LE(crc32(data), 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(0o100600 * 65536, 38); central.writeUInt32LE(this.#offset, 42);
    this.#parts.push(header, filename, data); this.#central.push(Buffer.concat([central, filename]));
    this.#offset += header.length + filename.length + data.length; this.#names.add(name);
  }
  finish() {
    const directory = Buffer.concat(this.#central), end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(this.#names.size, 8); end.writeUInt16LE(this.#names.size, 10);
    end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(this.#offset, 16);
    return Buffer.concat([...this.#parts, directory, end]);
  }
}
