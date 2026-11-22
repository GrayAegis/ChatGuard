import { createGuard } from './src/guard.js';

const SETTINGS_KEY = 'chatGuard';
const MAX_LOG = 20;
const CUSTOM_OVERWRITE = 1001;

const context = () => globalThis.SillyTavern.getContext();

function settings() {
    const store = context().extensionSettings;
    if (!store[SETTINGS_KEY] || typeof store[SETTINGS_KEY] !== 'object') {
        store[SETTINGS_KEY] = {};
    }
    const own = store[SETTINGS_KEY];
    if (typeof own.enabled !== 'boolean') own.enabled = true;
    if (!Array.isArray(own.log)) own.log = [];
    return own;
}

function isEnabled() {
    try {
        return settings().enabled;
    } catch {
        // Settings are not ready yet. Guarding is the safe default.
        return true;
    }
}

function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[ch]));
}

function plural(count) {
    return `${count} message${count === 1 ? '' : 's'}`;
}

function addLog(text) {
    try {
        const own = settings();
        own.log.unshift({ at: Date.now(), text });
        own.log.length = Math.min(own.log.length, MAX_LOG);
        context().saveSettingsDebounced();
        renderLog();
    } catch (error) {
        console.warn('[Chat Guard] Could not write the log', error);
    }
}

function renderLog() {
    const list = document.querySelector('#chat_guard_settings .chat-guard-log');
    if (!list) return;
    list.replaceChildren();
    const entries = settings().log;
    if (entries.length === 0) {
        const item = document.createElement('li');
        item.textContent = 'Nothing stopped so far.';
        list.append(item);
        return;
    }
    for (const entry of entries) {
        const item = document.createElement('li');
        item.textContent = `${new Date(entry.at).toLocaleString()}: ${entry.text}`;
        list.append(item);
    }
}

function notify(event, info) {
    const toast = globalThis.toastr;
    const sticky = { timeOut: 0, extendedTimeOut: 0, closeButton: true };
    switch (event) {
        case 'load-failed':
            console.warn('[Chat Guard] Chat load failed', info);
            toast?.error('What is on screen is not your chat. Nothing has been saved over it. Reload the page once the connection is back.', 'This chat failed to load', sticky);
            addLog(`A chat failed to load (${info.detail}).`);
            break;
        case 'unverified':
            console.warn('[Chat Guard] Could not read the chat back before saving', info);
            toast?.warning('The server did not answer, so this save was held back. Your chat file is untouched.', 'Chat Guard', { preventDuplicates: true });
            break;
        case 'blocked':
            console.warn('[Chat Guard] Stopped a save', info);
            addLog(`Stopped a save of ${plural(info.outgoing)} over ${plural(info.onDisk)} in "${info.name}".`);
            break;
        case 'overwritten':
            addLog(`You chose to overwrite "${info.name}".`);
            break;
        case 'guard-error':
            console.error('[Chat Guard] Internal error, save let through', info);
            break;
    }
}

async function ask(info) {
    const ctx = context();
    const cause = info.loadFailed
        ? 'This chat failed to load a moment ago, so what is on screen is not the real chat.'
        : 'This usually means the chat did not load properly. It also happens if you deleted the messages on purpose.';
    const html = `
        <div class="chat-guard-popup">
            <h3>Chat Guard stopped a save</h3>
            <p>${escapeHtml(cause)}</p>
            <div class="chat-guard-counts">
                <div>On the server: <b>${plural(info.onDisk)}</b></div>
                <div>About to be saved: <b>${plural(info.outgoing)}</b></div>
                <div>Chat: <code>${escapeHtml(info.name)}</code></div>
            </div>
            <p>Reloading the page keeps the server copy. Overwriting replaces it with what is on screen.</p>
        </div>`;

    const overwriteResult = ctx.POPUP_RESULT?.CUSTOM1 ?? CUSTOM_OVERWRITE;
    const result = await ctx.callGenericPopup(html, ctx.POPUP_TYPE.TEXT, '', {
        okButton: 'Reload page',
        cancelButton: 'Do nothing',
        customButtons: [{ text: 'Overwrite server copy', result: overwriteResult, appendAtEnd: true }],
    });

    if (result === overwriteResult) return 'overwrite';
    if (result === ctx.POPUP_RESULT.AFFIRMATIVE) return 'reload';
    return 'refuse';
}

function getMemoryCount() {
    try {
        return context().chat.length;
    } catch {
        return 0;
    }
}

function addSettingsPanel() {
    const host = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!host || document.getElementById('chat_guard_settings')) return;

    const panel = document.createElement('div');
    panel.id = 'chat_guard_settings';
    panel.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Chat Guard</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label" for="chat_guard_enabled">
                    <input id="chat_guard_enabled" type="checkbox">
                    <span>Stop saves that would wipe a longer chat</span>
                </label>
                <small>A save of one message or fewer is checked against the file on the server first.</small>
                <ul class="chat-guard-log"></ul>
            </div>
        </div>`;
    host.append(panel);

    const checkbox = /** @type {HTMLInputElement} */ (panel.querySelector('#chat_guard_enabled'));
    checkbox.checked = settings().enabled;
    checkbox.addEventListener('change', () => {
        settings().enabled = checkbox.checked;
        context().saveSettingsDebounced();
    });
    renderLog();
}

// Wrap fetch as soon as the script loads, before any chat is opened.
if (!globalThis.__chatGuardInstalled) {
    const realFetch = globalThis.fetch.bind(globalThis);
    const guard = createGuard({
        fetch: realFetch,
        baseUrl: globalThis.location.href,
        isEnabled,
        getMemoryCount,
        getHeaders: () => context().getRequestHeaders(),
        ask,
        reload: () => globalThis.location.reload(),
        notify,
    });
    globalThis.fetch = guard.fetch;
    globalThis.__chatGuardInstalled = true;
    console.log('[Chat Guard] Watching chat loads and saves');
}

try {
    const ctx = context();
    ctx.eventSource.once(ctx.eventTypes.APP_READY, addSettingsPanel);
    // The panel host already exists when the extension is installed mid-session.
    addSettingsPanel();
} catch (error) {
    console.warn('[Chat Guard] Could not add the settings panel', error);
}
