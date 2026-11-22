import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { createGuard, classifyRequest, chatKey, countMessages, decide, readBodyText } from '../src/guard.js';

const BASE = 'http://localhost:8000/';
const header = { chat_metadata: { integrity: 'abc' }, user_name: 'unused', character_name: 'unused' };
const messages = (n) => Array.from({ length: n }, (_, i) => ({ name: 'A', mes: `m${i}` }));
const file = (n) => [header, ...messages(n)];

/**
 * A fake server holding chat files, plus a guard wired to it.
 */
function setup({ disk = {}, memory = 30, answer = 'refuse', enabled = true } = {}) {
    const calls = [];
    const events = [];
    const asked = [];
    const world = { disk, memory, getFails: null, down: false, reloaded: false };

    const keyOf = (path, body) => path.includes('/group/') ? `group:${body.id}` : `char:${body.avatar_url}:${body.file_name}`;

    const serverFetch = async (url, init) => {
        const path = new URL(url, BASE).pathname;
        const body = JSON.parse(await readBodyText(init));
        calls.push({ path, body });
        if (world.down) throw new TypeError('Failed to fetch');
        const key = keyOf(path, body);
        if (path.endsWith('/get')) {
            if (world.getFails) {
                const status = world.getFails;
                world.getFails = null;
                return new Response('Bad Gateway', { status });
            }
            return Response.json(world.disk[key] ?? []);
        }
        world.disk[key] = body.chat;
        return Response.json({ ok: true });
    };

    const guard = createGuard({
        fetch: serverFetch,
        baseUrl: BASE,
        isEnabled: () => enabled,
        getMemoryCount: () => world.memory,
        getHeaders: () => ({ 'Content-Type': 'application/json' }),
        ask: async (info) => { asked.push(info); return typeof answer === 'function' ? answer(info) : answer; },
        reload: () => { world.reloaded = true; },
        notify: (event, info) => events.push({ event, info }),
    });

    const charBody = { ch_name: 'Mei', file_name: 'Mei - 2026-11-22', avatar_url: 'Mei.png' };
    const KEY = 'char:Mei.png:Mei - 2026-11-22';
    const post = (path, body) => guard.fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const load = () => post('/api/chats/get', charBody);
    const save = (n, extra = {}) => post('/api/chats/save', { ...charBody, chat: file(n), force: false, ...extra });
    const saves = () => calls.filter(c => c.path.endsWith('/save')).length;

    return { guard, world, calls, events, asked, load, save, saves, post, KEY, charBody };
}

test('classifyRequest matches only the four chat routes', () => {
    assert.deepEqual(classifyRequest('/api/chats/get', BASE), { kind: 'char', op: 'get' });
    assert.deepEqual(classifyRequest('/api/chats/save', BASE), { kind: 'char', op: 'save' });
    assert.deepEqual(classifyRequest(new URL('/api/chats/group/save', BASE), BASE), { kind: 'group', op: 'save' });
    assert.deepEqual(classifyRequest({ url: `${BASE}api/chats/group/get` }, BASE), { kind: 'group', op: 'get' });
    assert.equal(classifyRequest('/api/chats/search', BASE), null);
    assert.equal(classifyRequest('/api/settings/save', BASE), null);
});

test('chatKey and countMessages', () => {
    assert.equal(chatKey('group', { id: '123' }), 'group:123');
    assert.equal(chatKey('char', { avatar_url: 'a.png', file_name: 'f' }), 'char:a.png:f');
    assert.equal(chatKey('char', { avatar_url: 'a.png' }), null);
    assert.equal(chatKey('char', null), null);
    assert.equal(countMessages(file(30)), 30);
    assert.equal(countMessages(messages(3)), 3);
    assert.equal(countMessages([]), 0);
    assert.equal(countMessages({}), 0);
});

test('decide', () => {
    assert.equal(decide({ outgoing: 1, onDisk: 0, loadFailed: false }), 'allow');
    assert.equal(decide({ outgoing: 1, onDisk: 1, loadFailed: false }), 'allow');
    assert.equal(decide({ outgoing: 1, onDisk: 2, loadFailed: false }), 'allow');
    assert.equal(decide({ outgoing: 1, onDisk: 3, loadFailed: false }), 'block');
    assert.equal(decide({ outgoing: 1, onDisk: 2, loadFailed: true }), 'block');
    assert.equal(decide({ outgoing: 5, onDisk: 5, loadFailed: true }), 'allow');
});

test('readBodyText handles strings, bytes and gzip', async () => {
    assert.equal(await readBodyText({ body: '{"a":1}' }), '{"a":1}');
    assert.equal(await readBodyText({ body: new TextEncoder().encode('plain') }), 'plain');
    const zipped = gzipSync(Buffer.from('{"zipped":true}'));
    assert.equal(await readBodyText({ body: new Uint8Array(zipped), headers: { 'content-encoding': 'gzip' } }), '{"zipped":true}');
    assert.equal(await readBodyText({ body: new Uint8Array(zipped), headers: new Headers({ 'Content-Encoding': 'gzip' }) }), '{"zipped":true}');
    assert.equal(await readBodyText({}), null);
    assert.equal(await readBodyText({ body: new FormData() }), null);
});

test('a normal long chat saves with no extra request', async () => {
    const t = setup({ memory: 30 });
    const response = await t.save(30);
    assert.equal(response.ok, true);
    assert.equal(t.calls.length, 1);
    assert.equal(t.asked.length, 0);
});

test('the bug: failed load, then a greeting-only save, is stopped', async () => {
    const t = setup();
    t.world.disk[t.KEY] = file(30);
    t.world.getFails = 502;

    const loaded = await t.load();
    assert.equal(loaded.ok, false);
    assert.equal(t.events[0].event, 'load-failed');

    t.world.memory = 1;
    const response = await t.save(1);
    assert.equal(response.ok, false);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'chat-guard', reason: 'would-shrink' });
    assert.equal(t.saves(), 0);
    assert.equal(countMessages(t.world.disk[t.KEY]), 30);
    assert.equal(t.asked.length, 1);
    assert.deepEqual({ ...t.asked[0] }, { key: t.KEY, kind: 'char', name: 'Mei - 2026-11-22', outgoing: 1, onDisk: 30, loadFailed: true });
});

test('a load that throws is flagged and the error still reaches the caller', async () => {
    const t = setup();
    t.world.disk[t.KEY] = file(30);
    t.world.down = true;
    await assert.rejects(t.load(), /Failed to fetch/);
    assert.equal(t.guard.loadFailed.has(t.KEY), true);

    t.world.down = false;
    t.world.memory = 1;
    const response = await t.save(1);
    assert.equal(response.status, 409);
    assert.equal(countMessages(t.world.disk[t.KEY]), 30);
});

test('a wipe is stopped even when no failed load was seen', async () => {
    const t = setup({ memory: 1 });
    t.world.disk[t.KEY] = file(30);
    const response = await t.save(1);
    assert.equal(response.status, 409);
    assert.equal(t.asked[0].loadFailed, false);
    assert.equal(countMessages(t.world.disk[t.KEY]), 30);
});

test('a brand new chat saves, and is only read back once', async () => {
    const t = setup({ memory: 1 });
    assert.equal((await t.load()).ok, true);
    assert.equal((await t.save(1)).ok, true);
    assert.equal((await t.save(1)).ok, true);
    const readBacks = t.calls.filter(c => c.path.endsWith('/get')).length - 1;
    assert.equal(readBacks, 1);
    assert.equal(t.saves(), 2);
    assert.equal(t.asked.length, 0);
});

test('deleting the one reply after the greeting is allowed', async () => {
    const t = setup({ memory: 1 });
    t.world.disk[t.KEY] = file(2);
    assert.equal((await t.save(1)).ok, true);
    assert.equal(t.asked.length, 0);
});

test('choosing overwrite lets the save through and stops further questions', async () => {
    const t = setup({ memory: 1, answer: 'overwrite' });
    t.world.disk[t.KEY] = file(30);
    t.world.getFails = 500;
    await t.load();
    assert.equal((await t.save(1)).ok, true);
    assert.equal(countMessages(t.world.disk[t.KEY]), 1);
    assert.equal((await t.save(1)).ok, true);
    assert.equal(t.asked.length, 1);
    assert.equal(t.guard.loadFailed.size, 0);
});

test('choosing reload reloads and never resolves the save', async () => {
    const t = setup({ memory: 1, answer: 'reload' });
    t.world.disk[t.KEY] = file(30);
    const pending = t.save(1);
    const outcome = await Promise.race([pending, new Promise(r => setTimeout(() => r('still pending'), 50))]);
    assert.equal(outcome, 'still pending');
    assert.equal(t.world.reloaded, true);
    assert.equal(t.saves(), 0);
});

test('refusing asks again on the next save, and a good load clears the flag', async () => {
    const t = setup({ memory: 1 });
    t.world.disk[t.KEY] = file(30);
    t.world.getFails = 502;
    await t.load();
    await t.save(1);
    await t.save(1);
    assert.equal(t.asked.length, 2);

    assert.equal((await t.load()).ok, true);
    assert.equal(t.guard.loadFailed.size, 0);
    t.world.memory = 30;
    assert.equal((await t.save(31)).ok, true);
    assert.equal(countMessages(t.world.disk[t.KEY]), 31);
});

test('two saves arriving together share one question', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    const t = setup({ memory: 1, answer: () => gate });
    t.world.disk[t.KEY] = file(30);
    const both = Promise.all([t.save(1), t.save(1)]);
    await new Promise(r => setTimeout(r, 20));
    release('refuse');
    const [a, b] = await both;
    assert.equal(a.status, 409);
    assert.equal(b.status, 409);
    assert.equal(t.asked.length, 1);
});

test('the save is held back when the server cannot be read', async () => {
    const t = setup({ memory: 1 });
    t.world.disk[t.KEY] = file(30);
    t.world.getFails = 502;
    await t.load();
    t.world.getFails = 502;
    const response = await t.save(1);
    assert.deepEqual(await response.json(), { error: 'chat-guard', reason: 'unverified' });
    assert.equal(t.saves(), 0);
    assert.equal(t.asked.length, 0);
});

test('SillyTavern\'s own forced overwrite is respected', async () => {
    const t = setup({ memory: 1 });
    t.world.disk[t.KEY] = file(30);
    assert.equal((await t.save(1, { force: true })).ok, true);
    assert.equal(t.asked.length, 0);
});

test('a failed load of one chat does not hold up saves to another', async () => {
    const t = setup({ memory: 30 });
    t.world.disk[t.KEY] = file(30);
    t.world.getFails = 502;
    await t.load();
    const other = { ch_name: 'Rin', file_name: 'Rin - chat', avatar_url: 'Rin.png', chat: file(12), force: false };
    assert.equal((await t.post('/api/chats/save', other)).ok, true);
    assert.equal(t.asked.length, 0);
});

test('group chats: a failed load then a greetings-only save is stopped', async () => {
    const t = setup({ memory: 3 });
    t.world.disk['group:g1'] = file(40);
    t.world.getFails = 502;
    await t.post('/api/chats/group/get', { id: 'g1' });
    const response = await t.post('/api/chats/group/save', { id: 'g1', chat: file(3), force: false });
    assert.equal(response.status, 409);
    assert.equal(t.asked[0].kind, 'group');
    assert.equal(t.asked[0].onDisk, 40);
    assert.equal(countMessages(t.world.disk['group:g1']), 40);
});

test('a gzipped save is read and judged', async () => {
    const t = setup({ memory: 1 });
    t.world.disk[t.KEY] = file(30);
    const body = gzipSync(Buffer.from(JSON.stringify({ ...t.charBody, chat: file(1), force: false })));
    const response = await t.guard.fetch('/api/chats/save', { method: 'POST', headers: new Headers({ 'Content-Encoding': 'gzip' }), body: new Uint8Array(body) });
    assert.equal(response.status, 409);
    assert.equal(t.asked.length, 1);
});

test('an unreadable save body is let through', async () => {
    const t = setup({ memory: 1 });
    const calls = [];
    const guard = createGuard({
        fetch: async (url) => { calls.push(url); return Response.json({ ok: true }); },
        baseUrl: BASE, isEnabled: () => true, getMemoryCount: () => 1, getHeaders: () => ({}),
        ask: async () => 'refuse', reload: () => { }, notify: () => { },
    });
    assert.equal((await guard.fetch('/api/chats/save', { method: 'POST', body: new FormData() })).ok, true);
    assert.equal((await guard.fetch('/api/chats/save', { method: 'POST', body: 'not json' })).ok, true);
    assert.equal(calls.length, 2);
    assert.equal(t.asked.length, 0);
});

test('a guard fault lets the save through', async () => {
    const calls = [];
    const guard = createGuard({
        fetch: async (url) => { calls.push(url); return Response.json({ ok: true }); },
        baseUrl: BASE, isEnabled: () => true,
        getMemoryCount: () => { throw new Error('boom'); },
        getHeaders: () => ({}), ask: async () => 'refuse', reload: () => { }, notify: () => { },
    });
    assert.equal((await guard.fetch('/api/chats/save', { method: 'POST', body: '{}' })).ok, true);
    assert.equal(calls.length, 1);
});

test('disabled: nothing is inspected', async () => {
    const t = setup({ memory: 1, enabled: false });
    t.world.disk[t.KEY] = file(30);
    assert.equal((await t.save(1)).ok, true);
    assert.equal(t.calls.length, 1);
});
