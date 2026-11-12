// Desk page. Reads items from the Desk's database and shows them; nothing else.
// Everything that comes from a message is written with textContent, never as HTML.
(function () {
  "use strict";

  var cfg = window.DESK_CONFIG;
  var F = window.DeskFormat;
  var DOCS_NOTICES = "comments-noreply@docs.google.com";
  var versionTag = document.querySelector('meta[name="desk-version"]');
  var VERSION = versionTag ? versionTag.content : "?";
  var sb = window.supabase.createClient(cfg.url, cfg.key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });

  var SPACES = [
    { id: "all", label: "All" },
    { id: "metaculus", label: "Metaculus" },
    { id: "cea", label: "CEA" },
    { id: "personal", label: "Personal" },
  ];
  var VIEWS = [
    { id: "today", label: "Today" },
    { id: "inbox", label: "Inbox" },
    { id: "tasks", label: "Tasks" },
    { id: "planning", label: "Planning" },
    { id: "meetings", label: "Meetings" },
    { id: "notes", label: "Notes" },
  ];
  var DAY = 24 * 60 * 60 * 1000;

  var state = {
    items: [],
    tasks: [],
    meetings: [],
    notes: [],
    openNotes: {},    // ids of long notes you opened in full
    noteAsk: null,    // id of the note you are being asked about deleting
    noteEdit: null,   // { id, node } while a note is being edited in place
    noteSpace: null,  // the organisation you last saved a note for in this session
    openInbox: {},    // inbox sections you closed (false) or opened (true); all start open
    openMeetings: {}, // ids of meetings whose details you opened
    openPlans: {},    // ids of plans whose details you opened
    openTasks: {},    // ids of tasks you expanded in the list
    openSections: { today: true, week: true, weeks: false, later: false }, // task sections you opened or closed
    folds: {},        // the fixed folds (tray, Later, Closed, Decisions, ...) you opened
    query: "",        // what is typed in the search box
    reviewing: {},    // ids of plans whose review is running
    doneSuggestions: {}, // review suggestions that became tasks this session, keyed by plan id and text
    projects: [],
    covers: [],       // the written review of how things stand, one row per organisation
    starts: [],       // prepared steps (and draft replies) for items and tasks
    covering: {},     // organisations whose review is being written
    starting: {},     // "item:7" / "task:3" while Start is preparing
    startOpen: {},    // starts whose panel you opened
    startAsk: {},     // starts where you are being asked about writing it again
    startHold: {},    // ids of starts with a save on its way
    copied: {},       // starts whose draft was just copied
    sendFlow: {},     // "item:7" -> { phase: checking | confirm | blocked | failed | sending, text, to, reason, error } while a reply is being sent
    sent: {},         // start id -> { at, to } for replies sent from this page (a load also brings sent_at)
    fresh: { starts: {}, covers: {} }, // rows just received from a function, kept until a load has them too
    people: {},   // "space:userId" -> { name, is_vip, is_key }
    channels: {}, // "space:channelId" -> { name, kind }
    accounts: {}, // space -> { slack_url }
    filter: readPref("desk.space", "all"),
    view: "today", // the page always opens on Today; today | inbox | tasks | planning | meetings | notes
    taskMode: readPref("desk.task-mode", "list"), // list | days
    project: null, // show only this project's tasks
    seen: null,   // ids already shown, to tell which waiting items are new
    loading: false,
    reloadTimer: null,
    channel: null,
  };

  function $(id) { return document.getElementById(id); }

  // The first element for a selector that is in the view being shown (the same card can also sit in a hidden view).
  function onPage(selector) {
    var all = document.querySelectorAll(selector);
    for (var i = 0; i < all.length; i++) if (!all[i].closest("[data-view][hidden]")) return all[i];
    return null;
  }

  function readPref(key, fallback) {
    try { return localStorage.getItem(key) || fallback; } catch (_) { return fallback; }
  }
  function writePref(key, value) {
    try { localStorage.setItem(key, value); } catch (_) { /* private mode: keep it in memory only */ }
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  // ---------- Formatting ----------

  function ago(iso) {
    if (!iso) return "";
    var then = new Date(iso);
    var mins = Math.round((Date.now() - then.getTime()) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return mins + " min ago";
    if (mins < 24 * 60) return Math.round(mins / 60) + " h ago";
    var time = then.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (mins < 48 * 60) return "yesterday " + time;
    return then.toLocaleDateString([], { day: "numeric", month: "short" }) + " " + time;
  }

  function until(iso) {
    var d = new Date(iso);
    var sameDay = d.toDateString() === new Date().toDateString();
    var time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return sameDay ? "today " + time : d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }) + " " + time;
  }

  function spaceLabel(id) {
    for (var i = 0; i < SPACES.length; i++) if (SPACES[i].id === id) return SPACES[i].label;
    return id;
  }

  function isEmail(item) {
    return !!item.messages && item.messages.source === "gmail";
  }

  function isDocNotice(item) {
    return isEmail(item) && item.messages.author_id === DOCS_NOTICES;
  }

  function myEmail(item) {
    var account = state.accounts[item.space];
    return account && account.email ? account.email : "";
  }

  // Sends a Google link to the right account when the browser is signed in to several.
  function withAccount(url, item) {
    var email = myEmail(item);
    if (!url || !email) return url;
    return url + (url.indexOf("?") >= 0 ? "&" : "?") + "authuser=" + encodeURIComponent(email);
  }

  function docNotice(item) {
    if (!isDocNotice(item)) return null;
    var doc = F.parseDocNotice(item.messages.subject, item.messages.body, myEmail(item));
    return doc.comments.length ? doc : null;
  }

  function authorLabel(item) {
    var m = item.messages || {};
    if (isEmail(item)) return String(m.author_name || m.author_id || "Someone").replace(/\s*\((Google [A-Za-z]+)\)\s*$/, "");
    var p = state.people[item.space + ":" + m.author_id];
    return (p && p.name ? p.name : "Someone") + (p && p.is_vip ? " ★" : "");
  }

  function whereLabel(item) {
    var m = item.messages || {};
    if (isEmail(item)) {
      var app = /\((Google [A-Za-z]+)\)\s*$/.exec(m.author_name || "");
      return isDocNotice(item) && app ? app[1] + " comment" : "Email";
    }
    if (m.channel_type === "im") return "Direct message";
    if (m.channel_type === "mpim") return "Group message";
    var c = state.channels[item.space + ":" + m.channel_id];
    return "#" + (c && c.name ? c.name : "channel");
  }

  // Opens the thread in the right Google account, whichever accounts the browser is signed in to.
  function gmailLink(item) {
    var m = item.messages || {};
    var account = state.accounts[item.space];
    if (!account || !account.email || !m.channel_id || !/^[0-9a-f]+$/i.test(m.channel_id)) return null;
    return "https://mail.google.com/mail/?authuser=" + encodeURIComponent(account.email) + "#all/" + m.channel_id;
  }

  function fromNotes(item) {
    return item.origin === "notes";
  }

  // What an item from meetings rests on: one entry per place it was written down
  // (the written notes, Granola), each with its own words and link.
  function sourcesOf(item) {
    var list = Array.isArray(item.sources) ? item.sources.filter(function (x) { return x && x.label; }) : [];
    if (!list.length && (item.source_label || item.quote)) {
      list = [{ label: item.source_label || "Meeting notes", url: item.source_url, quote: item.quote, meeting_on: item.meeting_on }];
    }
    return list;
  }

  function isGranola(source) {
    return /^granola\b/i.test(String(source.label || ""));
  }

  function meetingDay(value) {
    return value ? new Date(value + "T12:00:00").toLocaleDateString([], { day: "numeric", month: "short" }) : null;
  }

  // One link per source that has one.
  function sourceLinks(item) {
    if (!fromNotes(item)) {
      var one = sourceLink(item);
      return one ? [one] : [];
    }
    var seen = {};
    var links = [];
    sourcesOf(item).forEach(function (x) {
      var href = x.url ? F.safeUrl(x.url) : null;
      if (!href || seen[href]) return;
      seen[href] = true;
      links.push({ href: href, label: isGranola(x) ? "Open Granola" : "Open notes", name: x.label });
    });
    return links;
  }

  function sourceLink(item) {
    if (fromNotes(item)) return sourceLinks(item)[0] || null;
    var doc = docNotice(item);
    if (doc && doc.fileUrl) return { href: withAccount(doc.fileUrl, item), label: "Open file" };
    if (isEmail(item)) {
      var g = gmailLink(item);
      return g ? { href: g, label: "Open in Gmail" } : null;
    }
    var s = slackLink(item);
    return s ? { href: s, label: "Open in Slack" } : null;
  }

  function slackLink(item) {
    var m = item.messages || {};
    var account = state.accounts[item.space];
    if (!account || !account.slack_url || !m.channel_id || !m.ts) return null;
    var base;
    try { base = new URL(account.slack_url); } catch (_) { return null; }
    if (base.protocol !== "https:" || !/\.slack\.com$/.test(base.hostname)) return null;
    var link = "https://" + base.hostname + "/archives/" + encodeURIComponent(m.channel_id) + "/p" + String(m.ts).replace(".", "");
    if (m.thread_ts && m.thread_ts !== m.ts) {
      link += "?thread_ts=" + encodeURIComponent(m.thread_ts) + "&cid=" + encodeURIComponent(m.channel_id);
    }
    return link;
  }

  // ---------- Which list an item belongs to ----------

  function bucket(item) {
    var home = item.lane === "waiting" ? "waiting" : item.lane === "commitment" ? (item.kind === "decision" ? "decision" : "commit") : "look";
    if (item.status === "open") return home;
    if (item.status === "snoozed") {
      if (item.snooze_until && new Date(item.snooze_until).getTime() > Date.now()) return "later";
      return home; // its time has come
    }
    return "closed";
  }

  // When the thing happened: the message's time, or else when the Desk made the item.
  function stamp(item) {
    var t = Date.parse((item.messages && item.messages.occurred_at) || item.created_at);
    return isNaN(t) ? 0 : t;
  }

  function newest(a, b) {
    return stamp(b) - stamp(a);
  }

  // ---------- Search ----------

  // Lower case with accents removed, so "Sao" finds "São".
  function plain(text) {
    return String(text === undefined || text === null ? "" : text).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  }

  var needles = []; // the words typed in the search box, for the draw in progress

  // True when every typed word appears somewhere in the given pieces of text.
  function hit(parts) {
    if (!needles.length) return true;
    var text = plain(parts.filter(function (x) { return x !== undefined && x !== null && x !== ""; }).join(" \n "));
    return needles.every(function (w) { return text.indexOf(w) >= 0; });
  }

  function itemParts(item) {
    var parts = [item.title, item.summary, item.reason, item.theme, item.owed_to];
    if (item.messages) {
      var m = item.messages;
      parts.push(authorLabel(item), whereLabel(item), m.subject, m.body);
    }
    sourcesOf(item).forEach(function (x) { parts.push(x.label, x.quote, x.detail); });
    return parts;
  }

  function taskParts(task) {
    var parts = [task.title, task.context, task.notes, projectName(task)];
    if (task.urgent && task.status === "open") parts.push("urgent");
    (Array.isArray(task.steps) ? task.steps : []).forEach(function (x) { parts.push(x && x.text); });
    (Array.isArray(task.links) ? task.links : []).forEach(function (x) { parts.push(x && x.label); });
    return parts;
  }

  function planParts(p) {
    var review = p.review && typeof p.review === "object" ? p.review : {};
    var parts = [p.name, p.what, p.next_step, p.depends_on, p.people, p.tools, p.standing];
    (Array.isArray(review.next_steps) ? review.next_steps : []).forEach(function (x) { parts.push(x); });
    (Array.isArray(review.suggested_tasks) ? review.suggested_tasks : []).forEach(function (x) { parts.push(x); });
    return parts;
  }

  function meetingParts(m) {
    var parts = [m.title, m.brief];
    (Array.isArray(m.attendees) ? m.attendees : []).forEach(function (a) { if (a) parts.push(personName(a)); });
    openOwed(m).forEach(function (o) { parts.push(o.title); });
    return parts;
  }

  function clearSearch() {
    clearTimeout(state.searchTimer);
    state.query = "";
    $("search").value = "";
  }

  // ---------- Rendering ----------

  function button(label, className, onClick) {
    var b = el("button", className, label);
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
  }

  function linkTo(href, label, className) {
    var a = el("a", className, label);
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    return a;
  }

  function appendTokens(parent, tokens) {
    tokens.forEach(function (t) {
      if (t.t === "link") {
        var a = linkTo(t.href, (t.v || F.host(t.href)) + " ↗", "chip");
        a.title = F.host(t.href);
        parent.appendChild(a);
      } else if (t.t === "bold") parent.appendChild(el("strong", null, t.v));
      else if (t.t === "italic") parent.appendChild(el("em", null, t.v));
      else if (t.t === "code") parent.appendChild(el("code", null, t.v));
      else if (t.t === "mention") parent.appendChild(el("span", "mention", t.v));
      else parent.appendChild(document.createTextNode(t.v));
    });
  }

  function appendBlocks(parent, blocks) {
    blocks.forEach(function (lines) {
      var p = el("p", "para");
      lines.forEach(function (tokens, i) {
        if (i) p.appendChild(document.createElement("br"));
        if (tokens.quote) {
          var q = el("span", "quoted");
          appendTokens(q, tokens);
          p.appendChild(q);
        } else {
          appendTokens(p, tokens);
        }
      });
      parent.appendChild(p);
    });
  }

  // What you see when a fold is open. Every fold uses this one box, so open content always looks the same.
  function foldIn(details) {
    var box = el("div", "fold-body");
    details.appendChild(box);
    return box;
  }

  // A Google Docs, Sheets or Slides notice: the file, each comment, and a link to it. Nothing else.
  function docView(item, doc) {
    var box = el("details", "message doc");
    box.appendChild(el("summary", null, doc.comments.length === 1 ? "1 comment" : doc.comments.length + " comments"));
    var inner = foldIn(box);
    inner.appendChild(el("p", "file", doc.file));
    doc.comments.forEach(function (c) {
      var one = el("div", "comment");
      var head = el("p", "comment-head", c.author);
      if (c.anchor) head.appendChild(el("span", "anchor", " on \u201c" + c.anchor + "\u201d"));
      one.appendChild(head);
      appendBlocks(one, F.emailBlocks(c.text));
      if (c.url) one.appendChild(linkTo(withAccount(c.url, item), "Open comment ↗", "chip"));
      inner.appendChild(one);
    });
    return box;
  }

  // The message itself, cleaned up, behind a fold. Emails lose quoted history, signature and footer;
  // "Show everything" brings the full text back.
  function originalView(item) {
    var m = item.messages;
    var more = el("details", "message");
    more.appendChild(el("summary", null, item.lane === "commitment" ? "What you wrote" : isEmail(item) ? "Original email" : "Original message"));
    var inner = foldIn(more);
    var body = el("div", "body");
    if (!isEmail(item)) {
      appendBlocks(body, F.slackBlocks(m.body, {
        me: (state.accounts[item.space] || {}).slack_user_id || "",
        person: function (id) { var p = state.people[item.space + ":" + id]; return p && p.name ? p.name : null; },
        channel: function (id) { var c = state.channels[item.space + ":" + id]; return c && c.name ? c.name : null; },
      }));
      inner.appendChild(body);
      return more;
    }
    if (m.subject) inner.appendChild(el("p", "subject", m.subject));
    var cleaned = F.cleanEmail(m.body);
    appendBlocks(body, F.emailBlocks(cleaned.text));
    inner.appendChild(body);
    if (cleaned.cut) {
      var full = el("p", "body raw", cleaned.full);
      full.hidden = true;
      var toggle = button("Show everything", "quiet", function () {
        full.hidden = !full.hidden;
        body.hidden = !full.hidden;
        toggle.textContent = full.hidden ? "Show everything" : "Show the short version";
      });
      inner.appendChild(full);
      inner.appendChild(toggle);
    }
    return more;
  }

  function dueLabel(day) {
    if (!day) return null;
    var due = new Date(day + "T12:00:00");
    var today = new Date(); today.setHours(12, 0, 0, 0);
    var days = Math.round((due.getTime() - today.getTime()) / DAY);
    if (days < 0) return { text: "Overdue since " + due.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }), late: true };
    if (days === 0) return { text: "Due today", late: true };
    if (days === 1) return { text: "Due tomorrow", late: false };
    return { text: "Due " + due.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }), late: false };
  }

  function taskFor(item) {
    for (var i = 0; i < state.tasks.length; i++) if (state.tasks[i].source_item_id === item.id) return state.tasks[i];
    return null;
  }

  // ---------- Confirmation: a brief stamp on the card, then a note with Undo ----------

  var calm = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  // Stamps the card or row ("✓ Done"), holds it for a moment, then folds it away.
  function leave(node, label, tone) {
    return new Promise(function (resolve) {
      if (!node || calm) { resolve(); return; }
      node.classList.add("confirmed", tone);
      node.appendChild(el("div", "stamp", label));
      setTimeout(function () {
        node.style.height = node.offsetHeight + "px";
        void node.offsetHeight; // fix the starting height before it shrinks
        node.classList.add("leaving");
        node.style.height = "0px";
        setTimeout(resolve, 300);
      }, 420);
    });
  }

  var toastTimer = null;
  function toast(text, undo) {
    $("toast-text").textContent = text;
    var again = $("toast-undo");
    again.hidden = !undo;
    again.onclick = undo ? function () { $("toast").hidden = true; undo(); } : null;
    $("toast").hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { $("toast").hidden = true; }, 6000);
  }

  function closedHow(item) {
    if (item.closed_by === "merged") return "Folded into the same item from another source";
    if (item.status === "dismissed") return "Dismissed";
    if (item.closed_by === "reply") return "You replied";
    if (item.closed_by === "reaction") return "You marked it with a check";
    return "Marked done";
  }

  // `where` names the place the card is drawn in ("inbox", "today", "sug"); cards that can be started carry a Start button.
  function card(item, kind, where) {
    var m = item.messages || {};
    var node = el("article", "card urgency-" + item.urgency);
    node.setAttribute("data-item", item.id);

    var top = el("div", "card-top");
    top.appendChild(el("span", "tag tag-" + item.space, spaceLabel(item.space)));
    if (kind === "commit" && item.theme) top.appendChild(el("span", "kind theme-tag", item.theme));
    var promise = item.lane === "commitment";
    var due = promise ? dueLabel(item.due_on) : null;
    if (due && kind !== "closed") {
      top.appendChild(el("span", "flag flag-" + (due.late ? 3 : 2), due.text));
    } else if ((kind === "waiting" || kind === "look") && item.urgency >= 2) {
      top.appendChild(el("span", "flag flag-" + item.urgency, item.urgency === 3 ? "Today" : "Soon"));
    }
    if (kind === "waiting" || kind === "look") {
      top.appendChild(el("span", "kind lane-tag lane-" + kind, kind === "waiting" ? "Needs you" : "FYI"));
    }
    var meta;
    if (fromNotes(item)) {
      var KINDS = { promise: "Promise", todo: "To-do", decision: "Decision" };
      top.appendChild(el("span", "kind", KINDS[item.kind] || "To-do"));
      var met = meetingDay(item.meeting_on);
      var from = sourcesOf(item);
      var where = from.length > 1
        ? (from.some(isGranola) && !from.every(isGranola) ? "Notes and Granola" : from.length + " sources")
        : (from[0] ? from[0].label : "Meeting notes");
      meta = (item.kind === "promise" && item.owed_to ? "Promised to " + item.owed_to + " · " : "") + where + (met ? " · meeting of " + met : "");
    } else {
      meta = (promise ? "Promised to " + (item.owed_to || "someone") : authorLabel(item)) + " · " + whereLabel(item) + " · " + ago(m.occurred_at || item.created_at);
    }
    top.appendChild(el("span", "meta", meta));
    node.appendChild(top);

    node.appendChild(el("h3", "title", item.title));
    if (kind === "closed") {
      node.appendChild(el("p", "reason", closedHow(item) + " · " + ago(item.closed_at)));
    } else if (kind === "later") {
      node.appendChild(el("p", "reason", "Back " + until(item.snooze_until)));
    } else if (!item.summary && item.reason && !promise) {
      node.appendChild(el("p", "reason", item.reason));
    }
    if (item.summary) node.appendChild(el("p", "gist", item.summary));

    var doc = docNotice(item);
    if (fromNotes(item)) {
      var told = sourcesOf(item).filter(function (x) { return x.quote || x.detail; });
      if (told.length) {
        var said = el("details", "message");
        said.appendChild(el("summary", null, told.length > 1 ? "From the meeting · " + told.length + " sources" : "From the notes"));
        var saidIn = foldIn(said);
        told.forEach(function (x) {
          var block = el("div", "said");
          var day = meetingDay(x.meeting_on);
          block.appendChild(el("p", "said-from", x.label + (day ? " · " + day : "")));
          if (x.quote) block.appendChild(el("p", "body", x.quote));
          // What the summary above already says is not repeated.
          if (x.detail && x.detail !== item.summary) block.appendChild(el("p", "said-detail", x.detail));
          saidIn.appendChild(block);
        });
        node.appendChild(said);
      }
    } else if (doc) node.appendChild(docView(item, doc));
    else if (m.body) node.appendChild(originalView(item));

    var actions = el("div", "actions");
    sourceLinks(item).forEach(function (link) {
      actions.appendChild(linkTo(link.href, link.label, "btn"));
    });
    var canStart = !!where && (kind === "waiting" || kind === "look" || kind === "commit");
    var startBtn = canStart ? startControl("item", item.id, "btn") : null;
    if (kind === "decision") {
      actions.appendChild(button("Noted", "btn", function () { act(item.id, "done"); }));
      actions.appendChild(button("Dismiss", "btn subtle", function () { act(item.id, "dismiss"); }));
    } else if (kind === "commit") {
      // A suggested task: turn it into a task, or say it is done or not a task.
      if (taskFor(item)) {
        actions.appendChild(el("span", "made", "In your tasks"));
      } else {
        var add = button("Add as task", "btn", function () { taskFromItem(item, add); });
        actions.appendChild(add);
      }
      if (startBtn) actions.appendChild(startBtn);
      actions.appendChild(button("Already done", "btn", function () { act(item.id, "done"); }));
      actions.appendChild(laterControl(item, "btn subtle"));
      actions.appendChild(button("Not a task", "btn subtle", function () { act(item.id, "dismiss"); }));
    } else if (kind === "waiting" || kind === "look") {
      actions.appendChild(button("Done", "btn", function () { act(item.id, "done"); }));
      actions.appendChild(laterControl(item, "btn"));
      if (taskFor(item)) {
        actions.appendChild(el("span", "made", "In your tasks"));
      } else {
        var make = button("Make a task", "btn subtle", function () { taskFromItem(item, make); });
        actions.appendChild(make);
      }
      if (startBtn) actions.appendChild(startBtn);
      actions.appendChild(button("Dismiss", "btn subtle", function () { act(item.id, "dismiss"); }));
    } else {
      actions.appendChild(button("Reopen", "btn", function () { act(item.id, "reopen"); }));
    }
    node.appendChild(actions);
    if (canStart) {
      var panel = startPanel("item", item.id, where);
      if (panel) node.appendChild(panel);
    }
    return node;
  }

  // "Later" and the times it offers, as one control.
  function laterControl(item, className) {
    var later = el("span", "later");
    later.appendChild(button("Later", className, function () { later.classList.toggle("open"); }));
    var choices = el("span", "choices");
    laterChoices().forEach(function (c) {
      choices.appendChild(button(c.label, "btn small", function () { act(item.id, "snooze", c.at.toISOString()); }));
    });
    later.appendChild(choices);
    return later;
  }

  function laterChoices() {
    var now = new Date();
    var inThree = new Date(now.getTime() + 3 * 60 * 60 * 1000);
    var tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1); tomorrow.setHours(8, 0, 0, 0);
    var monday = new Date(now); monday.setDate(now.getDate() + ((8 - now.getDay()) % 7 || 7)); monday.setHours(8, 0, 0, 0);
    var out = [{ label: "In 3 hours", at: inThree }, { label: "Tomorrow 8:00", at: tomorrow }];
    if (monday.toDateString() !== tomorrow.toDateString()) out.push({ label: "Monday 8:00", at: monday });
    return out;
  }

  function fill(listId, countId, items, kind, emptyText) {
    var list = $(listId);
    list.textContent = "";
    $(countId).textContent = items.length ? String(items.length) : "";
    if (!items.length) {
      if (emptyText && !needles.length) list.appendChild(el("p", "empty", emptyText));
      return;
    }
    items.forEach(function (item) { list.appendChild(card(item, kind)); });
  }

  // Decisions are shown under the theme they belong to.
  function themeBlocks(list, items, kind) {
    var themes = {};
    var order = [];
    items.forEach(function (item) {
      var name = (item.theme || "").trim() || "Other";
      var key = name.toLowerCase();
      if (!themes[key]) { themes[key] = { name: name, items: [] }; order.push(key); }
      themes[key].items.push(item);
    });
    order.sort(function (a, b) {
      if ((a === "other") !== (b === "other")) return a === "other" ? 1 : -1;
      return themes[b].items.length - themes[a].items.length || (a < b ? -1 : 1);
    });
    order.forEach(function (key) {
      list.appendChild(el("h3", "theme", themes[key].name + " · " + themes[key].items.length));
      themes[key].items.forEach(function (item) { list.appendChild(card(item, kind)); });
    });
  }

  function fillByTheme(listId, countId, items, kind) {
    var list = $(listId);
    list.textContent = "";
    $(countId).textContent = items.length ? String(items.length) : "";
    themeBlocks(list, items, kind);
  }

  // The tray of suggested tasks: one list, newest first. The theme shows as a small tag on each card.
  function fillSuggested(items) {
    var list = $("list-suggested");
    list.textContent = "";
    $("n-suggested").textContent = items.length ? String(items.length) : "";
    items.forEach(function (item) { list.appendChild(card(item, "commit", "sug")); });
  }

  // ---------- Inbox: four sections ----------

  // True when a Slack message came from one of the key people of its organisation.
  function fromKeyPerson(item) {
    var m = item.messages || {};
    if (m.source === "gmail" || !m.author_id) return false;
    var p = state.people[item.space + ":" + m.author_id];
    return !!(p && p.is_key);
  }

  // The first section's title: the first names of the key people of the organisation in the filter.
  function keyTitle() {
    if (state.filter === "all") return "Key people";
    var names = [];
    Object.keys(state.people).forEach(function (k) {
      var p = state.people[k];
      if (!p.is_key || p.space !== state.filter || !p.name) return;
      var first = String(p.name).trim().split(/\s+/)[0];
      if (first && names.indexOf(first) < 0) names.push(first);
    });
    names.sort();
    if (!names.length) return "Key people";
    if (names.length === 1) return names[0];
    return names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
  }

  function inboxSection(id, name, entries) {
    var box = el("details", "tsec");
    box.setAttribute("data-inbox", id);
    var head = el("summary", "tsec-head");
    head.appendChild(el("span", "tsec-name", name));
    head.appendChild(el("span", "count", String(entries.length)));
    box.appendChild(head);
    var body = el("div", "tsec-body");
    if (!entries.length) body.appendChild(el("p", "empty", "Nothing here"));
    entries.forEach(function (e) { body.appendChild(card(e.item, e.kind, "inbox")); });
    box.appendChild(body);
    box.open = needles.length ? true : state.openInbox[id] !== false; // all start open
    head.addEventListener("click", function () { state.openInbox[id] = !box.open; });
    return box;
  }

  // Waiting and worth-a-look items go into four sections, newest first. Returns how many cards are shown.
  function renderInbox(waiting, look) {
    var all = waiting.map(function (i) { return { item: i, kind: "waiting" }; })
      .concat(look.map(function (i) { return { item: i, kind: "look" }; }));
    all.sort(function (a, b) { return newest(a.item, b.item); });
    var parts = { key: [], others: [], channels: [], email: [] };
    all.forEach(function (e) {
      if (isEmail(e.item)) parts.email.push(e);
      else if (fromKeyPerson(e.item)) parts.key.push(e);
      else if (e.kind === "waiting") parts.others.push(e);
      else parts.channels.push(e);
    });
    var defs = [
      { id: "key", name: keyTitle(), col: 0 },
      { id: "others", name: "Other DMs and mentions", col: 0 },
      { id: "channels", name: "Key channels", col: 1 },
      { id: "email", name: "Email and Google Drive", col: 1 },
    ];
    var grid = $("list-inbox");
    grid.textContent = "";
    var cols = [el("div", "inbox-col"), el("div", "inbox-col")];
    var shown = 0;
    defs.forEach(function (d) {
      if (needles.length && !parts[d.id].length) return; // a section with nothing that matches is hidden
      shown += parts[d.id].length;
      cols[d.col].appendChild(inboxSection(d.id, d.name, parts[d.id]));
    });
    grid.appendChild(cols[0]);
    grid.appendChild(cols[1]);
    return shown;
  }

  // Which view an item lives in: suggested tasks in Tasks, decisions in Planning, the rest in Inbox.
  function viewFor(item) {
    if (item.lane !== "commitment") return "inbox";
    return item.kind === "decision" ? "planning" : "tasks";
  }

  // The folds that are part of the page itself. Your choice is remembered; while a search is on,
  // a fold that holds a match is shown open.
  var FOLDS = ["box-suggested", "box-later-sug", "box-closed-sug", "box-decisions", "box-later", "box-closed", "box-tasks-done"];

  // On a wide screen the tray of suggested tasks is open until you close it; on a phone it is closed until you open it.
  function wide() {
    return !!(window.matchMedia && window.matchMedia("(min-width: 1000px)").matches);
  }

  function setFold(id, hasMatch) {
    var chosen = state.folds[id];
    if (chosen === undefined && id === "box-suggested") chosen = wide();
    $(id).open = needles.length ? !!hasMatch : !!chosen;
  }

  function showView(id) {
    state.view = id;
    render();
    window.scrollTo(0, 0);
  }

  function render() {
    var typing = captureDraftFocus();
    needles = plain(state.query).split(/\s+/).filter(Boolean);
    var searching = needles.length > 0;
    var found = 0;
    var groups = { waiting: [], commit: [], decision: [], look: [], later: [], closed: [] };
    var waitingBySpace = {};
    state.items.forEach(function (item) {
      var b = bucket(item);
      if (b === "waiting") waitingBySpace[item.space] = (waitingBySpace[item.space] || 0) + 1;
      if (state.filter !== "all" && item.space !== state.filter) return;
      groups[b].push(item);
    });
    var waitingCount = groups.waiting.length; // the tab count ignores the search
    // Later and Closed follow the section: suggestions in Tasks, decisions in Planning, everything else in Inbox.
    ["later", "closed"].forEach(function (k) {
      groups[k] = groups[k].filter(function (item) { return viewFor(item) === state.view; });
    });
    if (searching) {
      Object.keys(groups).forEach(function (k) { groups[k] = groups[k].filter(function (item) { return hit(itemParts(item)); }); });
    }
    groups.waiting.sort(newest);
    groups.look.sort(newest);
    groups.commit.sort(newest);
    groups.later.sort(function (a, b) { return a.snooze_until < b.snooze_until ? -1 : 1; });
    groups.closed.sort(function (a, b) { return a.closed_at > b.closed_at ? -1 : 1; });

    var inboxRows = renderInbox(groups.waiting, groups.look);
    fillSuggested(groups.commit);
    $("box-suggested").hidden = !(groups.commit.length || groups.later.length || groups.closed.length);
    $("n-suggested").textContent = String(groups.commit.length);
    fillByTheme("list-decisions", "n-decisions", groups.decision, "decision");
    $("box-decisions").hidden = !groups.decision.length;
    var taskRows = renderTasks();
    // In Tasks, Later and Closed for the suggestions sit inside the tray; elsewhere they sit at the bottom.
    var inTasks = state.view === "tasks";
    fill("list-later", "n-later", inTasks ? [] : groups.later, "later", null);
    fill("list-closed", "n-closed", inTasks ? [] : groups.closed, "closed", null);
    fill("list-later-sug", "n-later-sug", inTasks ? groups.later : [], "later", null);
    fill("list-closed-sug", "n-closed-sug", inTasks ? groups.closed : [], "closed", null);
    $("box-later-sug").hidden = !(inTasks && groups.later.length);
    $("box-closed-sug").hidden = !(inTasks && groups.closed.length);
    var planRows = renderPlanning();
    var meetingCards = renderMeetings();
    var noteRows = renderNotes();
    var todayRows = renderToday();
    var lists = state.view !== "meetings" && state.view !== "notes";
    $("box-later").hidden = !lists || inTasks || !groups.later.length;
    $("box-closed").hidden = !lists || inTasks || !groups.closed.length;

    // What is on screen in this view, for "N found" and for the sentence when nothing matches.
    found = groups.later.length + groups.closed.length;
    if (state.view === "today") found += todayRows;
    else if (state.view === "inbox") found += inboxRows;
    else if (state.view === "tasks") found += groups.commit.length + taskRows;
    else if (state.view === "planning") found += groups.decision.length + planRows;
    else if (state.view === "notes") found += noteRows;
    else found += meetingCards;

    document.querySelectorAll("[data-view]").forEach(function (section) {
      section.hidden = section.getAttribute("data-view") !== state.view;
    });
    setFold("box-suggested", groups.commit.length || groups.later.length || groups.closed.length);
    setFold("box-later-sug", groups.later.length);
    setFold("box-closed-sug", groups.closed.length);
    setFold("box-decisions", groups.decision.length);
    setFold("box-later", groups.later.length);
    setFold("box-closed", groups.closed.length);
    setFold("box-tasks-done", $("list-tasks-done").children.length);
    if (state.view === "notes") fitNotes(); // measuring needs the view to be showing
    fitDrafts();

    var box = $("search-empty");
    box.hidden = !(searching && !found);
    if (!box.hidden) box.textContent = "Nothing here matches \u201c" + state.query.trim() + "\u201d.";
    $("search-count").textContent = searching ? found + " found" : "";
    $("search-clear").hidden = !$("search").value;

    var openTasks = state.tasks.filter(function (t) {
      return t.status === "open" && (state.filter === "all" || t.space === state.filter);
    }).length;
    var counts = { inbox: waitingCount, tasks: openTasks, meetings: meetingsLeftToday() };
    var views = $("views");
    views.textContent = "";
    VIEWS.forEach(function (v) {
      var b = button(v.label + (counts[v.id] ? " " + counts[v.id] : ""), "view" + (state.view === v.id ? " on" : ""), function () { showView(v.id); });
      b.setAttribute("aria-pressed", state.view === v.id ? "true" : "false");
      views.appendChild(b);
    });

    var totalWaiting = 0;
    Object.keys(waitingBySpace).forEach(function (k) { totalWaiting += waitingBySpace[k]; });
    document.title = (totalWaiting ? "(" + totalWaiting + ") " : "") + "Desk";

    var nav = $("filters");
    nav.textContent = "";
    SPACES.forEach(function (s) {
      var n = s.id === "all" ? totalWaiting : (waitingBySpace[s.id] || 0);
      var b = button(s.label + (n ? " " + n : ""), "filter" + (state.filter === s.id ? " on" : ""), function () {
        state.filter = s.id;
        writePref("desk.space", s.id);
        render();
      });
      b.setAttribute("aria-pressed", state.filter === s.id ? "true" : "false");
      nav.appendChild(b);
    });
    restoreDraftFocus(typing);
  }

  // ---------- Meetings ----------

  var RESPONSES = { needsAction: "Not answered", tentative: "Maybe" };

  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function clock(d) { return pad2(d.getHours()) + ":" + pad2(d.getMinutes()); }

  // An all-day event is stored at noon UTC on its date; the date shown is that UTC date.
  function meetingDate(m) {
    var d = new Date(m.starts_at);
    if (m.all_day) return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    return d;
  }

  function meetingEnd(m) {
    return new Date(m.ends_at || m.starts_at);
  }

  function meetingEnded(m, now) {
    return !m.all_day && meetingEnd(m).getTime() <= now;
  }

  function shownMeetings() {
    return state.meetings.filter(function (m) {
      return m.status !== "cancelled" && m.my_response !== "declined" && (state.filter === "all" || m.space === state.filter);
    });
  }

  function dayStart(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }

  // Timed meetings of today that have not finished yet.
  function meetingsLeftToday() {
    var now = Date.now();
    var today = dayStart(new Date());
    return shownMeetings().filter(function (m) {
      return !m.all_day && dayStart(meetingDate(m)) === today && !meetingEnded(m, now);
    }).length;
  }

  function personName(a) {
    var name = String(a.name || "").trim();
    if (name) return name;
    var email = String(a.email || "").trim();
    return email ? email.split("@")[0] : "";
  }

  function httpsLink(url) {
    var href = url ? F.safeUrl(url) : null;
    return href && href.indexOf("https:") === 0 ? href : null;
  }

  // What you owe for this meeting, leaving out anything that is no longer open.
  function openOwed(m) {
    var out = [];
    (Array.isArray(m.owed) ? m.owed : []).forEach(function (o) {
      if (!o) return;
      if (o.kind === "task") {
        var t = state.tasks.filter(function (x) { return x.id === o.id && x.status === "open"; })[0];
        if (t) out.push({ kind: "task", target: t, title: o.title || t.title, why: o.why });
      } else {
        var i = state.items.filter(function (x) { return x.id === o.id; })[0];
        var b = i ? bucket(i) : "closed";
        if (i && b !== "later" && b !== "closed") out.push({ kind: "item", target: i, title: o.title || i.title, why: o.why });
      }
    });
    return out;
  }

  function goToItem(item) {
    clearSearch(); // what you were looking for may not match the search
    state.view = viewFor(item);
    if (state.filter !== "all" && state.filter !== item.space) {
      state.filter = "all";
      writePref("desk.space", "all");
    }
    render();
    var card = onPage('[data-item="' + item.id + '"]');
    if (!card) return;
    for (var p = card.parentElement; p; p = p.parentElement) {
      if (p.tagName === "DETAILS") {
        p.open = true;
        if (p.id) state.folds[p.id] = true; // stays open across redraws
        if (p.getAttribute("data-inbox")) state.openInbox[p.getAttribute("data-inbox")] = true;
      }
    }
    card.scrollIntoView({ block: "center", behavior: calm ? "auto" : "smooth" });
    card.classList.add("flash");
    setTimeout(function () { card.classList.remove("flash"); }, 2200);
  }

  // Scrolls to a card or row that was just drawn and lights it up for a moment.
  function reveal(node) {
    if (!node) return;
    for (var p = node.parentElement; p; p = p.parentElement) {
      if (p.tagName === "DETAILS") {
        p.open = true;
        if (p.id) state.folds[p.id] = true;
      }
    }
    node.scrollIntoView({ block: "center", behavior: calm ? "auto" : "smooth" });
    node.classList.add("flash");
    setTimeout(function () { node.classList.remove("flash"); }, 2200);
  }

  // Opens Planning with this plan's Details open.
  function goToPlan(plan) {
    clearSearch();
    if (state.filter !== "all" && state.filter !== plan.space) {
      state.filter = "all";
      writePref("desk.space", "all");
    }
    state.openPlans[plan.id] = true;
    showView("planning");
    reveal(onPage('[data-plan="' + plan.id + '"]'));
  }

  // Opens Meetings with this meeting's card in view.
  function goToMeeting(meeting) {
    clearSearch();
    if (state.filter !== "all" && state.filter !== meeting.space) {
      state.filter = "all";
      writePref("desk.space", "all");
    }
    if (meetingEnded(meeting, Date.now())) state.folds.earlier = true; // a finished meeting sits in "Earlier today"
    showView("meetings");
    reveal(onPage('[data-meeting="' + meeting.id + '"]'));
  }

  function isLive(m, now) {
    return !m.all_day && meetingDate(m).getTime() <= now && now < meetingEnd(m).getTime();
  }

  // "Now" while it runs, "In 25 min" in the last hour before it starts.
  function timingFlag(m, now) {
    if (m.all_day) return null;
    if (isLive(m, now)) return el("span", "flag flag-3", "Now");
    var mins = Math.ceil((meetingDate(m).getTime() - now) / 60000);
    return mins > 0 && mins <= 60 ? el("span", "flag flag-2", "In " + mins + " min") : null;
  }

  // "With Ana, Ben and 3 more", or "" when nobody else is invited.
  function withLine(m) {
    var names = (Array.isArray(m.attendees) ? m.attendees : [])
      .filter(function (a) { return a && !a.self; })
      .map(personName).filter(Boolean);
    if (!names.length) return "";
    var shown = names.slice(0, 5).join(", ");
    if (names.length > 5) shown += " +" + (names.length - 5) + " more";
    return "With " + shown;
  }

  // The fold with the brief and what you owe; null when the meeting has neither.
  function meetingFold(m) {
    var owed = openOwed(m);
    if (!m.brief && !owed.length) return null;
    var fold = el("details", "message");
    fold.appendChild(el("summary", null, (m.brief ? "Context" : "") + (m.brief && owed.length ? " · " : "") + (owed.length ? owed.length + " to deliver" : "")));
    var foldBox = foldIn(fold);
    if (m.brief) foldBox.appendChild(el("p", "gist", m.brief));
    if (owed.length) {
      var box = el("div", "owed");
      box.appendChild(el("p", "owed-head", "What you owe"));
      owed.forEach(function (o) {
        var row = el("button", "owed-row");
        row.type = "button";
        row.appendChild(el("span", "owed-title", o.title));
        if (o.why) row.appendChild(el("span", "owed-why", o.why));
        row.addEventListener("click", function () {
          if (o.kind === "task") openTask(o.target); else goToItem(o.target);
        });
        box.appendChild(row);
      });
      foldBox.appendChild(box);
    }
    // The page redraws now and then; remember which folds you opened so they stay open.
    fold.open = !!state.openMeetings[m.id];
    fold.addEventListener("toggle", function () {
      if (fold.open) state.openMeetings[m.id] = true; else delete state.openMeetings[m.id];
    });
    return fold;
  }

  function meetingCard(m, now) {
    var start = meetingDate(m);
    var live = isLive(m, now);
    var node = el("article", "card meeting" + (live ? " in-progress" : ""));
    node.setAttribute("data-meeting", m.id);

    var top = el("div", "card-top");
    top.appendChild(el("span", "tag tag-" + m.space, spaceLabel(m.space)));
    top.appendChild(el("span", "when", m.all_day ? "All day" : clock(start) + " – " + clock(meetingEnd(m))));
    if (m.recurring_event_id) top.appendChild(el("span", "kind", "Repeats"));
    var flag = timingFlag(m, now);
    if (flag) top.appendChild(flag);
    if (RESPONSES[m.my_response]) top.appendChild(el("span", "flag flag-2", RESPONSES[m.my_response]));
    node.appendChild(top);

    node.appendChild(el("h3", "title", m.title || "Meeting"));

    var who = withLine(m);
    if (who) node.appendChild(el("p", "reason", who));
    var fold = meetingFold(m);
    if (fold) node.appendChild(fold);

    var join = httpsLink(m.join_url);
    var cal = httpsLink(m.event_url);
    if (join || cal) {
      var actions = el("div", "actions");
      if (join) actions.appendChild(linkTo(join, "Join", "btn join"));
      if (cal) actions.appendChild(linkTo(cal, "Open in Calendar", "btn"));
      node.appendChild(actions);
    }
    return node;
  }

  function renderMeetings() {
    var list = $("list-meetings");
    list.textContent = "";
    list.className = "";
    var now = Date.now();
    var today = dayStart(new Date());
    var days = {};
    var order = [];
    shownMeetings().forEach(function (m) {
      if (needles.length && !hit(meetingParts(m))) return;
      var key = dayStart(meetingDate(m));
      var offset = Math.round((key - today) / DAY);
      if (offset < 0 || offset > 7) return;
      if (!days[key]) { days[key] = { offset: offset, key: key, meetings: [] }; order.push(key); }
      days[key].meetings.push(m);
    });
    order.sort(function (a, b) { return a - b; });
    var left = meetingsLeftToday();
    $("n-meetings").textContent = left ? left + " to come today" : "";
    if (!order.length) {
      if (!needles.length) list.appendChild(el("p", "empty", "You have no meetings in the next 7 days."));
      return 0;
    }
    var cardsShown = 0;
    // Today goes in the left column, the following days in the right one (one column on a narrow screen).
    var colLeft = el("div", "meet-col");
    var colRight = el("div", "meet-col");
    list.className = "meet-cols";
    list.appendChild(colLeft);
    list.appendChild(colRight);
    if (!needles.length && days[today] === undefined) {
      var none = el("div", "day-none");
      none.appendChild(el("h3", "theme day", "Today"));
      none.appendChild(el("p", "empty", "No meetings today."));
      colLeft.appendChild(none);
    }
    order.forEach(function (key) {
      var column = key === today ? colLeft : colRight;
      var day = days[key];
      var name = day.offset === 0 ? "Today" : day.offset === 1 ? "Tomorrow"
        : new Date(key).toLocaleDateString([], { weekday: "long", day: "numeric", month: "short" });
      column.appendChild(el("h3", "theme day", name));
      var cards = el("div", "list");
      var byTime = function (a, b) {
        if (!!a.all_day !== !!b.all_day) return a.all_day ? -1 : 1;
        return meetingDate(a).getTime() - meetingDate(b).getTime();
      };
      var earlier = [];
      day.meetings.sort(byTime).forEach(function (m) {
        cardsShown++;
        if (day.offset === 0 && meetingEnded(m, now)) earlier.push(m);
        else cards.appendChild(meetingCard(m, now));
      });
      if (cards.children.length) column.appendChild(cards);
      if (earlier.length) {
        var fold = el("details", "earlier");
        var head = el("summary", null, "Earlier today · " + earlier.length);
        head.addEventListener("click", function () { state.folds.earlier = !fold.open; });
        fold.appendChild(head);
        var inner = el("div", "list");
        earlier.forEach(function (m) { inner.appendChild(meetingCard(m, now)); });
        fold.appendChild(inner);
        fold.open = needles.length ? true : !!state.folds.earlier;
        column.appendChild(fold);
      }
    });
    return cardsShown;
  }

  // ---------- Planning ----------

  var STAGES = [
    { id: "in_progress", label: "In progress" },
    { id: "ongoing", label: "Ongoing" },
    { id: "planned", label: "Planned" },
    { id: "idea", label: "Idea" },
    { id: "paused", label: "Paused" },
    { id: "done", label: "Done" },
  ];

  function stageOf(p) {
    return STAGES.some(function (s) { return s.id === p.stage; }) ? p.stage : "idea";
  }

  function stageLabel(p) {
    return STAGES.filter(function (s) { return s.id === stageOf(p); })[0].label;
  }

  function stageRank(p) {
    for (var i = 0; i < STAGES.length; i++) if (STAGES[i].id === stageOf(p)) return i;
    return STAGES.length;
  }

  function openTasksOf(p) {
    return state.tasks.filter(function (t) { return t.project_id === p.id && t.status === "open"; });
  }

  function planDate(day) {
    var d = new Date(day + "T12:00:00");
    var opts = { weekday: "short", day: "numeric", month: "short" };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
    return d.toLocaleDateString([], opts);
  }

  function shortDate(d) {
    return d.getDate() + " " + d.toLocaleDateString([], { month: "short" });
  }

  function suggestionKey(p, text) {
    return p.id + "\n" + String(text).trim().toLowerCase();
  }

  // The review's suggested tasks, without the ones already a task on this plan or already added this session.
  function openSuggestions(p, review, open) {
    var have = {};
    open.forEach(function (t) { have[String(t.title).trim().toLowerCase()] = true; });
    return (Array.isArray(review.suggested_tasks) ? review.suggested_tasks : []).map(function (x) { return String(x || "").trim(); })
      .filter(function (text) { return text && !have[text.toLowerCase()] && !state.doneSuggestions[suggestionKey(p, text)]; });
  }

  function suggestTask(p, text) {
    var task = blankTask(p.space, text);
    task.project = p.name;
    task.context = "Suggested by the review of " + p.name;
    task.fromReview = suggestionKey(p, text);
    showDialog(task, null);
  }

  // Asks Claude to look at the plan again. Takes up to a minute; the rest of the page stays usable.
  async function reviewPlan(p) {
    if (state.reviewing[p.id]) return;
    state.reviewing[p.id] = true;
    render();
    var failed = "The review did not finish. Try again in a minute.";
    try {
      var res = await sb.functions.invoke("plan-review", { body: { plan_id: p.id } });
      if (res.error || !res.data || res.data.ok === false || !res.data.plan) {
        notice(failed);
      } else {
        var now = state.projects.filter(function (x) { return x.id === p.id; })[0] || p;
        now.standing = res.data.plan.standing || null;
        now.review = res.data.plan.review || {};
        now.reviewed_at = res.data.plan.reviewed_at || null;
        state.openPlans[p.id] = true;
        notice("");
      }
    } catch (_) {
      notice(failed);
    }
    delete state.reviewing[p.id];
    render();
  }

  function planCard(p) {
    var node = el("article", "card plan");
    node.setAttribute("data-plan", p.id);
    var top = el("div", "card-top");
    top.appendChild(el("span", "tag tag-" + p.space, spaceLabel(p.space)));
    top.appendChild(el("span", "kind", stageLabel(p)));
    node.appendChild(top);
    node.appendChild(el("h3", "title", p.name));
    var preview = null;
    if (p.what) {
      preview = el("p", "gist clamp", p.what);
      preview.hidden = !!state.openPlans[p.id]; // the fold shows the full text
      node.appendChild(preview);
    }
    var open = openTasksOf(p);
    var review = p.review && typeof p.review === "object" ? p.review : {};
    if (review.attention) {
      var warn = el("p", "reason attention");
      warn.appendChild(el("span", "flag flag-3", "Needs attention"));
      warn.appendChild(document.createTextNode(" " + review.attention));
      node.appendChild(warn);
    }
    if (p.next_step) node.appendChild(el("p", "reason", "Next: " + p.next_step));
    if (p.target_on) node.appendChild(el("p", "reason", "By " + planDate(p.target_on)));
    if (p.depends_on) node.appendChild(el("p", "reason", "After: " + p.depends_on));
    node.appendChild(el("p", "reason", open.length ? open.length + (open.length === 1 ? " open task" : " open tasks") : "No tasks yet"));

    var steps = Array.isArray(review.next_steps) ? review.next_steps.filter(Boolean) : [];
    var suggested = openSuggestions(p, review, open);
    var sources = (Array.isArray(review.sources) ? review.sources : []).filter(function (x) { return x && x.label; });
    var links = (Array.isArray(p.links) ? p.links : []).map(function (l) {
      return l && httpsLink(l.url) ? { href: httpsLink(l.url), label: l.label || F.host(httpsLink(l.url)) } : null;
    }).filter(Boolean);
    var fold = el("details", "message");
    fold.appendChild(el("summary", null, "Details"));
    var inside = foldIn(fold);
    if (p.what) inside.appendChild(el("p", "gist", p.what));
    if (p.standing) {
      inside.appendChild(el("p", "owed-head", "Where it stands"));
      inside.appendChild(el("p", "gist", p.standing));
    }
    if (p.reviewed_at) inside.appendChild(el("p", "fine", "Reviewed " + shortDate(new Date(p.reviewed_at))));
    if (steps.length) {
      inside.appendChild(el("p", "owed-head", "Suggested next steps"));
      var ul = el("ul", "plan-steps");
      steps.forEach(function (t) { ul.appendChild(el("li", null, String(t))); });
      inside.appendChild(ul);
    }
    if (suggested.length) {
      inside.appendChild(el("p", "owed-head", "Suggested tasks"));
      suggested.forEach(function (text) {
        var row = el("div", "plan-suggest");
        row.appendChild(el("span", "plan-suggest-text", text));
        row.appendChild(button("Add as task", "btn small", function () { suggestTask(p, text); }));
        inside.appendChild(row);
      });
    }
    if (sources.length) {
      inside.appendChild(el("p", "owed-head", "From"));
      sources.forEach(function (x) {
        var row = el("p", "plan-source");
        var href = httpsLink(x.url);
        var day = x.date ? new Date(x.date + "T12:00:00") : null;
        var when = day && !isNaN(day.getTime()) ? " · " + shortDate(day) : "";
        if (href) {
          row.appendChild(linkTo(href, x.label + " ↗", "chip"));
          if (when) row.appendChild(document.createTextNode(when));
        } else {
          row.appendChild(document.createTextNode(x.label + when));
        }
        inside.appendChild(row);
      });
    }
    if (review.note) inside.appendChild(el("p", "fine", String(review.note)));
    if (p.people) inside.appendChild(el("p", "reason", "With: " + p.people));
    if (p.tools) inside.appendChild(el("p", "reason", "Tools: " + p.tools));
    if (links.length) {
      var box = el("p", "plan-links");
      links.forEach(function (l) { box.appendChild(linkTo(l.href, l.label + " ↗", "chip")); });
      inside.appendChild(box);
    }
    if (open.length) {
      inside.appendChild(el("p", "owed-head", "Open tasks"));
      open.forEach(function (t) {
        var row = el("div", "plan-task");
        row.appendChild(button(t.title, "ref", function () { openTask(t); }));
        inside.appendChild(row);
      });
    }
    var planNotes = state.notes.filter(function (n) { return n.project_id === p.id; }).sort(notesNewest);
    if (planNotes.length) {
      inside.appendChild(el("p", "owed-head", "Notes"));
      planNotes.slice(0, 3).forEach(function (n) {
        var line = el("div", "plan-note");
        line.appendChild(el("span", "meta", noteDate(n.created_at)));
        line.appendChild(el("p", "plan-note-text", firstLines(n.body)));
        inside.appendChild(line);
      });
      var allNotes = el("p", "plan-links");
      allNotes.appendChild(button("All notes", "btn small", function () { showNotesFor(p); }));
      inside.appendChild(allNotes);
    }
    fold.open = !!state.openPlans[p.id];
    fold.addEventListener("toggle", function () {
      if (fold.open) state.openPlans[p.id] = true; else delete state.openPlans[p.id];
      if (preview) preview.hidden = fold.open;
    });
    node.appendChild(fold);

    var actions = el("div", "actions");
    actions.appendChild(button("Add task", "btn", function () {
      var task = blankTask(p.space, "");
      task.project = p.name;
      showDialog(task, null);
    }));
    actions.appendChild(button("See tasks", "btn", function () {
      state.project = p.id;
      showView("tasks");
    }));
    var again = button(state.reviewing[p.id] ? "Reviewing…" : "Review now", "btn", function () { reviewPlan(p); });
    again.disabled = !!state.reviewing[p.id];
    actions.appendChild(again);
    actions.appendChild(button("Edit", "btn subtle", function () { openPlanDialog(p); }));
    node.appendChild(actions);
    return node;
  }

  function renderPlanning() {
    var visible = state.projects.filter(function (p) { return state.filter === "all" || p.space === state.filter; });
    var plans = visible.filter(function (p) { return p.is_plan && hit(planParts(p)); }).sort(function (a, b) {
      return stageRank(a) - stageRank(b) || (String(a.name).toLowerCase() < String(b.name).toLowerCase() ? -1 : 1);
    });
    var list = $("list-plans");
    list.textContent = "";
    plans.forEach(function (p) { list.appendChild(planCard(p)); });
    if (!plans.length && !needles.length) list.appendChild(el("p", "empty", "You have no plans here yet. Add one for anything that will take more than a single task."));

    var others = visible.filter(function (p) { return !p.is_plan && hit([p.name]); });
    var rest = $("list-projects");
    rest.textContent = "";
    $("box-projects").hidden = !others.length;
    others.forEach(function (p) {
      var row = el("div", "prow");
      var main = el("div", "task-main");
      main.appendChild(el("span", "tag tag-" + p.space, spaceLabel(p.space)));
      main.appendChild(el("span", null, p.name));
      var n = openTasksOf(p).length;
      main.appendChild(el("span", "repeat", n ? n + (n === 1 ? " open task" : " open tasks") : "No tasks yet"));
      row.appendChild(main);
      row.appendChild(button("Make it a plan", "btn small", function () { makePlan(p); }));
      rest.appendChild(row);
    });
    return plans.length + others.length;
  }

  var editingPlan = null; // the plan in the dialog; null while adding one

  function openPlanDialog(p) {
    editingPlan = p || null;
    $("pd-heading").textContent = p ? "Edit plan" : "New plan";
    $("pd-space-box").hidden = !!p || state.filter !== "all";
    $("pd-space").value = p ? p.space : (state.filter !== "all" ? state.filter : readPref("desk.task-space", "metaculus"));
    $("pd-name").value = p ? p.name : "";
    $("pd-stage").value = p ? stageOf(p) : "idea";
    $("pd-what").value = (p && p.what) || "";
    $("pd-next").value = (p && p.next_step) || "";
    $("pd-target").value = (p && p.target_on) || "";
    $("pd-after").value = (p && p.depends_on) || "";
    $("pd-people").value = (p && p.people) || "";
    $("pd-tools").value = (p && p.tools) || "";
    $("pd-error").hidden = true;
    $("pd-form").querySelector(".dlg-body").scrollTop = 0;
    var dialog = $("plan-dialog");
    if (!dialog.open) dialog.showModal();
  }

  async function savePlan() {
    var problem = $("pd-error");
    problem.hidden = true;
    var name = $("pd-name").value.trim();
    if (!name) return;
    var text = function (id) { return $(id).value.trim() || null; };
    var row = {
      name: name,
      stage: $("pd-stage").value,
      what: text("pd-what"),
      next_step: text("pd-next"),
      target_on: $("pd-target").value || null,
      depends_on: text("pd-after"),
      people: text("pd-people"),
      tools: text("pd-tools"),
      updated_at: new Date().toISOString(),
    };
    if (editingPlan) {
      // Shown at once; if the save fails you are told and the real data comes back.
      var current = state.projects.filter(function (p) { return p.id === editingPlan.id; })[0] || editingPlan;
      Object.keys(row).forEach(function (k) { current[k] = row[k]; });
      $("plan-dialog").close();
      render();
      var res = await sb.from("projects").update(row).eq("id", current.id);
      if (res.error) notice("That did not save: " + res.error.message);
      await load();
      return;
    }
    try {
      row.space = $("pd-space").value;
      row.is_plan = true;
      var made = await sb.from("projects").insert(row);
      if (made.error) throw new Error(made.error.message);
    } catch (err) {
      problem.textContent = "Not saved: " + (err && err.message ? err.message : "unknown error");
      problem.hidden = false;
      return;
    }
    $("plan-dialog").close();
    await load();
  }

  async function makePlan(p) {
    p.is_plan = true;
    p.updated_at = new Date().toISOString();
    render();
    openPlanDialog(p);
    var res = await sb.from("projects").update({ is_plan: true, updated_at: p.updated_at }).eq("id", p.id);
    if (res.error) notice("That did not save: " + res.error.message);
    await load();
  }

  // ---------- Tasks ----------

  var HORIZONS = [
    { id: "today", label: "Today" },
    { id: "week", label: "This week" },
    { id: "weeks", label: "Next 2-3 weeks" },
    { id: "later", label: "Later" },
  ];
  var REPEAT_PILL = { daily: "daily", weekly: "weekly", biweekly: "every 2 weeks", monthly: "monthly" };

  function projectName(task) {
    return task.projects && task.projects.name ? task.projects.name : null;
  }

  function localDay(date) {
    var d = date || new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  // Whole days from today to a date ("2026-11-14"); negative when it has passed.
  function daysFrom(day) {
    var due = new Date(day + "T12:00:00");
    var today = new Date(); today.setHours(12, 0, 0, 0);
    return Math.round((due.getTime() - today.getTime()) / DAY);
  }

  function horizonOf(task) {
    return HORIZONS.some(function (h) { return h.id === task.horizon; }) ? task.horizon : "week";
  }

  // The small due-date pill: "overdue 12d", "due today", "due tomorrow", "due Fri", "due 14 Nov".
  function duePill(day) {
    var n = daysFrom(day);
    var d = new Date(day + "T12:00:00");
    if (n < 0) return { text: "overdue " + (-n) + "d", tone: "pill-late" };
    if (n === 0) return { text: "due today", tone: "pill-today" };
    if (n === 1) return { text: "due tomorrow", tone: "" };
    if (n <= 6) return { text: "due " + d.toLocaleDateString([], { weekday: "short" }), tone: "" };
    return { text: "due " + shortDate(d), tone: "" };
  }

  // A sentence for a task that is long overdue.
  function lateNote(task) {
    if (task.status !== "open" || !task.due_on) return null;
    var late = -daysFrom(task.due_on);
    if (late < 7) return null;
    var text = "Overdue by " + late + " days (was due " + shortDate(new Date(task.due_on + "T12:00:00")) + ").";
    if (task.slips >= 2 && task.first_due_on) text += " First due " + shortDate(new Date(task.first_due_on + "T12:00:00")) + ".";
    return text;
  }

  function pills(task) {
    var open = task.status === "open";
    var box = el("div", "pills");
    box.appendChild(el("span", "pill tag-" + task.space, spaceLabel(task.space)));
    if (projectName(task)) {
      box.appendChild(button(projectName(task), "pill project-pill", function () {
        state.project = task.project_id;
        render();
      }));
    }
    if (open && task.urgent) box.appendChild(el("span", "pill pill-urgent", "Urgent"));
    if (open && task.due_on) {
      var due = duePill(task.due_on);
      box.appendChild(el("span", "pill " + due.tone, due.text));
    }
    if (open && task.slips >= 2) box.appendChild(el("span", "pill pill-slip", "slipped " + task.slips + "x"));
    if (task.repeat && REPEAT_PILL[task.repeat]) box.appendChild(el("span", "pill", "repeats " + REPEAT_PILL[task.repeat]));
    var steps = Array.isArray(task.steps) ? task.steps : [];
    if (steps.length && open) {
      box.appendChild(el("span", "pill", steps.filter(function (x) { return x.done; }).length + "/" + steps.length + " steps"));
    }
    return box;
  }

  // The first line of the background, for the one muted line under the pills.
  function why(task) {
    var lines = String(task.context || "").split("\n").map(function (l) { return l.trim(); }).filter(Boolean);
    return lines.length ? lines[0].slice(0, 300) : "";
  }

  // The source line ("From: ...") shared by the task dialog and the open task. False when the item is gone.
  function writeSource(node, itemId) {
    node.textContent = "";
    node.hidden = true;
    var from = itemId ? state.items.filter(function (i) { return i.id === itemId; })[0] : null;
    if (!from) return false;
    node.hidden = false;
    var lead = fromNotes(from) ? (from.kind === "promise" ? "From your promise in a meeting: " : from.kind === "decision" ? "From a decision in a meeting: " : "From a meeting: ")
      : from.lane === "commitment" ? "From your promise: " : "From: ";
    node.appendChild(document.createTextNode(lead + from.title + " "));
    sourceLinks(from).forEach(function (link) {
      node.appendChild(linkTo(link.href, link.label + " ↗", "chip"));
      node.appendChild(document.createTextNode(" "));
    });
    return true;
  }

  // One line of related work: another task, a suggestion or an inbox item.
  function relatedRow(r, inDialog) {
    var row = el("div", "td-link");
    var kind = r.kind === "task" ? "Task" : r.lane === "commitment" ? "Suggested" : "Inbox";
    row.appendChild(el("span", "kind", kind));
    var target = r.kind === "task"
      ? state.tasks.filter(function (t) { return t.id === r.id && t.status === "open"; })[0]
      : state.items.filter(function (i) { return i.id === r.id && (i.status === "open" || i.status === "snoozed"); })[0];
    if (!target) {
      row.appendChild(el("span", "closed-ref", r.title + " (closed)"));
    } else if (r.kind === "task") {
      row.appendChild(button(r.title, "ref", function () { if (inDialog) openTask(target); else goToTask(target); }));
    } else {
      row.appendChild(button(r.title, "ref", function () {
        if (inDialog) $("task-dialog").close();
        goToItem(target);
      }));
    }
    return row;
  }

  function label(text) {
    return el("p", "owed-head", text);
  }

  // What you see when you open a task in the list: everything it holds, read-only.
  function taskDetails(task, row, where) {
    var open = task.status === "open";
    var box = el("div", "fold-body task-open");
    var any = false;
    if (task.context) { box.appendChild(el("p", "gist pre", task.context)); any = true; }
    var steps = Array.isArray(task.steps) ? task.steps : [];
    if (steps.length) {
      any = true;
      box.appendChild(label("Steps"));
      steps.forEach(function (step, i) {
        var line = el("label", "tstep" + (step.done ? " is-done" : ""));
        var tick = document.createElement("input");
        tick.type = "checkbox";
        tick.checked = !!step.done;
        tick.addEventListener("change", function () {
          var next = steps.map(function (x, j) { return { text: String(x.text || ""), done: j === i ? tick.checked : !!x.done }; });
          saveTask(task.id, { steps: next });
        });
        line.appendChild(tick);
        line.appendChild(el("span", null, step.text));
        box.appendChild(line);
      });
    }
    if (task.notes) { any = true; box.appendChild(label("Notes")); box.appendChild(el("p", "gist pre", task.notes)); }
    var links = (Array.isArray(task.links) ? task.links : []).map(function (l) {
      var href = l && l.url ? F.safeUrl(l.url) : null;
      return href ? { href: href, label: l.label || F.host(href) } : null;
    }).filter(Boolean);
    if (links.length) {
      any = true;
      box.appendChild(label("Links"));
      var chips = el("p", "plan-links");
      links.forEach(function (l) { chips.appendChild(linkTo(l.href, l.label + " ↗", "chip")); });
      box.appendChild(chips);
    }
    var from = el("p", "hint");
    if (writeSource(from, task.source_item_id)) { any = true; box.appendChild(from); }
    var related = Array.isArray(task.related) ? task.related : [];
    if (related.length) {
      any = true;
      box.appendChild(label("Related work"));
      related.forEach(function (r) { box.appendChild(relatedRow(r, false)); });
    }
    if (!any) box.appendChild(el("p", "empty", "Nothing more written down yet."));

    var actions = el("div", "actions");
    actions.appendChild(button("Edit", "btn", function () { openTask(task); }));
    if (open) {
      actions.appendChild(button("Done", "btn", function () { finishTask(task, row); }));
      var begin = startControl("task", task.id, "btn");
      if (begin) actions.appendChild(begin);
      actions.appendChild(button("Drop", "btn subtle", function () {
        saveTask(task.id, { status: "dropped", done_at: new Date().toISOString() });
        toast("Task dropped.", function () { saveTask(task.id, { status: "open", done_at: null }); });
      }));
      var urgentBox = el("label", "task-urgent");
      var urgentTick = document.createElement("input");
      urgentTick.type = "checkbox";
      urgentTick.checked = !!task.urgent;
      urgentTick.addEventListener("change", function () { saveTask(task.id, { urgent: urgentTick.checked }); });
      urgentBox.appendChild(urgentTick);
      urgentBox.appendChild(document.createTextNode(" Urgent"));
      actions.appendChild(urgentBox);
      var when = document.createElement("select");
      when.className = "task-when";
      when.setAttribute("aria-label", "Move task");
      HORIZONS.forEach(function (h) {
        var o = el("option", null, "Move to: " + h.label);
        o.value = h.id;
        o.selected = horizonOf(task) === h.id;
        when.appendChild(o);
      });
      when.addEventListener("change", function () { saveTask(task.id, { horizon: when.value }); });
      actions.appendChild(when);
    }
    box.appendChild(actions);
    return box;
  }

  function taskRow(task, where) {
    var isOpen = !!state.openTasks[task.id];
    var row = el("div", "trow" + (task.status === "done" ? " is-done" : "") + (isOpen ? " is-open" : ""));
    row.setAttribute("data-task", task.id);
    var tick = document.createElement("input");
    tick.type = "checkbox";
    tick.className = "round";
    tick.checked = task.status === "done";
    tick.setAttribute("aria-label", task.status === "done" ? "Reopen task" : "Mark task done");
    tick.addEventListener("change", async function () {
      if (!tick.checked) { saveTask(task.id, { status: "open", done_at: null }); return; }
      finishTask(task, row);
    });
    row.appendChild(tick);

    var main = el("div", "trow-main");
    var title = button(task.title, "task-title", function () {});
    title.setAttribute("aria-expanded", isOpen ? "true" : "false");
    main.appendChild(title);
    main.appendChild(pills(task));
    var late = lateNote(task);
    if (late) main.appendChild(el("p", "trow-late", late));
    if (!isOpen && task.context) main.appendChild(el("p", "trow-why", why(task)));
    row.appendChild(main);
    if (task.status === "open") {
      // On a wide screen a small quiet button sits at the right end of the row (hidden by the stylesheet on a phone).
      var rowStart = startControl("task", task.id, "quiet row-start");
      if (rowStart) row.appendChild(rowStart);
    }
    if (isOpen) row.appendChild(taskDetails(task, row, where));
    if (task.status === "open") {
      var startBox = startPanel("task", task.id, where);
      if (startBox) row.appendChild(startBox);
    }

    // Tapping the row opens or closes it in place. Controls inside it do their own thing.
    row.addEventListener("click", function (event) {
      if (event.target.closest("input, a, select, .fold-body, button:not(.task-title)")) return;
      if (state.openTasks[task.id]) delete state.openTasks[task.id]; else state.openTasks[task.id] = true;
      var fresh = taskRow(task, where);
      row.replaceWith(fresh);
      if (event.target.classList.contains("task-title")) fresh.querySelector(".task-title").focus({ preventScroll: true });
    });
    return row;
  }

  // Jumps to a task in the list and opens it.
  function goToTask(task) {
    clearSearch();
    state.view = "tasks";
    if (state.filter !== "all" && state.filter !== task.space) {
      state.filter = "all";
      writePref("desk.space", "all");
    }
    state.project = null;
    state.openSections[horizonOf(task)] = true;
    state.openTasks[task.id] = true;
    render();
    var row = onPage('[data-task="' + task.id + '"]');
    if (!row) return;
    row.scrollIntoView({ block: "center", behavior: calm ? "auto" : "smooth" });
    row.classList.add("flash");
    setTimeout(function () { row.classList.remove("flash"); }, 2200);
  }

  // Tasks with a date first, by date; then the rest, newest first.
  // Urgent tasks come first; inside each group the order above holds.
  function urgentFirst(rows) {
    return rows.filter(function (t) { return t.urgent; }).concat(rows.filter(function (t) { return !t.urgent; }));
  }

  function taskOrder(a, b) {
    if (a.due_on && b.due_on) return a.due_on < b.due_on ? -1 : a.due_on > b.due_on ? 1 : 0;
    if (a.due_on !== b.due_on) return a.due_on ? -1 : 1;
    return Date.parse(b.created_at) - Date.parse(a.created_at);
  }

  // One section as a card: a heading with a count and a caret, then its rows.
  function taskSection(id, name, rows, collapsible) {
    var box = el(collapsible ? "details" : "div", "tsec");
    box.setAttribute("data-section", id);
    var head = el(collapsible ? "summary" : "div", "tsec-head");
    head.appendChild(el("span", "tsec-name", name));
    head.appendChild(el("span", "count", String(rows.length)));
    box.appendChild(head);
    var body = el("div", "tsec-body");
    if (!rows.length) body.appendChild(el("p", "empty", "Nothing here"));
    rows.forEach(function (t) { body.appendChild(taskRow(t, "tasks")); });
    box.appendChild(body);
    if (collapsible) {
      box.open = needles.length ? true : !!state.openSections[id];
      head.addEventListener("click", function () { state.openSections[id] = !box.open; });
    }
    return box;
  }

  // Draws the Tasks list; returns how many rows it shows.
  function renderTasks() {
    var list = $("list-tasks");
    list.textContent = "";
    var inSpace = state.tasks.filter(function (t) { return state.filter === "all" || t.space === state.filter; });
    var openInSpace = inSpace.filter(function (t) { return t.status === "open"; });
    if (state.project && !state.projects.some(function (p) { return p.id === state.project && (state.filter === "all" || p.space === state.filter); })) {
      state.project = null;
    }
    var mine = inSpace.filter(function (t) { return !state.project || t.project_id === state.project; });
    $("n-tasks").textContent = mine.filter(function (t) { return t.status === "open"; }).length || "";
    var shown = needles.length ? mine.filter(function (t) { return hit(taskParts(t)); }) : mine;
    var open = shown.filter(function (t) { return t.status === "open"; });

    // List or by day, then one chip per project with open tasks.
    var tools = $("task-tools");
    tools.textContent = "";
    [{ id: "list", label: "List" }, { id: "days", label: "By day" }].forEach(function (m) {
      var b = button(m.label, "filter" + (state.taskMode === m.id ? " on" : ""), function () {
        state.taskMode = m.id;
        writePref("desk.task-mode", m.id);
        render();
      });
      b.setAttribute("aria-pressed", state.taskMode === m.id ? "true" : "false");
      tools.appendChild(b);
    });
    tools.appendChild(el("span", "gap"));
    var all = button("All projects", "project" + (!state.project ? " on" : ""), function () { state.project = null; render(); });
    tools.appendChild(all);
    state.projects.forEach(function (p) {
      if (state.filter !== "all" && p.space !== state.filter) return;
      var n = openInSpace.filter(function (t) { return t.project_id === p.id; }).length;
      if (!n && state.project !== p.id) return;
      tools.appendChild(button(p.name + " " + n, "project" + (state.project === p.id ? " on" : ""), function () {
        state.project = state.project === p.id ? null : p.id;
        render();
      }));
    });

    var group = function (id, name, rows) {
      if (!rows.length) return;
      list.appendChild(taskSection(id, name, rows, false));
    };
    if (state.taskMode === "days") {
      var today = localDay();
      var byCreated = function (a, b) { return a.created_at < b.created_at ? -1 : 1; };
      group("overdue", "Overdue", urgentFirst(open.filter(function (t) { return t.due_on && t.due_on < today; }).sort(function (a, b) { return a.due_on < b.due_on ? -1 : 1; })));
      var days = {};
      open.forEach(function (t) { if (t.due_on && t.due_on >= today) (days[t.due_on] = days[t.due_on] || []).push(t); });
      Object.keys(days).sort().forEach(function (day) {
        var d = new Date(day + "T12:00:00");
        var name = d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "short" });
        group(day, day === today ? "Today · " + name : name, urgentFirst(days[day].sort(byCreated)));
      });
      group("nodate", "No date", urgentFirst(open.filter(function (t) { return !t.due_on; })));
    } else {
      HORIZONS.forEach(function (h) {
        var rows = open.filter(function (t) { return horizonOf(t) === h.id; }).sort(taskOrder);
        rows = urgentFirst(rows);
        if (needles.length && !rows.length) return;
        list.appendChild(taskSection(h.id, h.label, rows, true));
      });
    }
    if (!open.length && !needles.length && state.taskMode === "days") list.appendChild(el("p", "empty", state.project ? "No open tasks in this project." : "No open tasks."));

    var done = shown.filter(function (t) { return t.status === "done"; });
    var doneList = $("list-tasks-done");
    doneList.textContent = "";
    done.forEach(function (t) { doneList.appendChild(taskRow(t, "done")); });
    $("n-tasks-done").textContent = done.length ? String(done.length) : "";
    $("box-tasks-done").hidden = !done.length;
    return open.length + done.length;
  }

  // Ticking a task off: stamp the row, fold it away, then say so (with Undo unless it repeats,
  // because a repeating task has already produced its next occurrence).
  async function finishTask(task, row) {
    var saving = sb.from("tasks").update({ status: "done", done_at: new Date().toISOString() }).eq("id", task.id);
    await leave(row || onPage('[data-task="' + task.id + '"]'), "✓ Done", "ok");
    task.status = "done";
    task.done_at = new Date().toISOString();
    render();
    var res = await saving;
    if (res.error) notice("That did not save: " + res.error.message);
    else if (task.repeat) toast("Task done. The next one has been added.", null);
    else toast("Task done.", function () { saveTask(task.id, { status: "open", done_at: null }); });
    await load();
  }

  async function saveTask(id, changes) {
    var task = state.tasks.filter(function (t) { return t.id === id; })[0];
    if (task) {
      Object.keys(changes).forEach(function (k) { task[k] = changes[k]; });
      render();
    }
    var res = await sb.from("tasks").update(changes).eq("id", id);
    if (res.error) notice("That did not save: " + res.error.message);
    await load();
  }

  // Finds the project by name in that organisation, or creates it.
  async function projectId(space, name) {
    var wanted = String(name || "").trim();
    if (!wanted) return null;
    for (var i = 0; i < state.projects.length; i++) {
      var p = state.projects[i];
      if (p.space === space && p.name.toLowerCase() === wanted.toLowerCase()) return p.id;
    }
    var made = await sb.from("projects").insert({ space: space, name: wanted }).select("id").single();
    if (made.error) throw new Error(made.error.message);
    return made.data.id;
  }

  // Asks Claude to work out what a task is from one line or from an item. Suggests only.
  async function suggest(body) {
    try {
      var res = await sb.functions.invoke("task-suggest", { body: body });
      if (res.error || !res.data || !res.data.ok) return null;
      return res.data.suggestion;
    } catch (_) {
      return null;
    }
  }

  // ----- The task you can open -----

  var draft = null; // the task shown in the dialog; id is null until it is saved

  // The project picker: this organisation's projects, "No project", and "New project…".
  // A suggested name that does not exist yet arrives selected as a new project.
  function fillProjectChoices(space, chosen) {
    var pick = $("td-project");
    var fresh = $("td-project-new");
    pick.textContent = "";
    var add = function (value, label) {
      var o = el("option", null, label);
      o.value = value;
      pick.appendChild(o);
    };
    add("", "No project");
    var match = "";
    state.projects.forEach(function (p) {
      if (p.space !== space) return;
      add(p.name, p.name);
      if (chosen && p.name.toLowerCase() === String(chosen).toLowerCase()) match = p.name;
    });
    add("__new__", "New project…");
    var isNew = !!chosen && !match;
    pick.value = isNew ? "__new__" : match;
    fresh.value = isNew ? chosen : "";
    fresh.hidden = !isNew;
  }

  function chosenProject() {
    return $("td-project").value === "__new__" ? $("td-project-new").value : $("td-project").value;
  }

  function drawLinks() {
    var box = $("td-links");
    box.textContent = "";
    draft.links.forEach(function (link, i) {
      var row = el("div", "td-link");
      row.appendChild(linkTo(link.url, (link.label || F.host(link.url)) + " ↗", "chip"));
      row.appendChild(button("Remove", "quiet", function () { draft.links.splice(i, 1); drawLinks(); }));
      box.appendChild(row);
    });
    if (!draft.links.length) box.appendChild(el("p", "empty", "No links yet."));
  }

  function drawSteps() {
    var box = $("td-steps");
    box.textContent = "";
    draft.steps.forEach(function (step, i) {
      var row = el("label", "td-step" + (step.done ? " is-done" : ""));
      var tick = document.createElement("input");
      tick.type = "checkbox";
      tick.checked = !!step.done;
      tick.addEventListener("change", function () {
        step.done = tick.checked;
        row.className = "td-step" + (step.done ? " is-done" : "");
        // On a saved task a tick is kept straight away; on a new one it is saved with the task.
        if (draft.id) sb.from("tasks").update({ steps: draft.steps }).eq("id", draft.id).then(function () { load(); });
      });
      row.appendChild(tick);
      row.appendChild(el("span", null, step.text));
      row.appendChild(button("Remove", "quiet", function (event) { event.preventDefault(); draft.steps.splice(i, 1); drawSteps(); }));
      box.appendChild(row);
    });
    if (!draft.steps.length) box.appendChild(el("p", "empty", "No steps."));
  }

  function addStep() {
    var text = $("td-step-text").value.trim();
    if (!text) return;
    draft.steps.push({ text: text, done: false });
    $("td-step-text").value = "";
    drawSteps();
  }

  // Other open tasks, asks and promises about the same thing. Each opens what it points to.
  function drawRelated() {
    var box = $("td-related");
    box.textContent = "";
    $("td-related-box").hidden = !draft.related.length;
    draft.related.forEach(function (r) { box.appendChild(relatedRow(r, true)); });
  }

  // True when the task has anything filled in that lives under "More".
  function hasMore(task) {
    return !!(task.repeat || task.context || task.notes || task.source_item_id ||
      (task.steps && task.steps.length) || (task.links && task.links.length) || (task.related && task.related.length));
  }

  function showDialog(task, hint) {
    draft = task;
    $("td-heading").textContent = task.id ? "Task" : "New task";
    $("td-hint").hidden = !hint;
    $("td-hint").textContent = hint || "";
    $("td-title").value = task.title || "";
    $("td-space").value = task.space;
    $("td-horizon").value = task.horizon || "week";
    $("td-urgent").checked = !!task.urgent;
    $("td-due").value = task.due_on || "";
    $("td-repeat").value = task.repeat || "";
    $("td-context").value = task.context || "";
    $("td-notes").value = task.notes || "";
    $("td-link-label").value = "";
    $("td-link-url").value = "";
    $("td-error").hidden = true;
    $("td-step-text").value = "";
    fillProjectChoices(task.space, task.project || "");
    drawLinks();
    drawSteps();
    drawRelated();

    writeSource($("td-source"), task.source_item_id);
    $("td-more").open = hasMore(task);
    $("td-body").scrollTop = 0;
    $("td-extra").hidden = !task.id || task.status !== "open";
    var dialog = $("task-dialog");
    if (!dialog.open) dialog.showModal();
  }

  function openTask(task) {
    showDialog({
      id: task.id, status: task.status, space: task.space, title: task.title, project: projectName(task) || "",
      horizon: task.horizon, urgent: !!task.urgent, due_on: task.due_on, repeat: task.repeat, context: task.context, notes: task.notes,
      links: Array.isArray(task.links) ? task.links.slice() : [], source_item_id: task.source_item_id,
      steps: (Array.isArray(task.steps) ? task.steps : []).map(function (x) { return { text: String(x.text || ""), done: !!x.done }; }),
      related: Array.isArray(task.related) ? task.related.slice() : [],
    });
  }

  function blankTask(space, title) {
    return { id: null, status: "open", space: space, title: title || "", project: "", horizon: "week", urgent: false, due_on: null, repeat: null, context: "", notes: "", links: [], steps: [], related: [], source_item_id: null };
  }

  function withSuggestion(task, s) {
    if (!s) return task;
    task.title = s.title || task.title;
    task.space = s.space || task.space;
    task.project = s.project || "";
    task.horizon = s.horizon || task.horizon;
    task.due_on = s.due_on || task.due_on;
    task.repeat = s.repeat || null;
    task.context = s.context || "";
    task.steps = (s.steps || []).map(function (text) { return { text: String(text), done: false }; });
    task.related = Array.isArray(s.related) ? s.related : [];
    return task;
  }

  // `startSteps` are the steps of a Start; they are added to the ones the suggestion brings.
  async function taskFromItem(item, trigger, startSteps) {
    var triggerLabel = trigger ? trigger.textContent : "";
    if (trigger) { trigger.disabled = true; trigger.textContent = "Working it out…"; }
    var task = blankTask(item.space, item.title);
    task.source_item_id = item.id;
    task.due_on = item.due_on || null;
    task.context = item.summary || "";
    if (fromNotes(item)) {
      // Everything each source says goes into the background, in case no suggestion comes back.
      var extra = sourcesOf(item).filter(function (x) { return x.detail && x.detail !== item.summary; })
        .map(function (x) { return x.label + ": " + x.detail; });
      if (extra.length) task.context = [task.context].concat(extra).filter(Boolean).join("\n");
    }
    sourceLinks(item).forEach(function (link) {
      task.links.push({ label: link.name || link.label, url: link.href });
    });
    var s = await suggest({ item_id: item.id });
    if (s) s.space = item.space;
    var basis = !fromNotes(item) ? "the message" : sourcesOf(item).length > 1 ? "what the notes and Granola say" : "your meeting notes";
    withSuggestion(task, s);
    if (startSteps && startSteps.length) task.steps = mergeSteps(task.steps, startSteps);
    showDialog(task, s ? "Suggested from " + basis + ". Change anything, then save." : "Could not get a suggestion, so this is filled in from the item. Change anything, then save.");
    if (trigger) { trigger.disabled = false; trigger.textContent = triggerLabel; }
  }

  // A suggested task that has become a task leaves the tray (the task keeps its link to it).
  async function closeSuggestion(id) {
    var item = state.items.filter(function (i) { return i.id === id; })[0];
    if (!item || viewFor(item) !== "tasks" || (item.status !== "open" && item.status !== "snoozed")) return;
    item.status = "done";
    item.closed_by = "user";
    item.closed_at = new Date().toISOString();
    item.snooze_until = null;
    var res = await sb.rpc("set_item_state", { p_item: id, p_action: "done", p_until: null });
    if (res.error) notice("The task was saved, but the suggestion did not close: " + res.error.message);
  }

  async function saveDraft() {
    var problem = $("td-error");
    problem.hidden = true;
    var title = $("td-title").value.trim();
    if (!title) return;
    var space = $("td-space").value;
    try {
      var row = {
        space: space,
        title: title,
        project_id: await projectId(space, chosenProject()),
        horizon: $("td-horizon").value,
        urgent: $("td-urgent").checked,
        due_on: $("td-due").value || null,
        repeat: $("td-repeat").value || null,
        context: $("td-context").value.trim() || null,
        notes: $("td-notes").value.trim() || null,
        links: draft.links,
        steps: draft.steps,
        related: draft.related,
      };
      var res;
      if (draft.id) {
        res = await sb.from("tasks").update(row).eq("id", draft.id);
      } else {
        if (draft.source_item_id) row.source_item_id = draft.source_item_id;
        res = await sb.from("tasks").insert(row);
        if (!res.error && draft.source_item_id) await closeSuggestion(draft.source_item_id);
        if (!res.error && draft.fromReview) state.doneSuggestions[draft.fromReview] = true;
      }
      if (res.error) throw new Error(res.error.message);
    } catch (err) {
      problem.textContent = "Not saved: " + (err && err.message ? err.message : "unknown error");
      problem.hidden = false;
      return;
    }
    $("task-dialog").close();
    await load();
  }

  // A notice that load() wrote is cleared by the next good load; a notice about a failed save stays
  // until something else replaces it, so a reload right after the failure does not wipe it.
  function notice(text, fromLoad) {
    state.noticeFromLoad = !!fromLoad && !!text;
    var n = $("notice");
    n.hidden = !text;
    n.textContent = text || "";
  }

  // ---------- Notes ----------

  var NOTE_LINES = 6; // a note is cut after this many lines until you open it

  function noteDate(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.getDate() + " " + d.toLocaleDateString([], { month: "short" }) + ", " + clock(d);
  }

  function noteById(id) {
    return state.notes.filter(function (n) { return n.id === id; })[0] || null;
  }

  function projectById(id) {
    if (id === null || id === undefined) return null;
    return state.projects.filter(function (p) { return String(p.id) === String(id); })[0] || null;
  }

  function notesNewest(a, b) {
    return (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0);
  }

  // Fills a plan picker with "No plan" and the plans and projects of one organisation, plans first.
  function planOptions(select, space, chosen) {
    select.textContent = "";
    var none = el("option", null, "No plan");
    none.value = "";
    select.appendChild(none);
    state.projects.filter(function (p) { return p.space === space; }).sort(function (a, b) {
      if (!!a.is_plan !== !!b.is_plan) return a.is_plan ? -1 : 1;
      return String(a.name).toLowerCase() < String(b.name).toLowerCase() ? -1 : 1;
    }).forEach(function (p) {
      var o = el("option", null, p.name);
      o.value = String(p.id);
      select.appendChild(o);
    });
    var wanted = chosen === null || chosen === undefined ? "" : String(chosen);
    select.value = Array.prototype.some.call(select.options, function (o) { return o.value === wanted; }) ? wanted : "";
  }

  // The id to store for a picker's value (the project's own id, whatever its type).
  function planChoice(select) {
    var p = projectById(select.value);
    return p ? p.id : null;
  }

  // Makes a box taller as you type, up to about six lines.
  function grow(box) {
    box.style.height = "auto";
    var cs = getComputedStyle(box);
    var line = parseFloat(cs.lineHeight);
    if (isNaN(line)) line = parseFloat(cs.fontSize) * 1.45;
    var pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    var edge = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    var most = line * NOTE_LINES + pad + edge;
    var want = box.scrollHeight + edge;
    box.style.height = Math.min(want, most) + "px";
    box.style.overflowY = want > most ? "auto" : "hidden";
  }

  var noteFormFilter = null; // the filter the forms were last set up for
  var notePlanKey = "";

  function fillSpaceChoices(space) {
    if (space.options.length) return;
    [["", "Choose organisation"], ["metaculus", "Metaculus"], ["cea", "CEA"], ["personal", "Personal"]].forEach(function (x) {
      var o = el("option", null, x[1]);
      o.value = x[0];
      space.appendChild(o);
    });
    space.options[0].disabled = true;
  }

  // The writing boxes (Notes and the quick note on Today): organisation preset from the filter, plans of that organisation.
  function syncNoteForm() {
    var space = $("note-space");
    var quick = $("cvnote-space");
    fillSpaceChoices(space);
    fillSpaceChoices(quick);
    if (noteFormFilter !== state.filter) {
      noteFormFilter = state.filter;
      space.value = quick.value = state.filter !== "all" ? state.filter : (state.noteSpace || "");
    }
    space.options[0].hidden = quick.options[0].hidden = state.filter !== "all";
    var plans = $("note-plan");
    var key = space.value + "|" + state.projects.filter(function (p) { return p.space === space.value; })
      .map(function (p) { return p.id + ":" + p.name + ":" + !!p.is_plan; }).join("|");
    if (key !== notePlanKey) {
      notePlanKey = key;
      planOptions(plans, space.value, plans.value);
    }
  }

  // Saves the note in the Notes box, or in the quick note on Today when `quick` is true.
  async function saveNote(quick) {
    var pre = quick ? "cvnote-" : "note-";
    var problem = $(pre + "error");
    problem.hidden = true;
    var box = $(pre + "body");
    var body = box.value.trim();
    if (!body) { box.focus(); return; }
    var space = $(pre + "space").value;
    if (!space) {
      problem.textContent = "Choose an organisation first.";
      problem.hidden = false;
      $(pre + "space").focus();
      return;
    }
    var projectIdValue = quick ? null : planChoice($("note-plan"));
    state.noteSpace = space;
    var stamp = new Date().toISOString();
    // Shown at once; if the save fails you are told and the words go back into the box.
    var temp = { id: "new-" + Date.now(), temp: true, pending: true, space: space, project_id: projectIdValue, body: body, pinned: false, created_at: stamp, updated_at: stamp };
    state.notes.unshift(temp);
    box.value = "";
    grow(box);
    if (!quick) $("note-plan").value = "";
    render();
    var res = await sb.from("notes").insert({ space: space, project_id: projectIdValue, body: body, pinned: false }).select("id, space, project_id, body, pinned, created_at, updated_at").single();
    var at = state.notes.indexOf(temp);
    var failed = null;
    if (res.error || !res.data) {
      if (at >= 0) state.notes.splice(at, 1);
      failed = "That did not save: " + (res.error ? res.error.message : "unknown error");
      if (!box.value) { box.value = body; grow(box); }
    } else if (at >= 0) {
      state.notes[at] = res.data;
    }
    if (quick && !failed) {
      var ok = $("cvnote-ok");
      ok.hidden = false;
      clearTimeout(state.noteOkTimer);
      state.noteOkTimer = setTimeout(function () { ok.hidden = true; }, 4000);
    }
    render();
    await load();
    if (failed) notice(failed); // after the reload, which clears notices
  }

  async function updateNote(id, changes) {
    var n = noteById(id);
    if (n) { Object.keys(changes).forEach(function (k) { n[k] = changes[k]; }); render(); }
    var res = await sb.from("notes").update(changes).eq("id", id);
    await load();
    if (res.error) notice("That did not save: " + res.error.message);
  }

  async function deleteNote(id) {
    state.noteAsk = null;
    delete state.openNotes[id];
    state.notes = state.notes.filter(function (n) { return n.id !== id; });
    render();
    var res = await sb.from("notes").delete().eq("id", id);
    await load();
    if (res.error) notice("That did not save: " + res.error.message);
  }

  function noteTop(n) {
    var top = el("div", "card-top");
    top.appendChild(el("span", "tag tag-" + n.space, spaceLabel(n.space)));
    var plan = projectById(n.project_id);
    if (plan) top.appendChild(el("span", "kind", plan.name));
    top.appendChild(el("span", "meta", noteDate(n.created_at)));
    if (n.pinned) top.appendChild(el("span", "flag pin-flag", "Pinned"));
    return top;
  }

  // The card turns into a box for the words and a plan picker, in place.
  function editNote(n) {
    var id = n.id;
    var node = el("article", "card note editing");
    node.setAttribute("data-note", id);
    node.appendChild(noteTop(n));
    var ta = el("textarea", "note-edit");
    ta.value = n.body;
    ta.rows = 3;
    ta.maxLength = 20000;
    ta.setAttribute("aria-label", "Edit note");
    ta.addEventListener("input", function () { grow(ta); });
    node.appendChild(ta);
    var row = el("div", "note-row");
    var pick = document.createElement("select");
    pick.setAttribute("aria-label", "Plan");
    planOptions(pick, n.space, n.project_id);
    row.appendChild(pick);
    var save = function () {
      var body = ta.value.trim();
      if (!body) { ta.focus(); return; }
      var current = noteById(id);
      state.noteEdit = null;
      if (!current) { notice("That note is gone."); render(); return; }
      updateNote(id, { body: body, project_id: planChoice(pick), updated_at: new Date().toISOString() });
    };
    ta.addEventListener("keydown", function (event) {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); save(); }
    });
    row.appendChild(button("Save", "primary", save));
    row.appendChild(button("Cancel", "btn subtle", function () { state.noteEdit = null; render(); }));
    node.appendChild(row);
    state.noteEdit = { id: id, node: node };
    render();
    grow(ta);
    ta.focus();
  }

  function noteIsLong(body) {
    return body.length > 100 || body.split("\n").length > NOTE_LINES;
  }

  function noteCard(n) {
    if (state.noteEdit && state.noteEdit.id === n.id) return state.noteEdit.node; // keeps what you are typing
    var node = el("article", "card note" + (n.pinned ? " is-pinned" : ""));
    node.setAttribute("data-note", n.id);
    node.appendChild(noteTop(n));
    var long = noteIsLong(n.body);
    var open = long && !!state.openNotes[n.id];
    if (open) {
      var full = el("div", "fold-body");
      full.appendChild(el("p", "note-text", n.body));
      node.appendChild(full);
    } else {
      node.appendChild(el("p", "note-text" + (long ? " clamped" : ""), n.body));
    }
    if (long) {
      node.appendChild(button(open ? "Show less" : "Show all", "quiet note-more", function () {
        if (state.openNotes[n.id]) delete state.openNotes[n.id]; else state.openNotes[n.id] = true;
        node.replaceWith(noteCard(n));
        fitNotes();
      }));
    }
    var actions = el("div", "actions");
    if (state.noteAsk === n.id) {
      actions.appendChild(el("span", "note-ask", "Delete this note?"));
      actions.appendChild(button("Delete", "btn danger", function () { deleteNote(n.id); }));
      actions.appendChild(button("Keep", "btn", function () { state.noteAsk = null; render(); }));
    } else {
      var pin = button(n.pinned ? "Unpin" : "Pin", "btn", function () {
        updateNote(n.id, { pinned: !n.pinned, updated_at: new Date().toISOString() });
      });
      var edit = button("Edit", "btn", function () { editNote(n); });
      var del = button("Delete", "btn subtle", function () { state.noteAsk = n.id; render(); });
      if (n.temp) { pin.disabled = true; edit.disabled = true; del.disabled = true; }
      actions.appendChild(pin);
      actions.appendChild(edit);
      actions.appendChild(del);
    }
    node.appendChild(actions);
    return node;
  }

  // "Show all" only where the text really is cut; this needs the notes to be on screen.
  function fitNotes() {
    document.querySelectorAll("#list-notes .note-text.clamped").forEach(function (t) {
      var more = t.parentElement.querySelector(".note-more");
      if (more) more.hidden = t.scrollHeight <= t.clientHeight + 1;
    });
  }

  // Draws the Notes list: pinned first, then the rest, newest first. Returns how many notes it shows.
  function renderNotes() {
    syncNoteForm();
    var list = $("list-notes");
    var active = document.activeElement;
    var keepFocus = state.noteEdit && state.noteEdit.node.contains(active) ? active : null;
    list.textContent = "";
    var shown = state.notes.filter(function (n) {
      if (state.filter !== "all" && n.space !== state.filter) return false;
      var plan = projectById(n.project_id);
      return hit([n.body, plan && plan.name]);
    }).sort(function (a, b) {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      return notesNewest(a, b);
    });
    shown.forEach(function (n) { list.appendChild(noteCard(n)); });
    if (!shown.length && !needles.length) list.appendChild(el("p", "empty", "No notes here yet."));
    if (keepFocus) keepFocus.focus({ preventScroll: true });
    return shown.length;
  }

  // The first lines of a note, for the list inside a plan.
  function firstLines(body) {
    var text = body.split("\n").map(function (l) { return l.trim(); }).filter(Boolean).slice(0, 2).join(" · ");
    return text.length > 160 ? text.slice(0, 160).trim() + "…" : text;
  }

  function showNotesFor(p) {
    state.query = p.name;
    $("search").value = p.name;
    showView("notes");
  }

  // ---------- Today ----------

  var KIND_TAGS = { decision: "Decide", owed: "You owe", heads_up: "Heads-up" };
  var REVIEW_FAIL = "The review did not finish. Try again in a minute.";
  var START_FAIL = "Start did not finish. Try again in a minute.";

  function inFilter(row) {
    return state.filter === "all" || row.space === state.filter;
  }

  // Empties one block of Today and writes its heading; returns the heading row and the body.
  function coverBlock(id, name) {
    var box = $(id);
    box.textContent = "";
    var head = el("div", "tsec-head");
    head.appendChild(el("h2", "tsec-name", name));
    box.appendChild(head);
    var body = el("div", "tsec-body");
    box.appendChild(body);
    return { box: box, head: head, body: body };
  }

  function coverFoot(box, label, view) {
    var foot = el("div", "cv-foot");
    foot.appendChild(button(label, "quiet", function () { showView(view); }));
    box.appendChild(foot);
  }

  // The meetings that are running or still to come within 7 days, soonest first.
  function upcomingMeetings(now) {
    var limit = now + 7 * DAY;
    return shownMeetings().filter(function (m) {
      return !m.all_day && meetingEnd(m).getTime() > now && meetingDate(m).getTime() <= limit;
    }).sort(function (a, b) { return meetingDate(a).getTime() - meetingDate(b).getTime(); });
  }

  // "Today 14:00 - 14:30", "Tomorrow 09:30", "Fri 14 Nov 10:00".
  function whenLabel(m, now) {
    var start = meetingDate(m);
    var end = meetingEnd(m);
    var days = Math.round((dayStart(start) - dayStart(new Date(now))) / DAY);
    if (days <= 0) return "Today " + clock(start) + (end.getTime() > start.getTime() ? " - " + clock(end) : "");
    if (days === 1) return "Tomorrow " + clock(start);
    return start.toLocaleDateString([], { weekday: "short" }) + " " + shortDate(start) + " " + clock(start);
  }

  function renderNextUp(now) {
    var blk = coverBlock("cv-next", "Next up");
    var body = blk.body;
    body.className = "tsec-body cv-pad";
    var list = upcomingMeetings(now);
    if (!list.length) {
      body.appendChild(el("p", "empty", "You have no meetings in the next 7 days."));
      return;
    }
    var m = list[0];
    var top = el("div", "cv-top");
    top.appendChild(el("span", "tag tag-" + m.space, spaceLabel(m.space)));
    var flag = timingFlag(m, now);
    if (flag) top.appendChild(flag);
    if (RESPONSES[m.my_response]) top.appendChild(el("span", "flag flag-2", RESPONSES[m.my_response]));
    body.appendChild(top);
    body.appendChild(el("h3", "cv-title", m.title || "Meeting"));
    body.appendChild(el("p", "cv-when", whenLabel(m, now)));
    var who = withLine(m);
    if (who) body.appendChild(el("p", "reason", who));
    var join = httpsLink(m.join_url);
    var cal = httpsLink(m.event_url);
    if (join || cal) {
      var actions = el("div", "actions");
      if (join) actions.appendChild(linkTo(join, "Join", "btn join big"));
      if (cal) actions.appendChild(linkTo(cal, "Open in Calendar", "btn"));
      body.appendChild(actions);
    }
    var fold = meetingFold(m);
    if (fold) body.appendChild(fold);

    var today = dayStart(new Date(now));
    var later = list.slice(1).filter(function (x) { return dayStart(meetingDate(x)) === today; });
    if (later.length) {
      body.appendChild(el("p", "owed-head cv-later-head", "Later today"));
      var ul = el("ul", "cv-later");
      later.forEach(function (x) {
        var li = el("li");
        li.setAttribute("data-later-meeting", x.id);
        li.appendChild(el("span", "cv-t", clock(meetingDate(x))));
        li.appendChild(el("span", "cv-n", x.title || "Meeting"));
        var j = httpsLink(x.join_url);
        if (j) li.appendChild(linkTo(j, "Join", "cv-join"));
        ul.appendChild(li);
      });
      body.appendChild(ul);
    }
  }

  // Open tasks that are in the Today section, due today or overdue; overdue first, oldest date first.
  function coverTaskList() {
    var today = localDay();
    var open = state.tasks.filter(function (t) {
      return t.status === "open" && inFilter(t) && (t.urgent || horizonOf(t) === "today" || (t.due_on && t.due_on <= today));
    });
    var isLate = function (t) { return !!t.due_on && t.due_on < today; };
    var overdue = open.filter(isLate).sort(function (a, b) {
      return a.due_on < b.due_on ? -1 : a.due_on > b.due_on ? 1 : (Date.parse(a.created_at) || 0) - (Date.parse(b.created_at) || 0);
    });
    var rest = open.filter(function (t) { return !isLate(t); }).sort(taskOrder);
    return { all: urgentFirst(overdue.concat(rest)), late: overdue.length, urgent: open.filter(function (t) { return t.urgent; }).length };
  }

  function renderCoverTasks() {
    var blk = coverBlock("cv-tasks", "Tasks today");
    var found = coverTaskList();
    if (found.late) blk.head.appendChild(el("span", "cv-late", found.late + " late"));
    if (found.urgent) blk.head.appendChild(el("span", "cv-late cv-urgent", found.urgent + " urgent"));
    blk.head.appendChild(el("span", "count", found.all.length + " open"));
    var rows = needles.length ? found.all.filter(function (t) { return hit(taskParts(t)); }) : found.all;
    rows.slice(0, 6).forEach(function (t) { blk.body.appendChild(taskRow(t, "today")); });
    if (!found.all.length && !needles.length) {
      blk.body.appendChild(el("p", "empty", "Nothing is due today and nothing is late."));
    }
    coverFoot(blk.box, "All tasks", "tasks");
    return Math.min(rows.length, 6);
  }

  // Up to 3 open items from key people, newest first; filled up with other items that wait on you.
  function coverInboxList() {
    var live = state.items.filter(function (i) {
      var b = bucket(i);
      return inFilter(i) && (b === "waiting" || b === "look") && hit(itemParts(i));
    });
    var out = live.filter(fromKeyPerson).sort(newest).slice(0, 3);
    if (out.length < 3) {
      live.filter(function (i) { return bucket(i) === "waiting" && !fromKeyPerson(i); }).sort(newest).slice(0, 3 - out.length)
        .forEach(function (i) { out.push(i); });
    }
    return out;
  }

  function renderCoverInbox() {
    var blk = coverBlock("cv-inbox", "Inbox, most important");
    var list = coverInboxList();
    list.forEach(function (i) { blk.body.appendChild(card(i, bucket(i), "today")); });
    if (!list.length && !needles.length) blk.body.appendChild(el("p", "empty", "Nothing in your inbox is waiting on you."));
    coverFoot(blk.box, "All inbox", "inbox");
    return list.length;
  }

  function coverFor(space) {
    return state.covers.filter(function (c) { return c.space === space; })[0] || null;
  }

  // Keeps a review that a function just returned until a load has it too.
  function mergeCovers(fetched) {
    var out = fetched.slice();
    Object.keys(state.fresh.covers).forEach(function (space) {
      var f = state.fresh.covers[space];
      var at = out.map(function (c) { return c.space; }).indexOf(space);
      var caughtUp = at >= 0 && (Date.parse(out[at].written_at) || 0) >= (Date.parse(f.row.written_at) || 0);
      if (caughtUp || Date.now() - f.at > 30000) { delete state.fresh.covers[space]; return; }
      if (at >= 0) out[at] = f.row; else out.push(f.row);
    });
    return out;
  }

  // Where a point of the review leads; null when the thing is no longer open or not loaded.
  function pointTarget(ref) {
    if (!ref || !ref.kind || ref.id === undefined || ref.id === null) return null;
    var same = function (x) { return String(x.id) === String(ref.id); };
    if (ref.kind === "item") {
      var item = state.items.filter(same)[0];
      var b = item ? bucket(item) : "closed";
      return item && b !== "later" && b !== "closed" ? function () { goToItem(item); } : null;
    }
    if (ref.kind === "task") {
      var task = state.tasks.filter(same)[0];
      return task && task.status === "open" ? function () { goToTask(task); } : null;
    }
    if (ref.kind === "plan") {
      var plan = state.projects.filter(same)[0];
      return plan && plan.is_plan ? function () { goToPlan(plan); } : null;
    }
    if (ref.kind === "meeting") {
      var meeting = state.meetings.filter(same)[0];
      if (!meeting || meeting.status === "cancelled" || meeting.my_response === "declined") return null;
      var offset = Math.round((dayStart(meetingDate(meeting)) - dayStart(new Date())) / DAY);
      return offset >= 0 && offset <= 7 ? function () { goToMeeting(meeting); } : null;
    }
    return null;
  }

  function renderCoverReview() {
    var blk = coverBlock("cv-review", "How things stand");
    blk.body.className = "tsec-body cv-pad";
    var spaces = state.filter === "all"
      ? ["metaculus", "cea", "personal"].filter(function (sp) { return sp !== "personal" || coverFor(sp); })
      : [state.filter];
    var shown = 0;
    spaces.forEach(function (space) {
      var row = coverFor(space);
      var points = row && Array.isArray(row.points) ? row.points.filter(function (p) { return p && p.text; }) : [];
      var text = row && row.review ? String(row.review) : "";
      var showText = !needles.length || hit([text]);
      if (needles.length) {
        points = points.filter(function (p) { return hit([p.text, KIND_TAGS[p.kind]]); });
        if (!points.length && !(text && showText)) return;
      }
      var org = el("div", "cv-org");
      org.setAttribute("data-cover", space);
      var top = el("div", "cv-top");
      top.appendChild(el("span", "tag tag-" + space, spaceLabel(space)));
      org.appendChild(top);
      if (!row) {
        org.appendChild(el("p", "empty", "No review yet"));
      } else {
        if (text && showText) { org.appendChild(el("p", "gist cv-review-text", text)); shown++; }
        if (points.length) {
          var ul = el("ul", "cv-points");
          points.forEach(function (p) {
            var li = el("li", "cv-point");
            li.appendChild(el("span", "kind cv-kind-" + (KIND_TAGS[p.kind] ? p.kind : "heads_up"), KIND_TAGS[p.kind] || "Heads-up"));
            var go = pointTarget(p.ref);
            if (go) li.appendChild(button(String(p.text), "ref cv-ref", go));
            else li.appendChild(el("span", "cv-plain", String(p.text)));
            ul.appendChild(li);
            shown++;
          });
          org.appendChild(ul);
        }
      }
      if (!needles.length) {
        var foot = el("div", "cv-written");
        if (row && row.written_at) foot.appendChild(el("span", null, "Written " + noteDate(row.written_at)));
        var busy = !!state.covering[space];
        var again = button(busy ? "Writing..." : "Refresh", "btn small", function () { refreshCover(space); });
        again.disabled = busy;
        foot.appendChild(again);
        org.appendChild(foot);
      }
      blk.body.appendChild(org);
    });
    return shown;
  }

  // Asks Claude to write the review again. Takes up to a minute; the rest of the page stays usable.
  async function refreshCover(space) {
    if (state.covering[space]) return;
    state.covering[space] = true;
    render();
    var ok = false;
    try {
      var res = await sb.functions.invoke("cover-review", { body: { space: space } });
      var c = res && res.data && res.data.cover;
      if (!res.error && res.data && res.data.ok !== false && c && typeof c.review === "string") {
        var row = { space: c.space || space, review: c.review, points: Array.isArray(c.points) ? c.points : [], written_at: c.written_at || new Date().toISOString() };
        state.covers = state.covers.filter(function (x) { return x.space !== row.space; }).concat([row]);
        state.fresh.covers[row.space] = { row: row, at: Date.now() };
        ok = true;
      }
    } catch (_) { /* told below */ }
    delete state.covering[space];
    notice(ok ? "" : REVIEW_FAIL);
    render();
  }

  function renderToday() {
    var now = Date.now();
    renderNextUp(now);
    return renderCoverTasks() + renderCoverInbox() + renderCoverReview();
  }

  // ---------- Start: steps (and a draft reply) for an item or a task ----------

  var startBoxes = {}; // the draft boxes, kept between redraws so typing is never lost

  function stepKey(text) {
    return String(text === undefined || text === null ? "" : text).trim().toLowerCase();
  }

  // `base` steps followed by those of `extra` that are not already there (compared lower-cased and trimmed).
  function mergeSteps(base, extra) {
    var have = {};
    var out = [];
    (base || []).forEach(function (x) {
      if (!x) return;
      have[stepKey(x.text)] = true;
      out.push({ text: String(x.text || ""), done: !!x.done });
    });
    (extra || []).forEach(function (x) {
      var k = x ? stepKey(x.text) : "";
      if (!k || have[k]) return;
      have[k] = true;
      out.push({ text: String(x.text).trim(), done: !!x.done });
    });
    return out;
  }

  function startKey(kind, id) { return kind + ":" + id; }

  function startFor(kind, id) {
    for (var i = 0; i < state.starts.length; i++) {
      var s = state.starts[i];
      if (String(kind === "item" ? s.item_id : s.task_id) === String(id)) return s;
    }
    return null;
  }

  // Keeps a start that the function just returned until a load has it too; edits on their way win over a load.
  function mergeStarts(fetched) {
    var local = {};
    state.starts.forEach(function (r) { local[r.id] = r; });
    var out = fetched.map(function (r) { return state.startHold[r.id] && local[r.id] ? local[r.id] : r; });
    Object.keys(state.fresh.starts).forEach(function (id) {
      var f = state.fresh.starts[id];
      var there = out.some(function (r) { return String(r.id) === id; });
      if (there || Date.now() - f.at > 30000) { delete state.fresh.starts[id]; return; }
      out.push(f.row);
    });
    return out;
  }

  function storeStart(row) {
    state.starts = state.starts.filter(function (x) { return x.id !== row.id && !(row.item_id && x.item_id === row.item_id) && !(row.task_id && x.task_id === row.task_id); }).concat([row]);
    state.fresh.starts[row.id] = { row: row, at: Date.now() };
    // A new draft replaces whatever was typed in the boxes.
    var key = startKey(row.item_id ? "item" : "task", row.item_id || row.task_id);
    Object.keys(startBoxes).forEach(function (k) {
      if (k.indexOf(key + "|") !== 0) return;
      var ta = startBoxes[k];
      clearTimeout(ta._t);
      ta._dirty = false;
      ta._startId = row.id;
      ta.value = row.draft || "";
    });
  }

  // The Start button: "Start", "Preparing..." while it runs, "Show start" when one exists. Nothing while its panel is open.
  function startControl(kind, id, className) {
    var key = startKey(kind, id);
    var existing = startFor(kind, id);
    var busy = !!state.starting[key];
    if (existing && state.startOpen[key]) return null;
    var b = button(busy ? "Preparing..." : existing ? "Show start" : "Start", className, function () {
      if (existing) { state.startOpen[key] = true; render(); } else runStart(kind, id, false);
    });
    b.setAttribute("data-start", key);
    b.disabled = busy;
    return b;
  }

  // Asks the start-item function; it can take up to a minute. It prepares text only; nothing is sent.
  async function runStart(kind, id, redo) {
    var key = startKey(kind, id);
    if (state.starting[key]) return;
    if (redo && (sendBusy(key) || startSent(startFor(kind, id)))) return; // a draft that is being sent or was sent is never replaced
    state.starting[key] = true;
    delete state.startAsk[key];
    render();
    var body = kind === "item" ? { item_id: id } : { task_id: id };
    if (redo) body.redo = true;
    var ok = false;
    try {
      var res = await sb.functions.invoke("start-item", { body: body });
      if (!res.error && res.data && res.data.ok !== false && res.data.start) {
        storeStart(res.data.start);
        state.startOpen[key] = true;
        ok = true;
      }
    } catch (_) { /* told below */ }
    delete state.starting[key];
    notice(ok ? "" : START_FAIL);
    render();
  }

  // Saves changes to a start. The page shows them first; a failure is told and the real data comes back.
  async function saveStartFields(id, changes, quiet) {
    var row = state.starts.filter(function (r) { return r.id === id; })[0];
    if (row) {
      Object.keys(changes).forEach(function (k) { row[k] = changes[k]; });
      if (!quiet) render();
    }
    state.startHold[id] = (state.startHold[id] || 0) + 1;
    var res = await sb.from("starts").update(changes).eq("id", id);
    state.startHold[id]--;
    if (!state.startHold[id]) delete state.startHold[id];
    if (res.error) {
      notice("That did not save: " + res.error.message);
      await load();
      return false;
    }
    return true;
  }

  function hasBrackets(text) {
    return /\[[^\]\n]+\]/.test(text);
  }

  // The draft box of a start in one place on the page. It is created once and moved into each new panel.
  function draftBox(key, where, row) {
    var id = key + "|" + where;
    var locked = draftLocked(key, row);
    var ta = startBoxes[id];
    if (!ta) {
      ta = document.createElement("textarea");
      ta.className = "start-draft";
      ta.rows = 1;
      ta.maxLength = 20000;
      ta.spellcheck = true;
      ta.setAttribute("aria-label", "Draft reply");
      ta._rev = 0;
      ta._dirty = false;
      ta.addEventListener("input", function () {
        ta._dirty = true;
        ta._rev++;
        fitDraft(ta);
        if (ta._refresh) ta._refresh();
        clearTimeout(ta._t);
        ta._t = setTimeout(function () { flushDraft(ta); }, 1000);
      });
      ta.addEventListener("blur", function () { flushDraft(ta); });
      ta.value = row.draft || "";
      startBoxes[id] = ta;
    } else if (!locked && !ta._dirty && document.activeElement !== ta && ta.value !== (row.draft || "")) {
      ta.value = row.draft || "";
    }
    ta.readOnly = locked; // while a reply is being checked, confirmed or sent, or after it was sent, the words cannot change
    ta._startId = row.id;
    return ta;
  }

  // Saves what is in the draft box, if it changed.
  // Answers with true when nothing is left unsaved.
  function flushDraft(ta) {
    clearTimeout(ta._t);
    if (!ta._dirty) return Promise.resolve(true);
    var rev = ta._rev;
    return saveStartFields(ta._startId, { draft: ta.value }, true).then(function (saved) {
      if (saved !== false && ta._rev === rev) ta._dirty = false;
      return saved !== false;
    });
  }

  // Makes a box as tall as its text; only while it is on screen, where it can be measured.
  function fitDraft(ta) {
    if (!ta.offsetParent) return;
    ta.style.height = "auto";
    var cs = getComputedStyle(ta);
    var edge = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    ta.style.height = (ta.scrollHeight + edge) + "px";
  }

  function fitDrafts() {
    document.querySelectorAll("textarea.start-draft").forEach(fitDraft);
  }

  // A redraw takes the draft box out of the page and puts it back; these keep the caret where it was.
  function captureDraftFocus() {
    var a = document.activeElement;
    if (!a || !a.classList || !a.classList.contains("start-draft")) return null;
    return { box: a, from: a.selectionStart, to: a.selectionEnd, dir: a.selectionDirection, top: a.scrollTop };
  }

  function restoreDraftFocus(saved) {
    if (!saved || !saved.box.isConnected || !saved.box.offsetParent) return;
    saved.box.focus({ preventScroll: true });
    try { saved.box.setSelectionRange(saved.from, saved.to, saved.dir || "none"); } catch (_) { /* not selectable */ }
    saved.box.scrollTop = saved.top;
  }

  async function copyDraft(key, ta) {
    var done = false;
    try {
      if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error("no clipboard");
      await navigator.clipboard.writeText(ta.value);
      done = true;
    } catch (_) {
      // No clipboard here: select the words so you can copy them yourself.
      ta.focus();
      ta.select();
      try { done = document.execCommand("copy"); } catch (__) { done = false; }
    }
    state.copied[key] = done ? "done" : "select";
    render();
    setTimeout(function () { delete state.copied[key]; render(); }, 1800);
  }

  // ---------- Send: the only control on this page that sends something for you ----------

  // The sent state of a start: { at, to } once its draft went out, else null. `to` is empty for a start sent earlier.
  function startSent(row) {
    if (!row) return null;
    var mine = state.sent[row.id];
    if (mine) return mine;
    return row.sent_at ? { at: row.sent_at, to: "" } : null;
  }

  // True while a reply is being checked, confirmed or sent for this start.
  function sendBusy(key) {
    var f = state.sendFlow[key];
    return !!f && (f.phase === "checking" || f.phase === "confirm" || f.phase === "sending");
  }

  // The draft cannot be edited while its reply is in progress, or once it was sent.
  function draftLocked(key, row) {
    return sendBusy(key) || !!startSent(row);
  }

  var SEND_FAIL = "The reply was not sent. Nothing changed.";
  var SEND_UNSURE = "The connection dropped, so the Desk cannot tell whether the reply went out. Check the message before you try again.";

  // The plain words from a failed function call; { words, sure } where sure is false when no answer came back at all.
  async function failureWords(res, fallback) {
    var data = res && res.data;
    if (data && data.ok === false && typeof data.error === "string" && data.error.trim()) return { words: data.error.trim(), sure: true };
    var err = res && res.error;
    var reply = err && err.context;
    if (reply && typeof reply.json === "function") {
      try {
        var body = await reply.json();
        if (body && typeof body.error === "string" && body.error.trim()) return { words: body.error.trim(), sure: true };
      } catch (_) { /* no readable words */ }
      return { words: fallback, sure: true };
    }
    return { words: fallback, sure: !err && !!data }; // an answer that said no, or no answer at all
  }

  function sendLabel(row) {
    return row.draft_kind === "email" ? "Send email" : "Send in Slack";
  }

  // Step 1 and 2: save the draft, then ask the function who would get it. Sends nothing.
  async function beginSend(key, itemId, ta) {
    if (state.sendFlow[key] || state.starting[key]) return; // one flow at a time
    var row = startFor("item", itemId);
    if (!row || startSent(row)) return;
    var flow = { phase: "checking" };
    state.sendFlow[key] = flow;
    delete state.startAsk[key];
    render();
    var text = "";
    var res = null;
    var problem = null;
    if (!(await flushDraft(ta))) {
      problem = "The draft did not save, so it was not checked. Nothing was sent.";
    } else {
      text = ta.value; // the box is read-only now, so this is what was saved
      if (!text.trim() || hasBrackets(text)) {
        delete state.sendFlow[key];
        render();
        return;
      }
      try {
        res = await sb.functions.invoke("send-reply", { body: { mode: "preview", item_id: itemId } });
      } catch (e) {
        res = { error: e };
      }
    }
    if (state.sendFlow[key] !== flow) return;
    var pv = res && !res.error && res.data && res.data.ok === true ? res.data.preview : null;
    if (problem) {
      flow.phase = "failed";
      flow.error = problem;
    } else if (!pv || typeof pv !== "object") {
      var f = await failureWords(res, "The Desk could not check where this reply would go. Nothing was sent.");
      flow.phase = "failed";
      flow.error = f.words;
    } else if (pv.can_send !== true) {
      flow.phase = "blocked";
      flow.reason = typeof pv.reason === "string" && pv.reason.trim() ? pv.reason.trim() : "This reply cannot be sent from here. Nothing was sent.";
    } else if (typeof pv.recipient !== "string" || !pv.recipient.trim() || (pv.kind && row.draft_kind && pv.kind !== row.draft_kind)) {
      flow.phase = "failed";
      flow.error = "The Desk could not confirm who would get this reply. Nothing was sent.";
    } else {
      flow.phase = "confirm";
      flow.text = text;
      flow.to = pv.recipient.trim();
      flow.note = typeof pv.note === "string" && pv.note.trim() ? pv.note.trim() : ""; // shown only; never added to the text
    }
    render();
    focusSendBox(key);
  }

  // GUARANTEES, for the one place on this page that sends a message for you:
  //  1. The send call (the one with mode "send") is made in exactly one place: the line marked SEND CALL below,
  //     in this function, which only the "Send now" button's click handler calls. No redraw, load, timer,
  //     keyboard shortcut, live update or preview calls it, and nothing else on the page sends.
  //  2. One click makes at most one send call: the flow is switched to "sending" before anything is awaited,
  //     and a flow that is not in the "confirm" phase returns at once. Nothing ever retries by itself.
  //  3. The text sent is flow.text, the very text shown in the confirmation box.
  //  4. Enter or Ctrl+Enter in the draft never sends; no key handler on this page sends anything.
  async function sendNow(key, itemId) {
    var flow = state.sendFlow[key];
    if (!flow || flow.phase !== "confirm") return;
    var row = startFor("item", itemId);
    if (!row || startSent(row) || typeof flow.text !== "string") return;
    flow.phase = "sending";
    render();
    var res;
    try {
      var requestId = crypto.randomUUID();
      res = await sb.functions.invoke("send-reply", { body: { mode: "send", item_id: itemId, text: flow.text, request_id: requestId } }); // SEND CALL
    } catch (e) {
      res = { error: e };
    }
    var sent = res && !res.error && res.data && res.data.ok === true ? res.data.sent : null;
    if (sent && typeof sent === "object") {
      state.sent[row.id] = { at: sent.sent_at || new Date().toISOString(), to: typeof sent.recipient === "string" ? sent.recipient : flow.to };
      row.sent_at = state.sent[row.id].at;
      delete state.sendFlow[key];
      delete state.startAsk[key];
      notice("");
    } else {
      var f = await failureWords(res, SEND_FAIL);
      flow.phase = "failed";
      flow.error = f.sure ? f.words : SEND_UNSURE;
    }
    render();
    focusSendBox(key);
    load(); // brings the sent time and the closed item; sends nothing
  }

  function focusSendBox(key) {
    var box = onPage('[data-start-panel="' + key + '"] [data-send-box]');
    if (box) box.focus();
  }

  // Under the draft: the question and the exact text, or why it cannot be sent, or that it was sent.
  function sendBox(key, itemId, row) {
    var done = startSent(row);
    if (done) {
      var line = done.to ? "Sent " + noteDate(done.at) + " to " + done.to : "Sent " + noteDate(done.at);
      var ok = el("p", "send-sent", line);
      ok.setAttribute("role", "status");
      return ok;
    }
    var flow = state.sendFlow[key];
    if (!flow || flow.phase === "checking") return null;
    var box = el("div", "send-box");
    box.setAttribute("data-send-box", key);
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", "Send this reply");
    box.tabIndex = -1;
    var close = function () { delete state.sendFlow[key]; render(); };
    var foot = el("div", "actions");
    if (flow.phase === "confirm" || flow.phase === "sending") {
      var sending = flow.phase === "sending";
      box.appendChild(el("p", "send-ask", "Send this reply?"));
      box.appendChild(el("p", "send-to", "To: " + flow.to));
      box.appendChild(el("div", "send-text", flow.text));
      if (flow.note) box.appendChild(el("p", "fine send-note", flow.note));
      var go = button(sending ? "Sending..." : "Send now", "primary", function () { sendNow(key, itemId); });
      go.disabled = sending;
      var back = button("Keep editing", "btn subtle", close);
      back.disabled = sending;
      foot.appendChild(go);
      foot.appendChild(back);
    } else {
      var why = el("p", flow.phase === "failed" ? "send-why error" : "send-why", flow.phase === "failed" ? flow.error : flow.reason);
      if (flow.phase === "failed") why.setAttribute("role", "alert");
      box.appendChild(why);
      foot.appendChild(button("Close", "btn", close));
    }
    box.appendChild(foot);
    return box;
  }

  function startPanel(kind, id, where) {
    var key = startKey(kind, id);
    var row = startFor(kind, id);
    if (!row || !state.startOpen[key]) return null;
    var busy = !!state.starting[key];
    var panel = el("div", "fold-body start-panel");
    panel.setAttribute("data-start-panel", key);
    if (row.summary) panel.appendChild(el("p", "gist pre", row.summary));

    var steps = (Array.isArray(row.steps) ? row.steps : []).filter(function (x) { return x && x.text; });
    if (steps.length) {
      panel.appendChild(label("Steps"));
      steps.forEach(function (step, i) {
        var line = el("label", "tstep" + (step.done ? " is-done" : ""));
        var tick = document.createElement("input");
        tick.type = "checkbox";
        tick.checked = !!step.done;
        tick.addEventListener("change", function () {
          var next = steps.map(function (x, j) { return { text: String(x.text), done: j === i ? tick.checked : !!x.done }; });
          saveStartFields(row.id, { steps: next });
        });
        line.appendChild(tick);
        line.appendChild(el("span", null, step.text));
        panel.appendChild(line);
      });
    }

    var source = null; // the message this start is about, for the link to reply
    var actions = el("div", "actions");
    var task = null;
    if (kind === "task") {
      task = state.tasks.filter(function (t) { return String(t.id) === String(id); })[0] || null;
      if (task && task.source_item_id) source = state.items.filter(function (i) { return i.id === task.source_item_id; })[0] || null;
    } else {
      source = state.items.filter(function (i) { return String(i.id) === String(id); })[0] || null;
      task = source ? taskFor(source) : null;
    }
    if (steps.length && task) {
      var merged = mergeSteps(task.steps, steps);
      var fresh = merged.length > (Array.isArray(task.steps) ? task.steps.length : 0);
      var addSteps = button(fresh ? "Add these steps to the task" : "Added", "btn", function () { saveTask(task.id, { steps: merged }); });
      addSteps.disabled = !fresh;
      actions.appendChild(addSteps);
    } else if (steps.length && source) {
      var make = button("Make a task with these steps", "btn", function () { taskFromItem(source, make, steps); });
      actions.appendChild(make);
    }
    if (actions.children.length) panel.appendChild(actions);

    if (row.draft !== null && row.draft !== undefined) {
      var head = label("Draft reply");
      if (row.draft_kind === "slack" || row.draft_kind === "email") {
        head.appendChild(document.createTextNode(" "));
        head.appendChild(el("span", "kind", row.draft_kind === "slack" ? "Slack" : "Email"));
      }
      var sentNow = startSent(row);
      if (sentNow) {
        head.appendChild(document.createTextNode(" "));
        head.appendChild(el("span", "kind sent-tag", "Sent"));
      }
      panel.appendChild(head);
      var ta = draftBox(key, where, row);
      panel.appendChild(ta);
      var tools = el("div", "actions");
      var mark = state.copied[key];
      tools.appendChild(button(mark === "done" ? "Copied" : mark === "select" ? "Selected, now copy it" : "Copy", "btn", function () { copyDraft(key, ta); }));
      // Send exists only here: the panel of an inbox item or suggestion that has a message and a draft for it.
      var sendBtn = null;
      if (kind === "item" && source && source.messages && (row.draft_kind === "email" || row.draft_kind === "slack") && !sentNow) {
        var flow = state.sendFlow[key];
        var checking = !!flow && flow.phase === "checking";
        sendBtn = button(checking ? "Checking..." : sendLabel(row), "btn", function () { beginSend(key, id, ta); });
        sendBtn.setAttribute("data-send", key);
        tools.appendChild(sendBtn);
      }
      var link = source ? sourceLink(source) : null;
      if (link) tools.appendChild(linkTo(link.href, link.label, "btn"));
      panel.appendChild(tools);
      var box = sendBox(key, id, row);
      if (box) panel.appendChild(box);
      panel.appendChild(el("p", "fine", "Nothing is sent until you press Send and confirm."));
      var hint = el("p", "fine", "Fill in the parts in [brackets] before you use it.");
      ta._refresh = function () {
        var open = hasBrackets(ta.value) && !sentNow;
        hint.hidden = !open;
        if (sendBtn) sendBtn.disabled = busy || !!state.sendFlow[key] || !ta.value.trim() || hasBrackets(ta.value);
      };
      ta._refresh();
      panel.appendChild(hint);
    }

    var foot = el("div", "actions");
    if (busy) {
      var wait = button("Preparing...", "btn subtle", function () {});
      wait.disabled = true;
      foot.appendChild(wait);
    } else if (state.startAsk[key]) {
      foot.appendChild(el("span", "note-ask", row.draft ? "Write it again? Your edits to the draft will be replaced." : "Write it again? Your ticks on the steps will be replaced."));
      foot.appendChild(button("Write again", "btn", function () { runStart(kind, id, true); }));
      foot.appendChild(button("Keep", "btn", function () { delete state.startAsk[key]; render(); }));
    } else {
      if (!startSent(row) && !sendBusy(key)) foot.appendChild(button("Redo", "btn subtle", function () { state.startAsk[key] = true; render(); }));
      foot.appendChild(button("Hide", "btn subtle", function () { delete state.startOpen[key]; delete state.startAsk[key]; render(); }));
    }
    panel.appendChild(foot);
    return panel;
  }

  // ---------- Data ----------

  function index(rows, keyOf) {
    var out = {};
    (rows || []).forEach(function (r) { out[keyOf(r)] = r; });
    return out;
  }

  async function load() {
    // A request that arrives while a load is running is not dropped: it runs right after,
    // so the page never settles on data fetched before the latest change.
    if (state.loading) { state.loadAgain = true; return; }
    state.loading = true;
    try {
      var since = new Date(Date.now() - DAY).toISOString();
      var results = await Promise.all([
        sb.from("items")
          .select("id, space, lane, status, title, summary, reason, urgency, created_at, closed_at, closed_by, snooze_until, owed_to, due_on, origin, kind, theme, quote, source_label, source_url, meeting_on, sources, messages(source, channel_id, channel_type, thread_ts, ts, author_id, author_name, subject, body, occurred_at)")
          .or('status.in.(open,snoozed),closed_at.gte."' + since + '"')
          .order("created_at", { ascending: false })
          .limit(500),
        sb.from("channels").select("space, slack_channel_id, name, kind").limit(5000),
        sb.from("accounts").select("space, slack_url, slack_user_id, email"),
        sb.from("tasks")
          .select("id, space, project_id, title, notes, context, links, steps, related, repeat, horizon, urgent, status, due_on, source_item_id, slips, first_due_on, created_at, done_at, projects(name)")
          .or('status.eq.open,and(status.eq.done,done_at.gte."' + since + '")')
          .order("created_at", { ascending: true })
          .limit(1000),
        sb.from("projects").select("id, space, name, is_plan, what, stage, depends_on, next_step, target_on, people, tools, links, standing, review, reviewed_at, updated_at").eq("status", "active").order("name").limit(1000),
        // From the start of today (a little earlier, so all-day events dated in another time zone are not missed).
        sb.from("meetings")
          .select("id, space, event_id, title, starts_at, ends_at, all_day, status, my_response, join_url, event_url, location, organizer, attendees, recurring_event_id, brief, owed")
          .gte("starts_at", new Date(dayStart(new Date()) - 14 * 60 * 60 * 1000).toISOString())
          .neq("status", "cancelled")
          .order("starts_at", { ascending: true })
          .limit(200),
        sb.from("notes")
          .select("id, space, project_id, body, pinned, created_at, updated_at")
          .order("created_at", { ascending: false })
          .limit(500),
        sb.from("cover_reviews").select("space, review, points, written_at"),
        sb.from("starts").select("id, item_id, task_id, space, summary, steps, draft, draft_kind, sent_at, updated_at"),
      ]);
      var failed = results.filter(function (r) { return r.error; })[0];
      if (failed) throw new Error(failed.error.message);

      state.channels = index(results[1].data, function (c) { return c.space + ":" + c.slack_channel_id; });
      state.accounts = index(results[2].data, function (a) { return a.space; });
      state.tasks = results[3].data || [];
      state.projects = results[4].data || [];
      state.meetings = results[5].data || [];
      // A note you just saved stays on screen until the database has it.
      state.notes = (results[6].data || []).concat(state.notes.filter(function (n) { return n.pending; }));
      state.covers = mergeCovers(results[7].data || []);
      state.starts = mergeStarts(results[8].data || []);
      var items = results[0].data || [];
      state.people = await loadPeople(items);
      announceNew(items);
      state.items = items;

      // The owner can always see the two workspace rows; nobody else can see any.
      if (!(results[2].data || []).length) notice("This sign-in does not have access to the Desk.", true);
      else if (state.noticeFromLoad) notice("");
      render();
      $("updated").textContent = "Updated " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) + " · version " + VERSION;
    } catch (err) {
      notice("Could not load the Desk: " + (err && err.message ? err.message : "unknown error") + ". Retrying.", true);
    } finally {
      state.loading = false;
      if (state.loadAgain) {
        state.loadAgain = false;
        load();
      }
    }
  }

  // Names for the authors and for everyone mentioned in the Slack messages on the page.
  async function loadPeople(items) {
    var ids = {};
    items.forEach(function (item) {
      var m = item.messages || {};
      if (m.source === "gmail") return;
      if (m.author_id) ids[m.author_id] = true;
      var re = /<@([A-Z0-9]+)/g, hit;
      while ((hit = re.exec(String(m.body || "")))) ids[hit[1]] = true;
    });
    var list = Object.keys(ids);
    var out = {};
    // The key people are always loaded, even when none of them wrote anything on the page.
    var keysAsked = sb.from("people").select("space, slack_user_id, name, is_vip, is_key").eq("is_key", true); // runs alongside the rest
    for (var i = 0; i < list.length; i += 150) {
      var res = await sb.from("people").select("space, slack_user_id, name, is_vip, is_key").in("slack_user_id", list.slice(i, i + 150));
      if (res.error) throw new Error(res.error.message);
      (res.data || []).forEach(function (p) { out[p.space + ":" + p.slack_user_id] = p; });
    }
    var keys = await keysAsked;
    if (keys.error) throw new Error(keys.error.message);
    (keys.data || []).forEach(function (p) { out[p.space + ":" + p.slack_user_id] = p; });
    return out;
  }

  function reloadSoon() {
    clearTimeout(state.reloadTimer);
    state.reloadTimer = setTimeout(load, 250);
  }

  async function act(id, action, at) {
    var item = state.items.filter(function (i) { return i.id === id; })[0];
    var saving = sb.rpc("set_item_state", { p_item: id, p_action: action, p_until: at || null }); // saved at once
    var closing = action === "done" || action === "dismiss";
    if (item && closing) {
      var label = action === "dismiss" ? "Dismissed" : item.kind === "decision" ? "✓ Noted" : "✓ Done";
      await leave(onPage('[data-item="' + id + '"]'), label, action === "done" ? "ok" : "dismissed");
    }
    // Show the change without waiting for fresh data.
    if (item) {
      if (closing) {
        item.status = action === "done" ? "done" : "dismissed";
        item.closed_by = "user";
        item.closed_at = new Date().toISOString();
        item.snooze_until = null;
      } else if (action === "snooze") {
        item.status = "snoozed";
        item.snooze_until = at;
      } else if (action === "reopen") {
        item.status = "open";
        item.closed_by = null;
        item.closed_at = null;
        item.snooze_until = null;
      }
      render();
    }
    var res = await saving;
    if (res.error) {
      notice("That did not save: " + res.error.message);
    } else if (action !== "reopen") {
      var said = action === "dismiss" ? "Dismissed." : action === "snooze" ? "Back " + until(at) + "." : item && item.kind === "decision" ? "Noted." : "Marked done.";
      toast(said, function () { act(id, "reopen"); });
    }
    await load();
  }

  // ---------- Live updates ----------

  function setLive(text, ok) {
    var n = $("live");
    n.textContent = text;
    n.className = "live" + (ok ? " ok" : "");
  }

  function listen() {
    if (state.channel) sb.removeChannel(state.channel);
    state.channel = sb.channel("desk-items")
      .on("postgres_changes", { event: "*", schema: "public", table: "items" }, reloadSoon)
      .on("postgres_changes", { event: "*", schema: "public", table: "tasks" }, reloadSoon)
      .on("postgres_changes", { event: "*", schema: "public", table: "meetings" }, reloadSoon)
      .on("postgres_changes", { event: "*", schema: "public", table: "projects" }, reloadSoon)
      .on("postgres_changes", { event: "*", schema: "public", table: "notes" }, reloadSoon)
      .on("postgres_changes", { event: "*", schema: "public", table: "cover_reviews" }, reloadSoon)
      .subscribe(function (status) {
        if (status === "SUBSCRIBED") { setLive("Live", true); reloadSoon(); }
        else setLive("Reconnecting", false);
      });
  }

  // ---------- Alerts while this page is open ----------

  function alertsUsable() {
    return "Notification" in window;
  }

  function refreshAlertsButton() {
    var b = $("alerts");
    b.hidden = !alertsUsable() || Notification.permission !== "default";
  }

  function announceNew(items) {
    var fresh = [];
    var ids = {};
    items.forEach(function (item) {
      ids[item.id] = true;
      if (state.seen && !state.seen[item.id] && item.status === "open" && item.lane === "waiting") fresh.push(item);
    });
    state.seen = ids;
    if (!fresh.length || !alertsUsable() || Notification.permission !== "granted") return;
    fresh.slice(0, 3).forEach(function (item) {
      try {
        new Notification(authorLabel(item).replace(" ★", "") + " · " + spaceLabel(item.space), {
          body: item.title,
          tag: "desk-item-" + item.id,
        });
      } catch (_) { /* phones need the installed version of the Desk for alerts; that comes later */ }
    });
  }

  // ---------- Sign-in ----------

  function show(signedIn) {
    $("signin").hidden = signedIn;
    $("app").hidden = !signedIn;
  }

  $("signin-form").addEventListener("submit", async function (event) {
    event.preventDefault();
    var problem = $("signin-error");
    problem.hidden = true;
    var res = await sb.auth.signInWithPassword({ email: $("email").value.trim(), password: $("password").value });
    $("password").value = "";
    if (res.error) {
      problem.textContent = "Sign-in failed: " + res.error.message;
      problem.hidden = false;
    }
  });

  $("signout").addEventListener("click", function () { sb.auth.signOut(); });

  $("task-form").addEventListener("submit", async function (event) {
    event.preventDefault();
    var text = $("task-title").value.trim();
    if (!text) return;
    var add = $("task-add");
    add.disabled = true;
    add.textContent = "Working it out…";
    var space = state.filter !== "all" ? state.filter : readPref("desk.task-space", "metaculus");
    var s = await suggest({ text: text, space: state.filter !== "all" ? state.filter : null });
    showDialog(withSuggestion(blankTask(space, text), s), s ? "Suggested from what you typed. Change anything, then save." : "Could not get a suggestion. Fill in what you need, then save.");
    add.disabled = false;
    add.textContent = "Add";
    $("task-title").value = "";
  });

  $("plan-add").addEventListener("click", function () { openPlanDialog(null); });
  $("pd-form").addEventListener("submit", function (event) { event.preventDefault(); savePlan(); });
  $("pd-cancel").addEventListener("click", function () { $("plan-dialog").close(); });
  STAGES.forEach(function (st) {
    var o = el("option", null, st.label);
    o.value = st.id;
    $("pd-stage").appendChild(o);
  });

  $("td-form").addEventListener("submit", function (event) { event.preventDefault(); saveDraft(); });
  $("td-space").addEventListener("change", function () {
    writePref("desk.task-space", $("td-space").value);
    fillProjectChoices($("td-space").value, "");
  });
  $("td-project").addEventListener("change", function () {
    var fresh = $("td-project-new");
    fresh.hidden = $("td-project").value !== "__new__";
    if (!fresh.hidden) fresh.focus();
  });
  $("td-cancel").addEventListener("click", function () { $("task-dialog").close(); });
  $("td-done").addEventListener("click", function () {
    $("task-dialog").close();
    var task = state.tasks.filter(function (t) { return t.id === draft.id; })[0];
    if (task) finishTask(task, null);
  });
  $("td-drop").addEventListener("click", function () {
    $("task-dialog").close();
    saveTask(draft.id, { status: "dropped", done_at: new Date().toISOString() });
  });
  $("td-step-add").addEventListener("click", addStep);
  // Enter in the small "add" boxes adds the step or link instead of saving the whole task.
  $("td-step-text").addEventListener("keydown", function (event) {
    if (event.key === "Enter") { event.preventDefault(); addStep(); }
  });
  ["td-link-label", "td-link-url"].forEach(function (id) {
    $(id).addEventListener("keydown", function (event) {
      if (event.key === "Enter") { event.preventDefault(); $("td-link-add").click(); }
    });
  });
  $("td-link-add").addEventListener("click", function () {
    var url = F.safeUrl($("td-link-url").value.trim());
    if (!url) { $("td-link-url").focus(); return; }
    draft.links.push({ label: $("td-link-label").value.trim() || F.host(url), url: url });
    $("td-link-label").value = "";
    $("td-link-url").value = "";
    drawLinks();
  });

  $("td-close").addEventListener("click", function () { $("task-dialog").close(); });
  $("pd-close").addEventListener("click", function () { $("plan-dialog").close(); });

  // Search: the current view shows only what contains every word typed. The box itself is never redrawn.
  $("search").addEventListener("input", function () {
    $("search-clear").hidden = !$("search").value;
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(function () { state.query = $("search").value; render(); }, 150);
  });
  $("search-clear").addEventListener("click", function () {
    clearSearch();
    render();
    $("search").focus();
  });
  document.addEventListener("keydown", function (event) {
    if (event.key !== "Escape" || !$("search").value || document.querySelector("dialog[open]")) return;
    clearSearch();
    render();
  });
  FOLDS.forEach(function (id) {
    var fold = $(id);
    fold.querySelector("summary").addEventListener("click", function () { state.folds[id] = !fold.open; });
  });

  [false, true].forEach(function (quick) {
    var pre = quick ? "cvnote-" : "note-";
    $(pre + "form").addEventListener("submit", function (event) { event.preventDefault(); saveNote(quick); });
    $(pre + "body").addEventListener("input", function () { grow($(pre + "body")); });
    $(pre + "body").addEventListener("keydown", function (event) {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); saveNote(quick); }
    });
    $(pre + "space").addEventListener("change", function () { $(pre + "error").hidden = true; syncNoteForm(); });
  });
  window.addEventListener("resize", function () {
    if (state.view === "notes") fitNotes();
    fitDrafts();
  });

  $("alerts").addEventListener("click", function () {
    Notification.requestPermission().then(refreshAlertsButton);
  });

  var started = false;
  sb.auth.onAuthStateChange(function (_event, session) {
    // Supabase asks that no other Supabase call is made inside this callback, so defer.
    setTimeout(function () {
      if (session && !started) {
        started = true;
        show(true);
        refreshAlertsButton();
        load();
        listen();
      } else if (!session) {
        started = false;
        if (state.channel) { sb.removeChannel(state.channel); state.channel = null; }
        state.items = [];
        state.meetings = [];
        state.notes = [];
        state.covers = [];
        state.starts = [];
        state.sendFlow = {};
        state.sent = {};
        state.seen = null;
        show(false);
      }
    }, 0);
  });

  // Safety net if the live connection drops, and to move "Later" items back when their time comes.
  setInterval(function () { if (started && !document.hidden) load(); }, 60000);
  document.addEventListener("visibilitychange", function () { if (started && !document.hidden) load(); });
})();
