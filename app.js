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
    { id: "commitments", label: "Commitments" },
    { id: "tasks", label: "Tasks" },
  ];
  var DAY = 24 * 60 * 60 * 1000;

  var state = {
    items: [],
    tasks: [],
    projects: [],
    people: {},   // "space:userId" -> { name, is_vip }
    channels: {}, // "space:channelId" -> { name, kind }
    accounts: {}, // space -> { slack_url }
    filter: readPref("desk.space", "all"),
    view: readPref("desk.view", "inbox"), // inbox | commitments | tasks
    taskMode: readPref("desk.task-mode", "list"), // list | days
    project: null, // show only this project's tasks
    seen: null,   // ids already shown, to tell which waiting items are new
    loading: false,
    reloadTimer: null,
    channel: null,
  };

  function $(id) { return document.getElementById(id); }

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

  function byPriority(a, b) {
    if (b.urgency !== a.urgency) return b.urgency - a.urgency;
    var ta = (a.messages && a.messages.occurred_at) || a.created_at;
    var tb = (b.messages && b.messages.occurred_at) || b.created_at;
    return ta < tb ? -1 : ta > tb ? 1 : 0; // the one waiting longest comes first
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

  // A Google Docs, Sheets or Slides notice: the file, each comment, and a link to it. Nothing else.
  function docView(item, doc) {
    var box = el("details", "message doc");
    box.appendChild(el("summary", null, doc.comments.length === 1 ? "1 comment" : doc.comments.length + " comments"));
    box.appendChild(el("p", "file", doc.file));
    doc.comments.forEach(function (c) {
      var one = el("div", "comment");
      var head = el("p", "comment-head", c.author);
      if (c.anchor) head.appendChild(el("span", "anchor", " on \u201c" + c.anchor + "\u201d"));
      one.appendChild(head);
      appendBlocks(one, F.emailBlocks(c.text));
      if (c.url) one.appendChild(linkTo(withAccount(c.url, item), "Open comment ↗", "chip"));
      box.appendChild(one);
    });
    return box;
  }

  // The message itself, cleaned up, behind a fold. Emails lose quoted history, signature and footer;
  // "Show everything" brings the full text back.
  function originalView(item) {
    var m = item.messages;
    var more = el("details", "message");
    more.appendChild(el("summary", null, item.lane === "commitment" ? "What you wrote" : isEmail(item) ? "Original email" : "Original message"));
    var body = el("div", "body");
    if (!isEmail(item)) {
      appendBlocks(body, F.slackBlocks(m.body, {
        me: (state.accounts[item.space] || {}).slack_user_id || "",
        person: function (id) { var p = state.people[item.space + ":" + id]; return p && p.name ? p.name : null; },
        channel: function (id) { var c = state.channels[item.space + ":" + id]; return c && c.name ? c.name : null; },
      }));
      more.appendChild(body);
      return more;
    }
    if (m.subject) more.appendChild(el("p", "subject", m.subject));
    var cleaned = F.cleanEmail(m.body);
    appendBlocks(body, F.emailBlocks(cleaned.text));
    more.appendChild(body);
    if (cleaned.cut) {
      var full = el("p", "body raw", cleaned.full);
      full.hidden = true;
      var toggle = button("Show everything", "quiet", function () {
        full.hidden = !full.hidden;
        body.hidden = !full.hidden;
        toggle.textContent = full.hidden ? "Show everything" : "Show the short version";
      });
      more.appendChild(full);
      more.appendChild(toggle);
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
      meta = (item.kind === "promise" && item.owed_to ? "To " + item.owed_to + " · " : "") + where + (met ? " · meeting of " + met : "");
    } else {
      meta = (promise ? "To " + (item.owed_to || "someone") : authorLabel(item)) + " · " + whereLabel(item) + " · " + ago(m.occurred_at || item.created_at);
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
        told.forEach(function (x) {
          var block = el("div", "said");
          var day = meetingDay(x.meeting_on);
          block.appendChild(el("p", "said-from", x.label + (day ? " · " + day : "")));
          if (x.quote) block.appendChild(el("p", "body", x.quote));
          // What the summary above already says is not repeated.
          if (x.detail && x.detail !== item.summary) block.appendChild(el("p", "said-detail", x.detail));
          said.appendChild(block);
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
    } else if (kind === "waiting" || kind === "look" || kind === "commit") {
      actions.appendChild(button("Done", "btn", function () { act(item.id, "done"); }));
      var later = el("span", "later");
      later.appendChild(button("Later", "btn", function () { later.classList.toggle("open"); }));
      var choices = el("span", "choices");
      laterChoices().forEach(function (c) {
        choices.appendChild(button(c.label, "btn small", function () { act(item.id, "snooze", c.at.toISOString()); }));
      });
      later.appendChild(choices);
      actions.appendChild(later);
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
      if (emptyText) list.appendChild(el("p", "empty", emptyText));
      return;
    }
    items.forEach(function (item) { list.appendChild(card(item, kind)); });
  }

  // Commitments are shown under the project or theme they belong to.
  function fillByTheme(listId, countId, items, kind, emptyText) {
    var list = $(listId);
    list.textContent = "";
    $(countId).textContent = items.length ? String(items.length) : "";
    if (!items.length) {
      if (emptyText) list.appendChild(el("p", "empty", emptyText));
      return;
    }
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

  function render() {
    var groups = { waiting: [], commit: [], decision: [], look: [], later: [], closed: [] };
    var waitingBySpace = {};
    state.items.forEach(function (item) {
      var b = bucket(item);
      if (b === "waiting") waitingBySpace[item.space] = (waitingBySpace[item.space] || 0) + 1;
      if (state.filter !== "all" && item.space !== state.filter) return;
      groups[b].push(item);
    });
    // Later and Closed follow the section: promises in Commitments, everything else in Inbox.
    var promises = state.view === "commitments";
    ["later", "closed"].forEach(function (k) {
      groups[k] = groups[k].filter(function (item) { return (item.lane === "commitment") === promises; });
    });
    groups.waiting.sort(byPriority);
    groups.look.sort(byPriority);
    groups.commit.sort(function (a, b) {
      if (a.due_on && b.due_on && a.due_on !== b.due_on) return a.due_on < b.due_on ? -1 : 1;
      if (a.due_on !== b.due_on) return a.due_on ? -1 : 1; // dated promises first
      return byPriority(a, b);
    });
    groups.later.sort(function (a, b) { return a.snooze_until < b.snooze_until ? -1 : 1; });
    groups.closed.sort(function (a, b) { return a.closed_at > b.closed_at ? -1 : 1; });

    fill("list-waiting", "n-waiting", groups.waiting, "waiting", "Nothing is waiting on you.");
    fillByTheme("list-commit", "n-commit", groups.commit, "commit", "No open promises or to-dos.");
    fillByTheme("list-decisions", "n-decisions", groups.decision, "decision", null);
    $("box-decisions").hidden = state.view !== "commitments" || !groups.decision.length;
    fill("list-look", "n-look", groups.look, "look", "Nothing else to look at.");
    renderTasks();
    fill("list-later", "n-later", groups.later, "later", null);
    fill("list-closed", "n-closed", groups.closed, "closed", null);
    document.querySelectorAll("[data-view]").forEach(function (section) {
      section.hidden = section.getAttribute("data-view") !== state.view;
    });
    var lists = state.view !== "tasks";
    $("box-later").hidden = !lists || !groups.later.length;
    $("box-closed").hidden = !lists || !groups.closed.length;

    var openTasks = state.tasks.filter(function (t) {
      return t.status === "open" && (state.filter === "all" || t.space === state.filter);
    }).length;
    var counts = { inbox: groups.waiting.length, commitments: groups.commit.length, tasks: openTasks };
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

  // ---------- Tasks ----------

  var HORIZONS = [
    { id: "today", label: "Today" },
    { id: "week", label: "This week" },
    { id: "later", label: "Later" },
  ];
  var REPEATS = { daily: "every day", weekly: "every week", biweekly: "every 2 weeks", monthly: "every month" };

  function projectName(task) {
    return task.projects && task.projects.name ? task.projects.name : null;
  }

  function localDay(date) {
    var d = date || new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  function taskRow(task) {
    var row = el("div", "task" + (task.status === "done" ? " is-done" : ""));
    row.setAttribute("data-task", task.id);
    var tick = document.createElement("input");
    tick.type = "checkbox";
    tick.checked = task.status === "done";
    tick.setAttribute("aria-label", task.status === "done" ? "Reopen task" : "Mark task done");
    tick.addEventListener("change", async function () {
      if (!tick.checked) { saveTask(task.id, { status: "open", done_at: null }); return; }
      finishTask(task, row);
    });
    row.appendChild(tick);

    var main = el("div", "task-main");
    main.appendChild(button(task.title, "task-title", function () { openTask(task); }));
    var tags = el("span", "task-tags");
    tags.appendChild(el("span", "tag tag-" + task.space, spaceLabel(task.space)));
    if (projectName(task)) {
      tags.appendChild(button(projectName(task), "project", function () {
        state.project = task.project_id;
        render();
      }));
    }
    var due = dueLabel(task.due_on);
    if (due && task.status === "open") tags.appendChild(el("span", "flag flag-" + (due.late ? 3 : 2), due.text));
    if (task.repeat) tags.appendChild(el("span", "repeat", "Repeats " + REPEATS[task.repeat]));
    var steps = Array.isArray(task.steps) ? task.steps : [];
    if (steps.length && task.status === "open") {
      tags.appendChild(el("span", "repeat", steps.filter(function (x) { return x.done; }).length + "/" + steps.length + " steps"));
    }
    main.appendChild(tags);
    row.appendChild(main);

    if (task.status === "open") {
      var when = document.createElement("select");
      when.className = "task-when";
      when.setAttribute("aria-label", "Move task");
      HORIZONS.forEach(function (h) {
        var o = el("option", null, h.label);
        o.value = h.id;
        o.selected = task.horizon === h.id;
        when.appendChild(o);
      });
      when.addEventListener("change", function () { saveTask(task.id, { horizon: when.value }); });
      row.appendChild(when);
    }
    return row;
  }

  function group(list, heading, rows) {
    if (!rows.length) return;
    list.appendChild(el("h3", "horizon", heading));
    rows.forEach(function (t) { list.appendChild(taskRow(t)); });
  }

  function renderTasks() {
    var list = $("list-tasks");
    list.textContent = "";
    var inSpace = state.tasks.filter(function (t) { return state.filter === "all" || t.space === state.filter; });
    var openInSpace = inSpace.filter(function (t) { return t.status === "open"; });
    if (state.project && !state.projects.some(function (p) { return p.id === state.project && (state.filter === "all" || p.space === state.filter); })) {
      state.project = null;
    }
    var mine = inSpace.filter(function (t) { return !state.project || t.project_id === state.project; });
    var open = mine.filter(function (t) { return t.status === "open"; });
    $("n-tasks").textContent = open.length ? String(open.length) : "";

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

    if (state.taskMode === "days") {
      var today = localDay();
      var byCreated = function (a, b) { return a.created_at < b.created_at ? -1 : 1; };
      group(list, "Overdue", open.filter(function (t) { return t.due_on && t.due_on < today; }).sort(function (a, b) { return a.due_on < b.due_on ? -1 : 1; }));
      var days = {};
      open.forEach(function (t) { if (t.due_on && t.due_on >= today) (days[t.due_on] = days[t.due_on] || []).push(t); });
      Object.keys(days).sort().forEach(function (day) {
        var d = new Date(day + "T12:00:00");
        var name = d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "short" });
        group(list, day === today ? "Today · " + name : name, days[day].sort(byCreated));
      });
      group(list, "No date", open.filter(function (t) { return !t.due_on; }));
    } else {
      HORIZONS.forEach(function (h) {
        group(list, h.label, open.filter(function (t) { return t.horizon === h.id; }));
      });
    }
    if (!open.length) list.appendChild(el("p", "empty", state.project ? "No open tasks in this project." : "No open tasks."));

    var done = mine.filter(function (t) { return t.status === "done"; });
    var doneList = $("list-tasks-done");
    doneList.textContent = "";
    done.forEach(function (t) { doneList.appendChild(taskRow(t)); });
    $("n-tasks-done").textContent = done.length ? String(done.length) : "";
    $("box-tasks-done").hidden = !done.length;
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
    draft.related.forEach(function (r) {
      var row = el("div", "td-link");
      var kind = r.kind === "task" ? "Task" : r.lane === "commitment" ? "Promise" : "Inbox";
      row.appendChild(el("span", "kind", kind));
      var target = r.kind === "task"
        ? state.tasks.filter(function (t) { return t.id === r.id && t.status === "open"; })[0]
        : state.items.filter(function (i) { return i.id === r.id && (i.status === "open" || i.status === "snoozed"); })[0];
      if (!target) {
        row.appendChild(el("span", "closed-ref", r.title + " (closed)"));
      } else if (r.kind === "task") {
        row.appendChild(button(r.title, "ref", function () { openTask(target); }));
      } else {
        row.appendChild(button(r.title, "ref", function () {
          $("task-dialog").close();
          state.view = target.lane === "commitment" ? "commitments" : "inbox";
          writePref("desk.view", state.view);
          if (state.filter !== "all" && state.filter !== target.space) state.filter = "all";
          render();
        }));
      }
      box.appendChild(row);
    });
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

    var source = $("td-source");
    source.textContent = "";
    source.hidden = true;
    var from = task.source_item_id ? state.items.filter(function (i) { return i.id === task.source_item_id; })[0] : null;
    if (from) {
      source.hidden = false;
      var lead = fromNotes(from) ? (from.kind === "promise" ? "From your promise in a meeting: " : from.kind === "decision" ? "From a decision in a meeting: " : "From a meeting: ")
        : from.lane === "commitment" ? "From your promise: " : "From: ";
      source.appendChild(document.createTextNode(lead + from.title + " "));
      sourceLinks(from).forEach(function (link) {
        source.appendChild(linkTo(link.href, link.label + " ↗", "chip"));
        source.appendChild(document.createTextNode(" "));
      });
    }
    $("td-done").hidden = !task.id || task.status !== "open";
    $("td-drop").hidden = !task.id || task.status !== "open";
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
    if (trigger) { trigger.disabled = false; trigger.textContent = "Make a task"; }
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
          .select("id, space, project_id, title, notes, context, links, steps, related, repeat, horizon, status, due_on, source_item_id, created_at, done_at, projects(name)")
          .or('status.eq.open,and(status.eq.done,done_at.gte."' + since + '")')
          .order("created_at", { ascending: true })
          .limit(1000),
        sb.from("projects").select("id, space, name").eq("status", "active").order("name").limit(1000),
      ]);
      var failed = results.filter(function (r) { return r.error; })[0];
      if (failed) throw new Error(failed.error.message);

      state.channels = index(results[1].data, function (c) { return c.space + ":" + c.slack_channel_id; });
      state.accounts = index(results[2].data, function (a) { return a.space; });
      state.tasks = results[3].data || [];
      state.projects = results[4].data || [];
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
        state.seen = null;
        show(false);
      }
    }, 0);
  });

  // Safety net if the live connection drops, and to move "Later" items back when their time comes.
  setInterval(function () { if (started && !document.hidden) load(); }, 60000);
  document.addEventListener("visibilitychange", function () { if (started && !document.hidden) load(); });
})();
