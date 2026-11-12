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
| `app.js` | Sign-in; six views under the organisation filter and a search box that filters whichever one you are in. The page always opens on Today: the next meeting with a Join button and the rest of today's meetings, your tasks for today with how many are late, the most important inbox items, a written review of how things stand for each organisation (from the `cover_reviews` table, refreshed with the `cover-review` function), and a quick note. Inbox, newest first, in four collapsible sections: key people (Slack messages from the people marked as key), other DMs and mentions, key channels, and email and Google Drive, each card tagged "Needs you" or "FYI". Tasks, with a tray of suggested tasks and your tasks in collapsible sections Today, This week, Next 2-3 weeks and Later, each row opening in place. Planning, with plans you can add and edit, other projects and decisions. Meetings by day with what you owe for each. Notes: write a note, tie it to a plan, pin, edit and delete it in place; the three newest notes of a plan also show in its Details. Start, on every inbox card, suggestion and task: steps to follow (kept in the `starts` table, written by the `start-item` function) and, for a message, a draft reply you can edit and copy; nothing is ever sent from the page. The task and plan editors fill the screen on a phone with Save always in view; adding a task from one line with suggestions from the `task-suggest` function; live updates. |
| `format.js` | Makes message text readable: drops quoted history, signatures and mailing footers from email, turns long links into short labels, reads Google Docs comment notices into file, comments and link, and renders Slack formatting. Returns plain data; never HTML. |
| `style.css` | Styling, light and dark. The page is up to 1240 px wide; from 1000 px wide Today, Inbox, Tasks, Planning, Meetings and Notes use columns, and below that everything is one column. |
| `config.js` | Project address and publishable key. |
| `vendor/supabase-2.119.0.js` | The Supabase browser library, copied in unchanged from the npm package `@supabase/supabase-js` 2.119.0 so the page loads nothing from other sites. |

## Releasing a change

Raise the number in `index.html` (the `desk-version` tag and the `?v=` on each file) with every change. Browsers keep the old files for up to ten minutes otherwise. The page shows its version at the bottom.

## Rules

- Anything that comes from a message is written to the page as text, never as HTML.
- No third-party scripts, fonts or trackers.
- No secrets here, ever.
