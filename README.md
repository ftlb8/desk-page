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
| `app.js` | Sign-in; eight views under the organisation filter and a search box that filters whichever one you are in. The page always opens on Today: the next meeting with a Join button and the rest of today's meetings, a Coming up card of key dates (things that must happen on or by a day, from the `key_dates` table) whose warning has started, with the day count, the project, the last day, Done with Undo and a More that shows the note and makes a task from it (the card hides when there is nothing), your tasks for today with how many are late, the most important inbox items, a written review of how things stand for each organisation (from the `cover_reviews` table, refreshed with the `cover-review` function), and a quick note. Inbox in four collapsible sections: key people (Slack messages from the people marked as key), other DMs and mentions, key channels, and email and Google Drive; in each, what needs you comes first, then FYI, newest first. Each item is a row with Done and Later at its right end; opening it shows the gist, the message and the other actions. Tasks, with a tray of suggested tasks and your tasks in collapsible sections Today, This week, Next 2-3 weeks and Later, each row opening in place. Projects, in place of Planning: a "What changed" strip (the changes of the most recent day within the last three days, from the `project_changes` table, each with a Correct button), then a list of the key dates in the next 60 days (collapsed to the first 5), each as a one-line bar that opens and remembers whether you opened it, then the projects and ongoing areas as rows grouped by attention (Needs you, Active, Quiet), each with its topic count, the one thing that matters most, its next key date and its open tasks, and an Unsorted row for open tasks and key dates without a project, each task with a picker to file it. A row opens to the project page (its kind and topics at the top): where it stands, what is open now, its key dates (open ones in date order with Done, Edit and a two-step Remove, dates found by the Desk with Confirm and Dismiss, a Done fold, and Add a key date), its tasks grouped by topic, its topics, the plan fields, the review with Review now (projects only), notes, the change log (loaded when the page is first opened, with Add a line) and the Edit and Add a topic buttons. Decisions from your meetings sit at the bottom. Meetings by day with what you owe for each. Notes: write a note, tie it to a project, pin, edit and delete it in place; the three newest notes of a project also show on its page. Links: large tiles for the pages you open often, kept per organisation in the `quick_links` table (grouped by organisation under All), with Add a link and an Edit toggle to rename, move up or down and remove them. A small dot above Metaculus or CEA in the filter shows that organisation has something new that needs you (an item in Needs you, a run waiting for you, a run that finished, or an open key date that has reached its day or a proposed one) since you last had it selected. A task that is urgent and open carries a red Urgent pill. Plan, on every inbox card and suggestion: steps to follow (kept in the `starts` table, written by the `start-item` function) and, for a message, a draft reply you can edit and copy. Send, on the draft of a message, is the page's only control that sends something for you: it saves the draft, asks the `send-reply` function who would get it (nothing is sent yet), shows you the recipient and the exact text, and sends only when you press Send now. A reply goes out once, and the start then shows Sent. Plan on a task asks the `run-control` function for a plan (what it will look at, what you get, what it cannot do); you add corrections, then Start, Rewrite plan or Discard. Work lists the runs for the organisation you picked as rows in three groups (Needs you, including failed runs; In progress; Finished, folded when it is long) with this month's cost, an answer box when a run asks you something, its result, flags and links, its activity, and Stop and Discard; Today shows a Work in progress card, and the Work tab shows a count when a run needs you. The task and project editors fill the screen on a phone with Save always in view; adding a task from one line with suggestions from the `task-suggest` function; live updates. |
| `format.js` | Makes message text readable: drops quoted history, signatures and mailing footers from email, turns long links into short labels, reads Google Docs comment notices into file, comments and link, and renders Slack formatting. Returns plain data; never HTML. |
| `style.css` | Styling, light and dark, built on the design rules below (tokens and shared classes at the top of the file). The page is up to 1240 px wide; from 1000 px wide Today, Inbox, Tasks, Meetings and Notes use two columns, and below that everything is one column. A list narrower than 520 px (a phone, the tray) stacks each row into two lines. |
| `config.js` | Project address and publishable key. |
| `vendor/supabase-2.119.0.js` | The Supabase browser library, copied in unchanged from the npm package `@supabase/supabase-js` 2.119.0 so the page loads nothing from other sites. |

## Design rules

- **Attention has three looks, the same in every view.** Needs you: red for now, overdue, urgent, failed or past the limit; amber for soon, slipping or on the day, said in the state text or a pill. Active: plain text. Quiet: muted grey, never bold or coloured. One loud thing per row; blue is for links and the one primary action of a form.
- **Organisation colour:** Metaculus purple, CEA green, Personal blue (`--org-*`). It is the 3 px bar on the left edge of every row or tile that belongs to one organisation (with the name for screen readers), a dot before the organisation's name, and the filter at the top. The left edge is used for nothing else.
- **Type:** one typeface; title (600), body (400), quiet (400, muted, smaller). Numbers, dates, counts and money in tabular figures.
- **Rows, not cards:** lists are rows of equal height on one grid (title and a quiet line, state, date, count, actions on hover or always on touch, chevron); a row opens in place with the same fold look everywhere. Notes and links are tiles of equal height on the same grid.
- **Attention first:** groups go Needs you, Active, Quiet (Quiet folded when it holds more than 5 rows); bars and folds remember whether you opened them.
- At most two pills per row; spacing 4/8/12/16/24; hairline borders; no shadows or gradients; empty states are one quiet sentence; contrast AA in both themes; controls at least 40 px tall on a phone.

## Releasing a change

Raise the number in `index.html` (the `desk-version` tag and the `?v=` on each file) with every change. Browsers keep the old files for up to ten minutes otherwise. The page shows its version at the bottom.

## Rules

- Anything that comes from a message is written to the page as text, never as HTML.
- No third-party scripts, fonts or trackers.
- No secrets here, ever.
