# Desk page

The web page for Felipe's Desk. It is published with GitHub Pages at https://ftlb8.github.io/desk-page/.

This repository is public because GitHub Pages needs it to be. It holds only the page itself:

- No messages, names or other Desk content. Those live in the Desk's database and load only after sign-in.
- No secrets. `config.js` holds the project address and its publishable key, both of which are meant to be public. The database refuses every reader except the Desk's owner.

The backend (collector, database rules, agents) is in the private repository `ftlb8/desk`.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The page. Its content security policy only allows its own files and the Desk's Supabase project. |
| `app.js` | Sign-in; Waiting on you, Commitments, Tasks (with projects), Worth a look, Later, recently closed; live updates. |
| `format.js` | Makes message text readable: drops quoted history, signatures and mailing footers from email, turns long links into short labels, reads Google Docs comment notices into file, comments and link, and renders Slack formatting. Returns plain data; never HTML. |
| `style.css` | Styling, light and dark. |
| `config.js` | Project address and publishable key. |
| `vendor/supabase-2.119.0.js` | The Supabase browser library, copied in unchanged from the npm package `@supabase/supabase-js` 2.119.0 so the page loads nothing from other sites. |

## Releasing a change

Raise the number in `index.html` (the `desk-version` tag and the `?v=` on each file) with every change. Browsers keep the old files for up to ten minutes otherwise. The page shows its version at the bottom.

## Rules

- Anything that comes from a message is written to the page as text, never as HTML.
- No third-party scripts, fonts or trackers.
- No secrets here, ever.
