// Turns stored message text into something readable. Pure functions, no page access:
// they return plain data (paragraphs of lines of tokens) and the page builds elements from it,
// so message content is never treated as HTML.
(function (root) {
  "use strict";

  var URL_PART = "https?:\\/\\/[^\\s<>\\[\\]()]+";

  // Mail text arrives with CRLF inside paragraphs. "space + CRLF" is a soft wrap.
  function normalise(text) {
    return String(text || "")
      .replace(/(^|\n)-- ?\r\n/g, "$1--\n") // keep the signature marker on its own line
      .replace(/ \r\n/g, " ")
      .replace(/\r\n?/g, "\n");
  }

  function host(url) {
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch (_) { return "link"; }
  }

  function safeUrl(url) {
    try {
      var u = new URL(url);
      return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
    } catch (_) { return null; }
  }

  // ---------- Email ----------

  var HISTORY = [
    /\nOn [^\n]{5,200}\n?[^\n]{0,120}\bwrote:[ \t]*\n/,
    /\nEm [^\n]{5,200}\n?[^\n]{0,120}\bescreveu:[ \t]*\n/,
    /\n-{3,} ?Original Message ?-{3,}/i,
    /\nFrom: [^\n]+\n(Sent|Date): /,
    /\n(>[^\n]*\n){2,}/,
  ];
  var SIGNATURE = [/\n-- ?\n/, /\nSent from my [^\n]+/, /\nGet Outlook for [^\n]+/];
  var FOOTER = /^.*(unsubscribe|why am i receiving|manage (your )?(email |notification )?(preferences|settings)|this (email|message) was sent to|view (this email )?in (your )?browser|you('re| are) receiving this|you have received this (email|message)|update your (email )?preferences).*$/im;

  function cutAt(text, patterns, minIndex) {
    var best = -1;
    patterns.forEach(function (p) {
      var m = p.exec(text);
      if (m && m.index >= minIndex && (best < 0 || m.index < best)) best = m.index;
    });
    return best < 0 ? text : text.slice(0, best);
  }

  // Joins lines that were only broken to fit a line width.
  function unwrap(text) {
    var out = [];
    text.split("\n").forEach(function (line) {
      var prev = out.length ? out[out.length - 1] : null;
      if (prev !== null && prev.length >= 55 && line && !/^(\s*[-*•>|]|\s*\d+[.)]\s|https?:|\[|\()/.test(line) && !/^(https?:|\[https?:)/.test(prev)) {
        out[out.length - 1] = prev + " " + line;
      } else {
        out.push(line);
      }
    });
    return out.join("\n");
  }

  // Returns the part of an email a person actually wrote, without quoted history,
  // signature block, mailing footer and tracking lines.
  function cleanEmail(body) {
    var full = normalise(body).trim();
    var text = "\n" + full + "\n";
    // A forwarded message is the message itself, so its "From: / Date:" header is not history.
    var forwarded = /forwarded message/i.test(text);
    text = cutAt(text, HISTORY.filter(function (p, i) { return !(forwarded && i === 3); }), 2);
    text = cutAt(text, SIGNATURE, 2);
    var f = FOOTER.exec(text);
    if (f && f.index > 150) text = text.slice(0, f.index);
    text = text.split("\n").filter(function (line) {
      var t = line.trim();
      if (/^[A-Za-z0-9+\/_=-]{40,}$/.test(t)) return false; // tracking tokens
      if (/^\[image:[^\]]*\]$/i.test(t)) return false;
      return true;
    }).join("\n");
    text = unwrap(text).replace(/\n{3,}/g, "\n\n").trim();
    if (!text) text = full;
    return { text: text, cut: text.length < full.length - 40, full: full };
  }

  // Splits one line of email text into tokens.
  function emailLine(line) {
    var tokens = [];
    var re = new RegExp("\\[([^\\]\\n]{1,80})\\]\\((" + URL_PART + ")\\)|[\\[(<]\\s*(" + URL_PART + ")\\s*[\\])>]|(" + URL_PART + ")|\\*([^*\\n]{1,200})\\*", "g");
    var last = 0, m;
    while ((m = re.exec(line))) {
      if (m.index > last) tokens.push({ t: "text", v: line.slice(last, m.index) });
      if (m[5] !== undefined) {
        tokens.push({ t: "bold", v: m[5] });
      } else {
        var raw = (m[2] || m[3] || m[4]).replace(/[.,;:!?]+$/, "");
        var href = safeUrl(raw);
        if (href) tokens.push({ t: "link", v: m[1] || null, href: href });
        else tokens.push({ t: "text", v: m[0] });
      }
      last = re.lastIndex;
    }
    if (last < line.length) tokens.push({ t: "text", v: line.slice(last) });
    return tokens;
  }

  function onlyLink(tokens) {
    var links = tokens.filter(function (t) { return t.t === "link"; });
    var words = tokens.filter(function (t) { return t.t !== "link" && t.v.trim(); });
    return links.length === 1 && !words.length ? links[0] : null;
  }

  // Email text -> paragraphs -> lines -> tokens. A link on its own line right after a short
  // line takes that line as its label ("Review draft bill"); a repeated link is shown once.
  function emailBlocks(text) {
    var paragraphs = text.split(/\n{2,}/).map(function (p) {
      return p.split("\n").map(function (l) { return emailLine(l.trim()); });
    });
    var labelled = {};
    paragraphs.forEach(function (lines) {
      for (var i = 1; i < lines.length; i++) {
        var link = onlyLink(lines[i]);
        var prev = lines[i - 1];
        var prevText = prev.length === 1 && prev[0].t === "text" ? prev[0].v.trim() : null;
        if (link && !link.v && prevText && prevText.length <= 40) {
          link.v = prevText;
          labelled[link.href] = true;
          lines.splice(i - 1, 1);
          i--;
        }
      }
    });
    var seen = {};
    var out = [];
    paragraphs.forEach(function (lines) {
      var kept = [];
      lines.forEach(function (tokens) {
        var filtered = tokens.filter(function (t) {
          if (t.t !== "link") return true;
          if (!t.v && labelled[t.href]) return false; // the labelled copy is shown instead
          if (seen[t.href]) return false;
          seen[t.href] = true;
          return true;
        });
        if (filtered.some(function (t) { return t.t === "link" || t.v.trim(); })) kept.push(filtered);
      });
      if (kept.length) out.push(kept);
    });
    return out;
  }

  // ---------- Google Docs comment notices ----------

  function mentions(text, myEmail) {
    return text.replace(/@([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, function (all, local, domain) {
      return (local + "@" + domain).toLowerCase() === myEmail ? "@you" : "@" + local;
    });
  }

  // A notice from Google Docs, Sheets or Slides -> { file, fileUrl, comments: [{ author, anchor, text, url }] }.
  function parseDocNotice(subject, body, myEmail) {
    var text = normalise(body);
    var lines = text.split("\n").map(function (l) { return l.trim(); }).filter(Boolean);
    var file = /following (document|spreadsheet|presentation|file)/i.test(lines[0] || "") && lines[1] ? lines[1].replace(/\s*\(?https?:.*$/, "").trim() : "";
    if (!file) file = subject || "Document";
    var fileUrl = null;
    var first = new RegExp("https:\\/\\/docs\\.google\\.com\\/[^\\s<>\\[\\]()]+").exec(text);
    if (first) {
      try {
        var u = new URL(first[0]);
        if (u.hostname === "docs.google.com") fileUrl = u.origin + u.pathname;
      } catch (_) { /* leave empty */ }
    }
    var comments = [];
    text.split(/\n\.\n/).slice(1).forEach(function (block) {
      var link = /\((https:\/\/docs\.google\.com\/[^\s()]*disco=[^\s()]*)\)/.exec(block);
      var content = block.split(/\n(?:Reply \(|Open ?\n?\(https)/)[0];
      var rows = content.split("\n").map(function (l) { return l.trim(); });
      while (rows.length && !rows[0]) rows.shift();
      var author = rows.shift() || "";
      var anchor = null;
      if (rows.length && /^\| ?/.test(rows[0])) anchor = rows.shift().replace(/^\| ?/, "");
      var said = mentions(rows.join("\n").replace(/\n{3,}/g, "\n\n").trim(), String(myEmail || "").toLowerCase());
      if (!author || !said) return;
      // A thread lists each reply as a paragraph that starts with the person's name on its own line.
      var url = link ? safeUrl(link[1]) : null;
      var current = { author: author, anchor: anchor, text: "", url: null };
      said.split(/\n{2,}/).forEach(function (para) {
        var nl = para.indexOf("\n");
        var head = nl > 0 ? para.slice(0, nl).trim() : "";
        if (current.text && head && head.length <= 40 && /^[A-Z][A-Za-z\u00C0-\u024F'.-]*( [A-Z][A-Za-z\u00C0-\u024F'.-]*){1,3}$/.test(head)) {
          comments.push(current);
          current = { author: head, anchor: null, text: para.slice(nl + 1).trim(), url: null };
        } else {
          current.text += (current.text ? "\n\n" : "") + para;
        }
      });
      current.url = url; // the link opens the whole thread; show it once, after the last reply
      comments.push(current);
    });
    return { file: file, fileUrl: fileUrl, comments: comments };
  }

  // ---------- Slack ----------

  function unescape(s) {
    return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  }

  function styled(text, tokens) {
    var re = /`([^`\n]+)`|\*([^*\n]+)\*|(^|[^A-Za-z0-9])_([^_\n]+)_(?![A-Za-z0-9])/g;
    var last = 0, m;
    while ((m = re.exec(text))) {
      var start = m[4] !== undefined ? m.index + m[3].length : m.index;
      if (start > last) tokens.push({ t: "text", v: unescape(text.slice(last, start)) });
      if (m[1] !== undefined) tokens.push({ t: "code", v: unescape(m[1]) });
      else if (m[2] !== undefined) tokens.push({ t: "bold", v: unescape(m[2]) });
      else tokens.push({ t: "italic", v: unescape(m[4]) });
      last = re.lastIndex;
    }
    if (last < text.length) tokens.push({ t: "text", v: unescape(text.slice(last)) });
  }

  // Slack writes people as <@U123>, channels as <#C123|name> and links as <https://…|label>.
  // names: { person(id) -> name or null, channel(id) -> name or null, me: my user id }
  function slackBlocks(body, names) {
    var text = String(body || "").replace(/\r\n?/g, "\n").trim();
    return text.split(/\n{2,}/).map(function (p) {
      return p.split("\n").map(function (line) {
        var tokens = [];
        var quote = /^&gt; ?/.test(line);
        if (quote) line = line.replace(/^&gt; ?/, "");
        var re = /<([^<>\n]+)>/g;
        var last = 0, m;
        while ((m = re.exec(line))) {
          if (m.index > last) styled(line.slice(last, m.index), tokens);
          var inner = m[1];
          var parts = inner.split("|");
          var target = parts[0], label = parts.slice(1).join("|");
          if (target.charAt(0) === "@") {
            var id = target.slice(1);
            tokens.push({ t: "mention", v: id === names.me ? "@you" : "@" + (names.person(id) || unescape(label) || "someone") });
          } else if (target.charAt(0) === "#") {
            tokens.push({ t: "mention", v: "#" + (unescape(label) || names.channel(target.slice(1)) || "channel") });
          } else if (target.charAt(0) === "!") {
            tokens.push({ t: "mention", v: label ? unescape(label) : "@" + target.slice(1).split("^")[0] });
          } else if (/^https?:/.test(target) && safeUrl(unescape(target))) {
            tokens.push({ t: "link", v: label ? unescape(label) : null, href: safeUrl(unescape(target)) });
          } else if (/^mailto:/.test(target)) {
            tokens.push({ t: "text", v: unescape(label || target.slice(7)) });
          } else {
            tokens.push({ t: "text", v: unescape(m[0]) });
          }
          last = re.lastIndex;
        }
        if (last < line.length) styled(line.slice(last), tokens);
        if (quote) tokens.quote = true;
        return tokens;
      });
    });
  }

  root.DeskFormat = {
    normalise: normalise,
    host: host,
    safeUrl: safeUrl,
    cleanEmail: cleanEmail,
    emailBlocks: emailBlocks,
    parseDocNotice: parseDocNotice,
    slackBlocks: slackBlocks,
  };
})(typeof window !== "undefined" ? window : globalThis);
