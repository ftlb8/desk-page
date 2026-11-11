// Desk page. Reads items from the Desk's database and shows them; nothing else.
// Everything that comes from a message is written with textContent, never as HTML.
(function () {
  "use strict";

  var cfg = window.DESK_CONFIG;
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

  // Slack writes people as <@U123>, channels as <#C123|name> and links as <https://…|label>.
  function plain(space, text) {
    return String(text || "")
      .replace(/<@([A-Z0-9]+)(\|[^>]*)?>/g, function (_m, id) {
        var p = state.people[space + ":" + id];
        return "@" + (p && p.name ? p.name : "someone");
      })
      .replace(/<#([A-Z0-9]+)(?:\|([^>]*))?>/g, function (_m, id, name) {
        var c = state.channels[space + ":" + id];
        return "#" + (name || (c && c.name) || "channel");
      })
      .replace(/<!(here|channel|everyone)(\|[^>]*)?>/g, "@$1")
      .replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, "$2")
      .replace(/<((?:https?|mailto):[^>]+)>/g, "$1")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  }

  function spaceLabel(id) {
    for (var i = 0; i < SPACES.length; i++) if (SPACES[i].id === id) return SPACES[i].label;
    return id;
  }

  function whereLabel(item) {
    var m = item.messages || {};
    if (m.channel_type === "im") return "Direct message";
    if (m.channel_type === "mpim") return "Group message";
    var c = state.channels[item.space + ":" + m.channel_id];
    return "#" + (c && c.name ? c.name : "channel");
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
    if (item.status === "open") return item.lane === "waiting" ? "waiting" : "look";
    if (item.status === "snoozed") {
      if (item.snooze_until && new Date(item.snooze_until).getTime() > Date.now()) return "later";
      return item.lane === "waiting" ? "waiting" : "look"; // its time has come
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

  function closedHow(item) {
    if (item.status === "dismissed") return "Dismissed";
    if (item.closed_by === "reply") return "You replied";
    if (item.closed_by === "reaction") return "You marked it with a check";
    return "Marked done";
  }

  function card(item, kind) {
    var m = item.messages || {};
    var author = state.people[item.space + ":" + m.author_id];
    var node = el("article", "card urgency-" + item.urgency);

    var top = el("div", "card-top");
    top.appendChild(el("span", "tag tag-" + item.space, spaceLabel(item.space)));
    if ((kind === "waiting" || kind === "look") && item.urgency >= 2) {
      top.appendChild(el("span", "flag flag-" + item.urgency, item.urgency === 3 ? "Today" : "Soon"));
    }
    var meta = (author && author.name ? author.name : "Someone") + (author && author.is_vip ? " ★" : "") +
      " · " + whereLabel(item) + " · " + ago(m.occurred_at || item.created_at);
    top.appendChild(el("span", "meta", meta));
    node.appendChild(top);

    node.appendChild(el("h3", "title", item.title));
    if (kind === "closed") {
      node.appendChild(el("p", "reason", closedHow(item) + " · " + ago(item.closed_at)));
    } else if (kind === "later") {
      node.appendChild(el("p", "reason", "Back " + until(item.snooze_until)));
    } else if (item.reason) {
      node.appendChild(el("p", "reason", item.reason));
    }

    if (m.body) {
      var more = el("details", "message");
      more.appendChild(el("summary", null, "Message"));
      more.appendChild(el("p", "body", plain(item.space, m.body)));
      node.appendChild(more);
    }

    var actions = el("div", "actions");
    var link = slackLink(item);
    if (link) {
      var a = el("a", "btn", "Open in Slack");
      a.href = link;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      actions.appendChild(a);
    }
    if (kind === "waiting" || kind === "look") {
      actions.appendChild(button("Done", "btn", function () { act(item.id, "done"); }));
      var later = el("span", "later");
      later.appendChild(button("Later", "btn", function () { later.classList.toggle("open"); }));
      var choices = el("span", "choices");
      laterChoices().forEach(function (c) {
        choices.appendChild(button(c.label, "btn small", function () { act(item.id, "snooze", c.at.toISOString()); }));
      });
      later.appendChild(choices);
      actions.appendChild(later);
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
    var groups = { waiting: [], look: [], later: [], closed: [] };
    var waitingBySpace = {};
    state.items.forEach(function (item) {
      var b = bucket(item);
      if (b === "waiting") waitingBySpace[item.space] = (waitingBySpace[item.space] || 0) + 1;
      if (state.filter !== "all" && item.space !== state.filter) return;
      groups[b].push(item);
    });
    groups.waiting.sort(byPriority);
    groups.look.sort(byPriority);
    groups.later.sort(function (a, b) { return a.snooze_until < b.snooze_until ? -1 : 1; });
    groups.closed.sort(function (a, b) { return a.closed_at > b.closed_at ? -1 : 1; });

    fill("list-waiting", "n-waiting", groups.waiting, "waiting", "Nothing is waiting on you.");
    fill("list-look", "n-look", groups.look, "look", "Nothing else to look at.");
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
          .select("id, space, lane, status, title, reason, urgency, created_at, closed_at, closed_by, snooze_until, messages(channel_id, channel_type, thread_ts, ts, author_id, body, occurred_at)")
          .or('status.in.(open,snoozed),closed_at.gte."' + since + '"')
          .order("created_at", { ascending: false })
          .limit(500),
        sb.from("people").select("space, slack_user_id, name, is_vip").limit(5000),
        sb.from("channels").select("space, slack_channel_id, name, kind").limit(5000),
        sb.from("accounts").select("space, slack_url"),
      ]);
      var failed = results.filter(function (r) { return r.error; })[0];
      if (failed) throw new Error(failed.error.message);

      state.people = index(results[1].data, function (p) { return p.space + ":" + p.slack_user_id; });
      state.channels = index(results[2].data, function (c) { return c.space + ":" + c.slack_channel_id; });
      state.accounts = index(results[3].data, function (a) { return a.space; });
      var items = results[0].data || [];
      announceNew(items);
      state.items = items;

      // The owner can always see the two workspace rows; nobody else can see any.
      notice((results[3].data || []).length ? "" : "This sign-in does not have access to the Desk.");
      render();
      $("updated").textContent = "Updated " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    } catch (err) {
      notice("Could not load the Desk: " + (err && err.message ? err.message : "unknown error") + ". Retrying.");
    } finally {
      state.loading = false;
    }
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
      var m = item.messages || {};
      var author = state.people[item.space + ":" + m.author_id];
      try {
        new Notification((author && author.name ? author.name : "Someone") + " · " + spaceLabel(item.space), {
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
