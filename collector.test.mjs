import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { DiscordCollector, SourceError, StoredZip, allowedMedia, id, request } from './collector.mjs';

const result = (body, status = 200, headers = {}) => ({ status, headers, body: Buffer.from(JSON.stringify(body)) });
function source(overrides = {}) {
  const calls = [], waits = [];
  const routes = {
    '/users/@me': { id: '11' }, '/users/@me/channels': [],
    '/users/@me/guilds?limit=200': [{ id: '44', name: 'Synthetic' }],
    '/users/@me/guilds?limit=200&after=44': [],
    '/guilds/44/roles': [{ id: '44', name: '@everyone', permissions: '1152921504606846977' }],
    '/guilds/44/channels': [{ id: '22', name: 'voice', type: 2, guild_id: '44', parent_id: '55' }, { id: '55', type: 4, name: 'Category' }],
    '/guilds/44/threads/active': { threads: [] },
    '/channels/22': { id: '22', name: 'voice', type: 2, guild_id: '44' },
    '/channels/22/messages?limit=100': [{ id: '999999999999999999', channel_id: '22', content: 'synthetic', timestamp: '2026-10-27T00:00:00Z', author: { id: '33', username: 'fixture' }, attachments: [] }],
    '/channels/22/messages?limit=100&before=999999999999999999': [],
    ...overrides,
  };
  return { calls, waits, options: {
    sleep: async (ms) => { waits.push(ms); },
    transport: async (url, headers) => {
      calls.push({ url, headers });
      assert.ok(url.startsWith('https://discord.com/api/v10/'));
      const key = url.slice('https://discord.com/api/v10'.length);
      if (!(key in routes)) throw new Error('Unexpected synthetic route');
      const value = routes[key]; return typeof value === 'function' ? value() : result(value);
    },
  } };
}

// Minimal independent ZIP STORE decoder also verifies byte sizes and offsets.
function entries(bytes) {
  const found = new Map(); let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const size = bytes.readUInt32LE(offset + 18), n = bytes.readUInt16LE(offset + 26), x = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + n).toString('utf8');
    const body = bytes.subarray(offset + 30 + n + x, offset + 30 + n + x + size);
    assert.equal(body.length, size); found.set(name, body); offset += 30 + n + x + size;
  }
  assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
  assert.equal(bytes.readUInt32LE(bytes.length - 22), 0x06054b50);
  assert.equal(bytes.readUInt32LE(bytes.length - 6), offset);
  return found;
}

test('discovery includes empty categories and voice text; selected ZIP has exact IDs and no credential', async () => {
  const fixture = source();
  const collector = new DiscordCollector('synthetic-secret', fixture.options);
  const inventory = await collector.discover(); await collector.inspectGuild('44');
  assert.equal(inventory.channels.length, 2);
  assert.equal(inventory.guilds[0].roles[0].permissions, '1152921504606846977');
  const bytes = await collector.collect({ channel_ids: ['22'], guild_ids: ['44'], include_voice_text: true, include_dms: false, include_groups: false, include_media: false, media_types: [] });
  assert.equal(bytes.includes(Buffer.from('synthetic-secret')), false);
  const files = entries(bytes);
  assert.ok(files.has('guilds/44.json'));
  assert.ok(files.has('channels/22/metadata.json'));
  assert.equal(JSON.parse(files.get('channels/22/00000000.json')).messages[0].id, '999999999999999999');
  assert.equal(JSON.parse(files.get('migration-manifest.json')).attribution_trusted, false);
  await assert.rejects(collector.collect({ channel_ids: [], guild_ids: [] }), /cancelled/);
});

test('excluded voice text produces no history request', async () => {
  const fixture = source(); const collector = new DiscordCollector('secret', fixture.options);
  await collector.discover(); await collector.inspectGuild('44');
  const files = entries(await collector.collect({ channel_ids: ['22'], guild_ids: ['44'], include_voice_text: false }));
  assert.equal(JSON.parse(files.get('channels/22/metadata.json')).messages.length, 0);
  assert.equal(fixture.calls.some((call) => call.url.includes('/messages')), false);
});

test('unknown selections fail before message access', async () => {
  const fixture = source(); const collector = new DiscordCollector('secret', fixture.options);
  await collector.discover(); await collector.inspectGuild('44');
  await assert.rejects(collector.collect({ channel_ids: ['999'], guild_ids: ['44'] }), /Unknown source channel/);
  collector.cancel();
  assert.equal(fixture.calls.some((call) => call.url.includes('/messages')), false);
});

test('401 is terminal, 429 waits, and redirects are not followed', async () => {
  let attempts = 0;
  const fixture = source({ '/users/@me': () => ++attempts === 1 ? result({ retry_after: 2 }, 429) : result({ id: '11' }) });
  const collector = new DiscordCollector('secret', fixture.options);
  await collector.discover(); await collector.inspectGuild('44'); assert.equal(fixture.waits[0], 2100); collector.cancel();
  for (const status of [401, 302]) {
    const denied = source({ '/users/@me': () => result({ secret: 'never print remote body' }, status, { location: 'https://other.invalid' }) });
    await assert.rejects(new DiscordCollector('secret', denied.options).discover(), (error) => error instanceof SourceError && error.status === status && !error.message.includes('remote body'));
    assert.equal(denied.calls.length, 1);
  }
});

test('archive names/count and size are bounded', () => {
  for (const name of ['../secret', 'media/22//33/44.bin', 'channels/22/../../x', 'guilds/x.json']) {
    assert.throws(() => new StoredZip().add(name, 'x'), /Unsafe archive entry/);
  }
  const zip = new StoredZip(512); zip.add('migration-manifest.json', '{}');
  assert.throws(() => zip.add('migration-manifest.json', '{}'), /entry limit/);
  assert.throws(() => new StoredZip(50).add('migration-manifest.json', 'x'.repeat(100)), /size limit/);
  assert.equal(entries(zip.finish()).get('migration-manifest.json').toString(), '{}');
  for (const value of ['01', '1e3', '18446744073709551616', 123]) assert.throws(() => id(value));
});

test('local inspection returns authors without fetching media; final ZIP excludes authors and quoted data', async () => {
  const rows = [
    { id: '99', channel_id: '22', timestamp: '2026-10-27T00:00:00Z', content: 'exclude-this', author: { id: '33', username: 'excluded' }, attachments: [{ id: '77', filename: 'secret.gif', url: 'https://cdn.discordapp.com/attachments/22/77/secret.gif', size: 6 }] },
    { id: '98', channel_id: '22', timestamp: '2026-10-27T00:00:00Z', content: 'keep-this', author: { id: '34', username: 'kept' }, referenced_message: { content: 'exclude-this-too', author: { id: '33' } }, attachments: [] },
  ];
  const fixture = source({ '/channels/22/messages?limit=100': rows,
    '/channels/22/messages?limit=100&before=98': [] });
  const collector = new DiscordCollector('secret', fixture.options);
  await collector.discover(); await collector.inspectGuild('44');
  const selection = { channel_ids: ['22'], guild_ids: ['44'], include_messages: true, include_voice_text: true, include_media: true, media_types: ['image'] };
  const inventory = await collector.scan(selection);
  assert.equal(inventory.authors.length, 2);
  assert.equal(inventory.channels.find((c) => c.id === '22').message_count, 2);
  const count = fixture.calls.length;
  const bytes = await collector.collect({ ...selection, excluded_author_ids: ['33'] });
  assert.equal(fixture.calls.length, count, 'collection reused local cache and did not fetch excluded-author media');
  assert.equal(bytes.includes(Buffer.from('exclude-this')), false);
  assert.equal(bytes.includes(Buffer.from('keep-this')), true);
  assert.equal([...entries(bytes).keys()].some((key) => key.startsWith('media/')), false);
});

test('structure-only selection never reads message endpoints', async () => {
  const fixture = source(); const collector = new DiscordCollector('secret', fixture.options);
  await collector.discover(); await collector.inspectGuild('44');
  const selection = { channel_ids: ['22', '55'], guild_ids: ['44'], include_voice_text: true, include_messages: false };
  const inventory = await collector.scan(selection);
  assert.equal(inventory.authors.length, 0);
  assert.equal(inventory.channels.some((c) => c.id === '55'), true);
  const archive = entries(await collector.collect(selection));
  assert.equal(fixture.calls.some((c) => c.url.includes('/messages')), false);
  assert.equal(JSON.parse(archive.get('channels/22/metadata.json')).messages.length, 0);
});

test('date and per-channel author exclusions remove content before ZIP and media requests', async () => {
  const row = (n, timestamp, author = '33') => ({ id: n, channel_id: '22', timestamp, author: { id: author, username: 'fixture' }, content: `content-${n}`, attachments: [{ id: n, filename: 'private.png', size: 1, url: `https://cdn.discordapp.com/attachments/22/${n}/private.png` }] });
  const fixture = source({ '/channels/22/messages?limit=100': [row('99','2026-10-27T00:00:00Z'),row('98','2026-10-25T00:00:00Z'),row('97','2026-10-26T12:00:00Z'),{...row('96','2026-10-26T00:00:00Z','34'),attachments:[]}], '/channels/22/messages?limit=100&before=96': [] });
  const collector = new DiscordCollector('secret',fixture.options); await collector.discover(); await collector.inspectGuild('44');
  const selection = { channel_ids: ['22','55'],guild_ids:['44'],include_messages:true,include_voice_text:true,include_media:true,media_types:['image'] };
  const inventory = await collector.scan(selection);
  assert.equal(inventory.channels.some(c=>c.id==='55'),true,'structural ancestor remains inspected');
  const calls = fixture.calls.length;
  const bytes = await collector.collect({...selection,after:'2026-10-26T00:00:00Z',before:'2026-10-27T00:00:00Z',channel_excluded_author_ids:{'22':['33']}});
  assert.equal(fixture.calls.length,calls,'excluded dates/authors never trigger media requests');
  const rows = JSON.parse(entries(bytes).get('channels/22/00000000.json')).messages;
  assert.deepEqual(rows.map(row=>row.id),['96']);
  for(const n of ['99','98','97'])assert.equal(bytes.includes(Buffer.from(`content-${n}`)),false);
});

test('empty unnamed groups retain source display name through a supported envelope', async () => {
  const fixture = source({ '/users/@me/channels': [{ id: '66', type: 3, recipients: [{ username: 'fixture-friend' }] }],
    '/channels/66': { id: '66', type: 3 }, '/channels/66/messages?limit=100': [] });
  const collector = new DiscordCollector('secret', fixture.options); await collector.discover(); await collector.inspectGuild('44');
  const bytes = await collector.collect({ channel_ids: ['66'], guild_ids: [], include_groups: true, include_messages: true });
  const envelope = JSON.parse(entries(bytes).get('channels/66/metadata.json'));
  assert.equal(envelope.channel.name, 'fixture-friend');
  assert.deepEqual(envelope.messages, []);
  assert.equal(allowedMedia({ filename: 'photo.GIF' }, ['image']), true);
  assert.equal(allowedMedia({ filename: 'clip.webm' }, ['video']), true);
  assert.equal(allowedMedia({ filename: 'photo.png', content_type: 'application/octet-stream' }, ['image']), false);
});

test('a blocked selected channel does not discard accessible history during collection', async () => {
  const fixture = source({
    '/guilds/44/channels': [{id:'22',guild_id:'44',type:2,name:'visible'}, {id:'23',guild_id:'44',type:0,name:'blocked'}],
    '/channels/23': () => result({},403),
  });
  const collector = new DiscordCollector('secret',fixture.options);
  await collector.discover(); await collector.inspectGuild('44');
  const selection={channel_ids:['22','23'],guild_ids:['44'],include_voice_text:true,include_messages:true};
  const inventory=await collector.scan(selection);
  assert.ok(inventory.warnings.some(warning=>warning.includes('23')));
  const files=entries(await collector.collect(selection));
  assert.equal(JSON.parse(files.get('channels/22/00000000.json')).messages.length,1);
  assert.equal(JSON.parse(files.get('channels/23/metadata.json')).messages.length,0);
  assert.equal(fixture.calls.some(call=>call.url.includes('/channels/23/messages')),false);
  assert.ok(JSON.parse(files.get('migration-manifest.json')).failures.some(row=>row.channel_id==='23'&&row.code==='http_403'));
});

test('175 guilds are listed without eager structure requests; one inspect is cached', async () => {
  const guilds = Array.from({length:175},(_,index)=>({id:String(1000+index),name:`Fixture ${index}`}));
  const fixture = source({'/users/@me/guilds?limit=200':guilds, '/users/@me/guilds?limit=200&after=1174':[],
    '/guilds/1000/roles':[], '/guilds/1000/channels':[], '/guilds/1000/threads/active':{threads:[]}});
  const collector = new DiscordCollector('secret',fixture.options);
  const initial = await collector.discover();
  assert.equal(initial.guilds.length,175);
  assert.equal(fixture.calls.length,4);
  assert.ok(initial.guilds.every(guild=>guild.channels_loaded===false));
  await assert.rejects(collector.scan({channel_ids:[],guild_ids:['1000']}),/SOURCE_RESCAN_REQUIRED/);
  await assert.rejects(collector.inspectGuild('9999'),/Unknown source guild/);
  await collector.inspectGuild('1000');
  const calls=fixture.calls.length;
  await collector.inspectGuild('1000');
  assert.equal(fixture.calls.length,calls);
  assert.equal(calls,7);
  assert.equal(fixture.calls.some(call=>call.url.includes('/guilds/1001/')),false);
  collector.cancel();
});

test('optional role and thread denial keeps visible channels available', async () => {
  const fixture=source({'/guilds/44/roles':()=>result({},403),'/guilds/44/threads/active':()=>result({},403)});
  const collector=new DiscordCollector('secret',fixture.options); await collector.discover();
  const inventory=await collector.inspectGuild('44');
  assert.equal(inventory.channels.length,2);
  assert.equal(inventory.guilds[0].channels_loaded,true);
  assert.equal(inventory.warnings.filter(warning=>warning.includes('HTTP 403')).length,2);
  const files=entries(await collector.collect({channel_ids:['22'],guild_ids:['44'],include_voice_text:true}));
  assert.ok(files.has('channels/22/00000000.json'));
});

test('history revoked after a page retains that page and marks incompleteness', async () => {
  const fixture=source({'/channels/22/messages?limit=100&before=999999999999999999':()=>result({},403)});
  const collector=new DiscordCollector('secret',fixture.options);await collector.discover();await collector.inspectGuild('44');
  const selection={channel_ids:['22'],guild_ids:['44'],include_voice_text:true};
  await collector.scan(selection);
  const files=entries(await collector.collect(selection));
  assert.equal(JSON.parse(files.get('channels/22/00000000.json')).messages.length,1);
  const manifest=JSON.parse(files.get('migration-manifest.json'));
  assert.equal(manifest.channels[0].pagination_exhausted,false);
  assert.equal(manifest.failures[0].code,'http_403');
});

test('both429 and successful exhausted buckets report their waits',async()=>{
  for(const limited of [true,false]){
    let attempts=0;const events=[];
    const fixture=source({'/users/@me':()=> limited&&attempts++===0 ? result({retry_after:2},429):result({id:'11'},200,limited?{}:{'x-ratelimit-remaining':'0','x-ratelimit-reset-after':'3'})});
    const collector=new DiscordCollector('secret',{...fixture.options,progress:event=>events.push({...event})});
    await collector.discover();collector.cancel();
    assert.ok(events.some(event=>event.waiting_ms===(limited?2100:3100)));
    assert.ok(events.some(event=>event.waiting_ms===0));
  }
});

test('absolute request deadline covers a stalled connection before any socket',async()=>{
  const previous=https.get;let destroyed=false;
  try{
    https.get=()=>{const req=new EventEmitter();req.destroy=()=>{destroyed=true;};return req;};
    await assert.rejects(request('https://discord.com/api/v10/users/@me',{},undefined,1024,20),/SOURCE_TIMEOUT/);
    assert.equal(destroyed,true);
  }finally{https.get=previous;}
});

test('a bounded packing failure can retry from inspected history without re-reading',async()=>{
  const fixture=source();const collector=new DiscordCollector('secret',fixture.options);
  await collector.discover();await collector.inspectGuild('44');
  const selection={channel_ids:['22'],guild_ids:['44'],include_voice_text:true};
  await collector.scan(selection);const calls=fixture.calls.length;
  const add=StoredZip.prototype.add;let fails=true;
  try{
    StoredZip.prototype.add=function(...args){if(fails)throw new Error('Archive size limit reached; choose fewer channels');return add.apply(this,args);};
    await assert.rejects(collector.collect(selection),/Archive size limit/);
    fails=false;
    const files=entries(await collector.collect(selection));
    assert.ok(files.has('channels/22/00000000.json'));
    assert.equal(fixture.calls.length,calls);
  }finally{StoredZip.prototype.add=add;collector.cancel();}
});
