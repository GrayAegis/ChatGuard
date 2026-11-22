# Chat Guard

A SillyTavern extension that stops a chat from being wiped after a failed load.

## The problem

When SillyTavern opens a chat and the request to the server fails (a dropped connection, a proxy error, an expired session), it treats the chat as new. It puts the character's greeting in it and saves that to the same file, replacing every message that was there. The server's own overwrite check does not run on this path.

This was read from, and reproduced on, SillyTavern 1.18.0.

## What Chat Guard does

- It watches chat loads. If one fails, it shows a warning that what is on screen is not your chat.
- It watches chat saves. Before a save of one message or fewer goes out, or any save to a chat that failed to load, it asks the server how many messages the file holds.
- If the file on the server is longer, the save is held and you choose:
  - **Reload page** keeps the server copy.
  - **Do nothing** refuses this save and asks again on the next one.
  - **Overwrite server copy** lets the save through.
- If the server cannot be reached to check, the save is held back.

A normal save of a longer chat is passed straight through with no extra request. Group chats are covered the same way.

Deleting a chat down to its greeting on purpose also triggers the question, when that removes two or more messages. Choose "Overwrite server copy".

## Install

In SillyTavern: Extensions → Install extension → paste the repository URL. Or copy this folder to `data/<your-user>/extensions/ChatGuard` and reload the page.

The setting and a log of what was stopped are under Extensions → Chat Guard.

## Limits

- It runs in the browser, so it only protects sessions where the extension has loaded.
- It does not keep its own copies of chats. SillyTavern's server backups (`data/<your-user>/backups`) remain the way to recover a chat that is already lost.
- A fault inside the guard lets the save through, so that it can never block normal saving.

## Tests

```
npm test
```

The decision logic in `src/guard.js` has no SillyTavern imports and runs under Node 20 or later.
