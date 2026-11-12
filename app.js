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
    { id: "inbox", label: "Inbox" },
    { id: "tasks", label: "Tasks" },
    { id: "planning", label: "Planning" },
    { id: "meetings", label: "Meetings" },
  ];
  var DAY = 24 * 60 * 60 * 1000;

  var state = {
    items: [],
    tasks: [],
    meetings: [],
    openMeetings: {}, // ids of meetings whose details you opened
    openPlans: {},    // ids of plans whose details you opened
    openTasks: {},    // ids of tasks you expanded in the list
    openSections: { today: true, week: true, weeks: false, later: false }, // task sections you opened or closed
    folds: {},        // the fixed folds (tray, Later, Closed, Decisions, ...) you opened
    query: "",        // what is typed in the search box
    reviewing: {},    // ids of plans whose review is running
    doneSuggestions: {}, // review suggestions that became tasks this session, keyed by plan id and text
    projects: [],
    people: {},   // "space:userId" -> { name, is_vip }
    channels: {}, // "space:channelId" -> { name, kind }
    accounts: {}, // space -> { slack_url }
    filter: readPref("desk.space", "all"),
    view: readPref("desk.view", "inbox"), // inbox | tasks | planning | meetings
    taskMode: readPref("desk.task-mode", "list"), // list | days
    project: null, // show only this project's tasks
    seen: null,   // ids already shown, to tell which waiting items are new
    loading: false,
    reloadTimer: null,
    channel: null,
  };

  function $(id) { return document.getElementById(id); }

  // An old saved choice (such as the former Commitments view) falls back to Inbox.
  if (!VIEWS.some(function (v) { return v.id === state.view; })) state.view = "inbox";

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

  function card(item, kind) {
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
      actions.appendChild(button("Dismiss", "btn subtle", function () { act(item.id, "dismiss"); }));
    } else {
      actions.appendChild(button("Reopen", "btn", function () { act(item.id, "reopen"); }));
    }
    node.appendChild(actions);
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
    items.forEach(function (item) { list.appendChild(card(item, "commit")); });
  }

  // Which view an item lives in: suggested tasks in Tasks, decisions in Planning, the rest in Inbox.
  function viewFor(item) {
    if (item.lane !== "commitment") return "inbox";
    return item.kind === "decision" ? "planning" : "tasks";
  }

  // The folds that are part of the page itself. Your choice is remembered; while a search is on,
  // a fold that holds a match is shown open.
  var FOLDS = ["box-suggested", "box-later-sug", "box-closed-sug", "box-decisions", "box-later", "box-closed", "box-tasks-done"];

  function setFold(id, hasMatch) {
    $(id).open = needles.length ? !!hasMatch : !!state.folds[id];
  }

  function render() {
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

    fill("list-waiting", "n-waiting", groups.waiting, "waiting", "Nothing is waiting on you.");
    fillSuggested(groups.commit);
    $("box-suggested").hidden = !(groups.commit.length || groups.later.length || groups.closed.length);
    $("n-suggested").textContent = String(groups.commit.length);
    fillByTheme("list-decisions", "n-decisions", groups.decision, "decision");
    $("box-decisions").hidden = !groups.decision.length;
    fill("list-look", "n-look", groups.look, "look", "Nothing else to look at.");
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
    var lists = state.view !== "meetings";
    $("box-later").hidden = !lists || inTasks || !groups.later.length;
    $("box-closed").hidden = !lists || inTasks || !groups.closed.length;

    // What is on screen in this view, for "N found" and for the sentence when nothing matches.
    found = groups.later.length + groups.closed.length;
    if (state.view === "inbox") found += groups.waiting.length + groups.look.length;
    else if (state.view === "tasks") found += groups.commit.length + taskRows;
    else if (state.view === "planning") found += groups.decision.length + planRows;
    else found += meetingCards;

    document.querySelectorAll("[data-view]").forEach(function (section) {
      section.hidden = section.getAttribute("data-view") !== state.view;
    });
    if (searching) { // a section with nothing that matches is hidden
      if (!groups.waiting.length) $("list-waiting").parentElement.hidden = true;
      if (!groups.look.length) $("list-look").parentElement.hidden = true;
    }
    setFold("box-suggested", groups.commit.length || groups.later.length || groups.closed.length);
    setFold("box-later-sug", groups.later.length);
    setFold("box-closed-sug", groups.closed.length);
    setFold("box-decisions", groups.decision.length);
    setFold("box-later", groups.later.length);
    setFold("box-closed", groups.closed.length);
    setFold("box-tasks-done", $("list-tasks-done").children.length);

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
      var b = button(v.label + (counts[v.id] ? " " + counts[v.id] : ""), "view" + (state.view === v.id ? " on" : ""), function () {
        state.view = v.id;
        writePref("desk.view", v.id);
        render();
        window.scrollTo(0, 0);
      });
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
    writePref("desk.view", state.view);
    if (state.filter !== "all" && state.filter !== item.space) {
      state.filter = "all";
      writePref("desk.space", "all");
    }
    render();
    var card = document.querySelector('[data-item="' + item.id + '"]');
    if (!card) return;
    for (var p = card.parentElement; p; p = p.parentElement) {
      if (p.tagName === "DETAILS") {
        p.open = true;
        if (p.id) state.folds[p.id] = true; // stays open across redraws
      }
    }
    card.scrollIntoView({ block: "center", behavior: calm ? "auto" : "smooth" });
    card.classList.add("flash");
    setTimeout(function () { card.classList.remove("flash"); }, 2200);
  }

  function meetingCard(m, now) {
    var start = meetingDate(m);
    var live = !m.all_day && start.getTime() <= now && now < meetingEnd(m).getTime();
    var node = el("article", "card meeting" + (live ? " in-progress" : ""));
    node.setAttribute("data-meeting", m.id);

    var top = el("div", "card-top");
    top.appendChild(el("span", "tag tag-" + m.space, spaceLabel(m.space)));
    top.appendChild(el("span", "when", m.all_day ? "All day" : clock(start) + " – " + clock(meetingEnd(m))));
    if (m.recurring_event_id) top.appendChild(el("span", "kind", "Repeats"));
    if (live) {
      top.appendChild(el("span", "flag flag-3", "Now"));
    } else if (!m.all_day) {
      var mins = Math.ceil((start.getTime() - now) / 60000);
      if (mins > 0 && mins <= 60) top.appendChild(el("span", "flag flag-2", "In " + mins + " min"));
    }
    if (RESPONSES[m.my_response]) top.appendChild(el("span", "flag flag-2", RESPONSES[m.my_response]));
    node.appendChild(top);

    node.appendChild(el("h3", "title", m.title || "Meeting"));

    var names = (Array.isArray(m.attendees) ? m.attendees : [])
      .filter(function (a) { return a && !a.self; })
      .map(personName).filter(Boolean);
    if (names.length) {
      var shown = names.slice(0, 5).join(", ");
      if (names.length > 5) shown += " +" + (names.length - 5) + " more";
      node.appendChild(el("p", "reason", "With " + shown));
    }
    var owed = openOwed(m);
    if (m.brief || owed.length) {
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
      node.appendChild(fold);
    }

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
    order.forEach(function (key) {
      var day = days[key];
      var name = day.offset === 0 ? "Today" : day.offset === 1 ? "Tomorrow"
        : new Date(key).toLocaleDateString([], { weekday: "long", day: "numeric", month: "short" });
      list.appendChild(el("h3", "theme day", name));
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
      if (cards.children.length) list.appendChild(cards);
      if (earlier.length) {
        var fold = el("details", "earlier");
        var head = el("summary", null, "Earlier today · " + earlier.length);
        head.addEventListener("click", function () { state.folds.earlier = !fold.open; });
        fold.appendChild(head);
        var inner = el("div", "list");
        earlier.forEach(function (m) { inner.appendChild(meetingCard(m, now)); });
        fold.appendChild(inner);
        fold.open = needles.length ? true : !!state.folds.earlier;
        list.appendChild(fold);
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
      state.view = "tasks";
      writePref("desk.view", "tasks");
      render();
      window.scrollTo(0, 0);
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
  function taskDetails(task, row) {
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
      actions.appendChild(button("Drop", "btn subtle", function () {
        saveTask(task.id, { status: "dropped", done_at: new Date().toISOString() });
        toast("Task dropped.", function () { saveTask(task.id, { status: "open", done_at: null }); });
      }));
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

  function taskRow(task) {
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
    if (isOpen) row.appendChild(taskDetails(task, row));

    // Tapping the row opens or closes it in place. Controls inside it do their own thing.
    row.addEventListener("click", function (event) {
      if (event.target.closest("input, a, select, .fold-body, button:not(.task-title)")) return;
      if (state.openTasks[task.id]) delete state.openTasks[task.id]; else state.openTasks[task.id] = true;
      var fresh = taskRow(task);
      row.replaceWith(fresh);
      if (event.target.classList.contains("task-title")) fresh.querySelector(".task-title").focus({ preventScroll: true });
    });
    return row;
  }

  // Jumps to a task in the list and opens it.
  function goToTask(task) {
    clearSearch();
    state.view = "tasks";
    writePref("desk.view", "tasks");
    if (state.filter !== "all" && state.filter !== task.space) {
      state.filter = "all";
      writePref("desk.space", "all");
    }
    state.project = null;
    state.openSections[horizonOf(task)] = true;
    state.openTasks[task.id] = true;
    render();
    var row = document.querySelector('[data-task="' + task.id + '"]');
    if (!row) return;
    row.scrollIntoView({ block: "center", behavior: calm ? "auto" : "smooth" });
    row.classList.add("flash");
    setTimeout(function () { row.classList.remove("flash"); }, 2200);
  }

  // Tasks with a date first, by date; then the rest, newest first.
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
    rows.forEach(function (t) { body.appendChild(taskRow(t)); });
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
      group("overdue", "Overdue", open.filter(function (t) { return t.due_on && t.due_on < today; }).sort(function (a, b) { return a.due_on < b.due_on ? -1 : 1; }));
      var days = {};
      open.forEach(function (t) { if (t.due_on && t.due_on >= today) (days[t.due_on] = days[t.due_on] || []).push(t); });
      Object.keys(days).sort().forEach(function (day) {
        var d = new Date(day + "T12:00:00");
        var name = d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "short" });
        group(day, day === today ? "Today · " + name : name, days[day].sort(byCreated));
      });
      group("nodate", "No date", open.filter(function (t) { return !t.due_on; }));
    } else {
      HORIZONS.forEach(function (h) {
        var rows = open.filter(function (t) { return horizonOf(t) === h.id; }).sort(taskOrder);
        if (needles.length && !rows.length) return;
        list.appendChild(taskSection(h.id, h.label, rows, true));
      });
    }
    if (!open.length && !needles.length && state.taskMode === "days") list.appendChild(el("p", "empty", state.project ? "No open tasks in this project." : "No open tasks."));

    var done = shown.filter(function (t) { return t.status === "done"; });
    var doneList = $("list-tasks-done");
    doneList.textContent = "";
    done.forEach(function (t) { doneList.appendChild(taskRow(t)); });
    $("n-tasks-done").textContent = done.length ? String(done.length) : "";
    $("box-tasks-done").hidden = !done.length;
    return open.length + done.length;
  }

  // Ticking a task off: stamp the row, fold it away, then say so (with Undo unless it repeats,
  // because a repeating task has already produced its next occurrence).
  async function finishTask(task, row) {
    var saving = sb.from("tasks").update({ status: "done", done_at: new Date().toISOString() }).eq("id", task.id);
    await leave(row || document.querySelector('[data-task="' + task.id + '"]'), "✓ Done", "ok");
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
      horizon: task.horizon, due_on: task.due_on, repeat: task.repeat, context: task.context, notes: task.notes,
      links: Array.isArray(task.links) ? task.links.slice() : [], source_item_id: task.source_item_id,
      steps: (Array.isArray(task.steps) ? task.steps : []).map(function (x) { return { text: String(x.text || ""), done: !!x.done }; }),
      related: Array.isArray(task.related) ? task.related.slice() : [],
    });
  }

  function blankTask(space, title) {
    return { id: null, status: "open", space: space, title: title || "", project: "", horizon: "week", due_on: null, repeat: null, context: "", notes: "", links: [], steps: [], related: [], source_item_id: null };
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

  async function taskFromItem(item, trigger) {
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
    showDialog(withSuggestion(task, s), s ? "Suggested from " + basis + ". Change anything, then save." : "Could not get a suggestion, so this is filled in from the item. Change anything, then save.");
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

  function notice(text) {
    var n = $("notice");
    n.hidden = !text;
    n.textContent = text || "";
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
          .select("id, space, project_id, title, notes, context, links, steps, related, repeat, horizon, status, due_on, source_item_id, slips, first_due_on, created_at, done_at, projects(name)")
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
      ]);
      var failed = results.filter(function (r) { return r.error; })[0];
      if (failed) throw new Error(failed.error.message);

      state.channels = index(results[1].data, function (c) { return c.space + ":" + c.slack_channel_id; });
      state.accounts = index(results[2].data, function (a) { return a.space; });
      state.tasks = results[3].data || [];
      state.projects = results[4].data || [];
      state.meetings = results[5].data || [];
      var items = results[0].data || [];
      state.people = await loadPeople(items);
      announceNew(items);
      state.items = items;

      // The owner can always see the two workspace rows; nobody else can see any.
      notice((results[2].data || []).length ? "" : "This sign-in does not have access to the Desk.");
      render();
      $("updated").textContent = "Updated " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) + " · version " + VERSION;
    } catch (err) {
      notice("Could not load the Desk: " + (err && err.message ? err.message : "unknown error") + ". Retrying.");
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
    for (var i = 0; i < list.length; i += 150) {
      var res = await sb.from("people").select("space, slack_user_id, name, is_vip").in("slack_user_id", list.slice(i, i + 150));
      if (res.error) throw new Error(res.error.message);
      (res.data || []).forEach(function (p) { out[p.space + ":" + p.slack_user_id] = p; });
    }
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
      await leave(document.querySelector('[data-item="' + id + '"]'), label, action === "done" ? "ok" : "dismissed");
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
        state.seen = null;
        show(false);
      }
    }, 0);
  });

  // Safety net if the live connection drops, and to move "Later" items back when their time comes.
  setInterval(function () { if (started && !document.hidden) load(); }, 60000);
  document.addEventListener("visibilitychange", function () { if (started && !document.hidden) load(); });
})();
