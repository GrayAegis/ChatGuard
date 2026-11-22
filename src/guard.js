// Chat Guard core. No SillyTavern imports, so it runs under Node for tests.
//
// SillyTavern loads a chat with POST /api/chats/get and saves the whole chat
// with POST /api/chats/save (group chats use /api/chats/group/*). When a load
// fails, SillyTavern treats the chat as new, puts the greeting in it and saves
// that over the real file. This module sits in front of fetch and refuses a
// save that would replace a longer chat on disk with a near-empty one.

const ROUTES = {
    '/api/chats/get': { kind: 'char', op: 'get' },
    '/api/chats/save': { kind: 'char', op: 'save' },
    '/api/chats/group/get': { kind: 'group', op: 'get' },
    '/api/chats/group/save': { kind: 'group', op: 'save' },
};

const GET_PATH = { char: '/api/chats/get', group: '/api/chats/group/get' };

/** A save of this many messages or fewer is checked against the disk. */
export const SMALL_CHAT = 1;
/** An unexplained save must lose at least this many messages to be stopped. */
export const MIN_LOSS = 2;

/**
 * @param {RequestInfo|URL} input
 * @param {string} baseUrl
 * @returns {{kind: 'char'|'group', op: 'get'|'save'}|null}
 */
export function classifyRequest(input, baseUrl) {
    try {
        const raw = typeof input === 'string' ? input : (input?.url ?? String(input));
        const pathname = new URL(raw, baseUrl).pathname.replace(/\/+$/, '');
        return ROUTES[pathname] ?? null;
    } catch {
        return null;
    }
}

/**
 * Identifies one chat file on the server.
 * @param {'char'|'group'} kind
 * @param {any} body Parsed request body of a get or a save
 * @returns {string|null}
 */
export function chatKey(kind, body) {
    if (!body || typeof body !== 'object') return null;
    if (kind === 'group') {
        return body.id ? `group:${body.id}` : null;
    }
    if (!body.avatar_url || !body.file_name) return null;
    return `char:${body.avatar_url}:${body.file_name}`;
}

/**
 * Counts messages in a chat array, leaving out the header line.
 * @param {any} chat
 * @returns {number}
 */
export function countMessages(chat) {
    if (!Array.isArray(chat) || chat.length === 0) return 0;
    const first = chat[0];
    const hasHeader = first && typeof first === 'object' && Object.hasOwn(first, 'chat_metadata');
    return hasHeader ? chat.length - 1 : chat.length;
}

/**
 * The body of the get request that reads back the file a save is aimed at.
 * @param {'char'|'group'} kind
 * @param {any} saveBody
 */
export function readBackBody(kind, saveBody) {
    if (kind === 'group') return { id: saveBody.id };
    return { ch_name: saveBody.ch_name, file_name: saveBody.file_name, avatar_url: saveBody.avatar_url };
}

/**
 * @param {{outgoing: number, onDisk: number, loadFailed: boolean}} facts
 * @returns {'allow'|'block'}
 */
export function decide({ outgoing, onDisk, loadFailed }) {
    if (onDisk <= outgoing) return 'allow';
    if (loadFailed) return 'block';
    return (onDisk - outgoing) >= MIN_LOSS ? 'block' : 'allow';
}

function headerValue(headers, name) {
    if (!headers) return null;
    if (typeof headers.get === 'function') return headers.get(name);
    const wanted = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === wanted) return String(value);
    }
    return null;
}

/**
 * Reads a request body as text. SillyTavern may gzip large saves.
 * @param {RequestInit|undefined} init
 * @returns {Promise<string|null>} null when the body cannot be read
 */
export async function readBodyText(init) {
    const body = init?.body;
    if (typeof body === 'string') return body;
    if (!body) return null;

    const isBytes = body instanceof ArrayBuffer || ArrayBuffer.isView(body) || (typeof Blob !== 'undefined' && body instanceof Blob);
    if (!isBytes) return null;

    const blob = body instanceof Blob ? body : new Blob([body]);
    const encoding = (headerValue(init.headers, 'Content-Encoding') ?? '').toLowerCase();
    if (!encoding) return await blob.text();
    if (encoding !== 'gzip') return null;
    if (typeof DecompressionStream === 'undefined') return null;
    return await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text();
}

function refusal(reason) {
    return new Response(JSON.stringify({ error: 'chat-guard', reason }), {
        status: 409,
        statusText: 'Refused by Chat Guard',
        headers: { 'Content-Type': 'application/json' },
    });
}

/**
 * @typedef {object} GuardDeps
 * @property {typeof fetch} fetch The real fetch
 * @property {string} baseUrl Page URL, used to resolve relative request URLs
 * @property {() => boolean} isEnabled
 * @property {() => number} getMemoryCount Messages in the chat on screen
 * @property {() => Record<string,string>} getHeaders Headers for a JSON request to the server
 * @property {(info: BlockInfo) => Promise<'overwrite'|'reload'|'refuse'>} ask
 * @property {() => void} reload
 * @property {(event: string, info: object) => void} notify
 *
 * @typedef {object} BlockInfo
 * @property {string} key
 * @property {'char'|'group'} kind
 * @property {string} name Chat file name or group chat id
 * @property {number} outgoing Messages in the save
 * @property {number} onDisk Messages in the file on the server
 * @property {boolean} loadFailed Whether this chat failed to load earlier
 */

/**
 * @param {GuardDeps} deps
 */
export function createGuard(deps) {
    /** Chats whose last load failed. */
    const loadFailed = new Set();
    /** Small chats already checked against the disk since their last load. */
    const cleared = new Set();
    /** One open question per chat, shared by saves that arrive together. */
    const asking = new Map();

    function parseJson(text) {
        try { return JSON.parse(text); } catch { return null; }
    }

    async function handleGet(route, input, init) {
        let key = null;
        try {
            key = chatKey(route.kind, parseJson(await readBodyText(init) ?? ''));
        } catch { /* key stays null */ }

        const markFailed = (detail) => {
            if (!key) return;
            loadFailed.add(key);
            cleared.delete(key);
            deps.notify('load-failed', { key, detail });
        };

        let response;
        try {
            response = await deps.fetch(input, init);
        } catch (error) {
            markFailed(String(error?.message ?? error));
            throw error;
        }

        if (!response.ok) {
            markFailed(`HTTP ${response.status}`);
        } else if (key) {
            loadFailed.delete(key);
            cleared.delete(key);
        }
        return response;
    }

    /**
     * @returns {Promise<number|null>} Messages on disk, or null when the server did not answer
     */
    async function countOnDisk(kind, saveBody) {
        try {
            const response = await deps.fetch(GET_PATH[kind], {
                method: 'POST',
                headers: deps.getHeaders(),
                cache: 'no-cache',
                body: JSON.stringify(readBackBody(kind, saveBody)),
            });
            if (!response.ok) return null;
            return countMessages(await response.json());
        } catch {
            return null;
        }
    }

    /**
     * @returns {Promise<'pass'|'refuse-unverified'|'refuse'|'reload'>}
     */
    async function judgeSave(route, init) {
        const nothingSuspicious = loadFailed.size === 0 && deps.getMemoryCount() > SMALL_CHAT;
        if (nothingSuspicious) return 'pass';

        const text = await readBodyText(init);
        const body = text === null ? null : parseJson(text);
        const key = chatKey(route.kind, body);
        if (!key || !Array.isArray(body.chat)) return 'pass';

        // SillyTavern sets this only after the user typed OVERWRITE in its own dialog.
        if (body.force === true) return 'pass';

        const failed = loadFailed.has(key);
        const outgoing = countMessages(body.chat);
        if (!failed && (outgoing > SMALL_CHAT || cleared.has(key))) return 'pass';

        const onDisk = await countOnDisk(route.kind, body);
        if (onDisk === null) {
            deps.notify('unverified', { key, outgoing });
            return 'refuse-unverified';
        }

        if (decide({ outgoing, onDisk, loadFailed: failed }) === 'allow') {
            loadFailed.delete(key);
            cleared.add(key);
            return 'pass';
        }

        /** @type {BlockInfo} */
        const info = {
            key,
            kind: route.kind,
            name: String(route.kind === 'group' ? body.id : body.file_name),
            outgoing,
            onDisk,
            loadFailed: failed,
        };

        if (!asking.has(key)) {
            deps.notify('blocked', info);
            asking.set(key, Promise.resolve(deps.ask(info)).finally(() => asking.delete(key)));
        }
        const choice = await asking.get(key);

        if (choice === 'overwrite') {
            loadFailed.delete(key);
            cleared.add(key);
            deps.notify('overwritten', info);
            return 'pass';
        }
        return choice === 'reload' ? 'reload' : 'refuse';
    }

    async function guardedFetch(input, init) {
        const route = deps.isEnabled() ? classifyRequest(input, deps.baseUrl) : null;
        if (!route) return deps.fetch(input, init);
        if (route.op === 'get') return handleGet(route, input, init);

        let verdict = 'pass';
        try {
            verdict = await judgeSave(route, init);
        } catch (error) {
            // A fault in the guard must never stop a normal save.
            deps.notify('guard-error', { detail: String(error?.message ?? error) });
            verdict = 'pass';
        }

        if (verdict === 'pass') return deps.fetch(input, init);
        if (verdict === 'reload') {
            deps.reload();
            return new Promise(() => { });
        }
        return refusal(verdict === 'refuse-unverified' ? 'unverified' : 'would-shrink');
    }

    return { fetch: guardedFetch, loadFailed, cleared };
}
