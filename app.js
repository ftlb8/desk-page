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
  var DAY = 24 * 60 * 60 * 1000;

  var state = {
    items: [],
    tasks: [],
    projects: [],
    people: {},   // "space:userId" -> { name, is_vip }
    channels: {}, // "space:channelId" -> { name, kind }
    accounts: {}, // space -> { slack_url }
    filter: readPref("desk.space", "all"),
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

  function sourceLink(item) {
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
    var home = item.lane === "waiting" ? "waiting" : item.lane === "commitment" ? "commit" : "look";
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

  function closedHow(item) {
    if (item.status === "dismissed") return "Dismissed";
    if (item.closed_by === "reply") return "You replied";
    if (item.closed_by === "reaction") return "You marked it with a check";
    return "Marked done";
  }

  function card(item, kind) {
    var m = item.messages || {};
    var node = el("article", "card urgency-" + item.urgency);

    var top = el("div", "card-top");
    top.appendChild(el("span", "tag tag-" + item.space, spaceLabel(item.space)));
    var promise = item.lane === "commitment";
    var due = promise ? dueLabel(item.due_on) : null;
    if (due && kind !== "closed") {
      top.appendChild(el("span", "flag flag-" + (due.late ? 3 : 2), due.text));
    } else if ((kind === "waiting" || kind === "look") && item.urgency >= 2) {
      top.appendChild(el("span", "flag flag-" + item.urgency, item.urgency === 3 ? "Today" : "Soon"));
    }
    var meta = (promise ? "To " + (item.owed_to || "someone") : authorLabel(item)) + " · " + whereLabel(item) + " · " + ago(m.occurred_at || item.created_at);
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
    if (doc) node.appendChild(docView(item, doc));
    else if (m.body) node.appendChild(originalView(item));

    var actions = el("div", "actions");
    var link = sourceLink(item);
    if (link) {
      actions.appendChild(linkTo(link.href, link.label, "btn"));
    }
    if (kind === "waiting" || kind === "look" || kind === "commit") {
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
        actions.appendChild(button("Make a task", "btn subtle", function () { taskFromItem(item); }));
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

  function render() {
    var groups = { waiting: [], commit: [], look: [], later: [], closed: [] };
    var waitingBySpace = {};
    state.items.forEach(function (item) {
      var b = bucket(item);
      if (b === "waiting") waitingBySpace[item.space] = (waitingBySpace[item.space] || 0) + 1;
      if (state.filter !== "all" && item.space !== state.filter) return;
      groups[b].push(item);
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
    fill("list-commit", "n-commit", groups.commit, "commit", "No open promises to Leonard, Ryan or Cole.");
    fill("list-look", "n-look", groups.look, "look", "Nothing else to look at.");
    renderTasks();
    fill("list-later", "n-later", groups.later, "later", null);
    fill("list-closed", "n-closed", groups.closed, "closed", null);
    $("box-later").hidden = !groups.later.length;
    $("box-closed").hidden = !groups.closed.length;

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

  function projectName(task) {
    return task.projects && task.projects.name ? task.projects.name : null;
  }

  function taskRow(task) {
    var row = el("div", "task" + (task.status === "done" ? " is-done" : ""));
    var tick = document.createElement("input");
    tick.type = "checkbox";
    tick.checked = task.status === "done";
    tick.setAttribute("aria-label", task.status === "done" ? "Reopen task" : "Mark task done");
    tick.addEventListener("change", function () {
      saveTask(task.id, tick.checked ? { status: "done", done_at: new Date().toISOString() } : { status: "open", done_at: null });
    });
    row.appendChild(tick);

    var main = el("div", "task-main");
    main.appendChild(el("span", "task-title", task.title));
    var tags = el("span", "task-tags");
    tags.appendChild(el("span", "tag tag-" + task.space, spaceLabel(task.space)));
    if (projectName(task)) tags.appendChild(el("span", "project", projectName(task)));
    var due = dueLabel(task.due_on);
    if (due && task.status === "open") tags.appendChild(el("span", "flag flag-" + (due.late ? 3 : 2), due.text));
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
      var drop = button("Drop", "quiet", function () { saveTask(task.id, { status: "dropped", done_at: new Date().toISOString() }); });
      row.appendChild(drop);
    }
    return row;
  }

  function renderTasks() {
    var list = $("list-tasks");
    list.textContent = "";
    var mine = state.tasks.filter(function (t) { return state.filter === "all" || t.space === state.filter; });
    var open = mine.filter(function (t) { return t.status === "open"; });
    $("n-tasks").textContent = open.length ? String(open.length) : "";
    HORIZONS.forEach(function (h) {
      var rows = open.filter(function (t) { return t.horizon === h.id; });
      if (!rows.length) return;
      list.appendChild(el("h3", "horizon", h.label));
      rows.forEach(function (t) { list.appendChild(taskRow(t)); });
    });
    if (!open.length) list.appendChild(el("p", "empty", "No open tasks."));

    var done = mine.filter(function (t) { return t.status === "done"; });
    var doneList = $("list-tasks-done");
    doneList.textContent = "";
    done.forEach(function (t) { doneList.appendChild(taskRow(t)); });
    $("n-tasks-done").textContent = done.length ? String(done.length) : "";
    $("box-tasks-done").hidden = !done.length;
  }

  function fillProjectChoices() {
    var space = $("task-space").value;
    var box = $("project-names");
    box.textContent = "";
    state.projects.forEach(function (p) {
      if (p.space !== space) return;
      var o = document.createElement("option");
      o.value = p.name;
      box.appendChild(o);
    });
  }

  async function saveTask(id, changes) {
    var res = await sb.from("tasks").update(changes).eq("id", id);
    if (res.error) notice("That did not save: " + res.error.message);
    await load();
  }

  // Finds the project by name in that organisation, or creates it.
  async function projectId(space, name) {
    var wanted = name.trim();
    if (!wanted) return null;
    for (var i = 0; i < state.projects.length; i++) {
      var p = state.projects[i];
      if (p.space === space && p.name.toLowerCase() === wanted.toLowerCase()) return p.id;
    }
    var made = await sb.from("projects").insert({ space: space, name: wanted }).select("id").single();
    if (made.error) throw new Error(made.error.message);
    return made.data.id;
  }

  async function addTask(fields) {
    try {
      var row = { space: fields.space, title: fields.title.trim(), horizon: fields.horizon || "week" };
      if (fields.source_item_id) row.source_item_id = fields.source_item_id;
      if (fields.due_on) row.due_on = fields.due_on;
      row.project_id = await projectId(fields.space, fields.project || "");
      var res = await sb.from("tasks").insert(row);
      if (res.error) throw new Error(res.error.message);
    } catch (err) {
      notice("The task was not saved: " + (err && err.message ? err.message : "unknown error"));
      return false;
    }
    await load();
    return true;
  }

  function taskFromItem(item) {
    addTask({ space: item.space, title: item.title, horizon: "week", source_item_id: item.id, due_on: item.due_on || null });
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
    if (state.loading) return;
    state.loading = true;
    try {
      var since = new Date(Date.now() - DAY).toISOString();
      var results = await Promise.all([
        sb.from("items")
          .select("id, space, lane, status, title, summary, reason, urgency, created_at, closed_at, closed_by, snooze_until, messages(source, channel_id, channel_type, thread_ts, ts, author_id, author_name, subject, body, occurred_at)")
          .or('status.in.(open,snoozed),closed_at.gte."' + since + '"')
          .order("created_at", { ascending: false })
          .limit(500),
        sb.from("channels").select("space, slack_channel_id, name, kind").limit(5000),
        sb.from("accounts").select("space, slack_url, slack_user_id, email"),
        sb.from("tasks")
          .select("id, space, project_id, title, horizon, status, due_on, source_item_id, created_at, done_at, projects(name)")
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
      fillProjectChoices();
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
    var res = await sb.rpc("set_item_state", { p_item: id, p_action: action, p_until: at || null });
    if (res.error) notice("That did not save: " + res.error.message);
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

  $("task-space").value = readPref("desk.task-space", state.filter !== "all" ? state.filter : "metaculus");
  $("task-space").addEventListener("change", function () {
    writePref("desk.task-space", $("task-space").value);
    $("task-project").value = "";
    fillProjectChoices();
  });
  $("task-form").addEventListener("submit", async function (event) {
    event.preventDefault();
    var title = $("task-title").value;
    if (!title.trim()) return;
    var saved = await addTask({ space: $("task-space").value, title: title, project: $("task-project").value, horizon: $("task-horizon").value });
    if (saved) $("task-title").value = "";
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
