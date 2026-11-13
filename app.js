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
    { id: "work", label: "Work" },
    { id: "projects", label: "Projects" },
    { id: "meetings", label: "Meetings" },
    { id: "notes", label: "Notes" },
    { id: "links", label: "Links" },
  ];
  var DAY = 24 * 60 * 60 * 1000;
  var SEEN_KEY = "desk.runs-seen";

  // Finished runs you already opened, kept for this browser session only.
  function readSeen() {
    try {
      var v = JSON.parse(sessionStorage.getItem(SEEN_KEY) || "{}");
      return v && typeof v === "object" ? v : {};
    } catch (_) { return {}; }
  }

  var state = {
    items: [],
    tasks: [],
    meetings: [],
    notes: [],
    openNotes: {},    // ids of long notes you opened in full
    noteAsk: null,    // id of the note you are being asked about deleting
    noteEdit: null,   // { id, node } while a note is being edited in place
    links: [],        // the quick links, ordered by organisation, position and id
    linksEditing: false, // the Edit toggle of the Links view
    linkEdit: null,   // { id, node } while a link is being edited in place
    linkAsk: null,    // id of the link you are being asked about removing
    linkSpace: null,  // the organisation you last added a link for in this session
    linkBusy: false,  // an add is on its way
    noteSpace: null,  // the organisation you last saved a note for in this session
    openInbox: {},    // inbox sections you closed (false) or opened (true); all start open
    openMeetings: {}, // ids of meetings whose details you opened
    openProject: null, // the project whose page is open on the Projects tab ("unsorted" for the Unsorted card)
    changes: [],      // the change log of the last 14 days
    changesAll: false, // "Show all" is on in the What changed strip
    log: {},          // project id -> { rows, loading, error }: the whole log of a project, loaded when its page is first opened
    fix: null,        // { id, where, text, error } while a change line is being corrected
    keyDates: [],     // proposed and open key dates, and the ones done in the last 30 days
    kdForm: null,     // { pageId, date, last, text, note, warn, about, error, saving } while a key date is being added
    kdEdit: null,     // { id, date, last, text, note, warn, about, error, saving } while a key date is being edited
    kdAsk: null,      // id of the key date you are being asked about removing
    kdMore: {},       // ids of key dates whose More you opened on Today
    kdDone: {},       // project pages whose Done fold you opened
    kdAll: false,     // "Show all" is on in the Key dates list of the Projects tab
    addLine: null,    // { pageId, projectId, date, text, error, saving } while a line is being added
    openTasks: {},    // ids of tasks you expanded in the list
    openSections: { today: true, week: true, weeks: false, later: false }, // task sections you opened or closed
    folds: {},        // the fixed folds (tray, Later, Closed, Decisions, ...) you opened
    query: "",        // what is typed in the search box
    reviewing: {},    // ids of plans whose review is running
    doneSuggestions: {}, // review suggestions that became tasks this session, keyed by plan id and text
    projects: [],
    covers: [],       // the written review of how things stand, one row per organisation
    starts: [],       // prepared steps (and draft replies) for items and tasks
    runs: [],         // the Desk doing a task in the background (newest 50)
    runOpen: {},      // run ids whose card you opened in Work
    runAct: {},       // run ids whose Activity fold you opened
    runEvents: {},    // run id -> { rows, loading, error, stamp }
    runBusy: {},      // "run:ID" / "task:ID" -> the call on its way (plan, rewrite, start, answer, stop, discard)
    runMsg: {},       // "run:ID" / "task:ID" -> the plain error from the last call
    runHist: {},      // run ids whose "Earlier answers" fold you opened
    runAsk: {},       // runs where you are being asked about discarding
    runGone: {},      // run id -> when you discarded it, so an older load does not bring it back
    runSeen: readSeen(), // finished runs you opened in this browser session
    planOpen: {},     // task ids whose plan panel is open
    covering: {},     // organisations whose review is being written
    starting: {},     // "item:7" / "task:3" while Start is preparing
    startOpen: {},    // starts whose panel you opened
    startAsk: {},     // starts where you are being asked about writing it again
    startHold: {},    // ids of starts with a save on its way
    copied: {},       // starts whose draft was just copied
    sendFlow: {},     // "item:7" -> { phase: checking | confirm | blocked | failed | sending, text, to, reason, error } while a reply is being sent
    sent: {},         // start id -> { at, to } for replies sent from this page (a load also brings sent_at)
    fresh: { starts: {}, covers: {}, runs: {} }, // rows just received from a function, kept until a load has them too
    people: {},   // "space:userId" -> { name, is_vip, is_key }
    channels: {}, // "space:channelId" -> { name, kind }
    accounts: {}, // space -> { slack_url }
    filter: readPref("desk.space", "all"),
    view: "today", // the page always opens on Today; today | inbox | tasks | work | projects | meetings | notes | links
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

  // Which view an item lives in: suggested tasks in Tasks, decisions in Projects, the rest in Inbox.
  function viewFor(item) {
    if (item.lane !== "commitment") return "inbox";
    return item.kind === "decision" ? "projects" : "tasks";
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

  // A box of the key date form keeps the cursor when the page is redrawn under it (a live update, say).
  function captureKeyFocus() {
    var a = document.activeElement;
    if (!a || !a.id || !a.closest || !a.closest(".kd-form")) return null;
    return { id: a.id, start: a.selectionStart, end: a.selectionEnd };
  }

  function restoreKeyFocus(saved) {
    if (!saved) return;
    var n = $(saved.id);
    if (!n || n === document.activeElement) return;
    n.focus({ preventScroll: true });
    try { if (saved.start !== null && saved.start !== undefined) n.setSelectionRange(saved.start, saved.end); } catch (_) { /* a date or number box has no cursor */ }
  }

  function render() {
    var typing = captureDraftFocus();
    var keyFocus = captureKeyFocus();
    markLooked();
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
    // Later and Closed follow the section: suggestions in Tasks, decisions in Projects, everything else in Inbox.
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
    var planRows = renderProjects();
    var meetingCards = renderMeetings();
    var noteRows = renderNotes();
    var todayRows = renderToday();
    var workRows = renderWork();
    var linkRows = renderLinks();
    var lists = state.view !== "meetings" && state.view !== "notes" && state.view !== "work" && state.view !== "links";
    $("box-later").hidden = !lists || inTasks || !groups.later.length;
    $("box-closed").hidden = !lists || inTasks || !groups.closed.length;

    // What is on screen in this view, for "N found" and for the sentence when nothing matches.
    found = groups.later.length + groups.closed.length;
    if (state.view === "today") found += todayRows;
    else if (state.view === "inbox") found += inboxRows;
    else if (state.view === "tasks") found += groups.commit.length + taskRows;
    else if (state.view === "projects") found += groups.decision.length + planRows;
    else if (state.view === "notes") found += noteRows;
    else if (state.view === "work") found += workRows;
    else if (state.view === "links") found += linkRows;
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
    var counts = { inbox: waitingCount, tasks: openTasks, work: state.runs.filter(function (r) { return r.status === "needs_you" && inFilter(r); }).length, meetings: meetingsLeftToday() };
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
        markLooked(); // leaving an organisation counts as having looked at it
        state.filter = s.id;
        writePref("desk.space", s.id);
        render();
      });
      b.setAttribute("aria-pressed", state.filter === s.id ? "true" : "false");
      if (s.id !== "all" && state.filter !== s.id && hasUpdates(s.id)) {
        var dot = el("span", "upd-dot");
        dot.setAttribute("role", "img");
        dot.setAttribute("aria-label", "has updates");
        b.appendChild(dot);
      }
      nav.appendChild(b);
    });
    restoreDraftFocus(typing);
    restoreKeyFocus(keyFocus);
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

  // Opens the Projects tab with this project's page open (a topic opens the project it belongs to).
  function goToProject(project) {
    var plan = parentOf(project) || project;
    clearSearch();
    if (state.filter !== "all" && state.filter !== plan.space) {
      state.filter = "all";
      writePref("desk.space", "all");
    }
    state.openProject = plan.id;
    showView("projects");
    reveal(onPage('[data-project="' + plan.id + '"]'));
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

  // ---------- Projects ----------

  var STAGES = [
    { id: "in_progress", label: "In progress" },
    { id: "ongoing", label: "Ongoing" },
    { id: "planned", label: "Planned" },
    { id: "idea", label: "Idea" },
    { id: "paused", label: "Paused" },
    { id: "done", label: "Done" },
  ];
  var CHANGE_COLS = "id, project_id, space, changed_on, text, source_label, source_url, origin, created_at";
  var CHANGE_DAYS = 14;   // how far back the page loads changes
  var STRIP_DAYS = 3;     // the "What changed" strip looks at today and the two days before
  var STRIP_FIRST = 5;    // lines shown before "Show all"

  function stageOf(p) {
    return STAGES.some(function (s) { return s.id === p.stage; }) ? p.stage : "idea";
  }

  function stageLabel(p) {
    return STAGES.filter(function (s) { return s.id === stageOf(p); })[0].label;
  }

  function sameId(a, b) {
    return a !== null && a !== undefined && b !== null && b !== undefined && String(a) === String(b);
  }

  function byName(a, b) {
    var x = String(a.name).toLowerCase();
    var y = String(b.name).toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  }

  function isTopLevel(p) { return p.parent_id === null || p.parent_id === undefined; }
  function isArea(p) { return p.kind === "area"; }
  function parentOf(p) { return isTopLevel(p) ? null : projectById(p.parent_id); }

  function topicsOf(p) {
    return state.projects.filter(function (x) { return sameId(x.parent_id, p.id); }).sort(byName);
  }

  // "Parent › Topic" for a topic, the plain name for anything else.
  function projectLabel(p) {
    var up = parentOf(p);
    return up ? up.name + " › " + p.name : p.name;
  }

  // The project itself and its topics.
  function familyIds(p) {
    return [p.id].concat(topicsOf(p).map(function (t) { return t.id; }));
  }

  function inFamily(p, id) {
    return familyIds(p).some(function (x) { return sameId(x, id); });
  }

  function openTasksOf(p) {
    var ids = familyIds(p);
    return state.tasks.filter(function (t) {
      return t.status === "open" && ids.some(function (id) { return sameId(id, t.project_id); });
    });
  }

  function ownTasksOf(p) {
    return state.tasks.filter(function (t) { return t.status === "open" && sameId(t.project_id, p.id); });
  }

  function unsortedTasks() {
    return state.tasks.filter(function (t) {
      return t.status === "open" && (t.project_id === null || t.project_id === undefined) && inFilter(t);
    });
  }

  function countText(tasks) {
    if (!tasks.length) return "No open tasks";
    var urgent = tasks.filter(function (t) { return t.urgent; }).length;
    return tasks.length + (tasks.length === 1 ? " open task" : " open tasks") + (urgent ? " · " + urgent + " urgent" : "");
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

  // A change's day ("2026-11-12") for a line: "12 Nov", with the year when it is not this year.
  function changeDate(day) {
    var d = new Date(day + "T12:00:00");
    if (isNaN(d.getTime())) return "";
    return shortDate(d) + (d.getFullYear() !== new Date().getFullYear() ? " " + d.getFullYear() : "");
  }

  function suggestionKey(p, text) {
    return p.id + "\n" + String(text).trim().toLowerCase();
  }

  // The review's suggested tasks, without the ones already a task on this project or already added this session.
  function openSuggestions(p, review, open) {
    var have = {};
    open.forEach(function (t) { have[String(t.title).trim().toLowerCase()] = true; });
    return (Array.isArray(review.suggested_tasks) ? review.suggested_tasks : []).map(function (x) { return String(x || "").trim(); })
      .filter(function (text) { return text && !have[text.toLowerCase()] && !state.doneSuggestions[suggestionKey(p, text)]; });
  }

  function suggestTask(p, text) {
    var task = blankTask(p.space, text);
    task.project = p.name;
    task.project_id = p.id;
    task.context = "Suggested by the review of " + p.name;
    task.fromReview = suggestionKey(p, text);
    showDialog(task, null);
  }

  // Asks Claude to look at the project again. Takes up to a minute; the rest of the page stays usable.
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
        state.openProject = p.id;
        notice("");
      }
    } catch (_) {
      notice(failed);
    }
    delete state.reviewing[p.id];
    render();
  }

  // ----- The change log -----
  // The text, the source label and the change itself are partly written by a model from other people's content:
  // plain text only, and a source is a link only when its address passes the https check.

  function newestChange(a, b) {
    if (a.changed_on !== b.changed_on) return a.changed_on > b.changed_on ? -1 : 1;
    var x = String(a.created_at || ""), y = String(b.created_at || "");
    return x === y ? 0 : x > y ? -1 : 1;
  }

  // Every change the page knows for a project and its topics (the last 14 days, and its whole log once opened).
  function knownChanges(p) {
    var ids = familyIds(p);
    var seen = {};
    var out = [];
    var entry = state.log[p.id];
    (state.changes || []).concat(entry ? entry.rows : []).forEach(function (c) {
      if (seen[c.id] || !ids.some(function (id) { return sameId(id, c.project_id); })) return;
      seen[c.id] = true;
      out.push(c);
    });
    return out.sort(newestChange);
  }

  function patchChange(id, changes) {
    var all = (state.changes || []).slice();
    Object.keys(state.log).forEach(function (k) { all = all.concat(state.log[k].rows); });
    all.forEach(function (c) { if (sameId(c.id, id)) Object.keys(changes).forEach(function (f) { c[f] = changes[f]; }); });
  }

  // Loads a project's whole log (it and its topics) the first time its page is opened.
  async function fetchLog(p) {
    var entry = state.log[p.id];
    entry.loading = true;
    entry.error = null;
    try {
      var res = await sb.from("project_changes").select(CHANGE_COLS).in("project_id", familyIds(p))
        .order("changed_on", { ascending: false }).order("created_at", { ascending: false }).limit(200);
      if (res.error) throw new Error(res.error.message);
      entry.rows = res.data || [];
    } catch (err) {
      entry.error = err && err.message ? err.message : "unknown error";
    }
    entry.loading = false;
    render();
  }

  function ensureLog(p) {
    if (state.log[p.id]) return;
    state.log[p.id] = { rows: [], loading: true, error: null };
    fetchLog(p);
  }

  async function saveFix() {
    var fix = state.fix;
    if (!fix) return;
    var text = String(fix.text || "").trim();
    if (!text) { fix.error = "Write the corrected text first."; render(); return; }
    state.fix = null;
    patchChange(fix.id, { text: text, origin: "you" });
    render();
    var res = await sb.from("project_changes").update({ text: text, origin: "you" }).eq("id", fix.id);
    if (res.error) {
      notice("That did not save: " + res.error.message);
      state.log = {};
    }
    await load();
  }

  function fixForm(c, where) {
    var form = el("form", "change-fix");
    var ta = document.createElement("textarea");
    ta.className = "fix-text";
    ta.rows = 2;
    ta.maxLength = 2000;
    ta.value = state.fix.text;
    ta.setAttribute("aria-label", "Corrected text");
    ta.addEventListener("input", function () { state.fix.text = ta.value; });
    ta.addEventListener("keydown", function (event) {
      if (event.key === "Escape") { event.preventDefault(); state.fix = null; render(); }
    });
    form.appendChild(ta);
    if (state.fix.error) form.appendChild(el("p", "error", state.fix.error));
    var row = el("div", "actions");
    var save = el("button", "primary small", "Save");
    save.type = "submit";
    row.appendChild(save);
    row.appendChild(button("Cancel", "btn subtle small", function () { state.fix = null; render(); }));
    form.appendChild(row);
    form.addEventListener("submit", function (event) { event.preventDefault(); saveFix(); });
    return form;
  }

  // One line of the change log: where it happened, the words, the source and Correct.
  // `page` is the project whose page it sits on; null in the strip, which names the project instead.
  function changeLine(c, where, page) {
    var line = el("div", "change-line" + (c.origin === "you" ? " is-yours" : ""));
    line.setAttribute("data-change", c.id);
    var head = el("p", "change-head");
    if (where === "log") head.appendChild(el("span", "meta change-date", changeDate(c.changed_on)));
    var owner = projectById(c.project_id);
    if (!page && owner) head.appendChild(el("strong", "change-project", projectLabel(owner)));
    if (page && owner && !sameId(owner.id, page.id)) head.appendChild(el("span", "topic-chip", owner.name));
    if (c.origin === "you") head.appendChild(el("span", "pill pill-yours", "yours"));
    line.appendChild(head);
    var editing = state.fix && sameId(state.fix.id, c.id) && state.fix.where === where;
    if (editing) {
      line.appendChild(fixForm(c, where));
      return line;
    }
    var body = el("p", "change-body");
    body.appendChild(el("span", "change-text", String(c.text || "")));
    var href = httpsLink(c.source_url);
    if (href) {
      body.appendChild(document.createTextNode(" "));
      body.appendChild(linkTo(href, (c.source_label ? String(c.source_label) : F.host(href)) + " ↗", "chip"));
    } else if (c.source_label) {
      body.appendChild(el("span", "fine change-source", " " + String(c.source_label)));
    }
    line.appendChild(body);
    var fixBtn = button("Correct", "quiet change-correct", function () {
      state.fix = { id: c.id, where: where, text: String(c.text || ""), error: "" };
      render();
      var ta = onPage('[data-change="' + c.id + '"] .fix-text');
      if (ta) ta.focus();
    });
    fixBtn.setAttribute("aria-label", "Correct this line");
    line.appendChild(fixBtn);
    return line;
  }

  // "What changed": the lines of the most recent day with any, within the last three days.
  function renderChangesStrip() {
    var box = $("project-changes");
    box.textContent = "";
    var back = new Date();
    back.setDate(back.getDate() - (STRIP_DAYS - 1));
    var cutoff = localDay(back);
    var rows = (state.changes || []).filter(function (c) {
      return inFilter(c) && c.changed_on >= cutoff && projectById(c.project_id);
    });
    var head = el("div", "tsec-head");
    head.appendChild(el("h3", "tsec-name", "What changed"));
    var day = rows.reduce(function (best, c) { return c.changed_on > best ? c.changed_on : best; }, "");
    if (day) {
      rows = rows.filter(function (c) { return c.changed_on === day; }).sort(newestChange);
      var dayName = day === localDay() ? "today" : day === localDay(new Date(Date.now() - DAY)) ? "yesterday" : changeDate(day);
      head.appendChild(el("span", "meta", dayName));
      head.appendChild(el("span", "count", String(rows.length)));
    }
    box.appendChild(head);
    var body = el("div", "tsec-body cv-pad");
    if (!rows.length) {
      body.appendChild(el("p", "empty", "The daily update has not added anything yet."));
    } else {
      var shown = state.changesAll ? rows : rows.slice(0, STRIP_FIRST);
      shown.forEach(function (c) { body.appendChild(changeLine(c, "strip", null)); });
      if (rows.length > STRIP_FIRST) {
        var more = button(state.changesAll ? "Show fewer" : "Show all " + rows.length, "btn small", function () {
          state.changesAll = !state.changesAll;
          render();
        });
        more.setAttribute("aria-expanded", state.changesAll ? "true" : "false");
        body.appendChild(more);
      }
    }
    box.appendChild(body);
  }

  async function addLine() {
    var form = state.addLine;
    if (!form) return;
    var text = String(form.text || "").trim();
    if (!text) { form.error = "Write what changed first."; render(); return; }
    var target = projectById(form.projectId);
    if (!target) return;
    var day = form.date || localDay();
    form.saving = true;
    form.error = "";
    render();
    var res = await sb.from("project_changes")
      .insert({ project_id: target.id, space: target.space, changed_on: day, text: text, origin: "you" })
      .select(CHANGE_COLS).single();
    if (res.error || !res.data) {
      form.saving = false;
      form.error = "Not saved: " + (res.error ? res.error.message : "unknown error");
      render();
      return;
    }
    var page = projectById(form.pageId);
    state.addLine = null;
    state.changes = (state.changes || []).concat([res.data]).sort(newestChange);
    if (page && state.log[page.id]) state.log[page.id].rows = state.log[page.id].rows.concat([res.data]).sort(newestChange);
    render();
  }

  function addLineForm(p) {
    var form = state.addLine;
    var box = el("form", "change-add");
    box.setAttribute("data-add-line", p.id);
    var row = el("div", "td-row");
    var dateBox = el("div");
    var dl = el("label", null, "Date");
    dl.setAttribute("for", "al-date");
    var date = document.createElement("input");
    date.type = "date";
    date.id = "al-date";
    date.value = form.date;
    date.addEventListener("input", function () { form.date = date.value; });
    dateBox.appendChild(dl);
    dateBox.appendChild(date);
    row.appendChild(dateBox);
    var topics = topicsOf(p);
    if (topics.length) {
      var whoBox = el("div");
      var wl = el("label", null, "About");
      wl.setAttribute("for", "al-topic");
      var who = document.createElement("select");
      who.id = "al-topic";
      [p].concat(topics).forEach(function (x) {
        var o = el("option", null, x === p ? p.name : "Topic: " + x.name);
        o.value = String(x.id);
        who.appendChild(o);
      });
      who.value = String(form.projectId);
      who.addEventListener("change", function () { form.projectId = who.value; });
      whoBox.appendChild(wl);
      whoBox.appendChild(who);
      row.appendChild(whoBox);
    }
    box.appendChild(row);
    var tl = el("label", null, "What changed");
    tl.setAttribute("for", "al-text");
    box.appendChild(tl);
    var ta = document.createElement("textarea");
    ta.id = "al-text";
    ta.rows = 2;
    ta.maxLength = 2000;
    ta.value = form.text;
    ta.addEventListener("input", function () { form.text = ta.value; });
    box.appendChild(ta);
    if (form.error) box.appendChild(el("p", "error", form.error));
    var actions = el("div", "actions");
    var save = el("button", "primary small", form.saving ? "Saving…" : "Save");
    save.type = "submit";
    save.disabled = !!form.saving;
    actions.appendChild(save);
    actions.appendChild(button("Cancel", "btn subtle small", function () { state.addLine = null; render(); }));
    box.appendChild(actions);
    box.addEventListener("submit", function (event) { event.preventDefault(); if (!form.saving) addLine(); });
    return box;
  }

  function changeLog(inside, p) {
    inside.appendChild(label("Change log"));
    var entry = state.log[p.id];
    if (!entry || entry.loading) {
      inside.appendChild(el("p", "fine", "Loading the change log…"));
    } else if (entry.error) {
      var bad = el("p", "error", "The change log could not be read: " + entry.error + " ");
      bad.appendChild(button("Try again", "btn small", function () { fetchLog(p); render(); }));
      inside.appendChild(bad);
    }
    if (entry && !entry.loading && !entry.error) {
      var rows = knownChanges(p);
      if (!rows.length) inside.appendChild(el("p", "empty", "Nothing is logged for this yet."));
      var list = el("div", "change-log");
      rows.forEach(function (c) { list.appendChild(changeLine(c, "log", p)); });
      inside.appendChild(list);
    }
    if (state.addLine && sameId(state.addLine.pageId, p.id)) {
      inside.appendChild(addLineForm(p));
    } else {
      inside.appendChild(button("Add a line", "btn small", function () {
        state.addLine = { pageId: p.id, projectId: p.id, date: localDay(), text: "", error: "", saving: false };
        render();
        var ta = onPage("#al-text");
        if (ta) ta.focus();
      }));
    }
  }

  // ----- Cards and pages -----

  function lastChangeOf(p) {
    var rows = knownChanges(p);
    return rows.length ? rows[0] : null;
  }

  function cardParts(p) {
    var parts = planParts(p);
    topicsOf(p).forEach(function (t) { parts.push(t.name, t.standing, t.what); });
    knownChanges(p).forEach(function (c) { parts.push(c.text); });
    keyDatesOf(p).forEach(function (k) { if (k.status !== "dropped") parts.push(k.text, k.note); });
    return parts;
  }

  // The words written about the project; the card and the page both start from them.
  function standingText(p) {
    return p.standing || p.what || "";
  }

  function addTaskHere(p) {
    var task = blankTask(p.space, "");
    task.project = projectLabel(p);
    task.project_id = p.id;
    showDialog(task, null);
  }

  function taskGroup(inside, rows, name, withAdd, topic) {
    if (name) {
      var head = el("div", "proj-sub");
      head.appendChild(el("h4", null, name));
      if (withAdd) head.appendChild(button("Add a task", "quiet", function () { addTaskHere(topic); }));
      inside.appendChild(head);
    }
    rows.forEach(function (t) { inside.appendChild(taskRow(t, "projects")); });
  }

  function projectPage(p, inside) {
    var topics = topicsOf(p);
    var open = openTasksOf(p);
    var review = p.review && typeof p.review === "object" ? p.review : {};

    // Where it stands
    inside.appendChild(label("Where it stands"));
    var standing = standingText(p);
    inside.appendChild(standing ? el("p", "gist pre", standing) : el("p", "empty", "Nothing is written down yet."));

    // Open now
    inside.appendChild(label("Open now"));
    var now = (Array.isArray(p.open_now) ? p.open_now : []).filter(function (x) { return typeof x === "string" && x.trim(); });
    if (now.length) {
      var ul = el("ul", "plan-steps open-now");
      now.forEach(function (t) { ul.appendChild(el("li", null, t)); });
      inside.appendChild(ul);
    } else {
      inside.appendChild(el("p", "empty", "Nothing is listed as open right now."));
    }

    keyDatesSection(inside, p);

    // Tasks
    inside.appendChild(label("Tasks"));
    var tasksBox = el("div", "proj-tasks");
    if (!open.length) tasksBox.appendChild(el("p", "empty", "You have no open tasks here."));
    var order = function (rows) { return urgentFirst(rows.slice().sort(taskOrder)); };
    if (!topics.length) {
      taskGroup(tasksBox, order(open), "", false);
    } else {
      var own = ownTasksOf(p);
      if (own.length) taskGroup(tasksBox, order(own), "Not in a topic", false);
      topics.forEach(function (t) {
        var rows = order(openTasksOf(t));
        taskGroup(tasksBox, rows, t.name + (rows.length ? "" : " · no open tasks"), true, t);
      });
    }
    inside.appendChild(tasksBox);
    var addRow = el("p", "plan-links");
    addRow.appendChild(button("Add a task here", "btn small", function () { addTaskHere(p); }));
    inside.appendChild(addRow);

    // Topics
    inside.appendChild(label("Topics"));
    if (!topics.length) inside.appendChild(el("p", "empty", "No topics yet."));
    topics.forEach(function (t) {
      var row = el("div", "topic-row");
      row.setAttribute("data-topic", t.id);
      var main = el("div", "topic-main");
      var line = el("p", "topic-name");
      line.appendChild(el("strong", null, t.name));
      line.appendChild(el("span", "fine", " · " + countText(openTasksOf(t))));
      main.appendChild(line);
      main.appendChild(el("p", "topic-standing", standingText(t) || "No standing written yet."));
      row.appendChild(main);
      row.appendChild(button("Edit", "btn small subtle", function () { openPlanDialog(t, null); }));
      inside.appendChild(row);
    });

    // The plan
    inside.appendChild(label("The plan"));
    var fields = el("div", "proj-fields");
    if (p.stage) fields.appendChild(el("p", "reason", "Stage: " + stageLabel(p)));
    if (p.what && p.standing) fields.appendChild(el("p", "gist", p.what));
    if (p.next_step) fields.appendChild(el("p", "reason", "Next: " + p.next_step));
    if (p.target_on) fields.appendChild(el("p", "reason", "By " + planDate(p.target_on)));
    if (p.depends_on) fields.appendChild(el("p", "reason", "After: " + p.depends_on));
    if (p.people) fields.appendChild(el("p", "reason", "With: " + p.people));
    if (p.tools) fields.appendChild(el("p", "reason", "Tools: " + p.tools));
    var links = (Array.isArray(p.links) ? p.links : []).map(function (l) {
      return l && httpsLink(l.url) ? { href: httpsLink(l.url), label: l.label || F.host(httpsLink(l.url)) } : null;
    }).filter(Boolean);
    if (links.length) {
      var chips = el("p", "plan-links");
      links.forEach(function (l) { chips.appendChild(linkTo(l.href, l.label + " ↗", "chip")); });
      fields.appendChild(chips);
    }
    if (!fields.children.length) fields.appendChild(el("p", "empty", "No plan details yet. Press Edit to add them."));
    inside.appendChild(fields);

    // Decisions from your meetings that are about this project or one of its topics
    var names = [p].concat(topics).map(function (x) { return plain(x.name); });
    var decisions = state.items.filter(function (i) {
      return i.lane === "commitment" && i.kind === "decision" && (i.status === "open" || i.status === "snoozed") && i.theme && names.indexOf(plain(i.theme)) >= 0;
    });
    if (decisions.length) {
      inside.appendChild(label("Decisions"));
      decisions.forEach(function (d) {
        var row = el("div", "plan-task");
        row.appendChild(button(d.title, "ref", function () { goToItem(d); }));
        inside.appendChild(row);
      });
    }

    // The review: projects only, not areas and not topics
    if (isTopLevel(p) && !isArea(p)) {
      inside.appendChild(label("Review"));
      if (p.reviewed_at) inside.appendChild(el("p", "fine", "Reviewed " + shortDate(new Date(p.reviewed_at))));
      var steps = Array.isArray(review.next_steps) ? review.next_steps.filter(Boolean) : [];
      var suggested = openSuggestions(p, review, open);
      var sources = (Array.isArray(review.sources) ? review.sources : []).filter(function (x) { return x && x.label; });
      if (steps.length) {
        inside.appendChild(label("Suggested next steps"));
        var sl = el("ul", "plan-steps");
        steps.forEach(function (t) { sl.appendChild(el("li", null, String(t))); });
        inside.appendChild(sl);
      }
      if (suggested.length) {
        inside.appendChild(label("Suggested tasks"));
        suggested.forEach(function (text) {
          var row = el("div", "plan-suggest");
          row.appendChild(el("span", "plan-suggest-text", text));
          row.appendChild(button("Add as task", "btn small", function () { suggestTask(p, text); }));
          inside.appendChild(row);
        });
      }
      if (sources.length) {
        inside.appendChild(label("From"));
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
      var again = button(state.reviewing[p.id] ? "Reviewing…" : "Review now", "btn small", function () { reviewPlan(p); });
      again.disabled = !!state.reviewing[p.id];
      var reviewRow = el("p", "plan-links");
      reviewRow.appendChild(again);
      inside.appendChild(reviewRow);
    }

    // Notes tied to this project
    var projectNotes = state.notes.filter(function (n) { return sameId(n.project_id, p.id); }).sort(notesNewest);
    if (projectNotes.length) {
      inside.appendChild(label("Notes"));
      projectNotes.slice(0, 3).forEach(function (n) {
        var line = el("div", "plan-note");
        line.appendChild(el("span", "meta", noteDate(n.created_at)));
        line.appendChild(el("p", "plan-note-text", firstLines(n.body)));
        inside.appendChild(line);
      });
      var allNotes = el("p", "plan-links");
      allNotes.appendChild(button("All notes", "btn small", function () { showNotesFor(p); }));
      inside.appendChild(allNotes);
    }

    changeLog(inside, p);

    var actions = el("div", "actions");
    actions.appendChild(button("Edit", "btn", function () { openPlanDialog(p, null); }));
    actions.appendChild(button("Add a topic", "btn", function () { openPlanDialog(null, p); }));
    actions.appendChild(button("See tasks", "btn", function () {
      state.project = p.id;
      showView("tasks");
    }));
    inside.appendChild(actions);
  }

  // Opens or closes a card; one project page is open at a time.
  function toggleCard(id, fold, node) {
    var opening = fold.open;
    if (opening === sameId(state.openProject, id)) return;
    state.openProject = opening ? id : null;
    render();
    var summary = onPage('[data-project="' + id + '"] details.message > summary');
    if (summary) summary.focus({ preventScroll: true });
  }

  function cardFold(node, id, isOpen, build) {
    var fold = el("details", "message");
    fold.appendChild(el("summary", null, "Details"));
    if (isOpen) {
      var inside = foldIn(fold);
      inside.classList.add("project-page");
      build(inside);
    }
    fold.open = isOpen;
    fold.addEventListener("toggle", function () { toggleCard(id, fold, node); });
    node.appendChild(fold);
  }

  function projectCard(p) {
    var isOpen = sameId(state.openProject, p.id);
    var node = el("article", "card plan proj" + (isOpen ? " is-open" : ""));
    node.setAttribute("data-project", p.id);
    var top = el("div", "card-top");
    top.appendChild(el("span", "tag tag-" + p.space, spaceLabel(p.space)));
    if (!isArea(p) && p.stage) top.appendChild(el("span", "kind", stageLabel(p)));
    node.appendChild(top);
    node.appendChild(el("h3", "title", p.name));
    node.appendChild(el("p", "reason card-count", countText(openTasksOf(p))));
    var nextKey = keyDatesOf(p).filter(function (k) { return k.status === "open"; }).sort(byKeyDate)[0];
    if (nextKey) node.appendChild(el("p", "reason kd-next kd-" + keyTone(nextKey), "Next: " + keyDay(nextKey.on_date) + ", " + nextKey.text));
    var topics = topicsOf(p);
    if (topics.length) {
      var chips = el("p", "topic-chips");
      topics.forEach(function (t) { chips.appendChild(el("span", "topic-chip", t.name)); });
      node.appendChild(chips);
    }
    var review = p.review && typeof p.review === "object" ? p.review : {};
    if (!isArea(p) && review.attention) {
      var warn = el("p", "reason attention");
      warn.appendChild(el("span", "flag flag-3", "Needs attention"));
      warn.appendChild(document.createTextNode(" " + review.attention));
      node.appendChild(warn);
    }
    var last = lastChangeOf(p);
    if (last && last.changed_on === localDay()) {
      node.appendChild(el("p", "reason changed-line is-today", "Changed today"));
    } else {
      var since = last ? changeDate(last.changed_on) : changeDate(localDay(new Date(Date.now() - CHANGE_DAYS * DAY)));
      node.appendChild(el("p", "reason changed-line", "Quiet since " + since));
    }
    cardFold(node, p.id, isOpen, function (inside) { projectPage(p, inside); });
    return node;
  }

  // A project picker for filing a task: top-level rows, each followed by its topics indented.
  function addProjectOptions(select, space) {
    state.projects.filter(function (p) { return p.space === space && isTopLevel(p); }).sort(byName).forEach(function (p) {
      var o = el("option", null, p.name);
      o.value = String(p.id);
      select.appendChild(o);
      topicsOf(p).forEach(function (t) {
        var to = el("option", null, "    " + t.name);
        to.value = String(t.id);
        select.appendChild(to);
      });
    });
  }

  function unsortedCard(tasks) {
    var isOpen = sameId(state.openProject, "unsorted");
    var node = el("article", "card plan proj unsorted" + (isOpen ? " is-open" : ""));
    node.setAttribute("data-project", "unsorted");
    node.appendChild(el("h3", "title", "Unsorted"));
    node.appendChild(el("p", "reason card-count", countText(tasks)));
    var looseKeys = unsortedKeys();
    node.appendChild(el("p", "reason", looseKeys.length ? "Tasks and key dates that are not in a project yet." : "Tasks that are not in a project yet."));
    cardFold(node, "unsorted", isOpen, function (inside) {
      if (looseKeys.length) keyDatesSection(inside, null);
      inside.appendChild(label("Tasks"));
      urgentFirst(tasks.slice().sort(taskOrder)).forEach(function (t) {
        var wrap = el("div", "unsorted-row");
        wrap.setAttribute("data-unsorted", t.id);
        wrap.appendChild(taskRow(t, "projects"));
        var file = el("div", "unsorted-file");
        var id = "uf-" + t.id;
        var lab = el("label", "fine", "Project");
        lab.setAttribute("for", id);
        var pick = document.createElement("select");
        pick.id = id;
        pick.setAttribute("aria-label", "Project for " + t.title);
        var none = el("option", null, "Choose a project…");
        none.value = "";
        pick.appendChild(none);
        addProjectOptions(pick, t.space);
        pick.value = "";
        pick.addEventListener("change", function () {
          var target = projectById(pick.value);
          if (target) saveTask(t.id, { project_id: target.id });
        });
        file.appendChild(lab);
        file.appendChild(pick);
        wrap.appendChild(file);
        inside.appendChild(wrap);
      });
    });
    return node;
  }

  function projectGroup(boxId, listId, cards) {
    var list = $(listId);
    list.textContent = "";
    cards.forEach(function (c) { list.appendChild(c); });
    $(boxId).hidden = !cards.length;
  }

  // Draws the Projects tab; returns how many cards it shows.
  function renderProjects() {
    var keyRows = renderKeyStrip();
    renderChangesStrip();
    var visible = state.projects.filter(function (p) { return isTopLevel(p) && inFilter(p) && hit(cardParts(p)); });
    var rank = function (p) { var c = lastChangeOf(p); return c ? c.changed_on + "|" + String(c.created_at || "") : ""; };
    var newestFirst = function (a, b) {
      var x = rank(a), y = rank(b);
      return x === y ? byName(a, b) : x > y ? -1 : 1;
    };
    var projects = visible.filter(function (p) { return !isArea(p); }).sort(newestFirst);
    var areas = visible.filter(isArea).sort(newestFirst);
    projectGroup("box-proj-projects", "list-plans", projects.map(projectCard));
    projectGroup("box-proj-areas", "list-areas", areas.map(projectCard));
    var loose = unsortedTasks();
    var looseKeys = unsortedKeys();
    if (needles.length) {
      loose = hit(["Unsorted"].concat(loose.map(function (t) { return taskParts(t).join(" "); }))) ? loose : [];
      looseKeys = looseKeys.filter(function (k) { return hit([k.text, k.note]); });
    }
    var showUnsorted = loose.length || looseKeys.length;
    projectGroup("box-proj-unsorted", "list-unsorted", showUnsorted ? [unsortedCard(loose)] : []);
    var total = projects.length + areas.length + (showUnsorted ? 1 : 0) + (needles.length ? keyRows : 0);
    var some = state.projects.some(function (p) { return isTopLevel(p) && inFilter(p); });
    $("projects-empty").hidden = some || needles.length > 0 || showUnsorted;
    // The open page loads its change log the first time it is shown.
    var shownOpen = projects.concat(areas).filter(function (p) { return sameId(state.openProject, p.id); })[0];
    if (shownOpen) ensureLog(shownOpen);
    return total;
  }

  var editingPlan = null; // the project in the dialog; null while adding one

  // The "Part of" picker: the top-level rows of the organisation. A row that has topics cannot become a topic.
  function fillParentChoices(space, self, chosen) {
    var pick = $("pd-parent");
    pick.textContent = "";
    var none = el("option", null, "None (a project or area of its own)");
    none.value = "";
    pick.appendChild(none);
    state.projects.filter(function (x) {
      return x.space === space && isTopLevel(x) && !(self && sameId(x.id, self.id));
    }).sort(byName).forEach(function (x) {
      var o = el("option", null, x.name);
      o.value = String(x.id);
      pick.appendChild(o);
    });
    var blocked = !!self && topicsOf(self).length > 0;
    var wanted = blocked || chosen === null || chosen === undefined ? "" : String(chosen);
    pick.value = Array.prototype.some.call(pick.options, function (o) { return o.value === wanted; }) ? wanted : "";
    pick.disabled = blocked;
    $("pd-parent-note").hidden = !blocked;
  }

  function openPlanDialog(p, parent) {
    editingPlan = p || null;
    var asTopic = p ? !isTopLevel(p) : !!parent;
    $("pd-heading").textContent = p ? (asTopic ? "Edit topic" : isArea(p) ? "Edit area" : "Edit project") : parent ? "New topic" : "New project";
    $("pd-space-box").hidden = !!p || !!parent || state.filter !== "all";
    var space = p ? p.space : parent ? parent.space : (state.filter !== "all" ? state.filter : readPref("desk.task-space", "metaculus"));
    $("pd-space").value = space;
    $("pd-name").value = p ? p.name : "";
    $("pd-kind").value = p ? (isArea(p) ? "area" : "project") : parent && isArea(parent) ? "area" : "project";
    fillParentChoices(space, p, p ? p.parent_id : parent ? parent.id : null);
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
    var parent = projectById($("pd-parent").value);
    if (editingPlan && topicsOf(editingPlan).length) parent = null;
    var row = {
      name: name,
      kind: $("pd-kind").value === "area" ? "area" : "project",
      parent_id: parent ? parent.id : null,
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
      row.space = parent ? parent.space : $("pd-space").value;
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

  // ---------- Tasks ----------

  var HORIZONS = [
    { id: "today", label: "Today" },
    { id: "week", label: "This week" },
    { id: "weeks", label: "Next 2-3 weeks" },
    { id: "later", label: "Later" },
  ];
  var REPEAT_PILL = { daily: "daily", weekly: "weekly", biweekly: "every 2 weeks", monthly: "monthly" };

  // The project of a task as written on its row: "Name", or "Parent \u203a Topic" for a topic.
  function projectName(task) {
    var p = projectById(task.project_id);
    if (p) return projectLabel(p);
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

  function pills(task, where) {
    var open = task.status === "open";
    var box = el("div", "pills");
    box.appendChild(el("span", "pill tag-" + task.space, spaceLabel(task.space)));
    if (projectName(task)) {
      if (where === "projects") {
        box.appendChild(el("span", "pill project-pill", projectName(task)));
      } else {
        box.appendChild(button(projectName(task), "pill project-pill", function () {
          state.project = task.project_id;
          render();
        }));
      }
    }
    var live = open ? activeRunOf(task.id) : null;
    if (live) box.appendChild(el("span", "pill run-st-" + live.status, live.status === "needs_you" ? "Needs you" : "Working"));
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
      var begin = planControl(task, "btn");
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
    var row = el("div", "trow" + (task.status === "done" ? " is-done" : "") + (isOpen ? " is-open" : "") + (task.urgent && task.status === "open" ? " is-urgent" : ""));
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
    main.appendChild(pills(task, where));
    var late = lateNote(task);
    if (late) main.appendChild(el("p", "trow-late", late));
    if (!isOpen && task.context) main.appendChild(el("p", "trow-why", why(task)));
    row.appendChild(main);
    if (task.status === "open") {
      // On a wide screen a small quiet button sits at the right end of the row (hidden by the stylesheet on a phone).
      var rowStart = planControl(task, "quiet row-start");
      if (rowStart) row.appendChild(rowStart);
    }
    if (isOpen) row.appendChild(taskDetails(task, row, where));
    if (task.status === "open") {
      var planBox = planPanel(task, where);
      if (planBox) row.appendChild(planBox);
    }

    // Tapping the row opens or closes it in place. Controls inside it do their own thing.
    row.addEventListener("click", function (event) {
      var inner = event.target.closest("input, a, select, .fold-body, button:not(.task-title)");
      if (inner && row.contains(inner)) return; // a control of the row itself (the row may sit inside a project page)
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

  // True when the task is in this project or in one of its topics.
  function inProject(t, id) {
    if (sameId(t.project_id, id)) return true;
    var own = projectById(t.project_id);
    return !!own && sameId(own.parent_id, id);
  }

  // Draws the Tasks list; returns how many rows it shows.
  function renderTasks() {
    var list = $("list-tasks");
    list.textContent = "";
    var inSpace = state.tasks.filter(function (t) { return state.filter === "all" || t.space === state.filter; });
    var openInSpace = inSpace.filter(function (t) { return t.status === "open"; });
    if (state.project && !state.projects.some(function (p) { return sameId(p.id, state.project) && (state.filter === "all" || p.space === state.filter); })) {
      state.project = null;
    }
    var mine = inSpace.filter(function (t) { return !state.project || inProject(t, state.project); });
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
      var n = openInSpace.filter(function (t) { return inProject(t, p.id); }).length;
      if (!n && !sameId(state.project, p.id)) return;
      tools.appendChild(button(projectLabel(p) + " " + n, "project" + (sameId(state.project, p.id) ? " on" : ""), function () {
        state.project = sameId(state.project, p.id) ? null : p.id;
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
      if (p.space === space && isTopLevel(p) && p.name.toLowerCase() === wanted.toLowerCase()) return p.id;
    }
    var made = await sb.from("projects").insert({ space: space, name: wanted, kind: "project", parent_id: null }).select("id").single();
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

  // The project picker: this organisation's projects with their topics indented beneath, "No project", and "New project…".
  // A task can be saved without a project (it lands in Unsorted). A suggested name that does not exist yet arrives
  // selected as a new project.
  function fillProjectChoices(space, chosen, chosenId) {
    var pick = $("td-project");
    var fresh = $("td-project-new");
    pick.textContent = "";
    var none = el("option", null, "No project");
    none.value = "";
    pick.appendChild(none);
    addProjectOptions(pick, space);
    var wanted = "";
    var byId = chosenId !== null && chosenId !== undefined ? projectById(chosenId) : null;
    if (byId && byId.space === space) {
      wanted = String(byId.id);
    } else if (chosen) {
      var low = String(chosen).toLowerCase();
      var found = state.projects.filter(function (p) { return p.space === space && isTopLevel(p) && p.name.toLowerCase() === low; })[0] ||
        state.projects.filter(function (p) { return p.space === space && (p.name.toLowerCase() === low || projectLabel(p).toLowerCase() === low); })[0];
      if (found) wanted = String(found.id);
    }
    var newOpt = el("option", null, "New project…");
    newOpt.value = "__new__";
    pick.appendChild(newOpt);
    var isNew = !wanted && !!chosen;
    pick.value = isNew ? "__new__" : wanted;
    fresh.value = isNew ? chosen : "";
    fresh.hidden = !isNew;
  }

  // The project the form stands on: an id, or the name of a project to create, or nothing.
  async function chosenProjectId(space) {
    var v = $("td-project").value;
    if (v === "__new__") return await projectId(space, $("td-project-new").value);
    var p = v ? projectById(v) : null;
    return p ? p.id : null;
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
    fillProjectChoices(task.space, task.project || "", task.project_id);
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
      id: task.id, status: task.status, space: task.space, title: task.title, project: "", project_id: task.project_id === undefined ? null : task.project_id,
      horizon: task.horizon, urgent: !!task.urgent, due_on: task.due_on, repeat: task.repeat, context: task.context, notes: task.notes,
      links: Array.isArray(task.links) ? task.links.slice() : [], source_item_id: task.source_item_id,
      steps: (Array.isArray(task.steps) ? task.steps : []).map(function (x) { return { text: String(x.text || ""), done: !!x.done }; }),
      related: Array.isArray(task.related) ? task.related.slice() : [],
    });
  }

  function blankTask(space, title) {
    return { id: null, status: "open", space: space, title: title || "", project: "", project_id: null, horizon: "week", urgent: false, due_on: null, repeat: null, context: "", notes: "", links: [], steps: [], related: [], source_item_id: null };
  }

  function withSuggestion(task, s) {
    if (!s) return task;
    task.title = s.title || task.title;
    task.space = s.space || task.space;
    task.project = s.project || "";
    task.project_id = null;
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
        project_id: await chosenProjectId(space),
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
        if (draft.keyDateId) {
          res = await sb.from("tasks").insert(row).select("id").single();
          if (!res.error && res.data) await linkKeyTask(draft.keyDateId, res.data.id);
        } else {
          res = await sb.from("tasks").insert(row);
        }
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
      var o = el("option", null, projectLabel(p));
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
    if (plan) top.appendChild(el("span", "kind", projectLabel(plan)));
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

  // ---------- Update sign on the organisations ----------

  var LOOKED_KEY = "desk.looked.";
  var lookedMemory = {}; // organisation -> when you last looked at it; used when the browser will not store it

  function lookedAt(space) {
    var stored = parseInt(readPref(LOOKED_KEY + space, ""), 10);
    var mem = lookedMemory[space] || 0;
    return Math.max(isNaN(stored) ? 0 : stored, mem);
  }

  // Looking at an organisation means it is the chosen one (or All is chosen) while the page is showing.
  function markLooked() {
    if (document.hidden) return;
    var now = Date.now();
    SPACES.forEach(function (s) {
      if (s.id === "all" || (state.filter !== "all" && state.filter !== s.id)) return;
      lookedMemory[s.id] = now;
      writePref(LOOKED_KEY + s.id, String(now));
    });
  }

  function stampOf(iso) {
    var t = Date.parse(iso);
    return isNaN(t) ? 0 : t;
  }

  // True when this organisation has something that needs you that is newer than your last look:
  // an open item in "Needs you", a run waiting for you, a run that has finished, or a key date that needs you.
  function hasUpdates(space) {
    var since = lookedAt(space);
    if (!since) return false; // never looked yet: nothing counts as new
    var item = state.items.some(function (i) {
      return i.space === space && i.status === "open" && i.lane === "waiting" && stampOf(i.created_at) > since;
    });
    if (item) return true;
    var run = state.runs.some(function (r) {
      if (r.space !== space) return false;
      var t = r.status === "needs_you" ? stampOf(r.updated_at || r.finished_at)
        : (r.status === "done" || r.status === "failed") ? stampOf(r.finished_at || r.updated_at) : 0;
      return t > since;
    });
    return run || keyDatesNeedYou(space, since);
  }

  // On the first visit nothing is new: every organisation starts as looked at.
  function startLooked() {
    var now = Date.now();
    SPACES.forEach(function (s) {
      if (s.id !== "all" && !lookedAt(s.id)) { lookedMemory[s.id] = now; writePref(LOOKED_KEY + s.id, String(now)); }
    });
  }

  // ---------- Links ----------

  var LINK_FAIL = "That did not save: ";

  function linkOrder(a, b) {
    var ids = SPACES.map(function (s) { return s.id; });
    var sa = ids.indexOf(a.space);
    var sb2 = ids.indexOf(b.space);
    if (sa !== sb2) return sa - sb2;
    if ((a.position || 0) !== (b.position || 0)) return (a.position || 0) - (b.position || 0);
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }

  function linksOf(space) {
    return state.links.filter(function (l) { return l.space === space; }).sort(linkOrder);
  }

  // Turns what you typed into a label and an https address, or says in plain words what is wrong.
  function cleanLink(labelText, urlText) {
    var label = String(labelText || "").trim();
    var url = String(urlText || "").trim();
    if (!label) return { error: "Give the link a name.", field: "label" };
    if (label.length > 60) return { error: "The name can have at most 60 characters; yours has " + label.length + ".", field: "label" };
    if (!url) return { error: "Type the address of the page.", field: "url" };
    var hasScheme = /^[a-z][a-z0-9+.\-]*:\/\//i.test(url) || /^(javascript|data|vbscript|mailto|tel|sms|file|blob|about|ftp):/i.test(url);
    if (!hasScheme) url = "https://" + url;
    if (/\s/.test(url)) return { error: "The address cannot contain spaces.", field: "url" };
    if (!/^https:\/\//i.test(url)) return { error: "Only addresses that start with https:// can be saved.", field: "url" };
    url = "https://" + url.slice(8);
    var parsed = F.safeUrl(url);
    if (!parsed || parsed.indexOf("https:") !== 0 || url.length <= 8) return { error: "That does not look like a web address.", field: "url" };
    if (url.length > 1000) return { error: "The address is too long; it can have at most 1000 characters.", field: "url" };
    return { label: label, url: url };
  }

  var linkFormFilter = null;

  // The Add form: organisation preset from the filter; with All you must choose one.
  function syncLinkForm() {
    var space = $("link-space");
    fillSpaceChoices(space);
    if (linkFormFilter !== state.filter) {
      linkFormFilter = state.filter;
      space.value = state.filter !== "all" ? state.filter : (state.linkSpace || "");
    }
    space.options[0].hidden = state.filter !== "all";
  }

  function linkProblem(node, text, field) {
    node.textContent = text;
    node.hidden = !text;
    if (text && field) field.focus();
  }

  async function addLink() {
    if (state.linkBusy) return;
    var problem = $("link-error");
    problem.hidden = true;
    var space = $("link-space").value;
    var made = cleanLink($("link-label").value, $("link-url").value);
    if (made.error) { linkProblem(problem, made.error, $(made.field === "label" ? "link-label" : "link-url")); return; }
    if (!space) { linkProblem(problem, "Choose an organisation first.", $("link-space")); return; }
    state.linkBusy = true;
    $("link-save").disabled = true;
    var mine = linksOf(space);
    var position = mine.length ? (mine[mine.length - 1].position || 0) + 1 : 0;
    var res = await sb.from("quick_links").insert({ space: space, label: made.label, url: made.url, position: position }).select("id, space, label, url, position, created_at").single();
    state.linkBusy = false;
    $("link-save").disabled = false;
    if (res.error || !res.data) {
      linkProblem(problem, LINK_FAIL + (res.error ? res.error.message : "unknown error"), null);
      return;
    }
    state.linkSpace = space;
    state.links.push(res.data);
    $("link-label").value = "";
    $("link-url").value = "";
    $("link-label").focus();
    render();
    await load();
  }

  async function saveLinkEdit(l, labelBox, urlBox, problem) {
    var made = cleanLink(labelBox.value, urlBox.value);
    if (made.error) { linkProblem(problem, made.error, made.field === "label" ? labelBox : urlBox); return; }
    problem.hidden = true;
    var res = await sb.from("quick_links").update({ label: made.label, url: made.url }).eq("id", l.id);
    if (res.error) { linkProblem(problem, LINK_FAIL + res.error.message, null); return; }
    l.label = made.label;
    l.url = made.url;
    state.linkEdit = null;
    render();
    await load();
  }

  // Swaps the link with its neighbour and rewrites the positions of that organisation's links as 0..n-1.
  async function moveLink(l, step) {
    var mine = linksOf(l.space);
    var at = mine.indexOf(l);
    var to = at + step;
    if (at < 0 || to < 0 || to >= mine.length) return;
    mine.splice(to, 0, mine.splice(at, 1)[0]);
    var writes = [];
    mine.forEach(function (x, i) {
      if (x.position !== i) { x.position = i; writes.push(sb.from("quick_links").update({ position: i }).eq("id", x.id)); }
    });
    render();
    var results = await Promise.all(writes);
    var bad = results.filter(function (r) { return r && r.error; })[0];
    await load();
    if (bad) notice(LINK_FAIL + bad.error.message);
  }

  async function removeLink(l) {
    state.linkAsk = null;
    state.links = state.links.filter(function (x) { return x !== l; });
    render();
    var res = await sb.from("quick_links").delete().eq("id", l.id);
    await load();
    if (res.error) notice(LINK_FAIL + res.error.message);
  }

  // The tile turns into a small form, in place. The node is kept so that what you type survives redraws.
  function editLink(l) {
    var node = el("div", "link-tile editing");
    node.setAttribute("data-link", l.id);
    var labelBox = el("input", "link-input");
    labelBox.type = "text";
    labelBox.maxLength = 60;
    labelBox.value = l.label;
    labelBox.setAttribute("aria-label", "Name");
    var urlBox = el("input", "link-input");
    urlBox.type = "text";
    urlBox.maxLength = 1000;
    urlBox.value = l.url;
    urlBox.setAttribute("inputmode", "url");
    urlBox.setAttribute("aria-label", "Address");
    var problem = el("p", "error");
    problem.setAttribute("role", "alert");
    problem.hidden = true;
    var save = function () { saveLinkEdit(l, labelBox, urlBox, problem); };
    [labelBox, urlBox].forEach(function (box) {
      box.addEventListener("keydown", function (event) {
        if (event.key === "Enter") { event.preventDefault(); save(); }
        if (event.key === "Escape") { state.linkEdit = null; render(); }
      });
    });
    node.appendChild(labelBox);
    node.appendChild(urlBox);
    node.appendChild(problem);
    var row = el("div", "actions");
    row.appendChild(button("Save", "primary", save));
    row.appendChild(button("Cancel", "btn subtle", function () { state.linkEdit = null; render(); }));
    node.appendChild(row);
    state.linkEdit = { id: l.id, node: node };
    render();
    labelBox.focus();
  }

  function linkTile(l, index, count) {
    if (state.linkEdit && state.linkEdit.id === l.id) return state.linkEdit.node;
    var href = httpsLink(l.url);
    var label = el("span", "link-label", l.label);
    var where = el("span", "link-host", href ? F.host(href) : "Address cannot be opened");
    if (!state.linksEditing) {
      if (!href) {
        var dead = el("div", "link-tile dead");
        dead.setAttribute("data-link", l.id);
        dead.appendChild(label);
        dead.appendChild(where);
        return dead;
      }
      var a = linkTo(href, "", "link-tile");
      a.setAttribute("data-link", l.id);
      a.appendChild(label);
      a.appendChild(where);
      return a;
    }
    var node = el("div", "link-tile editing");
    node.setAttribute("data-link", l.id);
    node.appendChild(label);
    node.appendChild(where);
    var actions = el("div", "actions");
    if (state.linkAsk === l.id) {
      actions.appendChild(el("span", "note-ask", "Remove this link?"));
      actions.appendChild(button("Remove", "btn danger", function () { removeLink(l); }));
      actions.appendChild(button("Keep", "btn", function () { state.linkAsk = null; render(); }));
    } else {
      actions.appendChild(button("Edit", "btn", function () { state.linkAsk = null; editLink(l); }));
      var up = button("Move up", "btn", function () { moveLink(l, -1); });
      up.disabled = index === 0;
      var down = button("Move down", "btn", function () { moveLink(l, 1); });
      down.disabled = index === count - 1;
      actions.appendChild(up);
      actions.appendChild(down);
      actions.appendChild(button("Remove", "btn subtle", function () { state.linkAsk = l.id; render(); }));
    }
    node.appendChild(actions);
    return node;
  }

  // Draws the Links view: the tiles of the chosen organisation, grouped by organisation under All. Returns how many tiles show.
  function renderLinks() {
    syncLinkForm();
    var list = $("list-links");
    var edit = $("links-edit");
    edit.textContent = state.linksEditing ? "Done" : "Edit or remove links";
    edit.setAttribute("aria-pressed", state.linksEditing ? "true" : "false");
    var active = document.activeElement;
    var keepFocus = state.linkEdit && state.linkEdit.node.contains(active) ? active : null;
    // A tile (or one of its buttons) you reached with the keyboard stays focused after a redraw.
    var focusId = null, focusText = null;
    var focusTile = !keepFocus && list.contains(active) ? active.closest("[data-link]") : null;
    if (focusTile) { focusId = focusTile.getAttribute("data-link"); focusText = active === focusTile ? null : active.textContent; }
    list.textContent = "";
    var total = 0;
    var spaces = SPACES.filter(function (s) { return s.id !== "all" && (state.filter === "all" || state.filter === s.id); });
    spaces.forEach(function (s) {
      var all = linksOf(s.id);
      var shown = all.filter(function (l) { return hit([l.label, F.host(l.url)]); });
      if (!shown.length) return;
      var group = el("div", "link-group");
      if (state.filter === "all") group.appendChild(el("h3", "link-group-name", s.label));
      var grid = el("div", "link-grid");
      shown.forEach(function (l) { grid.appendChild(linkTile(l, all.indexOf(l), all.length)); });
      group.appendChild(grid);
      list.appendChild(group);
      total += shown.length;
    });
    if (!total && !needles.length) {
      list.appendChild(el("p", "empty", "Add the pages you open often, and they will be one tap away here."));
    }
    if (keepFocus && keepFocus.isConnected) keepFocus.focus({ preventScroll: true });
    if (focusId !== null) {
      var tiles = list.querySelectorAll("[data-link]");
      for (var i = 0; i < tiles.length; i++) {
        if (tiles[i].getAttribute("data-link") !== focusId) continue;
        var target = focusText === null ? tiles[i] : null;
        var buttons = tiles[i].querySelectorAll("button");
        for (var j = 0; focusText !== null && j < buttons.length; j++) if (buttons[j].textContent === focusText && !buttons[j].disabled) target = buttons[j];
        if (target) target.focus({ preventScroll: true });
      }
    }
    return total;
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

  // ---------- Key dates ----------
  // Something that has to happen on or by a day and is not a task. The text and the note may have been written by a
  // model from other people's content: they are plain text only, never linked and never HTML.

  var KD_COLS = "id, space, project_id, on_date, hard_limit, text, note, warn_days, status, origin, task_id, created_at, done_at";
  var KD_DONE_DAYS = 30;  // how far back the page loads key dates that are done
  var KD_AHEAD = 60;      // the Projects list looks this many days ahead
  var KD_FIRST = 5;       // lines shown before "Show all"
  var KD_FAIL = "That did not save: ";
  var KD_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

  // Days are counted on a calendar, from the year, month and day alone, so a time zone or a clock change never moves them.
  function dayNumber(day) {
    var m = KD_DAY.exec(String(day || ""));
    if (!m) return NaN;
    var n = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return new Date(n).getUTCMonth() === Number(m[2]) - 1 ? Math.round(n / DAY) : NaN;
  }

  function todayNumber() {
    var n = new Date();
    return Math.round(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()) / DAY);
  }

  // Whole days from your today to a day; negative when it has passed.
  function daysTo(day) { return dayNumber(day) - todayNumber(); }

  // A day as a local date at noon (never parsed as UTC midnight).
  function dayDate(day) {
    var m = KD_DAY.exec(String(day || ""));
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12) : null;
  }

  // "14 Dec", with the year when it is not this year.
  function keyDay(day) {
    var d = dayDate(day);
    if (!d || isNaN(d.getTime())) return "";
    return shortDate(d) + (d.getFullYear() !== new Date().getFullYear() ? " " + d.getFullYear() : "");
  }

  // "Mon 14 Dec".
  function keyDate(day) {
    var d = dayDate(day);
    if (!d || isNaN(d.getTime())) return "";
    return d.toLocaleDateString([], { weekday: "short" }) + " " + keyDay(day);
  }

  function keyCount(n) {
    if (n === 0) return "today";
    if (n === 1) return "tomorrow";
    if (n > 1) return "in " + n + " days";
    return (-n) + (n === -1 ? " day late" : " days late");
  }

  // ahead: before the day. warn: the day has come (or passed) and the last day has not. late: the last day (or the day, when there is no last day) has passed.
  function keyTone(k) {
    var t = todayNumber();
    if (t > dayNumber(k.hard_limit || k.on_date)) return "late";
    return t >= dayNumber(k.on_date) ? "warn" : "ahead";
  }

  function warnDays(k) {
    var w = Number(k.warn_days);
    return isNaN(w) ? 7 : w;
  }

  // The warning window has started: it is the day, or fewer than warn_days days before it, or later.
  function keyInWindow(k) { return todayNumber() >= dayNumber(k.on_date) - warnDays(k); }

  function byKeyDate(a, b) {
    var x = dayNumber(a.on_date), y = dayNumber(b.on_date);
    if (x !== y) return x - y;
    var l = dayNumber(a.hard_limit || a.on_date), m = dayNumber(b.hard_limit || b.on_date);
    if (l !== m) return l - m;
    return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
  }

  function keyById(id) {
    return state.keyDates.filter(function (k) { return sameId(k.id, id); })[0] || null;
  }

  // The key dates of a project and its topics.
  function keyDatesOf(p) {
    var ids = familyIds(p);
    return state.keyDates.filter(function (k) { return ids.some(function (id) { return sameId(id, k.project_id); }); });
  }

  // Open and proposed key dates that belong to no project.
  function unsortedKeys() {
    return state.keyDates.filter(function (k) {
      return (k.status === "open" || k.status === "proposed") && (k.project_id === null || k.project_id === undefined) && inFilter(k);
    });
  }

  function openKeys() {
    return state.keyDates.filter(function (k) { return k.status === "open" && inFilter(k) && hit([k.text, k.note]); }).sort(byKeyDate);
  }

  function proposedKeys() {
    return state.keyDates.filter(function (k) { return k.status === "proposed" && inFilter(k) && hit([k.text, k.note]); }).sort(byKeyDate);
  }

  // For the update dot: an open key date that has reached its day, or a proposed one, that was created or came due since you last looked.
  function keyDatesNeedYou(space, since) {
    var today = todayNumber();
    return state.keyDates.some(function (k) {
      if (k.space !== space || (k.status !== "open" && k.status !== "proposed")) return false;
      var day = dayNumber(k.on_date);
      var reached = day <= today;
      if (k.status === "open" && !reached) return false;
      if (k.origin !== "you" && stampOf(k.created_at) > since) return true;
      var d = dayDate(k.on_date);
      return reached && !!d && new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() > since;
    });
  }

  // Changes a key date at once on the page, then in the database; a failed save is told and the page reloads what is stored.
  async function saveKey(id, changes, saved) {
    var k = keyById(id);
    if (k) {
      Object.keys(changes).forEach(function (f) { k[f] = changes[f]; });
      render();
    }
    var res = await sb.from("key_dates").update(changes).eq("id", id);
    if (res.error) notice(KD_FAIL + res.error.message);
    else if (saved) saved();
    await load();
  }

  function keyDone(k) {
    saveKey(k.id, { status: "done", done_at: new Date().toISOString() }, function () {
      toast("Marked done.", function () { saveKey(k.id, { status: "open", done_at: null }); });
    });
  }

  function keyDismiss(k) {
    saveKey(k.id, { status: "dropped" }, function () {
      toast("Dismissed.", function () { saveKey(k.id, { status: "proposed" }); });
    });
  }

  async function removeKey(k) {
    state.kdAsk = null;
    state.keyDates = state.keyDates.filter(function (x) { return !sameId(x.id, k.id); });
    render();
    var res = await sb.from("key_dates").delete().eq("id", k.id);
    if (res.error) notice("That did not delete: " + res.error.message);
    await load();
  }

  // Opens the task form with the key date filled in. The key date stays open; the task's id is stored on it once the task is saved.
  function taskFromKey(k) {
    var task = blankTask(k.space, k.text);
    task.due_on = k.on_date;
    task.project_id = k.project_id === undefined ? null : k.project_id;
    task.keyDateId = k.id;
    showDialog(task, "Made from a key date. The key date stays open.");
  }

  async function linkKeyTask(keyId, taskId) {
    var k = keyById(keyId);
    if (k) k.task_id = taskId;
    var res = await sb.from("key_dates").update({ task_id: taskId }).eq("id", keyId);
    if (res.error) notice("The task was saved, but it could not be linked to the key date: " + res.error.message);
  }

  function focusKey(id, selector) {
    var node = onPage('[data-keydate="' + id + '"] ' + selector);
    if (node) node.focus({ preventScroll: true });
  }

  // The words under More on Today: the note and the task made from it.
  function keyPanel(k) {
    var panel = el("div", "kd-panel");
    panel.appendChild(k.note ? el("p", "kd-note", String(k.note)) : el("p", "empty", "There is no note."));
    var row = el("div", "actions");
    if (k.task_id) {
      var task = state.tasks.filter(function (t) { return sameId(t.id, k.task_id); })[0];
      row.appendChild(el("span", "fine", "A task was made from this."));
      if (task && task.status === "open") row.appendChild(button("Open the task", "btn small", function () { goToTask(task); }));
    } else {
      row.appendChild(button("Make this a task", "btn small", function () { taskFromKey(k); }));
    }
    panel.appendChild(row);
    return panel;
  }

  // One key date. where: "cover" (Today), "list" (the Projects tab list) or "page" (a project page); page is the project whose page it is.
  function keyLine(k, where, page) {
    if (where === "page" && state.kdEdit && sameId(state.kdEdit.id, k.id)) return keyForm(state.kdEdit, page, k);
    var open = k.status === "open";
    var line = el("div", "kd-line kd-" + (open ? keyTone(k) : "plain"));
    line.setAttribute("data-keydate", k.id);
    var main = el("div", "kd-main");
    var when = el("p", "kd-when");
    when.appendChild(el("span", "kd-date", keyDate(k.on_date)));
    if (k.status !== "done") when.appendChild(el("span", "kd-count", keyCount(daysTo(k.on_date))));
    if (k.hard_limit) when.appendChild(el("span", "kd-last", "last day " + keyDay(k.hard_limit)));
    main.appendChild(when);
    main.appendChild(el("p", "kd-text", String(k.text || "")));
    var proj = projectById(k.project_id);
    if (proj && where !== "page") {
      var at = el("p", "kd-where");
      at.appendChild(button(projectLabel(proj), "ref kd-project", function () { goToProject(proj); }));
      main.appendChild(at);
    } else if (proj && where === "page" && page && !sameId(proj.id, page.id)) {
      var inTopic = el("p", "kd-where");
      inTopic.appendChild(el("span", "topic-chip", proj.name));
      main.appendChild(inTopic);
    }
    if (k.status === "proposed") {
      var found = el("p", "kd-where");
      found.appendChild(el("span", "pill kd-found", "Found by the Desk"));
      main.appendChild(found);
    }
    line.appendChild(main);

    var actions = el("div", "kd-actions");
    var name = " (" + String(k.text || "").slice(0, 60) + ")";
    if (open) {
      var done = button("Done", "btn small", function () { keyDone(k); });
      done.setAttribute("aria-label", "Done: " + k.text);
      actions.appendChild(done);
    }
    if (open && where === "cover") {
      var isMore = !!state.kdMore[k.id];
      var more = button(isMore ? "Less" : "More", "quiet kd-more", function () {
        state.kdMore[k.id] = !state.kdMore[k.id];
        render();
        focusKey(k.id, ".kd-more");
      });
      more.setAttribute("aria-expanded", isMore ? "true" : "false");
      more.setAttribute("aria-label", (isMore ? "Less" : "More") + " about " + k.text);
      actions.appendChild(more);
    }
    if (where === "page" && open) {
      if (state.kdAsk !== null && sameId(state.kdAsk, k.id)) {
        actions.appendChild(el("span", "note-ask", "Remove this key date?"));
        actions.appendChild(button("Yes, remove", "btn small danger", function () { removeKey(k); }));
        actions.appendChild(button("Keep", "btn small kd-keep", function () { state.kdAsk = null; render(); focusKey(k.id, ".kd-remove"); }));
      } else {
        var edit = button("Edit", "btn small subtle kd-edit", function () {
          state.kdAsk = null;
          state.kdForm = null;
          state.kdEdit = {
            id: k.id, date: k.on_date, last: k.hard_limit || "", text: String(k.text || ""), note: String(k.note || ""),
            warn: String(warnDays(k)), about: k.project_id === null || k.project_id === undefined ? "" : String(k.project_id), error: "", saving: false,
          };
          render();
          var first = onPage("#ke-date");
          if (first) first.focus();
        });
        edit.setAttribute("aria-label", "Edit" + name);
        actions.appendChild(edit);
        var rm = button("Remove", "btn small subtle kd-remove", function () {
          state.kdAsk = k.id;
          render();
          focusKey(k.id, ".kd-keep");
        });
        rm.setAttribute("aria-label", "Remove" + name);
        actions.appendChild(rm);
      }
    }
    if (where === "page" && k.status === "proposed") {
      var yes = button("Confirm", "btn small", function () { saveKey(k.id, { status: "open" }); });
      yes.setAttribute("aria-label", "Confirm" + name);
      actions.appendChild(yes);
      var no = button("Dismiss", "btn small subtle", function () { keyDismiss(k); });
      no.setAttribute("aria-label", "Dismiss" + name);
      actions.appendChild(no);
    }
    if (where === "page" && k.status === "done") {
      actions.appendChild(button("Reopen", "btn small subtle", function () { saveKey(k.id, { status: "open", done_at: null }); }));
    }
    if (actions.children.length) line.appendChild(actions);
    if (open && where === "cover" && state.kdMore[k.id]) line.appendChild(keyPanel(k));
    return line;
  }

  // ----- Adding and editing -----

  // What is wrong with a form, in a plain sentence; "" when it can be saved.
  function keyProblem(form) {
    if (isNaN(dayNumber(form.date))) return "Choose the date first.";
    if (form.last && isNaN(dayNumber(form.last))) return "Choose a valid last day, or clear it.";
    if (form.last && dayNumber(form.last) < dayNumber(form.date)) return "The last day cannot be earlier than the date.";
    if (!String(form.text || "").trim()) return "Write what has to happen first.";
    if (String(form.text).trim().length > 300) return "Keep what has to happen to 300 characters or fewer.";
    if (String(form.note || "").trim().length > 1000) return "Keep the note to 1,000 characters or fewer.";
    var warn = String(form.warn === undefined || form.warn === null ? "" : form.warn).trim();
    if (!/^\d{1,3}$/.test(warn) || Number(warn) > 90) return "Choose between 0 and 90 days for the warning.";
    return "";
  }

  function keyRow(form) {
    return {
      on_date: form.date,
      hard_limit: form.last || null,
      text: String(form.text).trim(),
      note: String(form.note || "").trim() || null,
      warn_days: Number(String(form.warn).trim()),
    };
  }

  async function addKey() {
    var form = state.kdForm;
    if (!form || form.saving) return;
    form.error = keyProblem(form);
    if (form.error) { render(); focusForm("kd-error"); return; }
    var target = projectById(form.about) || projectById(form.pageId);
    if (!target) return;
    form.saving = true;
    render();
    var row = keyRow(form);
    row.space = target.space;
    row.project_id = target.id;
    row.status = "open";
    row.origin = "you";
    var res = await sb.from("key_dates").insert(row).select(KD_COLS).single();
    if (res.error || !res.data) {
      form.saving = false;
      form.error = "Not saved: " + (res.error ? res.error.message : "unknown error");
      render();
      return;
    }
    state.kdForm = null;
    state.keyDates = state.keyDates.concat([res.data]);
    render();
  }

  async function saveKeyEdit() {
    var form = state.kdEdit;
    if (!form || form.saving) return;
    var k = keyById(form.id);
    if (!k) { state.kdEdit = null; render(); return; }
    form.error = keyProblem(form);
    if (form.error) { render(); focusForm("kd-error"); return; }
    var changes = keyRow(form);
    var target = form.about === "" ? null : projectById(form.about);
    if (form.about !== "" && !target) return;
    changes.project_id = target ? target.id : null;
    if (target) changes.space = target.space;
    state.kdEdit = null;
    await saveKey(k.id, changes);
  }

  function focusForm(cls) {
    var node = onPage(".kd-form ." + cls);
    if (node) node.scrollIntoView({ block: "nearest" });
  }

  // The form for a new key date (k is null) or for editing one. `form` is state.kdForm or state.kdEdit; it keeps what you typed.
  function keyForm(form, page, k) {
    var adding = !k;
    var pre = adding ? "kd-" : "ke-";
    var box = el("form", "change-add kd-form");
    box.noValidate = true;
    box.autocomplete = "off";
    if (!adding) box.setAttribute("data-keydate", k.id);
    var field = function (parent, id, text, control) {
      var wrap = el("div");
      var lab = el("label", null, text);
      lab.setAttribute("for", id);
      control.id = id;
      wrap.appendChild(lab);
      wrap.appendChild(control);
      parent.appendChild(wrap);
      return control;
    };
    var dates = el("div", "td-row");
    var date = document.createElement("input");
    date.type = "date";
    date.value = form.date;
    date.addEventListener("input", function () { form.date = date.value; });
    field(dates, pre + "date", "Date", date);
    var last = document.createElement("input");
    last.type = "date";
    last.value = form.last;
    last.addEventListener("input", function () { form.last = last.value; });
    field(dates, pre + "last", "Last day (if there is one)", last);
    box.appendChild(dates);

    var text = document.createElement("input");
    text.type = "text";
    text.maxLength = 300;
    text.value = form.text;
    text.addEventListener("input", function () { form.text = text.value; });
    field(box, pre + "text", "What has to happen", text);

    var note = document.createElement("textarea");
    note.rows = 2;
    note.maxLength = 1000;
    note.value = form.note;
    note.addEventListener("input", function () { form.note = note.value; });
    field(box, pre + "note", "Note (optional)", note);

    var more = el("div", "td-row");
    var warn = document.createElement("input");
    warn.type = "number";
    warn.min = "0";
    warn.max = "90";
    warn.step = "1";
    warn.inputMode = "numeric";
    warn.value = form.warn;
    warn.addEventListener("input", function () { form.warn = warn.value; });
    field(more, pre + "warn", "Warn me this many days before", warn);
    var topics = page ? topicsOf(page) : [];
    if (page ? topics.length : k) {
      var about = document.createElement("select");
      if (page) {
        [page].concat(topics).forEach(function (x) {
          var o = el("option", null, x === page ? page.name : "Topic: " + x.name);
          o.value = String(x.id);
          about.appendChild(o);
        });
      } else {
        var none = el("option", null, "No project");
        none.value = "";
        about.appendChild(none);
        addProjectOptions(about, k.space);
      }
      about.value = String(form.about);
      about.addEventListener("change", function () { form.about = about.value; });
      field(more, pre + "about", "About", about);
    }
    box.appendChild(more);

    if (form.error) {
      var err = el("p", "error kd-error", form.error);
      err.setAttribute("role", "alert");
      box.appendChild(err);
    }
    var actions = el("div", "actions");
    var save = el("button", "primary small", form.saving ? "Saving…" : "Save");
    save.type = "submit";
    save.disabled = !!form.saving;
    actions.appendChild(save);
    actions.appendChild(button("Cancel", "btn subtle small", function () {
      if (adding) state.kdForm = null; else state.kdEdit = null;
      render();
    }));
    box.appendChild(actions);
    box.addEventListener("submit", function (event) {
      event.preventDefault();
      if (adding) addKey(); else saveKeyEdit();
    });
    box.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && !form.saving) {
        event.preventDefault();
        if (adding) state.kdForm = null; else state.kdEdit = null;
        render();
      }
    });
    return box;
  }

  // ----- On a project page -----

  // The "Key dates" section of a project page (p), or of the Unsorted card (p is null).
  function keyDatesSection(inside, p) {
    inside.appendChild(label("Key dates"));
    var mine = p ? keyDatesOf(p) : unsortedKeys();
    var open = mine.filter(function (k) { return k.status === "open"; }).sort(byKeyDate);
    var proposed = mine.filter(function (k) { return k.status === "proposed"; }).sort(byKeyDate);
    var done = mine.filter(function (k) { return k.status === "done"; }).sort(function (a, b) {
      return String(b.done_at || "") < String(a.done_at || "") ? -1 : String(b.done_at || "") > String(a.done_at || "") ? 1 : 0;
    });
    var list = el("div", "kd-list");
    list.setAttribute("data-keydates", p ? p.id : "unsorted");
    if (!open.length && !proposed.length) list.appendChild(el("p", "empty", "You have no open key dates here."));
    open.forEach(function (k) { list.appendChild(keyLine(k, "page", p)); });
    proposed.forEach(function (k) { list.appendChild(keyLine(k, "page", p)); });
    inside.appendChild(list);
    if (done.length) {
      var id = p ? String(p.id) : "unsorted";
      var fold = el("details", "kd-done");
      fold.appendChild(el("summary", null, "Done (" + done.length + ")"));
      var body = foldIn(fold);
      done.forEach(function (k) { body.appendChild(keyLine(k, "page", p)); });
      fold.open = !!state.kdDone[id];
      fold.addEventListener("toggle", function () { state.kdDone[id] = fold.open; });
      inside.appendChild(fold);
    }
    if (!p) return;
    if (state.kdForm && sameId(state.kdForm.pageId, p.id)) {
      inside.appendChild(keyForm(state.kdForm, p, null));
    } else {
      var row = el("p", "plan-links");
      row.appendChild(button("Add a key date", "btn small", function () {
        state.kdEdit = null;
        state.kdForm = { pageId: p.id, date: "", last: "", text: "", note: "", warn: "7", about: String(p.id), error: "", saving: false };
        render();
        var first = onPage("#kd-date");
        if (first) first.focus();
      }));
      inside.appendChild(row);
    }
  }

  // The list at the top of the Projects tab: open key dates in the next 60 days (and those already past), across the organisation filter.
  // Returns how many lines match.
  function renderKeyStrip() {
    var box = $("project-keydates");
    box.textContent = "";
    var limit = todayNumber() + KD_AHEAD;
    var rows = openKeys().filter(function (k) { return dayNumber(k.on_date) <= limit; });
    box.hidden = !rows.length && needles.length > 0;
    var head = el("div", "tsec-head");
    head.appendChild(el("h3", "tsec-name", "Key dates in the next " + KD_AHEAD + " days"));
    if (rows.length) head.appendChild(el("span", "count", String(rows.length)));
    box.appendChild(head);
    var body = el("div", "tsec-body cv-pad");
    if (!rows.length) {
      body.appendChild(el("p", "empty", "You have no key dates in the next " + KD_AHEAD + " days."));
    } else {
      var shown = state.kdAll ? rows : rows.slice(0, KD_FIRST);
      shown.forEach(function (k) { body.appendChild(keyLine(k, "list", null)); });
      if (rows.length > KD_FIRST) {
        var more = button(state.kdAll ? "Show fewer" : "Show all " + rows.length, "btn small", function () {
          state.kdAll = !state.kdAll;
          render();
        });
        more.setAttribute("aria-expanded", state.kdAll ? "true" : "false");
        body.appendChild(more);
      }
    }
    box.appendChild(body);
    return rows.length;
  }

  // ----- On Today -----

  // "Coming up": open key dates whose warning has started (and those already past), soonest first.
  function renderCoverComing() {
    var box = $("cv-coming");
    var open = openKeys();
    var rows = open.filter(keyInWindow);
    var later = open.length - rows.length;
    var proposed = proposedKeys();
    box.textContent = "";
    box.hidden = !(rows.length || later || proposed.length);
    if (box.hidden) return 0;
    var head = el("div", "tsec-head");
    head.appendChild(el("h2", "tsec-name", "Coming up"));
    var overdue = rows.filter(function (k) { return keyTone(k) === "late"; }).length;
    if (overdue) head.appendChild(el("span", "cv-late", overdue + " late"));
    head.appendChild(el("span", "count", String(rows.length)));
    box.appendChild(head);
    var body = el("div", "tsec-body cv-pad");
    if (!rows.length) body.appendChild(el("p", "empty", "Nothing is coming up yet."));
    rows.forEach(function (k) { body.appendChild(keyLine(k, "cover", null)); });
    box.appendChild(body);
    if (later || proposed.length) {
      var foot = el("div", "cv-foot kd-foot");
      if (later) foot.appendChild(button(later + " more later", "quiet", function () { showView("projects"); }));
      if (proposed.length) {
        foot.appendChild(button(proposed.length + " to confirm", "quiet", function () {
          var first = proposed[0];
          var owner = projectById(first.project_id);
          if (owner) { goToProject(owner); return; }
          state.openProject = "unsorted";
          showView("projects");
          reveal(onPage('[data-project="unsorted"]'));
        }));
      }
      box.appendChild(foot);
    }
    return rows.length;
  }

  // ---------- Today ----------

  var KIND_TAGS = { decision: "Decide", owed: "You owe", heads_up: "Heads-up" };
  var REVIEW_FAIL = "The review did not finish. Try again in a minute.";
  var START_FAIL = "Plan did not finish. Try again in a minute.";

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
      return plan ? function () { goToProject(plan); } : null;
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
    return renderCoverComing() + renderCoverWork() + renderCoverTasks() + renderCoverInbox() + renderCoverReview();
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
    var b = button(busy ? "Preparing..." : existing ? "Show start" : "Plan", className, function () {
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
    if (!a || !a.classList || !(a.classList.contains("start-draft") || a.classList.contains("run-text"))) return null;
    return { box: a, from: a.selectionStart, to: a.selectionEnd, dir: a.selectionDirection, top: a.scrollTop };
  }

  function restoreDraftFocus(saved) {
    if (!saved || !saved.box.isConnected || !saved.box.offsetParent) return;
    saved.box.focus({ preventScroll: true });
    try { saved.box.setSelectionRange(saved.from, saved.to, saved.dir || "none"); } catch (_) { /* not selectable */ }
    saved.box.scrollTop = saved.top;
  }

  // Copies a draft. `ta` is the draft box; for a run's draft it is the block that shows it and `text` is the whole text.
  async function copyDraft(key, ta, text) {
    var done = false;
    var words = text === undefined ? ta.value : text;
    try {
      if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error("no clipboard");
      await navigator.clipboard.writeText(words);
      done = true;
    } catch (_) {
      // No clipboard here: select the words so you can copy them yourself.
      try {
        if (text === undefined) {
          ta.focus();
          ta.select();
        } else {
          var range = document.createRange();
          range.selectNodeContents(ta);
          var sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }
        done = document.execCommand("copy");
      } catch (__) { done = false; }
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

  // ---------- Runs: the Desk doing a task in the background ----------
  // Everything a run says (plan, step, question, result, flags, events) was written by a model from other people's
  // content. It is shown as plain text only; the one exception is a link in `outputs`, and only when it is https.

  var RUN_COLUMNS = "id, space, task_id, title, status, plan, instructions, current_step, pending, result, drafts, follow_ups, history, flags, outputs, error, cost_usd, created_at, started_at, updated_at, finished_at";
  var RUN_FAIL = "That did not work. Try again in a minute.";
  var RUN_STATUS = { planned: "Planned", queued: "Waiting", working: "Working", needs_you: "Needs you", done: "Done", stopped: "Stopped", failed: "Failed" };
  var RUN_ACTIVE = { queued: true, working: true, needs_you: true };
  var RUN_SIZE = { simple: "Quick", medium: "Standard", complex: "Deep" };
  var RUN_BUSY = { plan: "Writing the plan...", rewrite: "Writing the plan...", start: "Starting...", answer: "Sending your answer...", follow_up: "Sending your follow-up...", stop: "Stopping...", discard: "Discarding..." };
  var RUN_MARK = { done: "✓", doing: "→", skipped: "–" };
  var RUN_MARK_WORDS = { done: "Done: ", doing: "In progress: ", skipped: "Skipped: " };
  var runBoxes = {}; // the text boxes of runs, kept between redraws so typing is never lost
  var runBoxCount = 0;
  var runPoll = null;

  function runPlan(run) {
    return run && run.plan && typeof run.plan === "object" && !Array.isArray(run.plan) ? run.plan : {};
  }

  // The strings in a list the model wrote; anything else is left out.
  function textList(value) {
    return (Array.isArray(value) ? value : []).map(function (x) { return typeof x === "string" ? x.trim() : ""; }).filter(Boolean);
  }

  function runKey(run) { return "run:" + run.id; }
  function followKey(run) { return "run:" + run.id + "|followup"; }
  function taskKey(taskId) { return "task:" + taskId; }

  function runsOfTask(taskId) {
    return state.runs.filter(function (r) { return r.task_id !== null && r.task_id !== undefined && String(r.task_id) === String(taskId); });
  }
  function activeRunOf(taskId) {
    return runsOfTask(taskId).filter(function (r) { return RUN_ACTIVE[r.status]; })[0] || null;
  }
  function plannedRunOf(taskId) {
    return runsOfTask(taskId).filter(function (r) { return r.status === "planned"; })[0] || null;
  }

  function money(n) { return "$" + (Number(n) || 0).toFixed(2); }

  // How long a finished run took: "45 s", "3 min", "1 h 5 min"; empty when the times are missing.
  function took(run) {
    var from = Date.parse(run.started_at || run.created_at);
    var to = Date.parse(run.finished_at);
    if (isNaN(from) || isNaN(to) || to < from) return "";
    var secs = Math.round((to - from) / 1000);
    if (secs < 60) return secs + " s";
    var mins = Math.round(secs / 60);
    if (mins < 60) return mins + " min";
    return Math.floor(mins / 60) + " h" + (mins % 60 ? " " + (mins % 60) + " min" : "");
  }

  // The time of an event: the clock today, with the date on other days.
  function eventTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toDateString() === new Date().toDateString() ? clock(d) : noteDate(iso);
  }

  function markSeen(id) {
    if (state.runSeen[id]) return;
    state.runSeen[id] = true;
    try { sessionStorage.setItem(SEEN_KEY, JSON.stringify(state.runSeen)); } catch (_) { /* kept in memory only */ }
  }

  function runParts(run) {
    var parts = [run.title, richPlain(run.result), RUN_STATUS[run.status], run.status, spaceLabel(run.space)];
    if (run.status === "queued") parts.push("queued");
    return parts;
  }

  // ----- keeping the runs -----

  function sortRuns(list) {
    return list.sort(function (a, b) { return (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0); });
  }

  // A run the function just returned stays on screen until a load has it too (or something newer).
  function storeRun(row) {
    state.runs = sortRuns(state.runs.filter(function (r) { return String(r.id) !== String(row.id); }).concat([row]));
    state.fresh.runs[row.id] = { row: row, at: Date.now() };
    delete state.runGone[row.id];
    syncRunPoll();
  }

  function forgetBoxes(id) {
    Object.keys(runBoxes).forEach(function (k) { if (k.indexOf(runKey({ id: id }) + "|") === 0) delete runBoxes[k]; });
  }

  function dropRun(id) {
    state.runs = state.runs.filter(function (r) { return String(r.id) !== String(id); });
    delete state.fresh.runs[id];
    delete state.runOpen[id];
    delete state.runAct[id];
    delete state.runEvents[id];
    delete state.runAsk[id];
    delete state.runHist[id];
    delete state.runBusy[followKey({ id: id })];
    delete state.runMsg[followKey({ id: id })];
    state.runGone[id] = Date.now();
    forgetBoxes(id);
    syncRunPoll();
  }

  function mergeRuns(fetched) {
    var out = fetched.filter(function (r) {
      var gone = state.runGone[r.id];
      if (gone && Date.now() - gone < 30000) return false;
      delete state.runGone[r.id];
      return true;
    });
    Object.keys(state.fresh.runs).forEach(function (id) {
      var f = state.fresh.runs[id];
      var at = -1;
      out.forEach(function (r, i) { if (String(r.id) === id) at = i; });
      var caughtUp = at >= 0 && (Date.parse(out[at].updated_at) || 0) >= (Date.parse(f.row.updated_at) || 0);
      if (caughtUp || Date.now() - f.at > 30000) { delete state.fresh.runs[id]; return; }
      if (at >= 0) out[at] = f.row; else out.push(f.row);
    });
    return sortRuns(out);
  }

  // Reads only the runs (for the live update and the 8-second check). Draws again only when something changed.
  async function loadRuns() {
    if (state.loadingRuns) { state.runsAgain = true; return; }
    state.loadingRuns = true;
    try {
      var res = await sb.from("runs").select(RUN_COLUMNS).order("created_at", { ascending: false }).limit(50);
      if (!res.error) {
        var next = mergeRuns(res.data || []);
        var changed = JSON.stringify(next) !== JSON.stringify(state.runs);
        state.runs = next;
        syncRunPoll();
        if (changed) render();
      }
    } catch (_) { /* the next read tries again */ }
    state.loadingRuns = false;
    if (state.runsAgain) { state.runsAgain = false; loadRuns(); }
  }

  function loadRunsSoon() {
    clearTimeout(state.runTimer);
    state.runTimer = setTimeout(loadRuns, 250);
  }

  // While a run is waiting or working, read the runs every 8 seconds (the live update is the main way; this is the safety net).
  function syncRunPoll() {
    var active = state.runs.some(function (r) { return r.status === "queued" || r.status === "working"; });
    var want = started && active;
    if (want && !runPoll) runPoll = setInterval(function () { if (started && !document.hidden) loadRuns(); }, 8000);
    else if (!want && runPoll) { clearInterval(runPoll); runPoll = null; }
  }

  // ----- talking to run-control -----

  // One call. A second press while one is on its way does nothing. Returns true when it worked; otherwise the
  // function's own words are kept for the place that asked (state.runMsg[key]).
  async function runCall(key, action, body) {
    if (state.runBusy[key]) return false;
    state.runBusy[key] = action;
    delete state.runMsg[key];
    render();
    var ok = false;
    var words = RUN_FAIL;
    try {
      var res = await sb.functions.invoke("run-control", { body: body });
      var data = res && !res.error ? res.data : null;
      if (data && data.ok === true && (action === "discard" || (data.run && typeof data.run === "object"))) {
        ok = true;
        if (action === "discard") dropRun(body.run_id);
        else storeRun(data.run);
      } else {
        words = (await failureWords(res, RUN_FAIL)).words;
      }
    } catch (_) { /* told below */ }
    delete state.runBusy[key];
    if (!ok) state.runMsg[key] = words;
    render();
    return ok;
  }

  function trimmed(text) { return String(text || "").trim(); }

  // Writes (or rewrites) the plan of a task. `run` is its planned run, if it has one.
  function planTask(taskId, run, note) {
    state.planOpen[taskId] = true;
    var body = { action: "plan", task_id: taskId };
    if (trimmed(note)) body.note = trimmed(note);
    return runCall(run ? runKey(run) : taskKey(taskId), run ? "rewrite" : "plan", body);
  }

  async function startRun(run, text) {
    var body = { action: "start", run_id: run.id };
    if (trimmed(text)) body.instructions = trimmed(text);
    if (await runCall(runKey(run), "start", body)) {
      if (run.task_id !== null && run.task_id !== undefined) delete state.planOpen[run.task_id];
      forgetBoxes(run.id);
      toast("Started. You can follow it in Work.");
      render();
    }
  }

  async function answerRun(run, text) {
    if (!trimmed(text)) return;
    if (await runCall(runKey(run), "answer", { action: "answer", run_id: run.id, text: trimmed(text) })) {
      forgetBoxes(run.id);
      render();
    }
  }

  async function askFollowUp(run, text) {
    if (!trimmed(text)) return;
    if (await runCall(followKey(run), "follow_up", { action: "follow_up", run_id: run.id, text: trimmed(text) })) {
      forgetBoxes(run.id);
      render();
    }
  }

  function stopRun(run) {
    return runCall(runKey(run), "stop", { action: "stop", run_id: run.id });
  }

  async function discardRun(run) {
    delete state.runAsk[run.id];
    if (await runCall(runKey(run), "discard", { action: "discard", run_id: run.id })) {
      if (run.task_id !== null && run.task_id !== undefined) delete state.planOpen[run.task_id];
      render();
    }
  }

  // ----- pieces shared by the plan panel and the Work card -----

  // A text box for a run, created once and moved into each new panel.
  function runBox(key, where, labelText, placeholder) {
    var id = key + "|" + where;
    var ta = runBoxes[id];
    if (!ta) {
      ta = document.createElement("textarea");
      ta.className = "run-text";
      ta.id = "run-text-" + (++runBoxCount);
      ta.rows = 3;
      ta.maxLength = 8000;
      ta.spellcheck = true;
      ta.addEventListener("input", function () { if (ta._refresh) ta._refresh(); });
      runBoxes[id] = ta;
    }
    ta.placeholder = placeholder || "";
    ta.setAttribute("aria-label", labelText);
    ta._refresh = null;
    return ta;
  }

  function boxWithLabel(parent, ta, text) {
    var lab = el("label", "owed-head", text);
    lab.htmlFor = ta.id;
    parent.appendChild(lab);
    parent.appendChild(ta);
  }

  // The steps of a plan or of a running run. Each carries its state in words for a screen reader.
  function stepsList(steps) {
    var ol = el("ol", "run-steps");
    steps.forEach(function (s, i) {
      var st = RUN_MARK[s.state] ? s.state : "todo";
      var li = el("li", "run-step is-" + st);
      li.appendChild(el("span", "run-mark", RUN_MARK[st] || (i + 1) + "."));
      if (RUN_MARK_WORDS[st]) li.appendChild(el("span", "run-sr", RUN_MARK_WORDS[st]));
      li.appendChild(el("span", "run-step-text", s.text));
      ol.appendChild(li);
    });
    return ol;
  }

  function planSteps(run) {
    return (Array.isArray(runPlan(run).steps) ? runPlan(run).steps : []).filter(function (s) { return s && typeof s.text === "string" && s.text.trim(); });
  }

  function bulletList(items) {
    var ul = el("ul", "run-list");
    items.forEach(function (t) { ul.appendChild(el("li", null, t)); });
    return ul;
  }

  // ----- the text a run writes -----
  // A small, strict reader for the light format the run result uses: "## " heading, "- " bullets, **bold**, [name](https://...).
  // It builds elements and text nodes only. Anything it does not know (HTML, other markdown, unbalanced marks) stays as text.

  // The words of a result without the marks, for search.
  function richPlain(text) {
    if (typeof text !== "string") return "";
    return text.replace(/\[([^\[\]]*)\]\(([^()\s]*)\)/g, "$1").replace(/\*\*/g, "").replace(/^(## |- )/gm, "");
  }

  function richLink(parent, label, url) {
    var href = httpsLink(String(url).trim());
    if (!href) { parent.appendChild(document.createTextNode(label)); return; }
    var a = linkTo(href, label, "rt-link");
    a.title = F.host(href);
    try {
      var u = new URL(href);
      if (u.hostname === "www.google.com" && u.pathname.indexOf("/maps") === 0) a.className = "rt-link rt-map";
    } catch (_) { /* no marker */ }
    parent.appendChild(a);
  }

  function richInline(parent, s, inBold) {
    var text = "";
    var flush = function () { if (text) { parent.appendChild(document.createTextNode(text)); text = ""; } };
    var i = 0;
    while (i < s.length) {
      var ch = s.charAt(i);
      if (ch === "*" && s.charAt(i + 1) === "*" && !inBold) {
        var end = s.indexOf("**", i + 2);
        if (end > i + 2) {
          flush();
          var strong = document.createElement("strong");
          richInline(strong, s.slice(i + 2, end), true);
          parent.appendChild(strong);
          i = end + 2;
          continue;
        }
      } else if (ch === "[") {
        var close = s.indexOf("]", i + 1);
        if (close > i + 1 && s.charAt(close + 1) === "(" && s.slice(i + 1, close).indexOf("[") < 0) {
          // The address runs to the matching ")" (an address may hold pairs of brackets) and holds no space.
          var depth = 1;
          var stop = close + 2;
          while (stop < s.length && depth > 0 && !/\s/.test(s.charAt(stop))) {
            if (s.charAt(stop) === "(") depth++;
            else if (s.charAt(stop) === ")") depth--;
            if (depth > 0) stop++;
          }
          if (depth === 0) {
            flush();
            richLink(parent, s.slice(i + 1, close), s.slice(close + 2, stop));
            i = stop + 1;
            continue;
          }
        }
      }
      text += ch;
      i++;
    }
    flush();
  }

  // Lines of one paragraph, with the line breaks kept.
  function richLines(parent, lines) {
    lines.forEach(function (line, n) {
      if (n) parent.appendChild(document.createElement("br"));
      richInline(parent, line, false);
    });
  }

  function renderRichText(text) {
    var frag = document.createDocumentFragment();
    if (typeof text !== "string" || !text) return frag;
    try {
      var lines = text.replace(/\r\n?/g, "\n").split("\n");
      var para = [];
      var list = null;
      var endPara = function () {
        if (para.length) { var p = document.createElement("p"); richLines(p, para); frag.appendChild(p); para = []; }
      };
      lines.forEach(function (raw) {
        var line = raw.replace(/\s+$/, "");
        if (!line.trim()) { endPara(); list = null; return; }
        if (line.indexOf("## ") === 0 && line.slice(3).trim()) {
          endPara(); list = null;
          var h = document.createElement("h4");
          h.className = "rt-h";
          richInline(h, line.slice(3).trim(), false);
          frag.appendChild(h);
        } else if (line.indexOf("- ") === 0 && line.slice(2).trim()) {
          endPara();
          if (!list) { list = document.createElement("ul"); list.className = "rt-list"; frag.appendChild(list); }
          var li = document.createElement("li");
          richInline(li, line.slice(2).trim(), false);
          list.appendChild(li);
        } else {
          list = null;
          para.push(line);
        }
      });
      endPara();
    } catch (_) {
      frag = document.createDocumentFragment();
      var p = document.createElement("p");
      p.textContent = text;
      frag.appendChild(p);
    }
    return frag;
  }

  function richBox(text, className) {
    var box = el("div", "rich " + (className || ""));
    box.appendChild(renderRichText(text));
    return box;
  }

  // The drafts a run wrote for you to send or paste yourself: each with its label, the whole text and Copy.
  function runDrafts(run) {
    return draftList(run.drafts);
  }

  function draftList(value) {
    return (Array.isArray(value) ? value : []).map(function (d) {
      var t = d && typeof d.text === "string" ? d.text : "";
      if (!t.trim()) return null;
      return { label: typeof d.label === "string" && d.label.trim() ? d.label.trim() : "Draft", text: t };
    }).filter(Boolean);
  }

  function draftsBlock(box, drafts, keyBase) {
    if (!drafts.length) return;
    box.appendChild(label("Drafts"));
    drafts.forEach(function (d, n) {
      var key = keyBase + ":" + n;
      var wrap = el("div", "run-draft");
      var head = el("div", "run-draft-head");
      head.appendChild(el("span", "run-draft-label", d.label));
      var pre = el("pre", "run-draft-text", d.text);
      var mark = state.copied[key];
      var copy = button(mark === "done" ? "Copied" : mark === "select" ? "Selected, now copy it" : "Copy", "btn", function () { copyDraft(key, pre, d.text); });
      copy.setAttribute("aria-label", "Copy draft: " + d.label);
      head.appendChild(copy);
      wrap.appendChild(head);
      wrap.appendChild(pre);
      box.appendChild(wrap);
    });
  }

  // One earlier answer: its date, what you asked, the result and its drafts.
  function earlierAnswer(run, entry, n) {
    var wrap = el("div", "run-earlier");
    var when = entry && typeof entry.finished_at === "string" ? noteDate(entry.finished_at) : "";
    wrap.appendChild(el("p", "run-earlier-head", when ? "Answer of " + when : "Earlier answer"));
    var asked = entry && typeof entry.asked === "string" ? entry.asked.trim() : "";
    if (asked) wrap.appendChild(el("blockquote", "run-asked", asked));
    var result = entry && typeof entry.result === "string" ? entry.result : "";
    if (result.trim()) wrap.appendChild(richBox(result, "run-result"));
    else wrap.appendChild(el("p", "fine", "It did not write a result."));
    draftsBlock(wrap, draftList(entry && entry.drafts), "rd:" + run.id + ":h" + n);
    return wrap;
  }

  function historyOf(run) {
    return (Array.isArray(run.history) ? run.history : []).filter(function (h) { return h && typeof h === "object"; });
  }

  function earlierFold(run, list) {
    var fold = el("details", "run-earlier-fold");
    fold.setAttribute("data-earlier", run.id);
    fold.appendChild(el("summary", null, "Earlier answers (" + list.length + ")"));
    var inner = foldIn(fold);
    list.forEach(function (h) { inner.appendChild(earlierAnswer(run, h, list.indexOf(h))); });
    fold.open = !!state.runHist[run.id];
    fold.addEventListener("toggle", function () {
      if (fold.open) state.runHist[run.id] = true; else delete state.runHist[run.id];
    });
    return fold;
  }

  // "Ask a follow-up": the suggestions as chips (they fill the box, they send nothing), the box and Ask.
  function followUpBlock(box, run) {
    var key = followKey(run);
    var busy = !!state.runBusy[key];
    var wrap = el("div", "run-follow");
    wrap.setAttribute("data-follow", run.id);
    var ta = runBox(runKey(run), "followup", "Ask a follow-up", "What should it look at next, or change?");
    wrap.appendChild(el("p", "owed-head", "Ask a follow-up"));
    var ideas = textList(run.follow_ups).slice(0, 6);
    if (ideas.length) {
      var chips = el("div", "run-ideas");
      ideas.forEach(function (t) {
        var c = button(t, "chip idea", function () {
          ta.value = t;
          if (ta._refresh) ta._refresh();
          ta.focus();
        });
        c.disabled = busy;
        chips.appendChild(c);
      });
      wrap.appendChild(chips);
    }
    ta.readOnly = busy;
    wrap.appendChild(ta);
    runStatusLine(wrap, key);
    var ask = button("Ask", "primary", function () { askFollowUp(run, ta.value); });
    var refresh = function () { ask.disabled = busy || !trimmed(ta.value); };
    ta._refresh = refresh;
    refresh();
    var actions = el("div", "actions");
    actions.appendChild(ask);
    wrap.appendChild(actions);
    box.appendChild(wrap);
  }

  // What the plan says: summary, steps, what it will look at, what you get, and what it cannot do.
  function planBody(box, run) {
    var plan = runPlan(run);
    var size = RUN_SIZE[plan.complexity];
    if (size) {
      var tags = el("p", "run-tags");
      tags.appendChild(el("span", "kind", size));
      box.appendChild(tags);
    }
    if (typeof plan.summary === "string" && plan.summary.trim()) box.appendChild(el("p", "gist pre", plan.summary.trim()));
    var steps = planSteps(run);
    if (steps.length) { box.appendChild(label("Steps")); box.appendChild(stepsList(steps)); }
    var reads = textList(plan.reads);
    if (reads.length) { box.appendChild(label("It will look at")); box.appendChild(bulletList(reads)); }
    var gets = textList(plan.produces);
    if (gets.length) { box.appendChild(label("You get")); box.appendChild(bulletList(gets)); }
    var cannot = textList(plan.cannot);
    if (cannot.length) {
      var warn = el("div", "run-cannot");
      warn.setAttribute("role", "note");
      warn.appendChild(el("p", "owed-head", "It cannot do this part"));
      warn.appendChild(bulletList(cannot));
      box.appendChild(warn);
    }
  }

  // The line that says what is on its way, or what went wrong, for one key.
  function runStatusLine(box, key) {
    var busy = state.runBusy[key];
    if (busy) {
      var p = el("p", "run-busy", RUN_BUSY[busy] || "Working...");
      p.setAttribute("role", "status");
      box.appendChild(p);
    } else if (state.runMsg[key]) {
      var e = el("p", "error run-error", state.runMsg[key]);
      e.setAttribute("role", "alert");
      box.appendChild(e);
    }
  }

  // Discard with a second click: "Discard", then "Discard this run?" with a confirm button.
  function discardControl(run, actions, busy) {
    if (state.runAsk[run.id] && !busy) {
      actions.appendChild(el("span", "note-ask", "Discard this run?"));
      actions.appendChild(button("Yes, discard", "btn", function () { discardRun(run); }));
      actions.appendChild(button("Keep", "btn subtle", function () { delete state.runAsk[run.id]; render(); }));
      return;
    }
    var d = button("Discard", "btn subtle", function () { state.runAsk[run.id] = true; render(); });
    d.disabled = !!busy;
    actions.appendChild(d);
  }

  // For a planned run: the box for corrections, Start, Rewrite plan and Discard. One function for the task's plan
  // panel and the Work card. `withStop` adds Stop (Work card only).
  function plannedControls(box, run, where, withStop) {
    var key = runKey(run);
    var busy = state.runBusy[key];
    var ta = runBox(key, where, "Add or correct anything", "Anything it should do differently, or know before it starts");
    boxWithLabel(box, ta, "Add or correct anything");
    ta.readOnly = !!busy;
    runStatusLine(box, key);
    var actions = el("div", "actions");
    var go = button("Start", "primary", function () { startRun(run, ta.value); });
    go.disabled = !!busy;
    actions.appendChild(go);
    if (run.task_id !== null && run.task_id !== undefined) {
      var again = button("Rewrite plan", "btn", function () { planTask(run.task_id, run, ta.value); });
      again.disabled = !!busy;
      actions.appendChild(again);
    }
    discardControl(run, actions, busy);
    if (withStop) {
      var stop = button("Stop", "btn subtle", function () { stopRun(run); });
      stop.disabled = !!busy;
      actions.appendChild(stop);
    }
    box.appendChild(actions);
  }

  // ----- the plan on a task -----

  function planPanelShown(task) {
    if (activeRunOf(task.id) || !state.planOpen[task.id]) return false;
    return !!plannedRunOf(task.id) || !!state.runBusy[taskKey(task.id)] || !!state.runMsg[taskKey(task.id)];
  }

  // The button on a task: "Plan", "Show plan" when a plan is already written, "Open run" while the Desk is on it.
  function planControl(task, className) {
    var live = activeRunOf(task.id);
    var planned = plannedRunOf(task.id);
    var b;
    if (live) {
      b = button("Open run", className, function () { goToRun(live); });
    } else {
      if (planPanelShown(task)) return null;
      b = button(planned ? "Show plan" : "Plan", className, function () {
        if (planned) { state.planOpen[task.id] = true; render(); } else planTask(task.id, null, "");
      });
    }
    b.setAttribute("data-plan", taskKey(task.id));
    return b;
  }

  function planPanel(task, where) {
    if (!planPanelShown(task)) return null;
    var run = plannedRunOf(task.id);
    var panel = el("div", "fold-body start-panel run-plan");
    panel.setAttribute("data-plan-panel", taskKey(task.id));
    if (!run) {
      // The first plan is being written, or it failed.
      var key = taskKey(task.id);
      runStatusLine(panel, key);
      if (!state.runBusy[key]) {
        var actions = el("div", "actions");
        actions.appendChild(button("Try again", "btn", function () { planTask(task.id, null, ""); }));
        actions.appendChild(button("Close", "btn subtle", function () { delete state.planOpen[task.id]; delete state.runMsg[key]; render(); }));
        panel.appendChild(actions);
      }
      return panel;
    }
    planBody(panel, run);
    plannedControls(panel, run, where, false);
    if (!state.runBusy[runKey(run)]) {
      var foot = el("div", "actions");
      foot.appendChild(button("Hide", "btn subtle", function () { delete state.planOpen[task.id]; render(); }));
      panel.appendChild(foot);
    }
    return panel;
  }

  // Jumps to a run in Work and opens it.
  function goToRun(run) {
    clearSearch();
    state.view = "work";
    if (state.filter !== "all" && state.filter !== run.space) {
      state.filter = "all";
      writePref("desk.space", "all");
    }
    state.runOpen[run.id] = true;
    markSeen(run.id);
    render();
    var card = onPage('[data-run="' + run.id + '"]');
    window.scrollTo(0, 0);
    if (!card) return;
    card.scrollIntoView({ block: "center", behavior: calm ? "auto" : "smooth" });
    card.classList.add("flash");
    setTimeout(function () { card.classList.remove("flash"); }, 2200);
  }

  // ----- Work -----

  // The activity of a run, read when its fold is first opened (again only if the run moved on while it was working).
  async function ensureEvents(run, force) {
    var cur = state.runEvents[run.id];
    if (cur && cur.loading) return;
    if (cur && !cur.error) {
      if (!RUN_ACTIVE[run.status] || cur.stamp === run.updated_at) return;
    } else if (cur && !force) {
      return;
    }
    var entry = { rows: cur ? cur.rows : null, loading: true, error: "", stamp: run.updated_at };
    state.runEvents[run.id] = entry;
    try {
      var res = await sb.from("run_events").select("id, run_id, at, kind, text, model, cost_usd").eq("run_id", run.id).order("id", { ascending: true }).limit(200);
      if (res.error) entry.error = "The activity could not be loaded.";
      else entry.rows = res.data || [];
    } catch (_) {
      entry.error = "The activity could not be loaded.";
    }
    entry.loading = false;
    render();
  }

  function activityFold(run) {
    var fold = el("details", "run-activity");
    fold.appendChild(el("summary", null, "Activity"));
    var inner = foldIn(fold);
    var cur = state.runEvents[run.id];
    if (!cur || (cur.loading && !cur.rows)) {
      var wait = el("p", "fine", "Loading...");
      wait.setAttribute("role", "status");
      inner.appendChild(wait);
    } else if (cur.error) {
      var bad = el("p", "error", cur.error);
      bad.setAttribute("role", "alert");
      inner.appendChild(bad);
    } else if (!cur.rows.length) {
      inner.appendChild(el("p", "empty", "Nothing yet."));
    } else {
      var ul = el("ul", "run-events");
      cur.rows.forEach(function (ev) {
        var li = el("li", "run-event run-ev-" + (typeof ev.kind === "string" ? ev.kind.replace(/[^a-z_]/g, "") : "note"));
        li.appendChild(el("span", "run-ev-time", eventTime(ev.at)));
        li.appendChild(el("span", "run-ev-text", ev.text === null || ev.text === undefined ? "" : String(ev.text)));
        ul.appendChild(li);
      });
      inner.appendChild(ul);
    }
    fold.open = !!state.runAct[run.id];
    fold.addEventListener("toggle", function () {
      if (fold.open) { state.runAct[run.id] = true; ensureEvents(run, true); } else delete state.runAct[run.id];
    });
    if (state.runAct[run.id]) ensureEvents(run, false);
    return fold;
  }

  // What the card shows when you open it.
  function runDetails(run) {
    var box = el("div", "run-open");
    var key = runKey(run);
    var busy = state.runBusy[key] || state.runBusy[followKey(run)];
    var steps = planSteps(run);
    var history = historyOf(run);
    var following = RUN_ACTIVE[run.status] && history.length > 0;
    if (following) {
      box.appendChild(label("The answer you are following up on"));
      box.appendChild(earlierAnswer(run, history[history.length - 1], history.length - 1));
    }
    if (run.status === "planned") {
      planBody(box, run);
    } else if (steps.length) {
      box.appendChild(label("Steps"));
      box.appendChild(stepsList(steps));
    }

    if (run.status === "needs_you") {
      var q = run.pending && run.pending.kind === "question" && typeof run.pending.text === "string" ? run.pending.text.trim() : "";
      box.appendChild(label("It is asking you"));
      box.appendChild(el("p", "gist pre run-question", q || "It is waiting for you."));
      var ta = runBox(key, "work", "Your answer", "Write your answer");
      boxWithLabel(box, ta, "Your answer");
      ta.readOnly = !!busy;
      runStatusLine(box, key);
      var answer = button("Answer", "primary", function () { answerRun(run, ta.value); });
      var refresh = function () { answer.disabled = !!busy || !trimmed(ta.value); };
      ta._refresh = refresh;
      refresh();
      var ask = el("div", "actions");
      ask.appendChild(answer);
      box.appendChild(ask);
    }

    var result = typeof run.result === "string" ? run.result : "";
    if (run.status === "failed") {
      box.appendChild(label("What went wrong"));
      box.appendChild(el("p", "error run-error pre", trimmed(run.error) || "It stopped without saying why."));
    }
    if (result.trim()) {
      box.appendChild(label(run.status === "done" ? "Result" : "What it had so far"));
      box.appendChild(richBox(result, "gist run-result"));
    }
    draftsBlock(box, runDrafts(run), "rd:" + run.id);
    var flags = textList(run.flags);
    if (flags.length) { box.appendChild(label("Check these")); box.appendChild(bulletList(flags)); }
    var links = (Array.isArray(run.outputs) ? run.outputs : []).map(function (o) {
      var href = o && typeof o.url === "string" ? httpsLink(o.url.trim()) : null;
      return href ? { href: href, label: typeof o.label === "string" && o.label.trim() ? o.label.trim() : F.host(href) } : null;
    }).filter(Boolean);
    if (links.length) {
      box.appendChild(label("Links"));
      var chips = el("p", "plan-links");
      links.forEach(function (l) { chips.appendChild(linkTo(l.href, l.label + " ↗", "chip")); });
      box.appendChild(chips);
    }
    if (trimmed(run.instructions)) {
      box.appendChild(label("What you told it"));
      box.appendChild(el("p", "gist pre", run.instructions));
    }

    if (run.status === "done") followUpBlock(box, run);
    var older = following ? history.slice(0, -1) : history;
    if (older.length) box.appendChild(earlierFold(run, older));
    box.appendChild(activityFold(run));

    if (run.status === "planned") {
      plannedControls(box, run, "work", true);
    } else {
      if (run.status !== "needs_you") runStatusLine(box, key);
      var actions = el("div", "actions");
      if (RUN_ACTIVE[run.status]) {
        var stop = button("Stop", "btn subtle", function () { stopRun(run); });
        stop.disabled = !!busy;
        actions.appendChild(stop);
      } else {
        discardControl(run, actions, busy);
      }
      box.appendChild(actions);
    }
    return box;
  }

  function runCard(run) {
    var node = el("article", "card run run-" + run.status);
    node.setAttribute("data-run", run.id);
    var top = el("div", "card-top");
    top.appendChild(el("span", "tag tag-" + run.space, spaceLabel(run.space)));
    top.appendChild(el("span", "pill run-st-" + run.status, RUN_STATUS[run.status] || String(run.status)));
    top.appendChild(el("span", "meta run-cost", money(run.cost_usd)));
    var finished = !RUN_ACTIVE[run.status] && run.status !== "planned";
    if (finished) {
      var secs = took(run);
      if (secs) top.appendChild(el("span", "meta", "took " + secs));
      if (run.finished_at) top.appendChild(el("span", "meta", ago(run.finished_at)));
    }
    node.appendChild(top);
    node.appendChild(el("h3", "title", run.title || "Untitled run"));
    if ((run.status === "working" || run.status === "queued") && trimmed(run.current_step)) node.appendChild(el("p", "reason run-step-line", trimmed(run.current_step)));

    var fold = el("details", "message run-fold");
    fold.appendChild(el("summary", null, "Details"));
    foldIn(fold).appendChild(runDetails(run));
    fold.open = !!state.runOpen[run.id];
    fold.addEventListener("toggle", function () {
      if (fold.open) { state.runOpen[run.id] = true; markSeen(run.id); renderCoverWork(); } else delete state.runOpen[run.id];
    });
    node.appendChild(fold);
    return node;
  }

  function runGroup(id, name, rows) {
    var box = el("div", "tsec");
    box.setAttribute("data-group", id);
    var head = el("div", "tsec-head");
    head.appendChild(el("h3", "tsec-name", name));
    head.appendChild(el("span", "count", String(rows.length)));
    box.appendChild(head);
    var body = el("div", "tsec-body run-list-body");
    rows.forEach(function (r) { body.appendChild(runCard(r)); });
    box.appendChild(body);
    return box;
  }

  // The Work view; returns how many runs it shows.
  function renderWork() {
    var list = $("list-work");
    list.textContent = "";
    var mine = state.runs.filter(inFilter);
    var now = new Date();
    var month = mine.filter(function (r) {
      var d = new Date(r.created_at);
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    });
    var cost = 0;
    month.forEach(function (r) { cost += Number(r.cost_usd) || 0; });
    $("work-month").textContent = "This month: " + money(cost) + " across " + month.length + (month.length === 1 ? " run" : " runs");

    var shown = needles.length ? mine.filter(function (r) { return hit(runParts(r)); }) : mine;
    var newestFirst = function (a, b) { return (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0); };
    var needs = shown.filter(function (r) { return r.status === "needs_you"; }).sort(newestFirst);
    var rank = { working: 0, queued: 1, planned: 2 };
    var going = shown.filter(function (r) { return rank[r.status] !== undefined; }).sort(function (a, b) {
      return rank[a.status] - rank[b.status] || newestFirst(a, b);
    });
    var done = shown.filter(function (r) { return r.status === "done" || r.status === "failed" || r.status === "stopped"; }).sort(function (a, b) {
      return (Date.parse(b.finished_at || b.updated_at) || 0) - (Date.parse(a.finished_at || a.updated_at) || 0);
    }).slice(0, 20);
    if (needs.length) list.appendChild(runGroup("needs", "Needs you", needs));
    if (going.length) list.appendChild(runGroup("going", "In progress", going));
    if (done.length) list.appendChild(runGroup("done", "Finished", done));
    var count = needs.length + going.length + done.length;
    if (!count && !needles.length) list.appendChild(el("p", "empty", "Nothing is running. Press Plan on a task to have the Desk do it in the background."));
    return count;
  }

  // ----- Today -----

  // Runs that need you or are on their way, and runs that finished in the last 24 hours that you have not opened yet.
  function coverRuns() {
    var cutoff = Date.now() - DAY;
    var rank = { needs_you: 0, working: 1, queued: 2 };
    return state.runs.filter(function (r) {
      if (!inFilter(r) || !hit(runParts(r))) return false;
      if (RUN_ACTIVE[r.status]) return true;
      if (r.status !== "done" && r.status !== "failed") return false;
      return (Date.parse(r.finished_at || r.updated_at) || 0) >= cutoff && !state.runSeen[r.id];
    }).sort(function (a, b) {
      var ra = rank[a.status] === undefined ? 3 : rank[a.status];
      var rb = rank[b.status] === undefined ? 3 : rank[b.status];
      return ra - rb || (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0);
    });
  }

  function renderCoverWork() {
    var box = $("cv-work");
    var rows = coverRuns();
    box.hidden = !rows.length;
    box.textContent = "";
    if (!rows.length) return 0;
    var head = el("div", "tsec-head");
    head.appendChild(el("h2", "tsec-name", "Work in progress"));
    head.appendChild(el("span", "count", String(rows.length)));
    box.appendChild(head);
    var body = el("div", "tsec-body cv-pad");
    var ul = el("ul", "cv-runs");
    rows.slice(0, 6).forEach(function (r) {
      var li = el("li", "cv-run");
      li.setAttribute("data-cover-run", r.id);
      li.appendChild(button(r.title || "Untitled run", "ref cv-ref", function () { goToRun(r); }));
      li.appendChild(el("span", "pill run-st-" + r.status, RUN_STATUS[r.status] || String(r.status)));
      if (r.status === "working" && trimmed(r.current_step)) li.appendChild(el("span", "cv-step", trimmed(r.current_step)));
      ul.appendChild(li);
    });
    body.appendChild(ul);
    box.appendChild(body);
    coverFoot(box, "All work", "work");
    return Math.min(rows.length, 6);
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
        sb.from("projects").select("id, space, name, kind, parent_id, open_now, is_plan, what, stage, depends_on, next_step, target_on, people, tools, links, standing, review, reviewed_at, updated_at").eq("status", "active").order("name").limit(1000),
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
        sb.from("runs").select(RUN_COLUMNS).order("created_at", { ascending: false }).limit(50),
        sb.from("quick_links").select("id, space, label, url, position, created_at").order("space", { ascending: true }).order("position", { ascending: true }).order("id", { ascending: true }),
        sb.from("project_changes").select(CHANGE_COLS).gte("changed_on", localDay(new Date(Date.now() - CHANGE_DAYS * DAY)))
          .order("changed_on", { ascending: false }).order("created_at", { ascending: false }).limit(400),
        sb.from("key_dates").select(KD_COLS)
          .or('status.in.(proposed,open),and(status.eq.done,done_at.gte."' + new Date(Date.now() - KD_DONE_DAYS * DAY).toISOString() + '")')
          .order("on_date", { ascending: true }).limit(1000),
      ]);
      var failed = results.slice(0, 9).filter(function (r) { return r.error; })[0];
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
      // The runs are extra: if they cannot be read the rest of the Desk still loads, with the runs it had.
      if (!results[9].error) state.runs = mergeRuns(results[9].data || []);
      // The links are extra too: if they cannot be read the rest of the Desk still loads.
      if (!results[10].error) state.links = results[10].data || [];
      else if (state.view === "links") notice("The links could not be read: " + results[10].error.message);
      // The change log is extra too.
      if (!results[11].error) state.changes = results[11].data || [];
      else if (state.view === "projects") notice("The changes could not be read: " + results[11].error.message);
      // The key dates are extra too.
      if (!results[12].error) state.keyDates = results[12].data || [];
      else if (state.view === "today" || state.view === "projects") notice("The key dates could not be read: " + results[12].error.message);
      syncRunPoll();
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
      .on("postgres_changes", { event: "*", schema: "public", table: "project_changes" }, function () { state.log = {}; reloadSoon(); })
      .on("postgres_changes", { event: "*", schema: "public", table: "key_dates" }, reloadSoon)
      .on("postgres_changes", { event: "*", schema: "public", table: "notes" }, reloadSoon)
      .on("postgres_changes", { event: "*", schema: "public", table: "quick_links" }, reloadSoon)
      .on("postgres_changes", { event: "*", schema: "public", table: "cover_reviews" }, reloadSoon)
      .on("postgres_changes", { event: "*", schema: "public", table: "runs" }, loadRunsSoon)
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

  $("plan-add").addEventListener("click", function () { openPlanDialog(null, null); });
  $("pd-space").addEventListener("change", function () { fillParentChoices($("pd-space").value, null, null); });
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
  $("link-form").addEventListener("submit", function (event) { event.preventDefault(); addLink(); });
  $("link-space").addEventListener("change", function () { $("link-error").hidden = true; });
  $("links-edit").addEventListener("click", function () {
    state.linksEditing = !state.linksEditing;
    state.linkAsk = null;
    state.linkEdit = null;
    render();
  });
  window.addEventListener("resize", function () {
    if (state.view === "notes") fitNotes();
    fitDrafts();
  });

  $("alerts").addEventListener("click", function () {
    Notification.requestPermission().then(refreshAlertsButton);
  });

  startLooked();
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
        state.links = [];
        state.linkEdit = null;
        state.linkAsk = null;
        state.linksEditing = false;
        state.covers = [];
        state.starts = [];
        state.runs = [];
        state.runBusy = {};
        state.runMsg = {};
        state.runHist = {};
        state.runEvents = {};
        state.planOpen = {};
        state.changes = [];
        state.log = {};
        state.fix = null;
        state.addLine = null;
        state.keyDates = [];
        state.kdForm = null;
        state.kdEdit = null;
        state.kdAsk = null;
        state.kdMore = {};
        state.openProject = null;
        syncRunPoll();
        state.sendFlow = {};
        state.sent = {};
        state.seen = null;
        show(false);
      }
    }, 0);
  });

  // Safety net if the live connection drops, and to move "Later" items back when their time comes.
  setInterval(function () { if (started && !document.hidden) load(); }, 60000);
  document.addEventListener("visibilitychange", function () {
    if (started && !document.hidden) { markLooked(); load(); }
  });
})();
