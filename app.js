/* Fringe Planner - offline-first, no dependencies, no build step. */
(function () {
  "use strict";

  var CACHE_KEY = "fringe-plan-v1";
  var PX_PER_MIN = 0.8;
  /* Minutes of overlap that are NOT a clash - see clashes() in renderDay for
   * why. Module scope because the pixel sizing pass asks the same question
   * about the same two events, and two copies of a threshold is one copy too
   * many. */
  var TOUCH_MIN = 10;
  var plan = null;
  /* Declared up here, not beside the star code, because boot() indexes into it
   * and a `var` initialiser further down the file would still be undefined if
   * boot ever ran first. */
  var publishedStars = {};
  var selectedDay = null;
  /* ⚠️ Book Now defaults to PRIORITY, not urgency, since 2026-08-23. The
   * view's whole job is "what should I book next", and urgency alone answers
   * a narrower question - it ranks a wide-open show he barely wants above a
   * one-chance show he has starred must-see. "Most urgent" is still one tap
   * away, which is the test: the change is reversible by him, not by me. */
  var bookFilter = "today", bookSort = "priority", actSort = "recent";
  /* How he last chose to order the fits inside a gap - "urgency" or "time".
   * Remembered, because his arrangement is the default: the app should not
   * reset to a code default every time he opens a gap. Declared here, beside
   * the other view state, so the key exists before anything reads it. */
  var GAPSORT_KEY = "fringe-gapsort-v1";
  /* ⚠️ Defaults to PRIORITY since 2026-08-23 - the same regret order Book Now
   * uses. Tapping a gap asks "what should I see in this slot", which is the
   * same question, so answering it with raw urgency ranked a wide-open show he
   * barely wants above a must-see that fits. A stored value is a choice he
   * MADE and is respected; only the absence of one takes the new default. */
  var gapSort = "priority";
  try { gapSort = localStorage.getItem(GAPSORT_KEY) || "priority"; } catch (e) {}
  if (["time", "urgency", "priority", "nearby"].indexOf(gapSort) < 0) {
    gapSort = "priority";
  }
  /* ⚠️ "nearby" is NOT remembered. The other three are orderings and outlast a
   * session; this one is a question about right now, and reopening the app
   * tomorrow morning to a list of things that were near him last night would
   * be wrong. It is chosen fresh every time - the same reasoning as which
   * LIST a gap opens on. */
  if (gapSort === "nearby") gapSort = "priority";
  /* ⚠️ Two axes, not one three-way - his call 2026-08-18: "maybe a toggle
   * between discover and favourites, and then that would allow me to also tap
   * between time and urgency for both". WHICH list is deliberately NOT
   * remembered: it is set fresh every time he taps a band, to Favourites
   * unless none of them fit, which is the "defaulting to favourites, unless
   * there are no favourites available" half of the same sentence. The SORT is
   * remembered, as it always was. */
  var gapSource = "favourites";
  /* How much of the Discover ranking is on screen. It grows by the page when
   * he asks for more, and resets whenever he opens a different window or
   * switches back into Discover. His ask, 2026-08-18: the old flat cap of 40
   * was invisible, which is the thing the no-silent-caps rule is about. */
  var DISCOVER_PAGE = 30;
  var discoverShown = DISCOVER_PAGE;

  var $ = function (sel) { return document.querySelector(sel); };
  var el = function (tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  };

  // ------------------------------------------------------------- helpers

  function hhmm(iso) { return iso.slice(11, 16); }

  // He reads times in AM/PM but the Fringe prints 24-hour on every ticket and
  // listing, so both are shown: "7:30 PM (19:30)".
  function ampm(hm) {
    if (!hm) return "";
    var p = String(hm).split(":");
    var h = Number(p[0]), m = p[1] || "00";
    if (isNaN(h)) return hm;
    var suffix = h >= 12 ? "PM" : "AM";
    var h12 = h % 12; if (h12 === 0) h12 = 12;
    return h12 + ":" + m + " " + suffix + " (" + hm + ")";
  }

  function clock(iso) { return ampm(hhmm(iso)); }

  // "Baby Grand at Pleasance Courtyard (Venue 33), 60 Pleasance, Edinburgh EH8
  // 9TJ" is the venue plus a postal address; the row only has room for the bit
  // he navigates by.
  function shortPlace(text) {
    return String(text || "").split(",")[0].replace(/\s*\(Venue [^)]*\)/i, "").trim();
  }

  function dur(mins) {
    var h = Math.floor(mins / 60), m = mins % 60;
    if (h && m) return h + "h " + m + "m";
    if (h) return h + "h";
    return m + "m";
  }

  function longDate(iso) {
    var d = new Date(iso + "T12:00:00+01:00");
    return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  }

  function shortDate(iso) {
    var d = new Date(iso + "T12:00:00+01:00");
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  }

  function urgClass(f) {
    if (f.urgencyLabel === "Going fast") return "fast";
    if (f.urgencyLabel === "Filling up") return "filling";
    return "";
  }

  // ⚠️ "Today" always means today IN EDINBURGH, never on the device. He is in
  // New York until he flies, so from 19:00 EDT onward the two disagree - and a
  // planner that rings the wrong day, or opens on yesterday, is worse than one
  // with no date at all. August is BST, so UTC+1 the whole trip.
  // The "now" line can be pinned to a fixed date and time, to see it before the
  // trip starts. It affects the LINE ONLY - nothing else in the app treats that
  // as the current date. Used once on 2026-08-15 as { date: "2026-08-17",
  // min: 20 * 60 }, and switched off at his request the same day.
  // null = the real clock, which is the normal state.
  var PREVIEW_NOW = null;

  // Minutes since midnight in Edinburgh, wherever he happens to be.
  function edinburghMinutes() {
    var parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hour12: false
    }).formatToParts(new Date());
    var h = 0, m = 0;
    parts.forEach(function (p) {
      if (p.type === "hour") h = Number(p.value);
      if (p.type === "minute") m = Number(p.value);
    });
    return h * 60 + m;
  }

  function todayISO() {
    return new Date(Date.now() + 3600000).toISOString().slice(0, 10);
  }

  /* The FRINGE day, which is the one he is living in.
   *
   * ⚠️ A Fringe day runs 09:00 to 04:00 the next morning, and the codebase says
   * so everywhere except here: the Browse "Today" filter and the timeline's
   * now-line both implement it, while defaultDay and the day ribbons used the
   * raw calendar date. At 01:30 that opened the app on tomorrow - an empty
   * morning, no now-line, and the night he was still standing in sitting one
   * swipe back labelled YESTERDAY, holds and all. Subtracting the 4 hours puts
   * every one of those on the same rule. Audit #3, 2026-08-16. */
  function fringeTodayISO() {
    return new Date(Date.now() + 3600000 - 4 * 3600000)
      .toISOString().slice(0, 10);
  }

  // True only in the small hours, when the two disagree - the one moment the
  // ribbon has to say which day it means.
  function inSmallHours() {
    return fringeTodayISO() !== todayISO();
  }

  // How far away a day is, in the words he would use out loud.
  function daysAway(iso) {
    var a = new Date(iso + "T12:00:00Z").getTime();
    var b = new Date(fringeTodayISO() + "T12:00:00Z").getTime();
    return Math.round((a - b) / 86400000);
  }

  function relDay(iso) {
    var n = daysAway(iso);
    if (n === 0) return inSmallHours() ? "TODAY · TIL 4AM" : "TODAY";
    if (n === 1) return "TOMORROW";
    if (n === -1) return "YESTERDAY";
    if (n > 1) return "IN " + n + " DAYS";
    return Math.abs(n) + " DAYS AGO";
  }

  function relClass(iso) {
    var n = daysAway(iso);
    if (n === 0) return "now";
    if (n < 0) return "past";
    if (n === 1) return "soon";
    return "";
  }

  // Today, but clamped into the trip so the app is useful before departure.
  function defaultDay() {
    var today = fringeTodayISO();
    var dates = plan.days.map(function (d) { return d.date; });
    if (dates.indexOf(today) >= 0) return today;
    return today < dates[0] ? dates[0] : dates[dates.length - 1];
  }

  // --------------------------------------------------------------- load

  // ⚠️ Two different ages, and conflating them would mislead him: the SCAN is
  // when EdFringe was last read, the SYNC is when a full run last finished
  // (including sending his holds). He asked for the sync.
  function showLastSync() {
    var line = $("#lastsync");
    if (!line) return;
    var scanned = plan && plan.sourceScanAt;
    var bits = [];
    if (scanned) bits.push("scanned " + when(scanned));
    var show = function () {
      line.textContent = bits.join(" · ");
      // Never fight the badge for the slot: it wins while a sync is running.
      line.hidden = !bits.length || !$("#syncbadge").hidden;
    };
    if (!isLocal()) { show(); return; }
    fetch("data/last-sync.json", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (d && d.at) {
          /* ⚠️ A light run must not claim to be a full one. `full:false` is
           * the calendar-only button, and labelling it "full sync 1 min ago"
           * beside "scanned 6 h ago" would be the app contradicting itself
           * about whether EdFringe had just been read. Older files have no
           * `full` key at all, and every one of those WAS a full run. */
          bits.unshift((d.full === false ? "calendar sync "
                        : d.writes === false ? "scan " : "full sync ") + when(d.at));
        }
        show();
      })
      .catch(show);
  }

  function boot(data, fromCache) {
    plan = data;
    indexPublishedStars();
    selectedDay = selectedDay || defaultDay();
    $("#meta").textContent = fromCache ? "offline copy" : "";
    renderDays();
    renderBook();
    renderActivity();
    showLastSync();
    if (catalogue) renderBrowse();

    /* ⚠️ RETIRING A BOUGHT SHOW'S HOLDS IS NOT DONE HERE. It used to be, and
     * the rule here went stale: it cleared the hold on the BOUGHT DATE ONLY,
     * while his rule since 2026-08-17 is that a ticket retires every hold for
     * that show, with the freedom to re-hold another date afterwards. He
     * caught it the first time it mattered - a ticket to Harriet Richardson:
     * Creep cleared one sitting and left eight standing.
     *
     * It is not fixed here, it is DELETED here, because the same rule lived in
     * two languages and only one of them was updated. build_plan.py's
     * clear_holds_bought() owns it: it retires the whole show, records the
     * ticket in holds.json's clearedByTicket so it fires ONCE, and therefore
     * lets a date he re-holds afterwards survive the next rebuild. This block
     * could never do that last part - the app has no access to that marker -
     * so a show-wide clear here would have wiped his re-holds on every launch.
     *
     * It runs in both Mac sequences (tools/sync_watch.py LIGHT and FULL, and
     * server.py's /api/refresh), so any refresh applies it. Deliberately NOT
     * in the cloud workflow: a runner mutating a holds.json it never publishes
     * would leave the phone and the Mac disagreeing. */

    // ⚠️ boot() runs twice on a normal load: once from the cached copy so the
    // app is instantly usable, then again with live data. Everything below
    // talks to the network, so it must only run on the live pass - otherwise
    // every launch pulled twice and could start a scan off a stale cache.
    if (fromCache) return;

    // Anything made offline goes out now, before anything is pulled.
    retryQueues();

    // ⚠️ Opportunistic refresh, his choice 2026-08-15: if the last EdFringe
    // scan is over 3 hours old, opening the app quietly refreshes it. NOT a
    // timer - nothing runs while he is not using the app, and it costs nothing
    // when the data is already fresh. Deliberately scan-only. (Nothing writes
    // holds to his EdFringe account from ANY path since 2026-08-15 - holds
    // live in this app; holdsync.py exists for when he explicitly asks.)
    maybeAutoScan();

    // And the calendar, on EVERY open, on BOTH devices - his request
    // 2026-08-18. See maybeAutoCalendarSync() for the two guards it needs.
    maybeAutoCalendarSync();

    // ⚠️ On the Mac the queue files are read off local disk, so a hold made on
    // his phone was invisible here until something published. Every load now
    // asks the server to pull the relay first - two ~1 KB calls, no scan - and
    // redraws if it brought anything back.
    var pullDone = syncOn("Syncing to GitHub");
    var pulled = isLocal()
      ? fetch("/api/pull", { method: "POST" })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (d && d.gained) flash("Picked up changes from your phone");
            return d;
          })
          .catch(function () { return null; })
          .then(function (d) {
            pullDone(!d || d.ok !== false,
                     d && d.gained ? "Picked up your phone's changes" : "Up to date");
            return d;
          })
      : Promise.resolve(null).then(function (d) { pullDone(true, "Up to date"); return d; });

    // Pull the shared queue, then redraw if it brought anything new.
    pulled.then(fetchHolds).then(function (remote) {
      if (!remote.length) return;
      var before = JSON.stringify(localHolds());
      mergeHolds(remote);
      if (JSON.stringify(localHolds()) !== before) renderDays();
    });

    // Favourites travel the same way: starred on the Mac, visible on the
    // phone, without either of them waiting for EdFringe.
    pulled.then(fetchFavs).then(function (remote) {
      if (!remote.length) return;
      var before = JSON.stringify(localFavs());
      mergeFavs(remote);
      if (JSON.stringify(localFavs()) !== before) { renderBook(); renderDays(); }
    });

    // His stars travel the same way. Unlike favourites there is no frozen
    // baseline anywhere - ratings.json IS the whole truth - so a device with
    // an empty log shows hollow until this lands.
    // Anything whose settle window elapsed while the app was closed.
    commitSettledStars();

    pulled.then(fetchRatings).then(function (remote) {
      if (!remote.length) return;
      var before = JSON.stringify(localRatings());
      mergeRatings(remote);
      if (JSON.stringify(localRatings()) !== before) { renderBook(); renderDays(); }
    });
  }

  var STALE_HOURS = 3, autoScanTried = false;

  function maybeAutoScan() {
    if (!isLocal() || autoScanTried) return;
    var scanned = plan && plan.sourceScanAt;
    if (!scanned) return;
    var age = (Date.now() - new Date(scanned).getTime()) / 3600000;
    if (age < STALE_HOURS) return;
    autoScanTried = true;                        // once per load, never a loop

    var release = syncOn("Scanning EdFringe");
    var stop = { done: false };
    watchSteps(stop);
    fetch("/api/refresh?scan-only=1", { method: "POST" })
      .then(function (r) { return r.json(); })
      .then(function () { return fetchPlan(); })
      .then(function (d) {
        try { localStorage.setItem(CACHE_KEY, JSON.stringify(d)); } catch (e) {}
        catalogue = null;                        // availability moved: refetch
        boot(d, false);
        stop.done = true;
        release(true, "Availability up to date");
      })
      .catch(function () {
        stop.done = true;
        release(false, "Could not sync");
      });
  }

  /* ⚠️ AUTO CALENDAR SYNC ON OPEN - his request 2026-08-18, and the one place
   * where "no changes to the mobile version" is deliberately superseded: he
   * asked for this "upon opening the app on iphone or mac".
   *
   * On the Mac that is the light sequence (the calendar button). On the phone
   * there is no Mac to call, so it is the CLOUD calendar rebuild - the same
   * thing ↻ does there - which works with the Mac shut. A phone with no cloud
   * token does nothing: the fallback is a five-minute round trip that wakes
   * the Mac, which is not something to spend on merely opening the app.
   *
   * Two guards, both necessary:
   *
   *  - AUTOCAL_QUIET_MIN. iOS re-runs this on every relaunch and every return
   *    from the background, and ⌘R now syncs and then reloads - which lands
   *    right back here. Without a floor, one keypress is two syncs and a day
   *    of app-switching is dozens of Actions runs. The stamp is in
   *    localStorage, so it holds across the reload.
   *  - On the Mac, if maybeAutoScan() is about to run a FULL scan (data over
   *    STALE_HOURS old), that sequence already includes the calendar. Running
   *    both would have the server refuse the second with a 409 and show him a
   *    failure that is really just an overlap.
   *
   * It never blocks the render: the app is already on screen from cache when
   * this starts, and everything it does redraws when it lands. */
  var AUTOCAL_KEY = "fp.autocal.at", AUTOCAL_QUIET_MIN = 10;

  function autoCalDue() {
    try {
      var last = parseInt(localStorage.getItem(AUTOCAL_KEY) || "0", 10);
      return !(last && Date.now() - last < AUTOCAL_QUIET_MIN * 60000);
    } catch (e) { return true; }
  }

  function maybeAutoCalendarSync() {
    if (!autoCalDue()) return;

    if (isLocal()) {
      var scanned = plan && plan.sourceScanAt;
      var age = scanned ? (Date.now() - new Date(scanned).getTime()) / 3600000 : 0;
      if (scanned && age >= STALE_HOURS) return;      // the full scan covers it
      if (!calendarSync) return;
      try { localStorage.setItem(AUTOCAL_KEY, String(Date.now())); } catch (e) {}
      calendarSync();
      return;
    }

    if (!actionsToken()) return;              // ↻ still asks the Mac by hand
    try { localStorage.setItem(AUTOCAL_KEY, String(Date.now())); } catch (e) {}
    var release = syncOn("Syncing your calendar");
    cloudRefresh()
      .then(function (outcome) {
        if (outcome === "no-cloud-token") {
          release(false, "No cloud token");
          return;
        }
        return fetchPlan().then(function (d) {
          try { localStorage.setItem(CACHE_KEY, JSON.stringify(d)); } catch (e) {}
          boot(d, false);
          release(outcome !== "cloud-slow",
                  outcome === "cloud-slow" ? "Still running — pull down shortly"
                                           : "Calendar synced");
        });
      })
      /* ⚠️ It still has to SAY it failed. He did not start this run, so the
       * wording is plain rather than alarming - but releasing it as a success
       * would be the app reporting a calendar sync that never happened, and
       * that is the one thing this badge exists to get right. The data on
       * screen is unaffected either way. */
      .catch(function () { release(false, "Calendar didn't sync"); });
  }

  /* iOS almost never re-runs the page: he switches back to an app that is
   * still loaded. "Opening the app" therefore means becoming visible again,
   * not loading - so re-arm here too, with the same quiet floor doing the
   * throttling. */
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) maybeAutoCalendarSync();
  });

  function fetchFavs() {
    if (isLocal()) {
      return fetch("data/favs.json", { cache: "no-store" })
        .then(function (r) { return r.ok ? r.json() : {}; })
        .then(function (d) { return d.favs || []; })
        .catch(function () { return []; });
    }
    var tk = token();
    if (!tk) return Promise.resolve([]);
    return fetch("https://api.github.com/repos/" + DATA_REPO + "/contents/favs.json", {
      cache: "no-store",
      headers: { Authorization: "Bearer " + tk, Accept: "application/vnd.github.raw" }
    }).then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (d) { return d.favs || []; })
      .catch(function () { return []; });
  }

  // Last tap wins, per show - the same rule the server merges by, so the two
  // copies cannot disagree about which way the heart is pointing.
  function favStamp(f) {
    var ms = Date.parse((f && f.at) || "");
    return isNaN(ms) ? 0 : ms;
  }

  function mergeFavs(remote) {
    var byslug = {};
    localFavs().concat(remote || []).forEach(function (f) {
      if (!f || !f.slug) return;
      var have = byslug[f.slug];
      // Instants, not text - same reason as stampOf(). A "+01:00" stamp sorts
      // after a later "Z" one as a string. Audit #3, 2026-08-16.
      if (!have || favStamp(f) > favStamp(have)) byslug[f.slug] = f;
    });
    var merged = Object.keys(byslug).map(function (k) { return byslug[k]; });
    try { localStorage.setItem(FAV_KEY, JSON.stringify(merged)); } catch (e) {}
    return merged;
  }

  // Served from the Mac it reads data/plan.json directly. Served from GitHub
  // Pages the shell is public but the plan is not, so the data lives in a
  // PRIVATE repo and is fetched with a token pasted once per device.
  // ⚠️ This file is published publicly - keep personal detail out of it.
  var DATA_REPO = "fy9syzbg24-svg/fringe-planner-data";
  var TOKEN_KEY = "fringe-gh-token";

  function isLocal() {
    return ["localhost", "127.0.0.1"].indexOf(location.hostname) >= 0 ||
           location.protocol === "file:";
  }

  function token() {
    try { return localStorage.getItem(TOKEN_KEY) || ""; } catch (e) { return ""; }
  }

  function fetchPlan() {
    if (isLocal()) {
      return fetch("data/plan.json", { cache: "no-store" })
        .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then(requirePlan);
    }
    var tk = token();
    if (!tk) return Promise.reject(new Error("no-token"));
    return fetch("https://api.github.com/repos/" + DATA_REPO + "/contents/plan.json", {
      cache: "no-store",
      headers: { Authorization: "Bearer " + tk, Accept: "application/vnd.github.raw" }
    }).then(function (r) {
      if (r.status === 401 || r.status === 403) throw new Error("bad-token");
      if (!r.ok) throw new Error(r.status);
      return r.json();
    }).then(requirePlan);
  }

  /* ⚠️ Belt to the service worker's braces: whatever arrives, it is only a plan
   * if it has days. Anything else - an offline stub, a truncated body, an error
   * object - must REJECT here, because the caller writes what it receives into
   * localStorage as the good copy. */
  function requirePlan(d) {
    if (!d || !d.days || !d.days.length) throw new Error("not-a-plan");
    return d;
  }

  function askForToken(msg) {
    var b = $("#sheetBody");
    b.innerHTML = "";
    b.appendChild(el("h2", null, "Connect to your data"));
    b.appendChild(el("div", "sub", msg || ("The app shell is public; your plan is not. " +
      "Paste a GitHub token with read access to " + DATA_REPO + ".")));
    var wrap = el("div", "searchwrap");
    var input = el("input");
    input.type = "password";
    input.placeholder = "github_pat_...";
    input.autocapitalize = "off";
    input.autocorrect = "off";
    wrap.appendChild(input);
    b.appendChild(wrap);
    var row = el("div", "btn-row");
    var save = el("button", "btn", "Save and load");
    save.onclick = function () {
      var v = (input.value || "").trim();
      if (!v) return;
      try { localStorage.setItem(TOKEN_KEY, v); } catch (e) {}
      $("#sheet").classList.add("is-hidden");
      load();
    };
    row.appendChild(save);
    b.appendChild(row);
    b.appendChild(el("div", "note",
      "Stored only on this device, in this browser. It is never sent anywhere " +
      "except api.github.com. Revoke it any time from GitHub settings."));
    $("#sheet").classList.remove("is-hidden");
  }

  // How stale the data may be before opening the app asks the Mac for a fresh
  // scan by itself. Every open triggering a scan would hammer EdFringe for no
  // benefit - he checks it several times a day - so this only fires when the
  // numbers are genuinely old.
  var AUTO_REFRESH_AFTER_MS = 2 * 3600 * 1000;

  function maybeAutoRefresh() {
    if (isLocal() || !plan || !plan.sourceScanAt || !token()) return;
    var age = Date.now() - new Date(plan.sourceScanAt).getTime();
    if (age < AUTO_REFRESH_AFTER_MS) return;
    $("#meta").textContent += " · refreshing…";
    requestRemoteRefresh()
      .then(function (outcome) {
        if (outcome === "read-only" || outcome === "timeout") return;
        catalogue = null;
        return fetchPlan().then(function (d) {
          try { localStorage.setItem(CACHE_KEY, JSON.stringify(d)); } catch (e) {}
          boot(d, false);
        });
      })
      .catch(function () { /* offline, or the Mac is asleep - keep what we have */ });
  }

  function load() {
    var cached = null;
    try { cached = JSON.parse(localStorage.getItem(CACHE_KEY)); } catch (e) {}
    /* ⚠️ Tickets are warmed from the cache at launch and refreshed in the
     * background on EVERY open - never lazily on the first tap. He opens this
     * screen in a venue queue, which is exactly where the phone has no signal;
     * a barcode that only downloads when he asks for it is a barcode he does
     * not have at the door. Failure here is silent on purpose: it must never
     * be able to stop the app booting. */
    ticketStore = cachedTickets();
    /* ⚠️ Self-healing. The cached boot is the FIRST thing a launch does, so a
     * bad cached copy threw before fetchPlan was ever called - the app opened
     * dead and stayed dead until he happened to pull to refresh. Now a cache
     * that cannot boot is dropped and the launch carries on to the network. */
    if (cached) {
      try {
        boot(cached, true);
      } catch (e) {
        cached = null;
        try { localStorage.removeItem(CACHE_KEY); } catch (e2) {}
      }
    }

    fetchPlan()
      .then(function (d) {
        try { localStorage.setItem(CACHE_KEY, JSON.stringify(d)); } catch (e) {}
        boot(d, false);
        fetchTickets().catch(function () {});
        maybeAutoRefresh();
      })
      .catch(function (err) {
        var why = String(err && err.message);
        if (why === "no-token" || why === "bad-token") {
          if (!cached) {
            askForToken(why === "bad-token"
              ? "That token was rejected. Paste a valid one with read access to " + DATA_REPO + "."
              : null);
          } else {
            $("#meta").textContent += " · tap ↻ to reconnect";
          }
          return;
        }
        if (!cached) {
          $("#meta").textContent = isLocal()
            ? "No data yet — run build_plan.py"
            : "Offline and no saved copy yet";
        }
      });
  }

  // --------------------------------------------------------------- days

  // The pinned stack at the top of the screen is measured, never assumed: the
  // masthead grows by the notch inset on his phone, so a hard-coded offset
  // leaves the day header either overlapping the tabs or floating below them.
  function pinOffsets() {
    var top = document.querySelector(".top"), tabs = document.querySelector(".tabs");
    var a = top ? Math.round(top.getBoundingClientRect().height) : 52;
    var b = tabs ? Math.round(tabs.getBoundingClientRect().height) : 55;
    var css = document.documentElement.style;
    css.setProperty("--pin-1", a + "px");
    css.setProperty("--pin-2", (a + b) + "px");
  }
  window.addEventListener("resize", pinOffsets);
  window.addEventListener("orientationchange", pinOffsets);

  // The ringed day: today during the festival, and the first day of the trip
  // until today catches up with it. "Defaulted to the 17th until the 18th
  // happens" - his words.
  function ringedDay() {
    var t = todayISO(), days = plan.days.map(function (x) { return x.date; });
    if (days.indexOf(t) >= 0) return t;
    for (var i = 0; i < days.length; i++) if (days[i] > t) return days[i];
    return days[days.length - 1];
  }

  function renderDays() {
    var strip = $("#daystrip");
    strip.innerHTML = "";
    var ringDay = ringedDay();
    plan.days.forEach(function (d) {
      // ⚠️ Today and "the day you are looking at" were both a blue ring and
      // were impossible to tell apart. They are now different SHAPES: today is
      // an outline, the selected day is filled. Before the trip starts the
      // ring sits on the first day, so it is never missing.
      var isToday = d.date === todayISO();
      var c = el("button", "daycard" + (d.date === selectedDay ? " is-on" : "") +
                           (d.date === ringDay ? " is-today" : ""));
      c.appendChild(el("div", "wd", isToday ? "TODAY" : d.weekday));
      c.appendChild(el("div", "dn", String(d.dayNum)));
      // ⚠️ Dots are ordered by what matters, not by time. They used to be the
      // first five events of the day, which on 17 Aug meant a flight, a
      // breakfast, a phone call and two maybes - and silently dropped the one
      // show he actually holds a ticket for. Colour follows his Google
      // Calendar scheme so a glance reads the same as his calendar.
      var RANK = { show: 0, bookmarked: 1, commitment: 2, medical: 3, travel: 4 };
      var dots = el("div", "dots");
      var ordered = d.events.slice().sort(function (a, b) {
        return (RANK[a.kind] === undefined ? 9 : RANK[a.kind]) -
               (RANK[b.kind] === undefined ? 9 : RANK[b.kind]);
      });
      ordered.slice(0, 6).forEach(function (e) {
        dots.appendChild(el("i", "dot " + e.kind));
      });
      c.appendChild(dots);
      c.onclick = function () { selectedDay = d.date; renderDays(); };
      strip.appendChild(c);
      if (d.date === selectedDay) {
        setTimeout(function () {
          c.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
        }, 0);
      }
    });
    renderTimeline();
    pinOffsets();
  }

  function renderTimeline() {
    var d = plan.days.filter(function (x) { return x.date === selectedDay; })[0];
    var body = $("#dayBody");
    body.innerHTML = "";
    function body_append(node) { body.appendChild(node); }

    var head = el("div", "dayhead");
    var h = el("div");
    h.appendChild(el("h2", null, longDate(d.date)));
    head.appendChild(h);
    // The gap between the date and the day's summary was dead space, and
    // "Monday 17 August" does not tell him how soon that is at a glance.
    // The arrows either side step the day: the header is pinned while he
    // scrolls, so this is the one control always within reach.
    var nav = el("div", "daynav");
    var idx = plan.days.map(function (x) { return x.date; }).indexOf(selectedDay);
    function arrow(delta, glyph, label) {
      var b = el("button", "daystep", glyph);
      b.setAttribute("aria-label", label);
      var to = plan.days[idx + delta];
      if (!to) b.disabled = true;
      else b.onclick = function () { selectedDay = to.date; renderDays(); };
      return b;
    }
    nav.appendChild(arrow(-1, "\u2039", "Previous day"));
    nav.appendChild(el("div", "rel " + relClass(d.date), relDay(d.date)));
    nav.appendChild(arrow(1, "\u203a", "Next day"));
    head.appendChild(nav);
    var shows = d.events.filter(function (e) { return e.kind === "show"; }).length;
    var marked = d.events.filter(function (e) { return e.kind === "bookmarked"; }).length;
    var bits = [];
    if (shows) bits.push(shows + (shows === 1 ? " show" : " shows"));
    if (marked) bits.push(marked + " held");
    if (!bits.length) bits.push("nothing booked");
    bits.push(dur(d.freeMinutes) + " free");
    head.appendChild(el("div", "sub", bits.join(" · ")));
    body.appendChild(head);

    // Turnaround warnings sit above everything else on the day: he cannot
    // hurry between venues, so this is the first thing he needs to see.
    (d.warnings || []).forEach(function (w) {
      var row = el("div", "warn " + w.severity);
      row.appendChild(el("span", "wm", w.minutes < 0
        ? Math.abs(w.minutes) + "m over" : w.minutes + "m"));
      var body = el("div", "wb");
      body.appendChild(el("div", "w1", w.minutes < 0
        ? "Clash — these overlap"
        : (w.sameVenue ? "Tight, but same building" : "Tight — and across town")));
      body.appendChild(el("div", "w2",
        w.fromTitle + " ends " + ampm(w.fromEnd) +
        (w.fromVenue ? " · " + shortPlace(w.fromVenue) : "") +
        "  →  " + w.toTitle + " starts " + ampm(w.toStart) +
        (w.toVenue ? " · " + shortPlace(w.toVenue) : "")));
      row.appendChild(body);
      body_append(row);
    });

    if (d.allDay.length) {
      var ad = el("div", "allday");
      d.allDay.forEach(function (a) {
        var row = el("div", "banner " + (a.kind || ""));
        row.appendChild(el("span", "bt", a.summary));
        row.appendChild(el("span", "bw", "all day"));
        ad.appendChild(row);
      });
      body.appendChild(ad);
    }

    if (!d.events.length && !d.gaps.length) {
      body.appendChild(el("div", "emptyday", "Nothing scheduled."));
      return;
    }

    // The plannable window is 09:00-24:00. An overnight flight would otherwise
    // stretch the grid over seven dead hours and bury the actual day, so
    // anything falling entirely outside the window becomes a banner instead,
    // and anything overlapping it is clamped to the edge.
    var from = 9 * 60, to = 24 * 60;
    var nightEnd = plan.dayEndMin || 28 * 60;      // 04:00 the next morning
    var outside = d.events.filter(function (e) {
      return e.endMin <= from || e.startMin >= nightEnd;
    });
    /* A hold he has just released must leave the timeline NOW, not at the next
     * build. The plan is rebuilt on the Mac, so without this the chip sits
     * there after he taps it off - which reads as the tap having failed, and
     * was half of why the 21st looked stuck. Only his own holds are filtered:
     * a booked show is never removed by a tombstone. */
    var inside = d.events.filter(function (e) {
      if (e.endMin <= from || e.startMin >= nightEnd) return false;
      if (e.kind !== "bookmarked" || !e.href) return true;
      var slug = e.href.split("/").pop();
      /* ⚠️ Compare the SITTING, not just the day. This was the last
       * (slug, date)-keyed path left: any tombstone for the show that day
       * suppressed EVERY chip for it, so the ordinary "held 20:25, EdFringe
       * moved it to 21:20, re-held" flow hid the live hold. Six were hidden
       * when this was found - The Duo on 19/21/24/27/28 Aug and Ania Magliano
       * on the 19th - all present in plan.json, all missing from the timeline,
       * with the gap logic treating those evenings as free while the date
       * squares (which are time-aware) still said held. matchesHold keeps a
       * time-less tombstone blanket, which is what a legacy release means.
       * Audit #3, 2026-08-16. */
      var chipTime = String(e.start || "").slice(11, 16);
      return !localHolds().some(function (h) {
        return h.unhold && matchesHold(h, slug, d.date, chipTime);
      });
    });

    if (outside.length) {
      var ob = el("div", "allday");
      outside.forEach(function (e) {
        var row = el("div", "banner " + e.kind);
        row.appendChild(el("span", "bt", e.summary));
        row.appendChild(el("span", "bw", clock(e.start) + " – " + clock(e.end)));
        ob.appendChild(row);
      });
      body.appendChild(ob);
    }
    /* Gap labels are placed before the holds are laid out, so they cannot know
     * where the wide clusters will land. Collected here and nudged in a second
     * pass once the lanes are known - see the end of this function. */
    var gapLabels = [];

    /* ⚠️ PLANNABLE vs FREE - his rule, 2026-08-18. His Video Work blocks and
     * "Book Physio Appointment" reminders are rough estimates: they keep their
     * place, but a show can still be planned across them. build_plan.py works
     * the day out twice and ships both, so "6h free" in the header stays the
     * truth while the timeline can still offer 12:00-04:00.
     *
     * A region swallows the real gaps inside it (covers), so one window - and
     * one fits list - serves the wide band AND the lane beside the block. Tap
     * either and he is choosing across 09:00-18:20, which is what he asked
     * for by name. */
    var regionForGap = {};
    (d.plannable || []).forEach(function (p) {
      (p.covers || []).forEach(function (gid) { regionForGap[gid] = p; });
    });
    /* Favourites that fit INSIDE one window. The opportunity says which
     * stretch it landed in, not where in it, so the sitting is checked against
     * the window's own minutes - otherwise the 12:00-19:00 band would offer
     * the 11 PM shows that fit the same region five hours later. */
    function fitsWindow(region, ws, we) {
      var ids = {};
      ids[region.id] = 1;
      (region.covers || []).forEach(function (gid) { ids[gid] = 1; });
      return favouritesNow().filter(function (f) {
        return !f.booked && (f.opportunities || []).some(function (o) {
          if (!ids[o.gapId] || o.date !== d.date || !o.time) return false;
          var st = Number(o.time.slice(0, 2)) * 60 + Number(o.time.slice(3, 5));
          if (st < 4 * 60) st += 24 * 60;    // small hours belong to this night
          return st >= ws && st + (f.durationMin || 60) <= we;
        });
      });
    }
    // Minutes back to an ISO stamp on this night, for the sheet's header.
    function atMin(m) {
      var day = d.date, mm = Math.round(m);
      if (mm >= 24 * 60) {
        var nx = new Date(d.date + "T12:00:00Z");
        nx.setUTCDate(nx.getUTCDate() + 1);
        day = nx.toISOString().slice(0, 10);
        mm -= 24 * 60;
      }
      return day + "T" + ("0" + Math.floor(mm / 60)).slice(-2) + ":" +
             ("0" + (mm % 60)).slice(-2) + ":00+01:00";
    }
    function minsOf(iso) {
      var m = Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16));
      return iso.slice(0, 10) !== d.date ? m + 24 * 60 : m;
    }

    /* ⚠️ Which real gaps are SWALLOWED by a soft block's window, and which
     * keep their own band. His two rulings, a message apart:
     *   19 Aug - "you can connect these too, currently i can't click on
     *   5PM- 6:20". That 80 minutes fits nothing on its own, so as its own
     *   band it was dead; as part of 09:00-18:20 it is the window he named.
     *   18 Aug - "then the 12-4 stays the same". The last stretch of the
     *   night is its own evening and keeps its own "4h free".
     * So: a gap inside a soft region joins the block's window, UNLESS it is
     * the tail that runs out to the end of the night. */
    var mergedGaps = {};
    (d.plannable || []).forEach(function (region) {
      var rs = minsOf(region.start), re = minsOf(region.end);
      var hasSoft = inside.some(function (e) {
        return e.soft && e.startMin < re && e.endMin > rs;
      });
      if (!hasSoft) return;
      (d.gaps || []).forEach(function (g) {
        var a = minsOf(g.start), b = minsOf(g.end);
        if (a < rs || b > re) return;                  // not in this region
        if (b >= re && re > 24 * 60) return;           // the night's own tail
        mergedGaps[g.id] = 1;
      });
    });
    function regionOver(startMin, endMin) {
      var hit = null;
      (d.plannable || []).forEach(function (p) {
        if (hit) return;
        if (minsOf(p.start) <= startMin && minsOf(p.end) >= endMin) hit = p;
      });
      return hit;
    }

    inside.forEach(function (e) { to = Math.max(to, Math.min(e.endMin, nightEnd)); });
    d.gaps.forEach(function (g) {
      var ge = Number(g.end.slice(11, 13)) * 60 + Number(g.end.slice(14, 16));
      if (g.end.slice(0, 10) !== d.date) ge += 24 * 60;   // gap runs past midnight
      to = Math.max(to, Math.min(ge, nightEnd));
    });
    to = Math.ceil(to / 60) * 60;

    var tl = el("div", "timeline");
    tl.style.height = ((to - from) * PX_PER_MIN) + "px";
    var top = function (min) { return (min - from) * PX_PER_MIN; };

    for (var m = from; m <= to; m += 60) {
      var line = el("div", "tl-hour");
      line.style.top = top(m) + "px";
      var hr = Math.floor(m / 60) % 24;
      var lab = el("span", null, ((hr % 12) || 12) + (hr >= 12 ? "pm" : "am"));
      line.appendChild(lab);
      tl.appendChild(line);
    }

    d.gaps.forEach(function (g) {
      if (mergedGaps[g.id]) return;      // drawn as part of a soft window
      var gs = Number(g.start.slice(11, 13)) * 60 + Number(g.start.slice(14, 16));
      var ge = Number(g.end.slice(11, 13)) * 60 + Number(g.end.slice(14, 16));
      if (g.start.slice(0, 10) !== d.date) gs += 24 * 60;
      if (g.end.slice(0, 10) !== d.date) ge += 24 * 60;
      var region = g;
      var fits = favouritesNow().filter(function (f) {
        return !f.booked && f.opportunities.some(function (o) { return o.gapId === g.id; });
      });
      var box = el("div", "tl-gap" + (g.minutes < 100 ? " tiny" : ""));
      gapLabels.push({ gs: gs, ge: ge, box: box });
      box.style.top = top(gs) + "px";
      box.style.height = Math.max(20, (ge - gs) * PX_PER_MIN - 3) + "px";
      var inner = el("div", "gapinner");
      inner.appendChild(el("div", "g1", dur(g.minutes) + " free"));
      box.appendChild(inner);
      // ⚠️ Hour rules run right across the timeline, and centring this pair in
      // the gap put a line straight through the words. Sit it in the middle of
      // ONE hour band instead - the same place to the eye, minus the strike-
      // through. Short gaps keep plain centring; there is no band to sit in.
      if (ge - gs >= 75) {
        var mid = (gs + ge) / 2;
        var bandCentre = from + Math.floor((mid - from) / 60) * 60 + 30;
        var half = 28 / PX_PER_MIN;                 // the pair, in minutes
        if (bandCentre - half < gs) bandCentre += 60;
        if (bandCentre + half > ge) bandCentre -= 60;
        /* ⚠️ Only sit in the band if the label actually FITS there. The two
         * nudges above are applied in sequence and neither re-checks the
         * other, so a gap just over the threshold could be pushed out of its
         * own box: 12:35-14:00 centred on 13:30, then the second nudge moved
         * it to 12:30 - five minutes ABOVE the gap's top - and the words
         * rendered underneath the show block above, half hidden. Seen on his
         * 29 August.
         *
         * If neither band fits, fall through to the plain flex centring the
         * short gaps already use. A struck-through label is a cosmetic
         * annoyance; a label outside its box reads as a broken app. */
        if (bandCentre - half >= gs && bandCentre + half <= ge) {
          inner.style.position = "absolute";
          inner.style.top = (top(bandCentre) - top(gs)) + "px";
          inner.style.transform = "translateY(-50%)";
        }
      }
      /* ⚠️ TAPPABLE EITHER WAY since 2026-08-18. "nothing from your list fits"
       * used to be a dead end - the one band where he most needed a way out.
       * It now opens the same sheet on the Discover tab, which is what he
       * asked for: "this would also allow me to click on those areas that say
       * nothing on your list fits and discover new shows that do fit". */
      var gb = el("button", "g2", fits.length
        ? fits.length + " favourite" + (fits.length === 1 ? "" : "s") + " fit — tap"
        : "nothing on your list — discover");
      gb.onclick = function (ev) {
        ev.stopPropagation();
        gapSource = fits.length ? "favourites" : "discover";
        discoverShown = DISCOVER_PAGE;
        showGap(region, fits);
      };
      inner.appendChild(gb);
      box.style.cursor = "pointer";
      box.onclick = function (ev) {
        if (ev.target !== box) return;
        gapSource = fits.length ? "favourites" : "discover";
        discoverShown = DISCOVER_PAGE;
        showGap(region, fits);
      };
      tl.appendChild(box);
    });

    /* The green space beside a soft block. His ask, 2026-08-18: "I'd like to
     * be able to click there and still add show holds ... so there is always a
     * dedicated green clickable schedule space from 9-5."
     *
     * ⚠️ ONE WINDOW PER BLOCK, not one per region. "when you click on the top
     * one, it should only show shows from 12PM-7PM, then if you click on the
     * one below it shows 7PM - 12AM, then the 12-4 stays the same." So the
     * plannable region has the REAL gaps cut out of it - they keep their own
     * band and their own scope - and what is left is shared between the soft
     * blocks in it, split down the middle where two of them meet. On 18 Aug
     * that is 12:00-19:00 and 19:00-00:00, and the 18:30-19:30 hour that is
     * too short to be a gap of its own stops falling through the cracks.
     *
     * ⚠️ And it WRAPS: full width above and below the block, narrow beside it
     * - "allow the green fill to wrap around the events to fill the gaps".
     * One window, up to three boxes, one label. */
    var softLanes = [];
    (d.plannable || []).forEach(function (region) {
      var rs = minsOf(region.start), re = minsOf(region.end);
      var blocks = inside.filter(function (e) {
        return e.soft && e.startMin < re && e.endMin > rs;
      }).sort(function (a, b) { return a.startMin - b.startMin; });
      if (!blocks.length) return;

      // The stretches of this region that no rendered gap band already owns.
      var pieces = [[rs, re]];
      (d.gaps || []).forEach(function (g) {
        if (mergedGaps[g.id]) return;                  // this one is ours
        var a = minsOf(g.start), b = minsOf(g.end);
        var next = [];
        pieces.forEach(function (pc) {
          if (b <= pc[0] || a >= pc[1]) { next.push(pc); return; }
          if (a > pc[0]) next.push([pc[0], a]);
          if (b < pc[1]) next.push([b, pc[1]]);
        });
        pieces = next;
      });

      blocks.forEach(function (e) {
        var pc = null;
        pieces.forEach(function (q) {
          if (!pc && e.startMin < q[1] && e.endMin > q[0]) pc = q;
        });
        if (!pc) return;
        // Where two blocks share a piece, they meet in the middle of the
        // free time between them.
        var ws = pc[0], we = pc[1];
        blocks.forEach(function (o) {
          if (o === e || o.startMin >= pc[1] || o.endMin <= pc[0]) return;
          if (o.endMin <= e.startMin) ws = Math.max(ws, (o.endMin + e.startMin) / 2);
          if (o.startMin >= e.endMin) we = Math.min(we, (e.endMin + o.startMin) / 2);
        });
        ws = Math.max(ws, from);
        we = Math.min(we, to);
        if (we - ws < 20) return;

        var fits = fitsWindow(region, ws, we);
        var win = { id: region.id, covers: region.covers,
                    start: atMin(ws), end: atMin(we),
                    minutes: Math.round(we - ws),
                    after: region.after, before: region.before };

        /* ⚠️ ONE BOX, not one per piece. Drawing the fill as three rectangles
         * - above the block, beside it, below it - left a dashed seam across
         * the green at every join: "this seam shouldnt exist on the 18th. only
         * at 11 AM 12 pm, 7 pm and 12 am." Those four are the real edges, the
         * ones where something actually changes.
         *
         * So the band spans the WHOLE window at full width and the block is
         * painted over it - it is appended after this, and it is opaque -
         * which wraps the green around it with no join to see. */
        var band = el("div", "tl-gap softlane");
        band.style.top = top(ws) + "px";
        band.style.height = Math.max(12, (we - ws) * PX_PER_MIN - 3) + "px";
        var li = el("div", "gapinner");
        var lb = el("button", "g2", fits.length
          ? fits.length + " favourite" + (fits.length === 1 ? "" : "s") + " fit — tap"
          : "nothing on your list — discover");
        lb.onclick = function (ev) {
          ev.stopPropagation();
          gapSource = fits.length ? "favourites" : "discover";
        discoverShown = DISCOVER_PAGE;
          showGap(win, fits);
        };
        li.appendChild(lb);
        band.style.cursor = "pointer";
        band.onclick = function (ev) {
          if (ev.target !== band && ev.target !== li) return;
          gapSource = fits.length ? "favourites" : "discover";
        discoverShown = DISCOVER_PAGE;
          showGap(win, fits);
        };

        /* The label lives in the open part of the band - the lane to the right
         * of the block, placed in sizeTimelineRows() which is where that edge
         * is known. Vertically it dodges the holds sharing that lane, by
         * minute arithmetic, before anything is in the document. */
        var mine = inside.filter(function (x) { return x.kind === "bookmarked"; });
        var HALF = 22 / PX_PER_MIN, mid = (ws + we) / 2, opts = [];
        for (var t = Math.ceil(ws / 60) * 60 + 30; t + HALF <= we; t += 60) {
          if (t - HALF >= ws) opts.push(t);
        }
        opts.sort(function (a, b) { return Math.abs(a - mid) - Math.abs(b - mid); });
        var at = null;
        for (var oi = 0; oi < opts.length && at === null; oi++) {
          var c = opts[oi];
          if (!mine.some(function (h) {
                return h.startMin < c + HALF && h.endMin > c - HALF;
              })) at = c;
        }
        li.style.position = "absolute";
        li.style.top = (top(at === null ? mid : at) - top(ws)) + "px";
        li.style.transform = "translateY(-50%)";
        band.appendChild(li);
        softLanes.push({ label: li, ev: e });
        tl.appendChild(band);
      });
    });

    // Is that exact date closed? Unknown is never sold out - a show we cannot
    // match must not be painted red on the strength of missing data.
    // ⚠️ Per SITTING where we know it. The date-level answer is "open if
    // anything that day is open", which for a hold is the wrong question: a
    // hold on a sold-out 13:25 read as fine because the 23:10 beside it was on
    // sale. Same fix as date_sold_out() in build_plan.py.
    function dateGone(fav, row, iso, time) {
      if (fav) {
        var hit = (fav.dates || []).filter(function (d) { return d.date === iso; })[0];
        if (hit) {
          var st = hit.timeStatus || {};
          if (time && st[time]) {
            return st[time] === "noAllocation" || st[time] === "cancelled";
          }
          return !hit.open;
        }
      }
      if (row) {
        var day = Number(iso.slice(8));
        var p = (row.d || []).filter(function (x) { return x[0] === day; })[0];
        if (p) {
          var slots = String(p[2] || "").split("/").filter(Boolean);
          var codes = String(p[3] || "");
          var at = time ? slots.indexOf(time) : -1;
          if (at >= 0 && codes.charAt(at)) {
            return codes.charAt(at) === "n" || codes.charAt(at) === "x";
          }
          return p[1] === "n";
        }
      }
      return false;
    }

    // Holds made in the app that the last build has not seen yet.
    var pending = localHolds().filter(function (h) {
      // Same fix as above: a hold at 21:20 is not "already on the timeline"
      // just because a 20:25 sitting of the same show is.
      return !h.unhold && h.date === d.date &&
             !heldOnFringe(h.slug, h.date, h.time || undefined) &&
             !bookedOnDate(h.slug, h.date);
    }).map(function (h) {
      var t = (h.time || "19:00").split(":");
      var startMin = Number(t[0]) * 60 + Number(t[1] || 0);
      if (startMin < 4 * 60) startMin += 24 * 60;        // small hours belong to this night
      var fav = plan.favourites.filter(function (f) {
        return f.href.split("/").pop() === h.slug; })[0];
      var row = catalogue && catalogue.shows.filter(function (r) {
        return r.s === h.slug; })[0];
      var known = null;
      plan.days.some(function (dd) {
        return dd.events.some(function (ev2) {
          if (ev2.imageUrl && ev2.href && ev2.href.split("/").pop() === h.slug) {
            known = ev2.imageUrl; return true;
          }
          return false;
        });
      });
      return {
        id: "hold:" + h.slug + ":" + h.date, summary: h.title,
        imageUrl: (fav && fav.imageUrl) || (row && row.im) || known || null,
        start: h.date + "T" + (h.time || "19:00") + ":00+01:00",
        end: h.date + "T" + (h.time || "19:00") + ":00+01:00",
        startMin: startMin, endMin: startMin + 60,
        kind: "bookmarked", pending: true,
        // Same warning as a synced hold: a pending one can be for a date that
        // is already gone. Favourites first, catalogue second, and unknown is
        // never treated as sold out.
        soldOut: dateGone(fav, row, h.date, h.time || ""),
        href: "/tickets/whats-on/" + h.slug
      };
    });
    pending.forEach(function (p) {
      if (p.endMin > from && p.startMin < nightEnd) inside.push(p);
    });

    var shareRow = [];         // real events splitting a row with holds
    var holdLanes = [];        // holds sharing a slot, packed right in pixels

    /* ⚠️ A minute of overlap is not a clash, his call 2026-08-15.
     *
     * His 19:30–00:00 evening reception and a 23:59 hold overlap by ONE minute,
     * and that was enough to make the reception yield half the timeline and
     * crop its own text - for a collision he could not act on and would not
     * care about. Shows butt up against each other constantly at the Fringe.
     *
     * So anything overlapping by TOUCH_MIN or less is treated as adjacent: no
     * lane, no narrowing, no yielding. Past that it is a real clash and the
     * layout says so, because a genuine double-booking must stay visible. */
    function clashes(aStart, aEnd, bStart, bEnd) {
      return Math.min(aEnd, bEnd) - Math.max(aStart, bStart) > TOUCH_MIN;
    }

    // Held shows overlap constantly - three maybes in one evening is normal -
    // so they are laid out in lanes like a calendar rather than stacked on top
    // of each other. Lane = the first column free at that time.
    /* ⚠️ The minutes a REAL event occupies. A hold drawn over these must leave
     * the confirmed thing at least half the timeline - his standing rule. */
    var solidRanges = inside.filter(function (e) { return e.kind !== "bookmarked"; })
      .map(function (e) { return [e.startMin, e.endMin]; });

    var holds = inside.filter(function (e) { return e.kind === "bookmarked"; })
      .sort(function (a, b) { return a.startMin - b.startMin; });
    // ⚠️ Cluster by ACTUAL overlap, not per day. Counting lanes across the
    // whole day meant one clash in the evening narrowed every hold and stripped
    // their posters, including ones with the timeline to themselves.
    var clusters = [], current = null;
    holds.forEach(function (e) {
      if (!current || !clashes(e.startMin, e.endMin, current.start, current.end)) {
        current = { items: [e], start: e.startMin, end: e.endMin };
        clusters.push(current);
      } else {
        current.items.push(e);
        current.end = Math.max(current.end, e.endMin);
      }
    });
    clusters.forEach(function (c) {
      var laneEnds = [];
      c.items.forEach(function (e) {
        var lane = 0;
        while (lane < laneEnds.length && laneEnds[lane] - TOUCH_MIN > e.startMin) lane++;
        laneEnds[lane] = e.endMin;
        e._lane = lane;
      });
      c.lanes = Math.max(1, laneEnds.length);
      c.items.forEach(function (e) { e._lanes = c.lanes; });
      /* ⚠️ A lane COUNT is not a lane USE. The cluster is a CHAIN - Patti
       * 22:00 overlaps UNDERGROUND 22:15 overlaps Bebe Cave 23:00 - so the
       * whole 21:20-24:00 run became one 6-lane cluster and Bebe was drawn a
       * sixth of the band wide, five slots in from the right, stranded in the
       * middle of an otherwise empty row. His report, 2026-08-18: "its
       * position is weird for bebe".
       *
       * Six is right for the 21:30 pile-up and wrong for 23:00, where one
       * other hold is on. So each hold now SPANS the columns to its right
       * that nothing overlapping it occupies: Bebe keeps lane 0 and takes
       * columns 0-4, stopping at UNDERGROUND in column 5. Nothing that has a
       * clashing neighbour beside it moves at all. */
      c.items.forEach(function (e) {
        var span = 1;
        while (e._lane + span < c.lanes) {
          var col = e._lane + span;
          var taken = c.items.some(function (f) {
            return f !== e && f._lane === col &&
                   clashes(e.startMin, e.endMin, f.startMin, f.endMin);
          });
          if (taken) break;
          span++;
        }
        e._span = span;
      });
    });

    /* ⚠️ Three or more holds share an 80% band (see below), which reaches far
     * enough left to sit on top of a gap's "N favourites fit — tap" button -
     * measured covering 89px of it on 23 August. The chips are the content and
     * the button is a control, so neither may be sacrificed: move the LABEL
     * instead, to an hour band the cluster does not occupy.
     *
     * Minute arithmetic, not geometry: this runs before the chips are in the
     * document, so there is nothing to measure yet. */
    var wide = clusters.filter(function (c) { return c.lanes >= 3; });
    if (wide.length) {
      var HALF = 28 / PX_PER_MIN;               // the label pair, in minutes
      var hits = function (centre) {
        return wide.some(function (c) {
          return centre + HALF > c.start && centre - HALF < c.end;
        });
      };
      gapLabels.forEach(function (L) {
        var inner = L.box.querySelector(".gapinner");
        if (!inner) return;
        // Where it sits now: an explicit band, or the middle of the box.
        var centre = inner.style.top
          ? L.gs + (parseFloat(inner.style.top) / PX_PER_MIN)
          : (L.gs + L.ge) / 2;
        if (!hits(centre)) return;
        // Try every hour band in this gap, nearest first, and take the first
        // one that is clear. If none is, leave it where it was - a covered
        // label is better than one outside its own gap.
        var options = [];
        for (var t = Math.ceil(L.gs / 60) * 60 + 30; t + HALF <= L.ge; t += 60) {
          if (t - HALF >= L.gs) options.push(t);
        }
        options.sort(function (a, b) { return Math.abs(a - centre) - Math.abs(b - centre); });
        for (var i = 0; i < options.length; i++) {
          if (!hits(options[i])) {
            inner.style.position = "absolute";
            inner.style.top = (top(options[i]) - top(L.gs)) + "px";
            inner.style.transform = "translateY(-50%)";
            return;
          }
        }
      });
    }

    holds.forEach(function (e) {
        var s = Math.max(e.startMin, from), en = Math.min(e.endMin, to);
        var fav = plan.favourites.filter(function (f) { return f.href === e.href; })[0];
        // The poster now rides along on the event itself, so a show he has
        // pencilled in shows its artwork whether or not it is a favourite.
        var lanes = e._lanes || 1, span = e._span || 1;
        var chip = el("button", "tl-hold" + (e.pending ? " pending" : "")
                      + (e.soldOut ? " soldout" : "")
                      + (lanes > 1 ? " narrow" : ""));
        chip.style.top = top(s) + "px";
        chip.style.height = Math.min(46, Math.max(30, (en - s) * PX_PER_MIN - 3)) + "px";
        // How many REAL events sit over these same minutes - the other half of
        // the split. A lone hold used to keep its CSS 46% regardless; now a
        // hold over a real event yields to the rule like any other.
        var nRealHere = solidRanges.filter(function (r) {
          return clashes(e.startMin, e.endMin, r[0], r[1]);
        }).length;
        /* The band this hold's slot may use, as a percentage of the timeline.
         * A hold alone over empty time is the 46% .tl-hold already defaults to,
         * so every hold can go down one path in the sizing pass. */
        var bandPct = spaceSplit(0, lanes).holdBand;
        if (lanes > 1 || nRealHere > 0) {
          // Only genuinely clashing holds share the band; anything alone keeps
          // the full-width, right-aligned chip with its poster.
          /* ⚠️ THREE or more sharing the slot get a wider band, his request
           * 2026-08-15: at 52% each chip was down to ~16% of the timeline and
           * showed a poster and an ellipsis. A lone hold keeps its 46% and two
           * keep 52% - "if there is no overlap, half width for the hold is
           * good though! don't change that". */
          /* ⚠️ The wide band is for holds sharing EMPTY time. Where a real
           * event sits under the same minutes it keeps its half, so the band
           * caps at 50% - otherwise three maybes covered a confirmed
           * appointment, which is the rule inverted. */
          var band = spaceSplit(nRealHere, lanes).holdBand, gap = 1.5;  // % of timeline
          /* ⚠️ A hold is never WIDER because a real event happens to sit under
           * it. The band is how much room the holds MAY use, not how much they
           * must fill - so take the smaller of the band and the width these
           * same holds would have had over empty time.
           *
           * Without this a lone hold over a commitment took the whole 60% band
           * while an identical lone hold over nothing kept its 46%. On the Mac
           * both hit .tl-hold's 260px cap and looked the same, so the bug only
           * ever showed on the phone: "in the phone view, the seymour is still
           * taking too much space, shouldnt it match glenn & flenn?" - his
           * report 2026-08-17. Same object, same size, every screen.
           *
           * It leaves his stated splits untouched, because the band is the
           * smaller number in every case he gave: 2 holds over 1 real event is
           * min(60,52)=52, 3 is min(60,80)=60, and 2 holds over 2 reals is
           * min(50,52)=50. Only the lone hold changes. */
          var free = spaceSplit(0, lanes).holdBand;
          var w = (Math.min(band, free) - gap * (lanes - 1)) / lanes;
          // One column, times the columns this hold actually spans.
          chip.style.width = (w * span + gap * (span - 1)) + "%";
          bandPct = Math.min(band, free);
          /* ⚠️ The max-width cap in .tl-hold STAYS. Removing it was why Seymour
           * and Megasquirt ballooned while Glenn & Flenn - the same kind of
           * lone hold, just with nothing underneath - sat at its capped 260px.
           * A hold is the same object either way and the cap is what keeps it
           * looking like one. His report, 2026-08-17. */
          chip.style.right = ((lanes - e._lane - span) * (w + gap)) + "%";
        }
        /* Handed to the sizing pass, which sets the real width and offset in
         * PIXELS. The percentages above are only what the chip wears until
         * that runs, and the fallback if it cannot measure. */
        holdLanes.push({ chip: chip, lane: e._lane || 0, lanes: lanes,
                         band: bandPct, span: span,
                         s: e.startMin, en: e.endMin });
        var pic = poster(e.imageUrl || (fav && fav.imageUrl));
        if (pic) chip.appendChild(pic);
        var body = el("div", "hb");
        body.appendChild(el("div", "h1", e.summary));
        // Short: the chip is only ~45px tall for an hour-long show, and a long
        // status wrapped onto a third line and got clipped mid-word.
        body.appendChild(el("div", "h2", clock(e.start) +
          (e.pending ? " · syncing" : " · held")));
        chip.appendChild(body);

        // Already holding a ticket for this show on another night.
        var slug = e.href ? e.href.split("/").pop() : "";
        var owned = slug ? bookedElsewhere(slug, d.date) : null;
        if (owned) {
          var badge = el("span", "tktbadge");
          badge.appendChild(ticketIcon());
          badge.title = "You already have a ticket for " + longDate(owned);
          badge.setAttribute("aria-label", badge.title);
          chip.appendChild(badge);
        }
        chip.onclick = function (ev) {
          ev.stopPropagation();
          openShowByHref(e.href, e.summary, {
            date: String(e.start || "").slice(0, 10),
            time: String(e.start || "").slice(11, 16),
            // ⚠️ The ticket screen shows a time RANGE, like the confirmation
            // email does, so `end` has to travel with the tap - the sheet
            // itself never needed it.
            end: String(e.end || "").slice(11, 16),
            location: e.place || e.location || "",
            pls: e.pls || [],
            ticket: e.ticket || null,
            offsite: e.offsite || null,
            // ⚠️ "He already owns this sitting", which is NOT the same question
            // as "is there a barcode for it". Colin Cloud is a ticket EdFringe
            // cannot see and will never have a code here, and the button must
            // still not invite him to buy a show he is already going to.
            booked: e.kind === "show"
          });
        };
        e._chip = chip;
        tl.appendChild(chip);
      });

    // ⚠️ Two things he is actually AT can overlap - a double-booked evening, or
    // a show that runs into dinner. Stacked, the later one covered the earlier
    // one completely and the clash was invisible. Same lane clustering the
    // holds use: overlap by overlap, not day-wide, so a single clash at 9pm
    // does not narrow the whole day.
    var solid = inside.filter(function (e) { return e.kind !== "bookmarked"; })
      .sort(function (a, b) { return a.startMin - b.startMin; });
    var sClusters = [], sCur = null;
    solid.forEach(function (e) {
      if (!sCur || !clashes(e.startMin, e.endMin, sCur.start, sCur.end)) {
        sCur = { items: [e], start: e.startMin, end: e.endMin };
        sClusters.push(sCur);
      } else {
        sCur.items.push(e);
        sCur.end = Math.max(sCur.end, e.endMin);
      }
    });
    sClusters.forEach(function (c) {
      var ends = [];
      c.items.forEach(function (e) {
        var lane = 0;
        while (lane < ends.length && ends[lane] - TOUCH_MIN > e.startMin) lane++;
        ends[lane] = e.endMin;
        e._slane = lane;
      });
      c.items.forEach(function (e) { e._slanes = Math.max(1, ends.length); });
    });

    var sideBySide = [];
    solid.forEach(function (e) {
      var s = Math.max(e.startMin, from), en = Math.min(e.endMin, to);
      var it = el("div", "tl-item " + e.kind + (e._slanes > 1 ? " narrow" : ""));
      var itPic = poster(e.imageUrl);
      if (itPic) { itPic.classList.add("tiny"); it.appendChild(itPic); }
      it.style.top = top(s) + "px";
      it.style.height = Math.max(24, (en - s) * PX_PER_MIN - 3) + "px";

      // A booked show yields room to any hold sitting over the same minutes,
      // rather than being overlapped by it. The hold band is 46% of the
      // timeline for a lone chip and 52% where several share the slot.
      var clash = holds.filter(function (h) {
        return h._chip && clashes(h.startMin, h.endMin, e.startMin, e.endMin);
      });
      // ⚠️ Only a BOOKED SHOW yields to a hold. A commitment does not: a hold is
      // a maybe and an appointment is real, so squeezing the appointment to
      // make room for three maybes gets the priority exactly backwards. It also
      // clipped: "Book Physio Appointment" 10:00-14:00 on 21 Aug overlaps three
      // held shows, and yielding to the leftmost of them shrank a four-hour
      // block to an unreadable sliver reading "Book P...". His bug report,
      // 2026-08-17. The same thing happened on the 24th and the 28th, and would
      // happen to any long commitment with holds inside it.
      // ⚠️ No longer "yield to the leftmost chip". A real event takes its SHARE
      // of the row - max(25, 40/nReal) per cent - and the holds split the rest.
      // Yielding by position was what let a four-hour commitment be squeezed to
      // a sliver by a hold that happened to start early in the band.
      /* ⚠️ A SOFT block joins this list even with no hold beside it. His rule,
       * 2026-08-18: "that relative size would be the max, so if i got rid of
       * tiny planet, the video work event would stay that size" - the lane is
       * dedicated, so the block must not spread into it when it happens to be
       * empty. A hard event with no clash is left alone and still fills the
       * row. */
      if (clash.length || e.soft) shareRow.push({ item: it, lane: e._slane || 0,
                                        reals: Math.max(1, e._slanes || 1),
                                        holds: clash.length,
                                        soft: !!e.soft,
                                        chips: clash.map(function (h) { return h._chip; }) });
      e._item = it;
      var itWords = el("div", "itw");
      itWords.appendChild(el("div", "t", e.summary));
      itWords.appendChild(el("div", "w", clock(e.start) + " – " + clock(e.end) +
        (e.kind === "bookmarked" ? " · Held in Planner" : "") +
        // ⚠️ Not shortPlace() when the venue is uncertain: that trims a place
        // name down, and "Monkey Barrel Comedy or Underbelly, Bristo Square"
        // must survive whole. Two buildings ten minutes apart is exactly the
        // thing he must not read as settled.
        (e.location ? " · " + (e.venueUncertain ? e.location + " (venue varies — check your ticket)"
                                                : shortPlace(e.location)) : "")));
      it.appendChild(itWords);
      // A ticket he actually holds says so with the same stub the holds use -
      // so "I own this" reads identically wherever it appears. Only real
      // shows: a dentist appointment is not a ticket.
      if (e.kind === "show" && e.href) {
        var tb = el("span", "tktbadge");
        tb.appendChild(ticketIcon());
        tb.title = "Ticket booked";
        tb.setAttribute("aria-label", tb.title);
        it.appendChild(tb);
      }
      if (e.href) {
        it.classList.add("tappable");
        it.setAttribute("role", "button");
        it.setAttribute("tabindex", "0");
        it.onclick = function () {
          openShowByHref(e.href, e.summary, {
            date: String(e.start || "").slice(0, 10),
            time: String(e.start || "").slice(11, 16),
            // ⚠️ The ticket screen shows a time RANGE, like the confirmation
            // email does, so `end` has to travel with the tap - the sheet
            // itself never needed it.
            end: String(e.end || "").slice(11, 16),
            location: e.place || e.location || "",
            pls: e.pls || [],
            ticket: e.ticket || null,
            offsite: e.offsite || null,
            // ⚠️ "He already owns this sitting", which is NOT the same question
            // as "is there a barcode for it". Colin Cloud is a ticket EdFringe
            // cannot see and will never have a code here, and the button must
            // still not invite him to buy a show he is already going to.
            booked: e.kind === "show"
          });
        };
      }
      if (e._slanes > 1) sideBySide.push({ item: it, lane: e._slane, lanes: e._slanes });
      tl.appendChild(it);
    });

    // ⚠️ Where "now" is, in EDINBURGH time - the same clock the whole app runs
    // on. From New York the line would otherwise sit five hours out and quietly
    // mislead him about what he has already missed. Only drawn on the day he
    // is actually living through, and only while it is inside the day's range.
    var nowMin = PREVIEW_NOW ? PREVIEW_NOW.min : edinburghMinutes();
    var nowDay = PREVIEW_NOW ? PREVIEW_NOW.date : todayISO();
    // Anything before 4am belongs to the previous night, as everywhere else.
    var nowNight = nowMin < ((plan.dayEndMin || 28 * 60) - 24 * 60)
      ? new Date(new Date(nowDay + "T12:00:00Z").getTime() - 86400000)
          .toISOString().slice(0, 10)
      : nowDay;
    var nowAt = nowMin < ((plan.dayEndMin || 28 * 60) - 24 * 60) ? nowMin + 24 * 60 : nowMin;
    if (nowNight === d.date && nowAt >= from && nowAt <= to) {
      // ⚠️ Two lines at the same height, not one. The lower one sits UNDER the
      // show blocks at full white; the upper one crosses them at 38%. Over
      // empty timeline the two stack and read as solid white; over a booked
      // show only the faint one survives. That is the "full white except on
      // the green" he asked for, and CSS cannot do it with a single rule.
      var under = el("div", "nowline under");
      under.style.top = top(nowAt) + "px";
      tl.appendChild(under);

      var line = el("div", "nowline over");
      line.style.top = top(nowAt) + "px";
      line.appendChild(el("i", null, ""));
      tl.appendChild(line);
      // Keep it honest without redrawing the day: move it every 30 seconds.
      clearInterval(renderTimeline._tick);
      renderTimeline._tick = PREVIEW_NOW ? null : setInterval(function () {
        if (!line.isConnected) { clearInterval(renderTimeline._tick); return; }
        var m = edinburghMinutes();
        if (m < ((plan.dayEndMin || 28 * 60) - 24 * 60)) m += 24 * 60;
        line.style.top = top(m) + "px";
        under.style.top = top(m) + "px";
      }, 30000);
    }

    body.appendChild(tl);

    /* Now that the timeline has real geometry, give every real event its SHARE
     * of the row and let the holds take the rest. See spaceSplit().
     *
     * ⚠️ HELD, NOT JUST RUN. The pass writes ABSOLUTE PIXELS, so the numbers
     * are only right for the width they were measured at. His report
     * 2026-08-17: "when i stretch and compress the window, it's not scaling
     * correctly in the calendar view" - widths worked out at a wide window
     * stayed that wide in a narrow one and pushed the whole day off the right
     * edge. Keeping the records lets a resize replay the sizing without
     * rebuilding the day, which would cost his scroll position. */
    renderTimeline._layout = { tl: tl, shareRow: shareRow, sideBySide: sideBySide,
                               holdLanes: holdLanes, softLanes: softLanes };
    watchTimelineWidth(tl);
    sizeTimelineRows();
  }

  /* The pixel sizing, replayable. Called once per render and again on every
   * width change. Everything it needs is measured fresh each time, so it is
   * safe to run at any moment; nothing is remembered from the last pass. */
  function sizeTimelineRows() {
    var L = renderTimeline._layout;
    if (!L || !L.tl.isConnected) return;
    var shareRow = L.shareRow, sideBySide = L.sideBySide;
    var softLanes = L.softLanes || [];
    var tlBox = L.tl.getBoundingClientRect();
    /* A hidden tab or a collapsed pane measures zero, and sizing against that
     * would write nonsense. Leave the last good numbers alone - the observer
     * fires again the moment it has a real width. */
    if (tlBox.width < 1) return;
    var LEFT = 42, GAP = 4, HGAP = 6;

    /* ⚠️ Holds are sized and packed in PIXELS, not per cent - and this is the
     * ONLY place their geometry is decided.
     *
     * Two bugs came out of splitting it between CSS percentages and this pass.
     * The offset was a percentage of the timeline while the width is capped at
     * 260px by .tl-hold, so every pixel the window gained pushed the chips
     * further apart: "all the holds are gradually separating more from
     * eachother as i stretch the pge". And the width subtracted a 1.5% gap
     * while the packing added a 6px one, so on a phone a group of three
     * rendered ~1px wider than its band and reached back under the real event
     * beside it. Both are the same mistake - two unit systems describing one
     * row - so the percentages are now just what a chip wears until this runs.
     *
     * FIRST, because the real events below measure where the holds start. */
    /* ⚠️ The compact styling follows the WIDTH, not the lane count. A hold
     * that spans free columns is full size and must not wear .narrow's smaller
     * poster and type - and on a phone a lone hold is under 260px without
     * being squeezed by anything, so "did it hit the cap" is the wrong test
     * too. A chip is narrow when its own allowance is less than a lone hold's
     * allowance on this timeline, which needs no cap constant in here. */
    var lone = spaceSplit(0, 1).holdBand / 100 * tlBox.width;
    /* The room a LONE hold really takes: the 46% band, or .tl-hold's own
     * max-width where that is smaller. Measured with a throwaway chip so the
     * cap keeps living in the stylesheet - the same reason the packing pass
     * below measures instead of assuming 260. */
    var probe = document.createElement("div");
    probe.className = "tl-hold";
    probe.style.cssText = "position:absolute;visibility:hidden;top:0;width:" +
                          Math.round(lone) + "px";
    L.tl.appendChild(probe);
    var laneW = Math.round(probe.getBoundingClientRect().width) || Math.round(lone);
    L.tl.removeChild(probe);
    L.holdLanes.forEach(function (rec) {
      var col = (rec.band / 100 * tlBox.width - HGAP * (rec.lanes - 1)) / rec.lanes;
      var want = col * rec.span + HGAP * (rec.span - 1);
      rec.chip.style.width = Math.max(30, Math.round(want)) + "px";
      rec.chip.classList.toggle("narrow", want < lone);
    });
    /* Second pass: a chip is packed against the nearest hold it actually
     * CLASHES with, measured after that one has been placed - rightmost lane
     * first, so it always has been.
     *
     * ⚠️ Measured, not computed from the lane index. Two chips in one cluster
     * can have different column widths, because a real event under some of
     * the minutes shrinks the band there and not elsewhere: Bebe's columns are
     * 126px against UNDERGROUND's 168px on 28 Aug. Packing either one by its
     * OWN idea of a column put it 36px inside the other. */
    L.holdLanes.slice()
      .sort(function (a, b) { return b.lane - a.lane; })
      .forEach(function (rec) {
        var right = 0;
        L.holdLanes.forEach(function (o) {
          if (o === rec || o.lane <= rec.lane) return;
          if (Math.min(rec.en, o.en) - Math.max(rec.s, o.s) <= TOUCH_MIN) return;
          right = Math.max(right, Math.round(
            tlBox.right - o.chip.getBoundingClientRect().left) + HGAP);
        });
        rec.chip.style.right = right + "px";
      });

    if (shareRow.length || sideBySide.length) {
      var usable = Math.max(0, tlBox.width - LEFT);
      var shared = [];

      /* Back to the stylesheet first. sideBySide below bails out when the row
       * is too tight to divide, and without this that bail-out would leave the
       * PREVIOUS width in place - stale pixels surviving exactly the resize
       * this function exists to handle. */
      shareRow.concat(sideBySide).forEach(function (rec) {
        rec.item.style.left = rec.item.style.width = rec.item.style.right = "";
      });

      // A real event sharing its minutes with holds takes its share of the row,
      // left-packed. Never positioned relative to a chip, so a hold starting
      // early in the band can no longer squeeze it to a sliver.
      shareRow.forEach(function (rec) {
        /* ⚠️ FILL THE ROW. The holds are capped and right-aligned, so there is
         * dead space to their left - his report 2026-08-17, "physio and
         * stamptown should be filling all the available space". A real event
         * therefore runs from the gutter to wherever the nearest hold actually
         * starts, measured after layout rather than assumed.
         *
         * The share from spaceSplit() is the FLOOR, not the width: if the holds
         * come so far left that they would leave less than 40% (or 25% each
         * where two real events share), the real event keeps its floor and the
         * holds overlap it rather than the other way round. */
        var split = spaceSplit(rec.reals, rec.holds);
        /* ⚠️ Minus the gutter. The share is a percentage of the whole timeline
         * but the event starts at LEFT, so a bare 40% ran 42px past where the
         * holds begin - which put Video Work back on top of Seymour Mace on
         * 25 Aug. Measured, not reasoned: the overlap was exactly LEFT wide. */
        var floorPx = Math.max(0, tlBox.width * split.real / 100 - LEFT);
        var leftMost = Infinity;
        rec.chips.forEach(function (c) {
          if (c) leftMost = Math.min(leftMost, c.getBoundingClientRect().left);
        });
        var region = isFinite(leftMost)
          ? (leftMost - GAP) - (tlBox.left + LEFT)      // up to the nearest hold
          : tlBox.width - LEFT;                          // no geometry: whole row
        /* ⚠️ A soft block never takes the whole row: it stops where a lone
         * hold would begin, whether or not one is there, so there is ALWAYS a
         * clickable lane beside it - "if i got rid of tiny planet, the video
         * work event would stay that size", 2026-08-18. That is the lane's
         * MINIMUM; where holds have already pushed the block narrower, the
         * lane takes all of the room left over (see softLanes below). A hard
         * event is untouched by this and still fills the row. */
        if (rec.soft) {
          region = Math.min(region, tlBox.width - LEFT - laneW - GAP);
        }
        var slot = Math.max(floorPx, region / rec.reals);
        rec.item.style.left = Math.round(LEFT + rec.lane * (slot + GAP)) + "px";
        rec.item.style.width = Math.max(60, Math.round(slot - (rec.reals > 1 ? GAP : 0))) + "px";
        rec.item.style.right = "auto";
        shared.push(rec.item);
      });

      /* ⚠️ LAST, because it measures where the soft block actually ended -
       * which the pass above has only just decided. His note, 2026-08-18:
       * "you can have it fill the negative space as the video work event
       * alters based on the holds". On 25 Aug three holds push Video Work
       * narrow by lunchtime, and a fixed lane would have left most of the
       * afternoon as dead space between the two. The lane simply takes
       * everything to the right of the block; the hold chips sit over it,
       * which is the point - that is the space they share. */
      softLanes.forEach(function (rec) {
        var it = rec.ev && rec.ev._item;
        if (!it || !rec.label) return;
        var edge = it.getBoundingClientRect().right - tlBox.left;
        rec.label.style.left = Math.round(edge + GAP) + "px";
        rec.label.style.right = "0";
      });

      // Real events clashing with each other but with NO hold over them split
      // the whole row, as before.
      sideBySide.forEach(function (rec) {
        if (shared.indexOf(rec.item) >= 0) return;
        var w = (usable - GAP * (rec.lanes - 1)) / rec.lanes;
        if (w < 60) return;                           // too tight: leave stacked
        rec.item.style.left = Math.round(LEFT + rec.lane * (w + GAP)) + "px";
        rec.item.style.width = Math.round(w) + "px";
        rec.item.style.right = "auto";
      });
    }
  }

  /* Re-size the rows whenever the timeline's own width changes.
   *
   * ⚠️ A window "resize" listener alone is not enough. The four views are
   * rendered once and then shown and hidden, so the day is NOT rebuilt when he
   * comes back to it - resize the window while reading Browse and the calendar
   * would still be holding the old width when he switched back. A
   * ResizeObserver on the timeline itself catches both: the drag, and the
   * moment a hidden tab gets a real width again.
   *
   * rAF-throttled rather than debounced so the rows follow the window edge
   * while he drags it, instead of snapping into place a beat after he stops. */
  function watchTimelineWidth(tl) {
    if (!window.ResizeObserver) return;            // the window listener covers it
    if (!watchTimelineWidth._ro) {
      watchTimelineWidth._ro = new ResizeObserver(queueTimelineSize);
    }
    watchTimelineWidth._ro.disconnect();           // the old day's node is gone
    watchTimelineWidth._ro.observe(tl);
  }

  function queueTimelineSize() {
    if (queueTimelineSize._queued) return;
    queueTimelineSize._queued = true;
    function run() { queueTimelineSize._queued = false; sizeTimelineRows(); }
    if (window.requestAnimationFrame) window.requestAnimationFrame(run);
    else setTimeout(run, 16);
  }

  /* The fallback, and the belt to the observer's braces: a plain resize covers
   * browsers without ResizeObserver, and costs nothing where it is redundant
   * because the two share one rAF slot. */
  window.addEventListener("resize", queueTimelineSize);
  window.addEventListener("orientationchange", queueTimelineSize);

  /* How a slot's width is divided between REAL events and HOLDS.
   *
   * His rule, 2026-08-17, stated by example:
   *   "80% was correct IF it doesn't clash with a real event. If there is a
   *    real event, then it is 60%, and 40% goes to the real event. If there
   *    are 2 real events and 2 holds at the same time, they each have 25%. If
   *    a third hold appears clashing with 2 real events, the 2 real events
   *    keep 25% each and the holds split the remaining 50%."
   *
   * The rule that fits every one of those: a real event gets
   * max(25, 40 / nReal) per cent, and the holds split the remainder. With no
   * real event the holds keep the band they always had - a lone hold 46%, two
   * 52%, three or more 80% - because a hold is right-aligned and was never
   * meant to fill the row ("if there is no overlap, half width for the hold is
   * good though! don't change that", 2026-08-15).
   *
   * ⚠️ THREE OR MORE REAL EVENTS IS AN EXTRAPOLATION. He gave one and two.
   * The formula keeps the 25% floor, so three reals take 75% and the holds
   * share 25%. If that is wrong it is one number to change, here.
   */
  function spaceSplit(nReal, nHold) {
    /* No real event under them: holds keep the band they always had. */
    if (nReal <= 0) {
      return { real: 0, holdBand: nHold >= 3 ? 80 : nHold === 2 ? 52 : 46 };
    }
    /* His original shares, restored: a real event takes max(25, 40/nReal) per
     * cent whatever the hold count, so "Video Work" is 40% beside one hold or
     * five. Letting the hold count shrink it put that block at 26.7%, which is
     * the thing he spotted. The holds take the rest - and each chip is still
     * capped by .tl-hold's max-width, so none of them stretches to fill it. */
    var each = Math.max(25, 40 / nReal);
    return { real: each, holdBand: Math.max(0, 100 - each * nReal) };
  }

  // ----------------------------------------------------------- book now

  // ⚠️ "No dates left" has two very different causes and he should not have to
  // work out which: a run that has ENDED is nothing to chase, while a run
  // still going that is fully booked can release returns.
  function goneReason(f) {
    var last = (f.dates || []).map(function (d) { return d.date; }).sort().pop();
    var end = plan.showEnd || plan.tripEnd;
    if (!last) return "No dates on your trip";
    if (last < todayISO()) return "Run finished " + shortDate(last);
    if (last < plan.tripStart) return "Run finished before you arrive";
    var openLater = (f.dates || []).some(function (d) { return d.open && d.date <= end; });
    return openLater ? "Sold out on your dates" : "Sold out — returns still possible";
  }

  // ⚠️ "Tickets back" only existed in the Activity tab, which is the wrong
  // place for it to be alone: Book Next is where he decides what to buy, and a
  // sold-out favourite that has just reopened is the most actionable thing on
  // the page. Recent only - a return from ten days ago is history, not news.
  function ticketsBack(f) {
    var slug = f.href.split("/").pop();
    var cutoff = new Date(Date.now() - 7 * 86400000).toISOString();
    return (plan.alerts || []).filter(function (a) {
      return a.type === "availableAgain" && a.slug === slug && (a.at || "") >= cutoff;
    }).sort(function (a, b) { return (a.at || "") < (b.at || "") ? 1 : -1; })[0] || null;
  }

  /* ⚠️ A favourite that has just ADDED dates, his request 2026-08-15. It was
   * only in the Changed tab, and he found out about Josh Glanc adding the 29th
   * and 30th from EdFringe's website instead of from here - "this is the exact
   * scenario where I would have loved to know on the app easily".
   *
   * 48 hours, not the 7 days `ticketsBack` uses: a newly released date is worth
   * acting on while the good seats are there, and after two days it is simply
   * part of the run. He scans roughly daily, so 48 h also survives a missed scan.
   */
  function newDatesFor(f) {
    var slug = f.href.split("/").pop();
    var cutoff = new Date(Date.now() - 48 * 3600000).toISOString();
    return (plan.alerts || []).filter(function (a) {
      return a.type === "newDates" && a.slug === slug && (a.at || "") >= cutoff;
    }).sort(function (a, b) { return (a.at || "") < (b.at || "") ? 1 : -1; })[0] || null;
  }

  function favCard(f) {
    var c = el("button", "card fav" + (f.booked ? " booked" : "") +
                         (f.pendingFav ? " pendingfav" : "") +
                         (f.heldFav ? " heldfav" : "") +
                         (f.openOnTrip === 0 ? " nodates" : ""));

    var pcol = el("div", "postercol");
    var pic = poster(f.imageUrl);
    if (pic) pcol.appendChild(pic);
    if (f.fitsCount) {
      pcol.appendChild(el("span", "pill2 fit",
        f.fitsCount + (f.fitsCount === 1 ? " gap" : " gaps")));
    }
    c.appendChild(pcol);

    var left = el("div", "catbody");
    /* ⚠️ The regret order explains itself on the card ALREADY - his star is
     * the mark on the title, the gone-risk is the pill and bar, and whether it
     * fits is its own line. So priorityWhy is a tooltip, not a fourth row:
     * repeating all three in words would be exactly the duplication he called
     * clutter. Nothing is lost on the phone, where the components are visible
     * and a tooltip would not be. */
    if (f.priorityWhy) c.title = f.priorityWhy;
    var t = el("div", "ttl");
    if (f.booked) t.appendChild(el("span", "tag", "Booked"));
    else if (f.onlyChance) t.appendChild(el("span", "tag only", "Only chance"));
    var fslug = f.href.split("/").pop();
    var fstar = starMark(starOf(fslug), fslug);
    if (fstar) t.appendChild(fstar);
    var back = f.booked ? null : ticketsBack(f);
    if (back) t.appendChild(el("span", "tag back", "Tickets back"));
    var fresh = f.booked ? null : newDatesFor(f);
    if (fresh) {
      // The dates themselves, not just "new dates" - which ones decides
      // whether it is worth acting on, and they fit in the same space.
      var days = (fresh.dates || []).map(function (d) { return Number(d.slice(8)); });
      t.appendChild(el("span", "tag newdates",
        days.length ? "New: " + days.join(", ") + " Aug" : "New dates"));
    }
    t.appendChild(el("span", "ttltext", f.title));
    left.appendChild(t);
    left.appendChild(el("div", "sub",
      [f.venue, ampm(f.time), f.duration].filter(Boolean).join(" · ")));

    // One row instead of three: how sold out it is, the bar, and the exact
    // ratio. EdFringe publishes per-date allocation only, so this says
    // "dates", never "% sold".
    var state = el("div", "state");
    state.appendChild(el("span", "pill2 " + (urgClass(f) || "open"),
      f.scheduled ? f.depleted + "/" + f.scheduled + " dates gone" : "Run over"));
    var bar = el("span", "minibar " + urgClass(f));
    var i = el("i");
    i.style.width = Math.round((f.share || 0) * 100) + "%";
    bar.appendChild(i);
    state.appendChild(bar);
    left.appendChild(state);

    if (back) {
      var when2 = (back.dates || []).map(function (d) { return shortDate(d); }).join(", ");
      left.appendChild(el("div", "fit backline",
        "Tickets came back" + (when2 ? " for " + when2 : "") + " · " + when(back.at)));
    }
    if (f.booked) left.appendChild(el("div", "fit none", "Already in your calendar"));
    else if (!f.fitsCount && f.openOnTrip) {
      left.appendChild(el("div", "fit none",
        f.openOnTrip + " date" + (f.openOnTrip === 1 ? "" : "s") + " left, none fit"));
    } else if (!f.openOnTrip) {
      // Sold out and finished are different problems: one can still turn into
      // a ticket, the other never will.
      left.appendChild(el("div", "fit none", goneReason(f)));
    }
    c.appendChild(left);

    c.appendChild(calMonth(daysFromDates(f.dates), daysFromFits(f.opportunities),
                           f.dates.length, glanceTime(favDaysOf(f))));
    c.onclick = function () { showFav(f); };
    return c;
  }

  // ⚠️ A heart tapped in the app has to count IMMEDIATELY, whether or not
  // EdFringe has heard about it: the queue can sit unsynced for hours, and a
  // show he just starred going missing from Book Next reads as the tap not
  // working. Pending adds are built from the catalogue row into the same shape
  // build_plan.py produces; pending removals drop out at once.
  function favouritesNow() {
    var q = localFavs();
    var off = {}, on = {};
    q.forEach(function (f) { (f.want ? on : off)[f.slug] = f; });

    var list = plan.favourites.filter(function (f) {
      return !off[f.href.split("/").pop()];
    });
    var have = {};
    list.forEach(function (f) { have[f.href.split("/").pop()] = 1; });

    Object.keys(on).forEach(function (slug) {
      if (have[slug]) return;
      var r = catalogue && catalogue.shows.filter(function (x) { return x.s === slug; })[0];
      if (!r) return;                       // catalogue not loaded yet: no guessing
      list.push(favFromRow(r));
      have[slug] = 1;
    });

    // ⚠️ A hold IS an intention to book, so it belongs on Book Next whether or
    // not the show was ever starred. Holds made in the app, holds already in
    // his EdFringe planner, holds that came in through Google Calendar - all
    // of them, so nothing he has pencilled in can quietly go missing.
    heldSlugs().forEach(function (slug) {
      if (have[slug]) return;
      var r = catalogue && catalogue.shows.filter(function (x) { return x.s === slug; })[0];
      if (!r) return;
      var f = favFromRow(r);
      f.pendingFav = false;
      f.heldFav = true;
      list.push(f);
      have[slug] = 1;
    });
    return list;
  }

  // Every show he is holding a date for, from either source.
  function heldSlugs() {
    var out = {};
    plan.days.forEach(function (d) {
      d.events.forEach(function (e) {
        if (e.kind === "bookmarked" && e.href) out[e.href.split("/").pop()] = 1;
      });
    });
    localHolds().forEach(function (h) {
      if (!h.unhold && h.slug) out[h.slug] = 1;
    });
    return Object.keys(out);
  }

  // The same numbers build_plan.py computes, from the compact catalogue row -
  // including his own "Going fast" rule (75% of the run gone, or fewer than
  // four dates left), so a pending favourite is ranked like every other one.
  function favFromRow(r) {
    var today = todayISO(), month = plan.tripStart.slice(0, 8);
    var dates = (r.d || []).map(function (p) {
      var dd = p[0] < 10 ? "0" + p[0] : String(p[0]);
      return { date: month + dd, day: p[0],
               statusKey: p[1] === "n" ? "noAllocation" : "available",
               open: p[1] !== "n" && p[1] !== "x" };
    });
    var opportunities = (r.fit || []).map(function (f) {
      var dd = f[0] < 10 ? "0" + f[0] : String(f[0]);
      return { date: month + dd, time: r.tm, fits: true,
               beforeMin: f[1], afterMin: f[2] };
    });
    var openOnTrip = dates.filter(function (d) {
      return d.open && d.date >= today;
    }).length;
    var share = r.sch ? r.dep / r.sch : 0;
    var label = openOnTrip === 0 ? "Nothing left on your trip"
      : (share >= 0.75 || openOnTrip < 4) ? "Going fast"
      : share >= 0.5 ? "Filling up" : share > 0 ? "Some gone" : "Wide open";
    return {
      href: "/tickets/whats-on/" + r.s,
      url: "https://www.edfringe.com/tickets/whats-on/" + r.s,
      title: r.t, presenter: r.p || "", venue: r.v || "", space: "",
      venueNumber: "", genre: r.g || "", subGenres: r.sg || [], time: r.tm || "",
      duration: (r.dm || 60) + " min", durationMin: r.dm || 60,
      imageUrl: r.im || "", depleted: r.dep || 0, scheduled: r.sch || 0,
      share: share, dates: dates, opportunities: opportunities,
      fitsCount: (r.fit || []).length, openOnTrip: openOnTrip,
      onlyChance: openOnTrip === 1,
      urgency: openOnTrip ? Math.min(1, 0.65 * share + 0.35 * (1 / openOnTrip)) : 0,
      urgencyLabel: label, booked: !!r.bk, pendingFav: true
    };
  }

  function renderBook() {
    // A pending favourite is only knowable from the catalogue, so fetch it
    // once rather than leaving him staring at a list his tap is missing from.
    if (!catalogue && (localFavs().some(function (f) { return f.want; }) ||
                       heldSlugs().length)) {
      loadCatalogue().then(renderBook).catch(function () {});
    }
    var favs = favouritesNow();
    var fits = favs.filter(function (f) { return f.fitsCount > 0 && !f.booked; });
    var hero = $("#bookHero");
    hero.innerHTML = "";
    hero.appendChild(el("div", "big", String(fits.length)));
    hero.appendChild(el("div", "cap",
      "favourites you could book right now — they still have a date left, " +
      "and it lands in a gap you actually have"));
    // ⚠️ The headline counts what he could BOOK; the list also carries held
    // shows that no longer fit or have sold out, because he asked for holds to
    // always show. Two different questions, so the difference is stated rather
    // than left as a number that does not match the rows underneath it.
    var extra = favs.filter(function (f) {
      return !f.booked && f.heldFav && !(f.fitsCount > 0);
    }).length;
    if (extra) {
      hero.appendChild(el("div", "cap2",
        "Plus " + extra + " show" + (extra === 1 ? "" : "s") + " you are holding " +
        "that no longer fit" + (extra === 1 ? "s" : "") + " a gap or have sold " +
        "out — listed below, but not counted here."));
    }
    hero.appendChild(el("div", "cap2",
      "Ordered by what you would lose first: how much of the run is gone, and " +
      "how few chances you have left. " + dur(plan.stats.totalFreeMinutes) +
      " free across the trip."));

    var list = favs.filter(function (f) {
      // ⚠️ "All" is checked BEFORE the booked filter, deliberately. Every other
      // chip is about what he could still book, so a show he owns a ticket to
      // is noise there - but "all of my favourites" has to mean all of them,
      // tickets included, or the chip quietly hides the seven he has bought.
      // His request 2026-08-17.
      if (bookFilter === "all") return true;
      if (f.booked) return false;
      // ⚠️ Sold out is the one tab where nothing is exempt - it exists so that
      // NOTHING is missing from this page. Every other tab is about what he
      // could still book, so a hold is never filtered out of those.
      if (bookFilter === "gone") return f.openOnTrip === 0;
      // ⚠️ "Today" is the one tab a held show does NOT get a free pass on: the
      // question is what he can still see tonight, and a hold on the 24th is
      // not an answer to it.
      if (bookFilter === "today") return isTodayFav(f);
      if (f.heldFav) return true;
      if (bookFilter === "fits") return f.fitsCount > 0;
      if (bookFilter === "urgent") return f.urgencyLabel === "Going fast" && f.openOnTrip > 0;
      return f.openOnTrip > 0;
    }).filter(function (f) { return matchesGenre(f, "book"); });

    // The chips decide WHICH favourites; this decides their order. Default
    // stays "urgency", the order the page was built around, so nothing moves
    // unless he asks it to.
    if (bookSort !== "urgency") {
      list = list.slice().sort(function (a, b) {
        if (bookSort === "priority") {
          /* regret = want x gone-risk x can-I-actually-go, computed in
           * build_plan.py so there is ONE formula rather than a Python copy
           * and a JavaScript copy drifting apart. Ties fall back to urgency
           * then title, so the order is stable between renders. */
          var ap = a.priority || 0, bp = b.priority || 0;
          if (ap !== bp) return bp - ap;
          if ((a.urgency || 0) !== (b.urgency || 0)) {
            return (b.urgency || 0) - (a.urgency || 0);
          }
          return a.title.toLowerCase() < b.title.toLowerCase() ? -1 : 1;
        }
        if (bookSort === "title") {
          return a.title.toLowerCase() < b.title.toLowerCase() ? -1 : 1;
        }
        if (bookSort === "fits") return (b.fitsCount || 0) - (a.fitsCount || 0);
        if (bookSort === "depleted") return (b.share || 0) - (a.share || 0);
        if (bookSort === "ending") {
          var ae = lastScheduledDayFav(a), be = lastScheduledDayFav(b);
          if (ae !== be) return ae - be;
          return a.title.toLowerCase() < b.title.toLowerCase() ? -1 : 1;
        }
        if (bookSort === "time") {
          var at = fringeDayMin(a.time), bt = fringeDayMin(b.time);
          if (at !== bt) return at - bt;
          return a.title.toLowerCase() < b.title.toLowerCase() ? -1 : 1;
        }
        return 0;
      });
    }
    $("#bookCount").textContent =
      list.length + " of " + favs.length + " favourites";

    var box = $("#bookList");
    box.innerHTML = "";
    // ⚠️ An empty filter must say WHY it is empty. "Going fast" needs 85% of a
    // show's remaining dates to be gone, and on 15 Aug nothing of his is
    // close - an unexplained blank page reads as a broken app.
    if (!list.length) {
      var msg = "Nothing matches that filter.";
      if (bookFilter === "urgent") {
        var near = plan.favourites.filter(function (f) {
          return !f.booked && f.openOnTrip > 0;
        }).sort(function (a, b) { return b.share - a.share; })[0];
        msg = "Nothing of yours is 75% sold out or down to its last few dates" +
          (near ? " — the closest is " + near.title + " at " +
            Math.round(near.share * 100) + "% (" + near.depleted + " of " +
            near.scheduled + " dates gone)." : ".");
      }
      box.appendChild(el("div", "emptyday", msg));
    }
    /* ⚠️ Newly released dates go to the TOP, his request. They are the most
     * time-critical thing on the page: a date that appeared today still has
     * good seats, and by the time it reaches its natural place in the urgency
     * order it is no longer news. Order within each group is untouched, so
     * everything else stays where he expects it.
     *
     * Not on the Sold out filter - a show with no dates left cannot have
     * usefully gained one, and that tab exists to be complete, not urgent. */
    if (bookFilter !== "gone" && bookFilter !== "all") {
      var freshFirst = list.filter(function (f) { return newDatesFor(f); });
      if (freshFirst.length) {
        var rest = list.filter(function (f) { return !newDatesFor(f); });
        list = freshFirst.concat(rest);
      }
    }
    list.forEach(function (f) { box.appendChild(favCard(f)); });
  }

  // -------------------------------------------------------- lazy posters

  // Posters are hotlinked from EdFringe's image host. `loading="lazy"` alone
  // still let ~130 requests go out at once when a long list rendered, which on
  // venue wifi means a wall of grey boxes. This only sets src once a card is
  // actually near the viewport.
  function show(img) {
    if (img.dataset.src) { img.src = img.dataset.src; delete img.dataset.src; }
  }

  var seeing = ("IntersectionObserver" in window) && new IntersectionObserver(
    function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        seeing.unobserve(e.target);
        show(e.target);
      });
    }, { rootMargin: "300px 0px" });

  // ⚠️ An IntersectionObserver never fires where the viewport measures zero
  // height - some embedded web views report innerHeight 0, and every poster
  // then stays blank forever with no error to notice. A blank list is a worse
  // failure than an eager one, so anything still waiting after a moment is
  // loaded regardless.
  function sweepPending() {
    if (!seeing) return;
    setTimeout(function () {
      document.querySelectorAll("img.poster[data-src]").forEach(function (img) {
        if (!innerHeight || img.getBoundingClientRect().top < (innerHeight || 0) + 600) {
          seeing.unobserve(img);
          show(img);
        }
      });
    }, 1200);
  }

  function poster(url) {
    if (!url) return null;
    var img = el("img", "poster");
    img.alt = "";
    img.decoding = "async";
    img.onerror = function () { img.remove(); };
    if (seeing) { img.dataset.src = url; seeing.observe(img); sweepPending(); }
    else { img.loading = "lazy"; img.src = url; }
    return img;
  }

  // ---------------------------------------------------- calendar (month)

  // A real August grid, Monday-first, the way he asked for it: red circle the
  // Fringe allocation is gone, teal circle tickets are there, a plain number
  // the show is not on that day, and TODAY carries a ring so the whole thing
  // is legible at a glance without reading any dates.
  //
  // Rows start at the Monday of the week containing today (or the trip start,
  // whichever is earlier), so the first fortnight of August never eats space -
  // but today is always on the grid.
  var WEEKDAYS = ["M", "T", "W", "T", "F", "S", "S"];

  function calMonth(statusByDay, fitDays, shows, glance) {
    var wrap = el("div", "calm");
    var tight = window.matchMedia && window.matchMedia("(max-width: 560px)").matches;
    var t = todayISO();
    var todayDay = t.slice(0, 7) === plan.tripStart.slice(0, 7)
      ? Number(t.slice(8)) : -1;

    var last = Number((plan.showEnd || plan.tripEnd).slice(8));
    var from = Math.min(todayDay > 0 ? todayDay : 99, Number(plan.tripStart.slice(8)));

    // Monday-first column for a given day of this month.
    function col(day) {
      var js = new Date(plan.tripStart.slice(0, 8) + (day < 10 ? "0" + day : day)
                        + "T12:00:00Z").getUTCDay();     // 0=Sun
      return (js + 6) % 7;                                // 0=Mon
    }
    var start = from - col(from);                         // back to that Monday
    if (start < 1) start = 1;

    var head = el("div", "calm-head");
    var d = new Date(plan.tripStart + "T12:00:00Z");
    head.appendChild(el("span", "m",
      d.toLocaleDateString("en-GB", { month: "long", timeZone: "UTC" }) + " " +
      plan.tripStart.slice(0, 4)));
    if (shows != null) {
      // Count what is left, not what the run was - "12 shows" beside "11/11
      // gone" would be two numbers describing different things.
      var left = 0;
      Object.keys(statusByDay).forEach(function (d) {
        if (todayDay < 0 || Number(d) >= todayDay) left++;
      });
      // ⚠️ At 96px "6 shows left" overflowed the calendar by 4px. On a phone
      // the word "shows" carries nothing - the count and "left" do the work.
      head.appendChild(el("span", "n", tight ? left + " left"
        : left + (left === 1 ? " show left" : " shows left")));
    }
    wrap.appendChild(head);

    var grid = el("div", "calm-grid");
    WEEKDAYS.forEach(function (w) { grid.appendChild(el("i", "wd", w)); });
    for (var i = 0; i < col(start); i++) grid.appendChild(el("i", "pad"));

    for (var day = start; day <= last; day++) {
      var code = statusByDay[day];
      var cls = "dd";
      if (!code) cls += " none";
      else if (code === "n") cls += " gone";
      else if (code === "x") cls += " cxl";
      else cls += " open";
      if (todayDay > 0 && day < todayDay && code) cls += " past";
      if (day === todayDay) cls += " today";
      if (fitDays && fitDays[day] && !(todayDay > 0 && day < todayDay)) cls += " gapfit";
      grid.appendChild(el("i", cls, String(day)));
    }
    wrap.appendChild(grid);

    // The glance time, under the grid: bigger and bolder than anything else on
    // the card, because it is the one thing he wants without opening the sheet.
    if (glance && glance.time) {
      var line = el("div", "calmtime" + (glance.isToday ? " istoday" : ""));
      line.appendChild(el("b", null, short12(glance.time) +
        (glance.more > 0 ? " +" + glance.more : "")));
      line.appendChild(el("i", null, glance.isToday
        ? "today" : glance.day + " Aug"));
      wrap.appendChild(line);
    }
    return wrap;
  }

  function daysFromDates(dates) {
    var out = {};
    (dates || []).forEach(function (d) {
      if (d.date.slice(0, 7) !== plan.tripStart.slice(0, 7)) return;
      if (plan.showEnd && d.date > plan.showEnd) return;
      out[d.day] = d.statusKey === "cancelled" ? "x" : (d.open ? "o" : "n");
    });
    return out;
  }

  function daysFromFits(opps) {
    var out = {};
    (opps || []).forEach(function (o) { if (o.fits) out[Number(o.date.slice(8))] = 1; });
    return out;
  }

  // ----------------------------------------------------------- catalogue

  // ⚠️ Defaults match the chip marked is-on in index.html - set in BOTH places
  // or the page loads showing one filter and highlighting another.
  var catalogue = null, catLoading = null, browseFilter = "open",
      browseSort = "depleted", browseLimit = 60;

  // EdFringe's ten top-level genres, with the labels their own site uses -
  // the raw values are SCREAMING_SNAKE and three of them group more than the
  // word suggests (CIRCUS is where dance and physical theatre live).
  var GENRE_LABELS = {
    CABARET: "Cabaret and Variety",
    CHILDRENS_SHOWS: "Children's Shows",
    COMEDY: "Comedy",
    CIRCUS: "Dance, Physical Theatre & Circus",
    EVENTS: "Events",
    EXHIBITIONS: "Exhibitions",
    MUSIC: "Music",
    OPERA: "Musicals and Opera",
    SPOKEN_WORD: "Spoken Word",
    THEATRE: "Theatre"
  };
  var GENRE_ORDER = ["CABARET", "CHILDRENS_SHOWS", "COMEDY", "CIRCUS", "EVENTS",
                     "EXHIBITIONS", "MUSIC", "OPERA", "SPOKEN_WORD", "THEATRE"];

  // ⚠️ Shorter label for the PICKER only - EdFringe's own name for CIRCUS is
  // "Dance, Physical Theatre & Circus", the one long entry in an otherwise tidy
  // list. His call 2026-08-16. GENRE_LABELS keeps the full name, so searching
  // "physical theatre" still finds it.
  var GENRE_SHORT = { CIRCUS: "Dance & Circus" };

  // ⚠️ HIS list, not all 114. Taken from the sub-genres he ticked on EdFringe's
  // own filter (2026-08-16) - the rest are noise he asked not to see. Stand-up
  // and Solo show are the two big ones deliberately absent.
  var SUBGENRES = [
    "Absurdist", "Alternative Comedy", "Cabaret", "Character Comedy", "Circus",
    "Clown", "Comedy", "Dance", "Event", "Experimental", "Film",
    "Food and Drink", "Game Show", "Immersive", "Impressions", "Improv",
    "Magic", "Modern", "Multimedia", "Musical Comedy", "Musical Theatre",
    "Podcast", "Puppetry", "Variety", "Ventriloquism"
  ];

  // ⚠️ EdFringe publishes the SAME sub-genre in two casings and both are live:
  // "Alternative comedy" (122 shows) and "Alternative Comedy" (50). Ten pairs
  // do this. Every comparison here is lower-cased for that reason - matching
  // the string as given silently loses most of the shows.
  // One picker per view: Browse, Book Next and What Changed each keep their own
  // selection, so filtering one page never silently reshapes another.
  var GPICKS = {};

  function itemGenre(x) { return x.g || x.genre || ""; }
  function itemSubs(x) { return x.sg || x.subGenres || []; }

  function selCount(st) {
    return Object.keys(st.main).length + Object.keys(st.sub).length;
  }

  function matchesGenre(x, scope) {
    var st = GPICKS[scope];
    if (!st || !selCount(st)) return true;
    if (st.main[itemGenre(x)]) return true;
    var subs = itemSubs(x);
    for (var i = 0; i < subs.length; i++) {
      if (st.sub[String(subs[i]).toLowerCase()]) return true;
    }
    return false;
  }

  function genreBtnLabel(st) {
    var n = selCount(st);
    if (!n) return "All genres";
    var firstKey = Object.keys(st.main)[0];
    var first = Object.keys(st.main).length
      ? (GENRE_SHORT[firstKey] || GENRE_LABELS[firstKey])
      : SUBGENRES.filter(function (s) { return st.sub[s.toLowerCase()]; })[0];
    return n === 1 ? first : first + " +" + (n - 1);
  }

  function syncGenreBtn(scope) {
    var st = GPICKS[scope];
    st.btn.textContent = genreBtnLabel(st);
    st.btn.classList.toggle("is-on", selCount(st) > 0);
  }

  function buildGenrePanel(scope) {
    var st = GPICKS[scope];
    // ⚠️ The CARD does not scroll; an inner element does. With the background on
    // the scroller, WebKit painted it only for the region composited when the
    // panel opened - scroll down and the card appeared to end mid-list while the
    // rows carried on. Removing the blur did not help; the split is in the
    // scrolling layer itself. Reported twice, 2026-08-16.
    st.panel.innerHTML = "";
    var p = el("div", "gpickscroll");
    st.panel.appendChild(p);
    st.scroll = p;

    var head = el("div", "gpickhead");
    head.appendChild(el("b", null, "Genre"));
    var clear = el("button", "gpickclear", "Clear all");
    clear.type = "button";
    clear.onclick = function () {
      st.main = {}; st.sub = {};
      buildGenrePanel(scope); syncGenreBtn(scope); st.onChange();
    };
    head.appendChild(clear);
    p.appendChild(head);

    // Counts come from the list this view is actually showing, so a sub-genre
    // with nothing in it reads as 0 rather than posing as a useful filter.
    var mainN = {}, subN = {};
    (st.rowsFn() || []).forEach(function (x) {
      var g = itemGenre(x);
      if (g) mainN[g] = (mainN[g] || 0) + 1;
      itemSubs(x).forEach(function (sname) {
        var k = String(sname).toLowerCase();
        subN[k] = (subN[k] || 0) + 1;
      });
    });

    function addRow(label, on, count, toggle) {
      var b = el("button", "gpickrow" + (on ? " is-on" : ""));
      b.type = "button";
      b.appendChild(el("span", "gpickbox"));
      b.appendChild(el("span", null, label));
      b.appendChild(el("span", "gpickn", String(count || 0)));
      b.onclick = function () {
        toggle();
        buildGenrePanel(scope); syncGenreBtn(scope); st.onChange();
      };
      p.appendChild(b);
    }

    p.appendChild(el("div", "gpicksec", "Main genres"));
    GENRE_ORDER.forEach(function (key) {
      addRow(GENRE_SHORT[key] || GENRE_LABELS[key], !!st.main[key], mainN[key], function () {
        if (st.main[key]) delete st.main[key]; else st.main[key] = 1;
      });
    });

    p.appendChild(el("div", "gpicksec", "Sub-genres"));
    SUBGENRES.forEach(function (label) {
      var k = label.toLowerCase();
      addRow(label, !!st.sub[k], subN[k], function () {
        if (st.sub[k]) delete st.sub[k]; else st.sub[k] = 1;
      });
    });
  }

  // ⚠️ "Today" is the FRINGE day, not the calendar day - a 00:30 show belongs
  // to the night before, the same rule as night_of() in build_plan.py. His
  // spec, 2026-08-16: everything still to come today with an hour of leeway,
  // running all the way into what is technically tomorrow morning. So at 13:00
  // on Tuesday it opens at 12:00 and closes at 04:00 on Wednesday.
  //
  // Edinburgh time throughout, wherever he is - he flies from New York, and a
  // "Today" built on his phone's clock would be five hours out on the way over.
  var NIGHT_END_MIN = 4 * 60;
  var TODAY_LEEWAY_MIN = 60;

  function hhmmMin(hhmm) {
    if (!hhmm) return -1;
    var p = String(hhmm).split(":");
    var h = Number(p[0]), m = Number(p[1] || 0);
    return (isFinite(h) && isFinite(m)) ? h * 60 + m : -1;
  }

  // Minutes into the Fringe day, which starts in the morning and ends at 04:00:
  // 00:30 is 24:30, not half past midnight. No time at all sorts last.
  function fringeDayMin(hhmm) {
    var t = hhmmMin(hhmm);
    if (t < 0) return 99999;
    return t < NIGHT_END_MIN ? t + 24 * 60 : t;
  }

  // ⚠️ Works off the per-date sittings, not the show-level time: a show that
  // plays 13:25 and 23:10 today is still on tonight even though its headline
  // time has passed. Shared by Browse and Book Next so the two answer the same.
  function isTodayFromDays(days) {
    var nowMin = edinburghMinutes();
    var today = Number(todayISO().slice(8, 10));
    var cutoff = nowMin - TODAY_LEEWAY_MIN;

    function anyOn(day, test) {
      for (var i = 0; i < days.length; i++) {
        if (days[i].day !== day) continue;
        if (!days[i].open) return false;
        var ts = days[i].times || [];
        for (var j = 0; j < ts.length; j++) {
          var t = hhmmMin(ts[j]);
          if (t >= 0 && test(t)) return true;
        }
        return false;
      }
      return false;
    }

    // Between midnight and 04:00 it is still last night's Fringe day: all that
    // is left is dated today but before 04:00. And before 01:00 the leeway
    // reaches back over midnight, to a show that started last night.
    if (nowMin < NIGHT_END_MIN) {
      if (anyOn(today, function (t) {
            return t >= Math.max(cutoff, 0) && t < NIGHT_END_MIN; })) return true;
      return cutoff < 0 && anyOn(today - 1, function (t) {
        return t >= 24 * 60 + cutoff; });
    }

    // Daytime and evening: the rest of today, plus tonight's after-midnight
    // shows, which the catalogue dates to tomorrow.
    if (anyOn(today, function (t) { return t >= cutoff; })) return true;
    return anyOn(today + 1, function (t) { return t < NIGHT_END_MIN; });
  }

  function isTodayShow(r) { return isTodayFromDays(catDays(r)); }

  // ⚠️ "Ending soon" = the day of a show's LAST scheduled performance, so the
  // ones about to finish their run come first. His spec 2026-08-16: today's
  // closers, then tomorrow's, and so on.
  //
  // Cancelled dates are not performances and never count as the last one. A
  // show with nothing scheduled sinks to the bottom rather than posing as
  // ending today.
  function lastScheduledDay(cells) {
    var last = -1;
    (cells || []).forEach(function (c) {
      if (c[1] === "x") return;
      if (c[0] > last) last = c[0];
    });
    return last < 0 ? 99 : last;
  }

  function lastScheduledDayFav(f) {
    var last = -1;
    (f.dates || []).forEach(function (d) {
      if (d.statusKey === "cancelled") return;
      if (d.day > last) last = d.day;
    });
    return last < 0 ? 99 : last;
  }

  // "21:20" -> "9:20 PM". The long ampm() form carries the 24h clock in
  // brackets, which is right in a header and far too wide under a card's
  // month grid.
  function short12(hhmm) {
    var m = hhmmMin(hhmm);
    if (m < 0) return "";
    var h = Math.floor(m / 60) % 24, mi = m % 60;
    var suffix = h < 12 ? "AM" : "PM";
    var h12 = h % 12 === 0 ? 12 : h % 12;
    return h12 + ":" + (mi < 10 ? "0" + mi : mi) + " " + suffix;
  }

  // ⚠️ The time he actually needs at a glance: today's, if it is on today,
  // otherwise the next date it plays. His request 2026-08-16 - the sub line
  // keeps the show's usual time, this is the one that answers "what time is
  // this thing tonight".
  /* ⚠️ Skip sittings that have already happened. This took the day's EARLIEST
   * time with no past-filter, so at 22:00 Ania Magliano read "TONIGHT · 1:25 PM"
   * - nine hours gone, and the sold-out sitting at that. It uses the same
   * TODAY_LEEWAY_MIN the Today filter already uses, so a show stays glanceable
   * for an hour after curtain (he can still make a late entry) and then the
   * glance moves on to the next date it plays. One rule, shared. Preview 2 of
   * audit #3, 2026-08-16. */
  function glanceTime(days) {
    var today = Number(todayISO().slice(8, 10));
    var cutoff = edinburghMinutes() - TODAY_LEEWAY_MIN;

    // Tonight's after-midnight sittings are dated tomorrow but belong to now.
    function liveTimes(d) {
      var ts = (d.times || []).slice().sort();
      if (d.day !== today) return ts;
      return ts.filter(function (t) {
        var m = hhmmMin(t);
        if (m < 0) return false;
        return m < NIGHT_END_MIN ? true : m >= cutoff;
      });
    }

    var pick = null, picked = null;
    for (var i = 0; i < days.length; i++) {
      if (days[i].day !== today || !days[i].open) continue;
      var live = liveTimes(days[i]);
      if (live.length) { pick = days[i]; picked = live; }
      break;
    }
    if (!pick) {
      for (var j = 0; j < days.length; j++) {
        if (days[j].day > today && days[j].open && (days[j].times || []).length) {
          pick = days[j]; picked = days[j].times.slice().sort(); break;
        }
      }
    }
    if (!pick) return null;
    return { day: pick.day, time: picked[0], more: picked.length - 1,
             isToday: pick.day === today };
  }

  function favDaysOf(f) {
    return (f.dates || []).map(function (d) {
      return { day: d.day, open: d.open,
               times: (d.times && d.times.length) ? d.times
                      : (d.time ? [d.time] : (f.time ? [f.time] : [])) };
    });
  }

  function isTodayFav(f) { return isTodayFromDays(favDaysOf(f)); }

  function toggleGenrePanel(scope, open) {
    var st = GPICKS[scope];
    if (!st) return;
    var p = st.panel;
    var want = open === undefined ? p.classList.contains("is-hidden") : open;
    // ⚠️ Back to the top on OPEN only. Re-rendering after a tick keeps its
    // place - resetting there would throw him back to the top mid-selection -
    // but a reopen that lands halfway down the sub-genres hides "Clear all"
    // and the main genres entirely. Emptying innerHTML does not do this by
    // itself: the browser keeps scrollTop when the content comes straight back.
    if (want) { buildGenrePanel(scope); if (st.scroll) st.scroll.scrollTop = 0; }
    p.classList.toggle("is-hidden", !want);
    st.btn.setAttribute("aria-expanded", want ? "true" : "false");
    // Nothing behind an open list scrolls or takes a tap.
    document.documentElement.classList.toggle("modal-open",
      !!document.querySelector(".gpickpanel:not(.is-hidden)"));
  }

  function clearAllGenres() {
    var touched = false;
    Object.keys(GPICKS).forEach(function (k) {
      var st = GPICKS[k];
      if (!selCount(st)) return;
      st.main = {}; st.sub = {};
      syncGenreBtn(k);
      touched = true;
    });
    if (!touched) return;
    try { renderBook(); renderBrowse(); renderActivity(); } catch (e) {}
  }

  function closeAllGenrePanels() {
    Object.keys(GPICKS).forEach(function (k) { toggleGenrePanel(k, false); });
  }

  function initGenrePick(scope, root, rowsFn, onChange) {
    if (!root) return;
    var st = { main: {}, sub: {}, root: root,
               btn: root.querySelector(".gpickbtn"),
               panel: root.querySelector(".gpickpanel"),
               rowsFn: rowsFn, onChange: onChange };
    GPICKS[scope] = st;
    st.btn.onclick = function (e) { e.stopPropagation(); toggleGenrePanel(scope); };
    // ⚠️ Taps on a ROW must not reach the document handler that closes the
    // panel, or every checkbox would shut the list it lives in. But a tap on
    // the panel ITSELF is its scrim (the ::before covers the screen), and that
    // means "outside" - so it closes. His rule 2026-08-16: while it is open,
    // only its contents are live; tapping away just puts it back.
    st.panel.onclick = function (e) {
      if (e.target === st.panel || e.target === st.scroll) {
        toggleGenrePanel(scope, false); return;
      }
      e.stopPropagation();
    };
    syncGenreBtn(scope);
  }

  function idb(mode, fn) {
    return new Promise(function (res, rej) {
      var rq = indexedDB.open("fringe-planner", 1);
      rq.onupgradeneeded = function () { rq.result.createObjectStore("blobs"); };
      rq.onerror = function () { rej(rq.error); };
      rq.onsuccess = function () {
        var db = rq.result;
        var tx = db.transaction("blobs", mode);
        var out = fn(tx.objectStore("blobs"));
        tx.oncomplete = function () { db.close(); res(out && out.result); };
        tx.onerror = function () { db.close(); rej(tx.error); };
      };
    });
  }

  function fetchCatalogue() {
    if (isLocal()) {
      return fetch("data/catalogue-app.json", { cache: "no-store" })
        .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); });
    }
    var tk = token();
    if (!tk) return Promise.reject(new Error("no-token"));
    return fetch("https://api.github.com/repos/" + DATA_REPO + "/contents/catalogue-app.json", {
      cache: "no-store",
      headers: { Authorization: "Bearer " + tk, Accept: "application/vnd.github.raw" }
    }).then(function (r) {
      if (r.status === 401 || r.status === 403) throw new Error("bad-token");
      if (!r.ok) throw new Error(r.status);
      return r.json();
    });
  }

  // 1.4 MB, so it is fetched only when he opens Browse, and kept in IndexedDB
  // afterwards - localStorage is too small for it and this has to work in a
  // basement venue with no signal.
  function loadCatalogue() {
    if (catalogue) return Promise.resolve(catalogue);
    if (catLoading) return catLoading;
    catLoading = idb("readonly", function (s) { return s.get("catalogue"); })
      .catch(function () { return null; })
      .then(function (cached) {
        /* ⚠️ Shape-check the cached copy. A doc written by an older build can
         * lack `shows`, and renderBrowse() then throws BEFORE the network fetch
         * that would heal it - Browse dead, and pull-to-refresh reporting
         * "Could not reach GitHub" after a perfectly good plan fetch. The plan
         * path already self-heals; this one did not. Found by audit,
         * 2026-08-16. */
        if (cached && !(cached.shows && cached.shows.length)) cached = null;
        if (cached) { catalogue = cached; renderBrowse(); }
        return fetchCatalogue().then(function (doc) {
          catalogue = doc;
          idb("readwrite", function (s) { s.put(doc, "catalogue"); }).catch(function () {});
          return doc;
        }).catch(function (e) {
          if (cached) return cached;
          throw e;
        });
      })
      .then(function (doc) { catLoading = null; return doc; },
            function (err) {
              // ⚠️ Clear it on FAILURE too. Without this, a first Browse open
              // with no signal - basement, hotel captive portal - left a
              // permanently rejected promise here, and every later call
              // returned it instantly without ever retrying the network. Browse
              // stayed dead for the whole session, even once signal came back;
              // only relaunching the app recovered. Found by audit, 2026-08-16.
              catLoading = null;
              throw err;
            });
    return catLoading;
  }

  function catCard(r) {
    var c = el("button", "card cat" + (r.bk ? " booked" : ""));

    // The gap pill hangs under the poster rather than after the details: it
    // was costing every card a whole line of height, and the poster column
    // had empty space going spare.
    var pcol = el("div", "postercol");
    var pic = poster(r.im);
    if (pic) pcol.appendChild(pic);
    if (r.fit && r.fit.length) {
      pcol.appendChild(el("span", "pill2 fit",
        r.fit.length + (r.fit.length === 1 ? " gap" : " gaps")));
    }
    c.appendChild(pcol);

    var left = el("div", "catbody");
    var t = el("div", "ttl");
    if (r.bk) t.appendChild(el("span", "tag booked", "Booked"));
    else if (r.fav) t.appendChild(el("span", "tag fav", "Fave"));
    /* The catalogue lives in IndexedDB, not plan.json, so its published stars
     * are registered as the rows render. */
    notePublishedStar(r.s, r.st);
    var rstar = starMark(starOf(r.s), r.s);
    if (rstar) t.appendChild(rstar);
    t.appendChild(el("span", "ttltext", r.t));
    left.appendChild(t);
    left.appendChild(el("div", "sub",
      [venueShort(r.vn, r.v), timeLabel(tripTimes(catDays(r)), r.tm), r.dm + "m"]
      .filter(Boolean).join(" · ")));

    var gone = r.sch ? r.dep / r.sch : 0;
    var state = el("div", "state");
    var cls = !r.sch ? "none" : gone >= 1 ? "gone" : gone >= 0.75 ? "fast"
            : gone >= 0.5 ? "filling" : "open";
    state.appendChild(el("span", "pill2 " + cls,
      r.sch ? r.dep + "/" + r.sch + " dates gone" : "Run over"));
    left.appendChild(state);
    c.appendChild(left);

    var byDay = {}, fitDays = {};
    (r.d || []).forEach(function (p) { byDay[p[0]] = p[1] === "n" ? "n" : (p[1] === "x" ? "x" : "o"); });
    (r.fit || []).forEach(function (f) { fitDays[f[0]] = 1; });
    c.appendChild(calMonth(byDay, fitDays, (r.d || []).length, glanceTime(catDays(r))));

    c.onclick = function () { showCatShow(r); };
    return c;
  }

  function browseRows() {
    if (!catalogue) return [];
    var q = ($("#browseSearch").value || "").toLowerCase().trim();
    var rows = catalogue.shows.filter(function (r) {
      // ⚠️ The friendly genre label goes in the haystack as well as the raw
      // value: the raw one is "SPOKEN_WORD", so typing "spoken word" would
      // otherwise find nothing. Sub-genres are searchable too, which is how
      // "magic" or "puppetry" finds a show whose title never says so.
      if (q && (r.t + " " + r.p + " " + r.v + " " + r.g + " " +
                (GENRE_LABELS[r.g] || "") + " " + (r.sg || []).join(" "))
                .toLowerCase().indexOf(q) < 0) return false;
      if (!matchesGenre(r, "browse")) return false;
      var gone = r.sch ? r.dep / r.sch : 0;
      switch (browseFilter) {
        case "fav": return !!r.fav;
        case "fits": return r.fit && r.fit.length;
        case "open": return r.sch && gone < 1;
        case "today": return isTodayShow(r);
        case "fast": return r.sch && gone >= 0.75 && gone < 1;
        case "gone": return r.sch && gone >= 1;
        case "booked": return !!r.bk;
        default: return true;
      }
    });
    rows.sort(function (a, b) {
      if (browseSort === "title") return a.t.toLowerCase() < b.t.toLowerCase() ? -1 : 1;
      if (browseSort === "fits") return (b.fit || []).length - (a.fit || []).length;
      if (browseSort === "ending") {
        var ae = lastScheduledDay(a.d), be = lastScheduledDay(b.d);
        if (ae !== be) return ae - be;
        return a.t.toLowerCase() < b.t.toLowerCase() ? -1 : 1;
      }
      // ⚠️ Ordered by the FRINGE day, not the clock: anything before 04:00 is
      // the tail of the night before, so it sorts AFTER 23:55 rather than
      // first. Sorting the raw string instead put every after-midnight show at
      // the top of "Today", which reads as the first thing on and is the last.
      // A show with no time sinks to the bottom rather than posing as midnight.
      if (browseSort === "time") {
        var at = fringeDayMin(a.tm), bt = fringeDayMin(b.tm);
        if (at !== bt) return at - bt;
        return a.t.toLowerCase() < b.t.toLowerCase() ? -1 : 1;
      }
      var ag = a.sch ? a.dep / a.sch : -1, bg = b.sch ? b.dep / b.sch : -1;
      return bg - ag;
    });
    return rows;
  }

  function renderBrowse() {
    var box = $("#browseList");
    box.innerHTML = "";
    if (!catalogue) {
      box.appendChild(el("div", "emptyday", "Loading the catalogue…"));
      return;
    }
    var rows = browseRows();
    $("#browseCount").textContent =
      rows.length + " of " + catalogue.count + " shows on your dates";
    rows.slice(0, browseLimit).forEach(function (r) { box.appendChild(catCard(r)); });
    if (!rows.length) box.appendChild(el("div", "emptyday", "Nothing matches that."));
    $("#browseMore").classList.toggle("is-hidden", rows.length <= browseLimit);
    $("#browseMoreBtn").textContent =
      "Show more (" + (rows.length - browseLimit) + " left)";
  }

  // ---- holding a show -----------------------------------------------
  // Local first: the hold appears at once and survives offline. Holds live in
  // THIS app - nothing has written them to his EdFringe account since
  // 2026-08-15 (holdsync.py exists for when he explicitly asks). The queue is
  // how they reach his other devices, and the cloud refresh mirrors them into
  // the Edinburgh Planner Google calendar.
  var HOLD_KEY = "fringe-holds-v1";
  // ⚠️ Favourites are a queue for the same reason holds are: the app has to
  // work with EdFringe unreachable, and the heart has to answer instantly. The
  // queue records the INTENTION ({slug, want}) and syncs it between devices.
  // Nothing replays it onto EdFringe any more (reversed 2026-08-15;
  // favwrite.py exists for when he explicitly asks).
  var FAV_KEY = "fringe-favs-v1";

  function localFavs() {
    try { return JSON.parse(localStorage.getItem(FAV_KEY)) || []; }
    catch (e) { return []; }
  }

  // What EdFringe last told us, with anything he has changed since laid on top.
  function isFav(slug) {
    var pending = localFavs().filter(function (f) { return f.slug === slug; })
      .sort(function (a, b) { return (a.at || "") < (b.at || "") ? -1 : 1; }).pop();
    if (pending) return !!pending.want;
    return plan.favourites.some(function (f) {
      return f.href.split("/").pop() === slug;
    });
  }

  function setFav(slug, title, want) {
    var favs = localFavs().filter(function (f) { return f.slug !== slug; });
    favs.push({ slug: slug, title: title, want: want,
                at: new Date().toISOString() });
    try { localStorage.setItem(FAV_KEY, JSON.stringify(favs)); } catch (e) {}
    pushFavs(favs);
    return want;
  }

  function toggleFav(slug, title) {
    return setFav(slug, title, !isFav(slug), false);
  }

  // Same bridge the holds use: the Mac writes the file directly, the phone
  // writes it into the private repo. Without this a heart tapped on his phone
  // would sit in that phone's localStorage and never reach his other devices.
  function pushFavs(favs) {
    var done = syncOn("Syncing to GitHub");
    return pushFavsInner(favs).then(function (r) {
      done(r === "queued", r === "queued" ? "Synced" : "Saved on this device");
      return r;
    }, function (e) { done(false); throw e; });
  }

  function pushFavsInner(favs) {
    if (isLocal()) {
      return fetch("/api/favs", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ favs: favs })
      }).then(function (r) { return r.ok ? markPushed(FAV_KEY, favs) : "local-only"; })
        .catch(function () { return "local-only"; });
    }
    var tk = token();
    if (!tk) return Promise.resolve("local-only");
    var url = "https://api.github.com/repos/" + DATA_REPO + "/contents/favs.json";
    return fetch(url, { headers: { Authorization: "Bearer " + tk } })
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (meta) {
        /* ⚠️ KEEP THE REST OF THE DOCUMENT - the same bug pushHoldsInner had:
         * a fresh {favs, updatedAt} threw away every other top-level key the
         * relay copy carried, so the day favs.json gains a sibling of
         * clearedByTicket one heart tap here would have wiped it. The server
         * and pull_queues sides were fixed by audit #5; this was the phone's
         * half. Audit #6, 2026-08-18. */
        var doc = {};
        try {
          if (meta && meta.content) {
            doc = JSON.parse(decodeURIComponent(escape(atob(
              meta.content.replace(/\s/g, ""))))) || {};
          }
        } catch (e) { doc = {}; }
        doc.favs = favs;
        doc.updatedAt = new Date().toISOString();
        return fetch(url, {
          method: "PUT",
          headers: { Authorization: "Bearer " + tk, "Content-Type": "application/json" },
          body: JSON.stringify({
            message: "favourites: " + favs.length + " queued change(s)",
            content: btoa(unescape(encodeURIComponent(JSON.stringify(doc)))),
            sha: meta.sha
          })
        });
      })
      .then(function (r) { return r.ok ? markPushed(FAV_KEY, favs) : "local-only"; })
      .catch(function () { return "local-only"; });
  }

  /* ------------------------------------------------------------ his stars
   *
   * One star per show, tapped hollow -> silver -> gold -> hollow. It means the
   * SAME thing on both sides of the show: how far up his list it is - a
   * priority before he sees it ("everyone says this is a must-see"), a verdict
   * after. His call 2026-08-23; see STARS.md.
   *
   * ⚠️ A star NEVER touches edfringe.com, and starring never favourites. He
   * decided the two are separate things, so a starred non-favourite is a
   * legitimate state - do not "fix" it by calling into the fav queue here.
   *
   * ⚠️ APPEND-ONLY EVENT LOG. The live star for a show is the newest event for
   * that slug; the earlier ones are the history he never sees. That is what
   * makes the merge a union, so two devices that rated the same show offline
   * both keep their history instead of the newer record erasing the older.
   */
  var RATING_KEY = "fringe-ratings-v1";

  /* ⚠️ AN EVENT STAMPED IN THE FUTURE IS INVALID, and is dropped on sight.
   *
   * Learned the hard way on 2026-08-23. Five Claude test events escaped a
   * sandbox onto the relay, and two carried instants an hour ahead of the
   * clock. Under newest-wins a future stamp beats everything he can ever tap:
   * the button painted the new value, then snapped back on the next read, and
   * 21 consecutive taps recorded a value that never stuck.
   *
   * A blocklist of the offending shows was the first fix and was WRONG - it
   * put his slugs and dates into app.js, which ships to the PUBLIC repo, and
   * deploy.sh rightly refused it. This rule is better anyway: it names
   * nothing, and it kills the whole class rather than the five instances.
   *
   * SKEW_MS covers ordinary clock drift between his devices; beyond that the
   * stamp is not drift, it is wrong.
   */
  var SKEW_MS = 120000;

  function futureStamped(r) {
    if (!r || !r.at) return false;
    var ms = Date.parse(r.at);
    return !isNaN(ms) && ms > Date.now() + SKEW_MS;
  }

  function localRatings() {
    var raw;
    try { raw = JSON.parse(localStorage.getItem(RATING_KEY)) || []; }
    catch (e) { return []; }
    var clean = raw.filter(function (r) { return !futureStamped(r); });
    if (clean.length !== raw.length) {
      try { localStorage.setItem(RATING_KEY, JSON.stringify(clean)); } catch (e) {}
    }
    return clean;
  }

  // Instants, not text - a "+01:00" stamp sorts after a later "Z" one as a
  // string. The same trap the holds and favs queues both hit.
  function ratingStamp(r) {
    var ms = Date.parse((r && r.at) || "");
    return isNaN(ms) ? 0 : ms;
  }

  // 0 hollow, 1 silver, 2 gold.
  /* What the last build published, keyed by slug. The local log is the
   * authority - this only answers for a device whose log has not arrived yet,
   * so a star set on the Mac is visible on the phone before the queues sync.
   * A local event ALWAYS wins, including one that sets the star back to
   * hollow, or clearing a star would silently undo itself. */
  function notePublishedStar(slug, star) {
    if (slug && star) publishedStars[slug] = star;
  }

  function indexPublishedStars() {
    if (!plan) return;
    (plan.favourites || []).forEach(function (f) {
      if (f && f.star && f.href) notePublishedStar(f.href.split("/").pop(), f.star);
    });
    (plan.days || []).forEach(function (d) {
      (d.events || []).forEach(function (e) {
        if (e && e.star && e.href) notePublishedStar(e.href.split("/").pop(), e.star);
      });
    });
  }

  function starOf(slug) {
    // A tap not yet settled is still what he last chose - the UI shows it, and
    // the next tap cycles on from it.
    var pend = pendingStars()[slug];
    if (pend) return pend.star || 0;
    var best = null, seen = false;
    localRatings().forEach(function (r) {
      if (!r || r.slug !== slug) return;
      seen = true;
      if (!best || ratingStamp(r) > ratingStamp(best)) best = r;
    });
    if (seen) return best ? (best.star || 0) : 0;
    return publishedStars[slug] || 0;
  }

  /* ------------------------------------------------ the settle window
   *
   * His request 2026-08-23: "maybe only record the change if the change has
   * stayed for more than 1 minute so you know it's not just a toggle."
   *
   * A tap PAINTS immediately, as it always did. What waits is the RECORD. The
   * value has to sit still for a minute before an event is appended, so the
   * intermediate states of a cycle - and an accidental double tap - never
   * reach the log at all.
   *
   * ⚠️ This is worth more than tidiness. The history is what tells the
   * recommender "buzz said gold, he came out silver"; a log full of half-second
   * intermediate states would make that signal noise.
   *
   * ⚠️ AND IT MUST NEVER LOSE A RATING. The pending value is written to disk on
   * the tap, not held in a timer, so closing the app one second later still
   * records it - committed on the next load, stamped with the instant he
   * actually tapped rather than the instant we noticed.
   *
   * A cycle that ends where it started records NOTHING, which is correct: no
   * net change happened. */
  var PENDING_KEY = "fringe-ratings-pending-v1";
  var SETTLE_MS = 60000;
  var settleTimers = {};

  function pendingStars() {
    try { return JSON.parse(localStorage.getItem(PENDING_KEY)) || {}; }
    catch (e) { return {}; }
  }

  function writePending(map) {
    try { localStorage.setItem(PENDING_KEY, JSON.stringify(map)); } catch (e) {}
  }

  // What the log actually holds for this show, ignoring anything pending.
  function recordedStar(slug) {
    var best = null, seen = false;
    localRatings().forEach(function (r) {
      if (!r || r.slug !== slug) return;
      seen = true;
      if (!best || ratingStamp(r) > ratingStamp(best)) best = r;
    });
    if (seen) return best ? (best.star || 0) : 0;
    return publishedStars[slug] || 0;
  }

  /* Append the settled value, unless it matches what is already recorded - a
   * tap out and back is not a change, and a 0 on a show that was never rated
   * is not an event. */
  function commitStar(slug) {
    var map = pendingStars();
    var p = map[slug];
    if (!p) return;
    delete map[slug];
    writePending(map);
    if (settleTimers[slug]) {
      clearTimeout(settleTimers[slug]);
      delete settleTimers[slug];
    }
    if (p.star === recordedStar(slug)) return;      // ended where it started
    var log = localRatings();
    log.push({ slug: slug, title: p.title, star: p.star, at: p.at });
    try { localStorage.setItem(RATING_KEY, JSON.stringify(log)); } catch (e) {}
    pushRatings(log);
  }

  /* Anything whose minute elapsed while the app was closed. Run at boot. */
  function commitSettledStars() {
    var map = pendingStars(), now = Date.now();
    Object.keys(map).forEach(function (slug) {
      var p = map[slug];
      if (!p || !p.at) return;
      if (now - Date.parse(p.at) >= SETTLE_MS) commitStar(slug);
      else armSettle(slug, SETTLE_MS - (now - Date.parse(p.at)));
    });
  }

  function armSettle(slug, ms) {
    if (settleTimers[slug]) clearTimeout(settleTimers[slug]);
    settleTimers[slug] = setTimeout(function () { commitStar(slug); },
                                    ms == null ? SETTLE_MS : ms);
  }

  function setStar(slug, title, star) {
    var map = pendingStars();
    // ⚠️ Keep the ORIGINAL instant across a re-tap within the window, so the
    // record says when he started deciding, not when he stopped fiddling.
    var at = (map[slug] && map[slug].at) || new Date().toISOString();
    map[slug] = { star: star, title: title, at: at };
    writePending(map);
    armSettle(slug);
    return star;
  }

  function cycleStar(slug, title) {
    return setStar(slug, title, (starOf(slug) + 1) % 3);
  }

  // Union on (slug, at) - an event log merges by keeping everything, which is
  // why it cannot lose the other device's history.
  function mergeRatings(remote) {
    var byid = {};
    localRatings().concat(remote || []).forEach(function (r) {
      if (!r || !r.slug || !r.at) return;
      byid[r.slug + "|" + r.at] = r;
    });
    var merged = Object.keys(byid).map(function (k) { return byid[k]; });
    try { localStorage.setItem(RATING_KEY, JSON.stringify(merged)); } catch (e) {}
    return merged;
  }

  function fetchRatings() {
    if (isLocal()) {
      return fetch("data/ratings.json", { cache: "no-store" })
        .then(function (r) { return r.ok ? r.json() : {}; })
        .then(function (d) { return d.ratings || []; })
        .catch(function () { return []; });
    }
    var tk = token();
    if (!tk) return Promise.resolve([]);
    return fetch("https://api.github.com/repos/" + DATA_REPO + "/contents/ratings.json", {
      cache: "no-store",
      headers: { Authorization: "Bearer " + tk, Accept: "application/vnd.github.raw" }
    }).then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (d) { return d.ratings || []; })
      .catch(function () { return []; });
  }

  // Same bridge holds and favourites use: the Mac writes the file directly,
  // the phone writes it into the private repo.
  function pushRatings(log) {
    var done = syncOn("Syncing to GitHub");
    return pushRatingsInner(log).then(function (r) {
      done(r === "queued", r === "queued" ? "Synced" : "Saved on this device");
      return r;
    }, function (e) { done(false); throw e; });
  }

  function pushRatingsInner(log) {
    if (isLocal()) {
      return fetch("/api/ratings", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ratings: log })
      }).then(function (r) { return r.ok ? markPushed(RATING_KEY, log) : "local-only"; })
        .catch(function () { return "local-only"; });
    }
    var tk = token();
    if (!tk) return Promise.resolve("local-only");
    var url = "https://api.github.com/repos/" + DATA_REPO + "/contents/ratings.json";
    return fetch(url, { headers: { Authorization: "Bearer " + tk } })
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (meta) {
        /* ⚠️ KEEP THE REST OF THE DOCUMENT - holds, favs and the server side
         * all had to learn this. A fresh {ratings, updatedAt} throws away
         * every other top-level key the relay copy carries. */
        var doc = {};
        try {
          if (meta && meta.content) {
            doc = JSON.parse(decodeURIComponent(escape(atob(
              meta.content.replace(/\s/g, ""))))) || {};
          }
        } catch (e) { doc = {}; }
        /* Union against what the relay already holds, so a device pushing a
         * short log cannot truncate another device's history. */
        var byid = {};
        (doc.ratings || []).concat(log || []).forEach(function (r) {
          if (r && r.slug && r.at) byid[r.slug + "|" + r.at] = r;
        });
        doc.ratings = Object.keys(byid).map(function (k) { return byid[k]; });
        doc.updatedAt = new Date().toISOString();
        var body = { message: "ratings: " + doc.ratings.length + " event(s)",
                     content: btoa(unescape(encodeURIComponent(JSON.stringify(doc)))) };
        if (meta && meta.sha) body.sha = meta.sha;
        return fetch(url, {
          method: "PUT",
          headers: { Authorization: "Bearer " + tk, "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
      })
      .then(function (r) { return r.ok ? markPushed(RATING_KEY, log) : "local-only"; })
      .catch(function () { return "local-only"; });
  }

  function starIcon() {
    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("class", "str");
    var path = document.createElementNS(ns, "path");
    path.setAttribute("d", "M12 2.6l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3-5.8 3 " +
      "1.1-6.5L2.6 9.4l6.5-.9z");
    svg.appendChild(path);
    return svg;
  }

  /* ⚠️ THE WORDS FOLLOW WHETHER HE HAS SEEN IT - his instruction 2026-08-23:
   * "the star should only say 'liked it' 'loved it' if it was a show I already
   * saw". The VALUE is one thing either way (how far up his list this show is);
   * only the caption changes, because before the show that value is a
   * prediction and after it is a verdict. Calling an unseen show "Loved it"
   * would be the app asserting something he never said.
   *
   * The unseen wording is deliberately the "Must see / Should see" language of
   * the priority labels he designed and paused - this is where it landed. */
  var STAR_WORDS_SEEN   = ["Rate", "Liked it", "Loved it"];
  var STAR_WORDS_UNSEEN = ["Priority", "Should see", "Must see"];

  /* Seen means he had a TICKET and the sitting has finished. A hold is not
   * attendance, and this is the same narrow definition the recommender's
   * inferred negative uses - widening it in one place and not the other is
   * exactly the bug shape this repo keeps hitting. */
  function hasSeen(slug) {
    if (!plan || !plan.days) return false;
    var now = Date.now();
    for (var i = 0; i < plan.days.length; i++) {
      var evs = plan.days[i].events || [];
      for (var j = 0; j < evs.length; j++) {
        var e = evs[j];
        if (e.kind !== "show" || !e.href) continue;
        if (e.href.split("/").pop() !== slug) continue;
        if (Date.parse(e.end) < now) return true;
      }
    }
    return false;
  }

  function starWords(slug) {
    return hasSeen(slug) ? STAR_WORDS_SEEN : STAR_WORDS_UNSEEN;
  }

  /* ⚠️ The tap paints the new state IMMEDIATELY and the push is never what
   * gates the feedback. An 8.6 s push once made a second tap undo the first,
   * because nothing had moved on screen yet. */
  function starButton(slug, title) {
    var b = el("button", "starbtn");
    b.appendChild(starIcon());
    b.appendChild(el("span"));
    var words = starWords(slug);
    function paint(v) {
      b.className = "starbtn s" + v;
      b.querySelector("span").textContent = words[v];
      b.setAttribute("aria-label", v ? words[v] : "Not rated");
      b.title = v ? words[v] : (hasSeen(slug) ? "Tap to rate"
                                              : "Tap to set a priority");
    }
    paint(starOf(slug));
    b.onclick = function (ev) {
      ev.stopPropagation();
      paint(cycleStar(slug, title));
      // Book Next and the day timeline show the star too, so they have to
      // repaint - the same courtesy the heart does.
      if (typeof renderBook === "function") renderBook();
      if (typeof renderDays === "function") renderDays();
    };
    return b;
  }

  // Display only: the small star that rides along on a list row. Returns null
  // for an unrated show so a hollow outline never clutters 3,400 browse rows.
  /* The score build_plan.py computed. A favourite he hearted seconds ago has
   * none until the next rebuild, so it is derived here from the constants the
   * PLAN ships - never from numbers written into this file, which is the
   * duplication that has bitten the urgency formula. */
  function priorityOf(f) {
    if (f && f.priority != null) return f.priority;
    if (!f || !plan || !plan.priorityConstants) return 0;
    var K = plan.priorityConstants;
    var st = starOf((f.href || "").split("/").pop());
    var want = (K.wantByStar || [])[st] || 0;
    var risk = f.urgency || 0;
    if (st === 2) risk = Math.max(risk, K.goldUrgencyFloor || 0);
    var feasible = f.fitsCount ? 1 : (K.noGapFactor || 0);
    return want * risk * feasible;
  }

  function starMark(v, slug) {
    if (!v) return null;
    var m = el("span", "starmark s" + v);
    m.appendChild(starIcon());
    m.title = starWords(slug)[v];
    return m;
  }

  function heartIcon() {
    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("class", "hrt");
    var path = document.createElementNS(ns, "path");
    path.setAttribute("d", "M12 21s-7.5-4.6-9.3-9A5.3 5.3 0 0 1 12 6.6 5.3 5.3 0 0 1 " +
      "21.3 12c-1.8 4.4-9.3 9-9.3 9z");
    svg.appendChild(path);
    return svg;
  }

  // The heart itself: instant locally, shared to his other devices through
  // the queue. (Nothing replays it onto EdFringe - reversed 2026-08-15.)
  function favButton(slug, title) {
    var b = el("button", "favbtn" + (isFav(slug) ? " on" : ""));
    b.appendChild(heartIcon());
    b.appendChild(el("span", null, isFav(slug) ? "Favourite" : "Add to favourites"));
    b.setAttribute("aria-pressed", isFav(slug) ? "true" : "false");
    b.onclick = function (ev) {
      ev.stopPropagation();
      var on = toggleFav(slug, title);
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
      b.querySelector("span").textContent = on ? "Favourite" : "Add to favourites";
      // Book Next, the day timeline and the gap sheets all read favourites,
      // so they all have to hear about this now - not at the next sync.
      renderBook();
      renderDays();
    };
    return b;
  }

  function localHolds() {
    try { return JSON.parse(localStorage.getItem(HOLD_KEY)) || []; }
    catch (e) { return []; }
  }

  // The queue is shared, not per-device. Holds made on the Mac show on the
  // phone and vice versa, without waiting for EdFringe to be reachable - which
  // matters precisely when it is not.
  /* ⚠️ Compare as INSTANTS, not as text. Seven records carry a "+01:00" offset
   * instead of "Z" (they were written by a path that used local time), and
   * "…T14:00:00+01:00" sorts AFTER "…T14:30:00Z" as a string while being half
   * an hour earlier in fact. Last-action-wins runs on this, so a stale hold
   * could out-rank the release that came after it. Audit, 2026-08-16. */
  function stampOf(h) {
    var raw = h.removedAt || h.unheldAt || h.addedAt || h.heldAt || "";
    if (!raw) return 0;
    var ms = Date.parse(raw);
    return isNaN(ms) ? 0 : ms;
  }

  function mergeHolds(remote) {
    var byKey = {};
    // ⚠️ Keyed on (slug, date, TIME), like tools/pull_queues.py and server.py.
    // This was the FOURTH merge path and it was missed when holds were re-keyed:
    // it runs on every app load, collapsed both sittings of a two-sitting day to
    // one, and wrote that back to localStorage - which the phone then PUTs over
    // the whole relay file. Two live holds were in that state when it was found
    // (Ania Magliano 17 Aug, The Duo 28 Aug). Found by audit, 2026-08-16.
    localHolds().concat(remote || []).forEach(function (h) {
      if (!h || !h.slug || !h.date) return;
      var k = h.slug + "|" + h.date + "|" + (h.time || "");
      var prev = byKey[k];
      // Last action wins, so releasing on one device is not undone by an
      // older hold sitting in another device's copy.
      if (!prev || stampOf(h) > stampOf(prev)) byKey[k] = h;
    });
    // ⚠️ A tombstone with NO time is a blanket release - written when this
    // device has no local row for the hold (one made on the other device, or
    // imported through the plan). Under the old key it beat the live record;
    // under the new one it lands on its own key and the live sitting survived
    // as a zombie. So it retires every older sitting on that date explicitly.
    Object.keys(byKey).forEach(function (k) {
      var t = byKey[k];
      if (!t.unhold || (t.time || "")) return;
      Object.keys(byKey).forEach(function (k2) {
        var other = byKey[k2];
        if (k2 === k || other.slug !== t.slug || other.date !== t.date) return;
        if (stampOf(other) < stampOf(t)) delete byKey[k2];
      });
    });
    /* Tombstones are kept so a stale copy on another device cannot resurrect
     * something he released; after that they are just noise.
     *
     * ⚠️ 30 days, not 7. The festival is 15 days long, so a week-old cutoff sat
     * INSIDE the window it has to protect: a device that went quiet for eight
     * days - a dead phone, a long flight, airplane mode - could come back
     * holding the original "held" record with nothing left to out-rank it. The
     * relay never prunes, which is the only reason this never bit. 30 days
     * covers the whole trip with margin either side. Audit, 2026-08-16. */
    var TOMB_DAYS = 30;
    var cutoff = Date.now() - TOMB_DAYS * 86400000;   // stampOf() returns ms
    var merged = Object.keys(byKey).map(function (k) { return byKey[k]; })
      .filter(function (h) { return !(h.unhold && stampOf(h) < cutoff); });
    try { localStorage.setItem(HOLD_KEY, JSON.stringify(merged)); } catch (e) {}
    return merged;
  }

  function fetchHolds() {
    if (isLocal()) {
      return fetch("data/holds.json", { cache: "no-store" })
        .then(function (r) { return r.ok ? r.json() : {}; })
        .then(function (d) { return d.holds || []; })
        .catch(function () { return []; });
    }
    var tk = token();
    if (!tk) return Promise.resolve([]);
    return fetch("https://api.github.com/repos/" + DATA_REPO + "/contents/holds.json", {
      cache: "no-store",
      headers: { Authorization: "Bearer " + tk, Accept: "application/vnd.github.raw" }
    }).then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (d) { return d.holds || []; })
      .catch(function () { return []; });
  }

  /* -------------------------------------------------------------- TICKETS
   * The QR code the door actually scans, on the phone, offline - his request
   * 2026-08-22: "tap on the purchased showtime on my calendar, click a ticket
   * button and then see the QR code".
   *
   * ⚠️ ONE CODE CAN COVER SEVERAL SHOWS. Assembly's email says so outright, so
   * the badge reports what the order covers rather than implying one QR = one
   * show. plan.json carries only the ADDRESS of the barcode ({order, covers,
   * ...}); the images live in tickets.json, fetched once and cached, so an
   * ordinary sync is not dragging a PNG per show around.
   *
   * ⚠️ CACHED DELIBERATELY. He opens this in a venue queue, on festival wifi,
   * possibly with no signal at all. Whatever was last fetched must still be
   * showable with the network flatly gone, so the store is written to
   * localStorage and read from there first, exactly like the plan itself.
   */
  var TICKET_KEY = "fringe-tickets";
  var ticketStore = null;

  function cachedTickets() {
    try { return JSON.parse(localStorage.getItem(TICKET_KEY) || "null"); }
    catch (e) { return null; }
  }

  function fetchTickets() {
    var keep = function (d) {
      var doc = (d && d.orders) ? d : { orders: [] };
      ticketStore = doc;
      cacheTickets(doc);
      return doc;
    };
    if (isLocal()) {
      return fetch("data/tickets.json", { cache: "no-store" })
        .then(function (r) { return r.ok ? r.json() : {}; })
        .then(keep).catch(function () { return ticketStore || { orders: [] }; });
    }
    var tk = token();
    if (!tk) return Promise.resolve(ticketStore || { orders: [] });
    return fetch("https://api.github.com/repos/" + DATA_REPO + "/contents/tickets.json", {
      cache: "no-store",
      headers: { Authorization: "Bearer " + tk, Accept: "application/vnd.github.raw" }
    }).then(function (r) { return r.ok ? r.json() : {}; })
      .then(keep).catch(function () { return ticketStore || { orders: [] }; });
  }

  /* ⚠️ A FULL localStorage must never mean no ticket at the door. Safari gives
   * an origin ~5MB and the plan, catalogue and holds are already in there, so
   * a store that has grown all festival can be the straw that breaks it. On a
   * quota failure the past is dropped - orders whose every sitting has already
   * happened - and it tries again, because a barcode for last Tuesday is the
   * one thing here that can be spared. Nothing is deleted from the STORE, only
   * from this device's offline copy; the full file stays in the data repo. */
  function cacheTickets(doc) {
    var write = function (d) {
      localStorage.setItem(TICKET_KEY, JSON.stringify(d));
    };
    try { write(doc); return true; } catch (e) {}
    var today = todayISO();
    var future = (doc.orders || []).filter(function (o) {
      return (o.items || []).some(function (it) { return (it.date || "") >= today; });
    });
    try {
      write({ orders: future, generatedAt: doc.generatedAt, trimmed: true });
      return true;
    } catch (e2) {
      return false;
    }
  }

  function ticketOrder(id) {
    var doc = ticketStore || (ticketStore = cachedTickets()) || { orders: [] };
    var hits = (doc.orders || []).filter(function (o) { return o.id === id; });
    return hits[0] || null;
  }

  /* What the badge says: how many tickets he holds FOR THIS SITTING - his
   * correction 2026-08-22, "only display 2 tickets if i actually bought 2
   * tickets in the order".
   *
   * ⚠️ NOT what the order covers. One code can admit him to several shows
   * (that order bought this one and Kirsty Mann on the 24th), and the badge
   * first read "2 TICKETS · 2 SHOWS" at a door where he is one person seeing
   * one show. The other show has its own ticket screen showing the same code,
   * so nothing is lost by answering the question actually being asked here. */
  function ticketBadgeText(rec) {
    var n = (rec && rec.tickets) || 1;
    return n + (n === 1 ? " TICKET" : " TICKETS");
  }

  // ⚠️ A hold is identified by (slug, date, TIME) since 2026-08-16: he can hold
  // more than one sitting on the same day, and CAI runs six times on the 19th.
  // Passing no time asks the old question - "is anything held that day" - which
  // is still what a cell's colour needs.
  function matchesHold(h, slug, date, time) {
    if (h.slug !== slug || h.date !== date) return false;
    // A record with no time is legacy or a blanket release: it answers for the
    // whole date rather than for one sitting.
    if (!time || !h.time) return true;
    return h.time === time;
  }

  function isHeld(slug, date, time) {
    /* ⚠️ Per SITTING, not per day - his rule 2026-08-17: a ticket spends only
     * the sitting it is for ("the only showtime i cannot re-add a hold to is
     * the time of the actual ticketed event"). This used to return false for
     * the WHOLE ticketed day, so the other sitting holdableSlots() correctly
     * offered could be held but never read as held: the picker chip never said
     * "held", every extra tap ADDED another row (the dedupe below in addHold
     * runs on this), and no tap could ever release it. Audit #6, 2026-08-18. */
    var owned = bookedTimesOn(slug, date);
    if (time && owned.indexOf(time) >= 0) return false;   // that sitting is bought
    var mine = localHolds().filter(function (h) {
      return matchesHold(h, slug, date, time) &&
             !(h.time && owned.indexOf(h.time) >= 0);     // spent by the ticket
    });
    if (mine.some(function (h) { return !h.unhold; })) return true;
    if (mine.length) return false;         // he has just let it go
    return heldOnFringe(slug, date, time);
  }

  // Which sittings on this date are held, as "HH:MM" strings.
  // ⚠️ The TICKETED sitting is excluded, never the whole day - see isHeld().
  // A whole-day [] here was what hid a legitimate hold on the other sitting.
  function heldTimes(slug, date) {
    var out = {}, released = {};
    localHolds().forEach(function (h) {
      if (h.slug !== slug || h.date !== date) return;
      var t = h.time || "";
      if (h.unhold) { released[t] = 1; delete out[t]; }
      else { out[t] = 1; delete released[t]; }
    });
    heldFringeTimes(slug, date).forEach(function (t) {
      if (!released[t] && !released[""]) out[t] = 1;
    });
    bookedTimesOn(slug, date).forEach(function (t) { delete out[t]; });
    return Object.keys(out).sort();
  }

  // Has he actually bought this show on this date?
  function bookedOnDate(slug, date) {
    return bookedTimesOn(slug, date).length > 0;
  }

  // ⚠️ WHICH sitting he has a ticket to, not just which day. His rule
  // 2026-08-17: buying a ticket clears every hold for that show, and he may
  // then re-add a hold on another date - "the only showtime i cannot re-add a
  // hold to is the time of the actual ticketed event, as that would be
  // redundant". A show playing twice on the ticketed day is therefore still
  // holdable at its OTHER sitting, which a whole-day block used to forbid.
  function bookedTimesOn(slug, date) {
    var day = plan.days.filter(function (d) { return d.date === date; })[0];
    if (!day) return [];
    return day.events.filter(function (e) {
      return e.kind === "show" && e.href && e.href.split("/").pop() === slug;
    }).map(function (e) { return String(e.start || "").slice(11, 16); })
      .filter(Boolean);
  }

  // The sittings on a date he could still hold: everything except the one he
  // already has a ticket for.
  function holdableSlots(slug, date, slots) {
    var owned = bookedTimesOn(slug, date);
    return (slots || []).filter(function (t) { return owned.indexOf(t) < 0; });
  }

  // ⚠️ A hold on a show he has ALREADY BOUGHT for another night is the easiest
  // way to waste an evening: the chip looks like every other maybe. Returns
  // the date of that ticket, so the chip can say which night it is.
  function bookedElsewhere(slug, date) {
    var found = null;
    plan.days.forEach(function (d) {
      if (d.date === date || found) return;
      d.events.forEach(function (e) {
        if (!found && e.kind === "show" && e.href &&
            e.href.split("/").pop() === slug) found = d.date;
      });
    });
    return found;
  }

  function ticketIcon() {
    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("class", "tkt");
    var path = document.createElementNS(ns, "path");
    // A ticket stub: rounded body with a notch bitten out of each side.
    path.setAttribute("d", "M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a3 3 0 0 0 0 6v2a2 2 " +
      "0 0 1-2 2H5a2 2 0 0 1-2-2v-2a3 3 0 0 0 0-6z");
    svg.appendChild(path);
    return svg;
  }

  // Held sittings as the last plan build saw them (plan.json "bookmarked"
  // events - the app's own holds; his EdFringe planner is no longer read).
  function heldFringeTimes(slug, date) {
    var day = plan.days.filter(function (d) { return d.date === date; })[0];
    if (!day) return [];
    return day.events.filter(function (e) {
      return e.kind === "bookmarked" && e.href &&
             e.href.split("/").pop() === slug;
    }).map(function (e) { return String(e.start || "").slice(11, 16); })
      .filter(Boolean);
  }

  function heldOnFringe(slug, date, time) {
    var ts = heldFringeTimes(slug, date);
    if (!ts.length) return false;
    return !time || ts.indexOf(time) >= 0;
  }

  // Tapping a held date again releases it. Holds live in this app only -
  // nothing has written them to his EdFringe account since 2026-08-15.
  /* ⚠️ daySlots, when the caller knows the date's REAL sittings, also retires
   * ORPHANED rows: a hold stores the time it was MADE at and EdFringe moves
   * shows - Man Sings gained 15:00 sittings on 28/29 Aug, he held them, then
   * EdFringe removed those sittings again. Every release tap passes the LIVE
   * time, matchesHold wants equality, so the stored 15:00 could never be
   * released from any surface and resurrected as a 19:45 hold on every plan
   * rebuild. Releasing any sitting of a day now also releases rows whose
   * stored time is no longer scheduled that day. Only with the COMPLETE slot
   * list - a partial list would release a second legitimate sitting.
   * Audit #6, 2026-08-18. */
  function removeHold(slug, date, time, daySlots) {
    var hit = false;
    var slots = daySlots || [];
    var out = localHolds().map(function (h) {
      var orphan = slots.length && h.slug === slug && h.date === date &&
                   !h.unhold && h.time && slots.indexOf(h.time) < 0;
      if (!matchesHold(h, slug, date, time) && !orphan) return h;
      if (matchesHold(h, slug, date, time)) hit = true;
      h.unhold = true;
      h.unheldAt = new Date().toISOString();
      if (!h.addedAt) h.removedAt = h.unheldAt;   // addedAt: import-era relic
      return h;
    });
    /* ⚠️ A device can be shown a hold it has no local row for - one made on the
     * other device, or the five imported from his EdFringe planner on
     * 2026-08-15, which arrived through the plan rather than through this
     * device's own queue. map() alone could not release those: no row matched,
     * so tapping produced no tombstone and nothing moved. It looked like the
     * hold was stuck, with no error to explain it.
     *
     * A tombstone with no prior row is exactly what the merge already expects,
     * so writing one here is enough for every device to agree it is released. */
    if (!hit) {
      var stamp = new Date().toISOString();
      // ⚠️ The tombstone MUST carry the time. The merge keys on
      // (slug, date, time), so a release written without one keys to a
      // different record and the hold comes straight back on the next sync.
      out.push({ slug: slug, date: date, time: time || "", unhold: true,
                 unheldAt: stamp, removedAt: stamp });
    }
    try { localStorage.setItem(HOLD_KEY, JSON.stringify(out)); } catch (e) {}
    return pushHolds(out);
  }

  // ⚠️ Sync used to be invisible: taps went to GitHub, the Mac talked to
  // EdFringe, and nothing on screen said so. A counter rather than a flag,
  // because a pull, a push and a retry overlap constantly - the badge must not
  // vanish because the first of three finished.
  var syncDepth = 0, syncLabel = "", syncTail = null;

  /* ⚠️ A FAILURE INSIDE A BATCH MUST WIN. Only the last release to land gets
   * to settle the badge, so a background pull finishing after a failed sync
   * settled it as "Up to date" while the meta line underneath said the sync
   * had failed - the app contradicting itself, and the wrong half is the one
   * he glances at. Found 2026-08-18 when the auto calendar sync on open
   * overlapped the load's own pull. These remember a failure for the life of
   * one batch (depth 0 -> n -> 0). */
  var syncFailed = false, syncFailLabel = "";

  // release(ok, label) - a sync that finishes silently looks identical to one
  // that never happened, so the badge holds a tick (or a warning) for a few
  // seconds before it goes.
  function syncOn(label) {
    if (syncDepth === 0) { syncFailed = false; syncFailLabel = ""; }
    syncDepth++;
    syncLabel = label || syncLabel || "Syncing";
    paintSync();
    var released = false;
    return function (ok, doneLabel) {
      if (released) return;
      released = true;
      if (ok === false && !syncFailed) {
        syncFailed = true;
        syncFailLabel = doneLabel || "Sync failed";
      }
      syncDepth = Math.max(0, syncDepth - 1);
      if (syncDepth === 0) {
        // The first failure in the batch wins the label, not the last finisher.
        settle(syncFailed ? "fail" : "done",
               syncFailed ? syncFailLabel : (doneLabel || "Synced"));
      } else {
        paintSync();
      }
    };
  }

  function syncSay(label) {                    // relabel without changing depth
    syncLabel = label;
    paintSync();
  }

  function settle(state, label) {
    var b = $("#syncbadge");
    if (!b) return;
    b.className = "syncbadge " + state;
    b.querySelector("b").textContent = label;
    b.hidden = false;
    if ($("#lastsync")) $("#lastsync").hidden = true;
    clearTimeout(syncTail);
    syncTail = setTimeout(function () {
      // Anything that started in the meantime keeps the badge alive.
      if (syncDepth === 0) {
        b.hidden = true;
        b.className = "syncbadge";
        showLastSync();                 // re-read: that sync may be the newest
      }
    }, 3200);
  }

  function paintSync() {
    var b = $("#syncbadge");
    if (!b) return;
    if (syncDepth > 0) {
      clearTimeout(syncTail);
      b.className = "syncbadge";
      b.querySelector("b").textContent = syncLabel;
      b.hidden = false;
      if ($("#lastsync")) $("#lastsync").hidden = true;
    }
  }

  function flash(text) {
    $("#meta").textContent = text;
    clearTimeout(flash._t);
    flash._t = setTimeout(function () { $("#meta").textContent = ""; }, 4000);
  }

  function addHold(slug, title, date, time) {
    var holds = localHolds();
    if (isHeld(slug, date, time || undefined)) return Promise.resolve("already");
    holds.push({ slug: slug, title: title, date: date, time: time,
                 heldAt: new Date().toISOString() });
    try { localStorage.setItem(HOLD_KEY, JSON.stringify(holds)); } catch (e) {}
    return pushHolds(holds);
  }

  // The queue lives in the private repo, the same bridge the refresh button
  // uses. A read-only token simply means it stays local until he syncs.
  function pushHolds(holds) {
    var done = syncOn("Syncing to GitHub");
    return pushHoldsInner(holds).then(function (r) {
      done(r === "queued", r === "queued" ? "Synced" : "Saved on this device");
      return r;
    }, function (e) { done(false); throw e; });
  }

  function pushHoldsInner(holds) {
    if (isLocal()) {
      return fetch("/api/holds", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ holds: holds })
      }).then(function (r) { return r.ok ? markPushed(HOLD_KEY, holds) : "local-only"; })
        .catch(function () { return "local-only"; });
    }
    var tk = token();
    if (!tk) return Promise.resolve("local-only");
    var url = "https://api.github.com/repos/" + DATA_REPO + "/contents/holds.json";
    return fetch(url, { headers: { Authorization: "Bearer " + tk } })
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (meta) {
        /* ⚠️ KEEP THE REST OF THE DOCUMENT. This built a fresh
         * {holds, updatedAt} and threw away every other top-level key the
         * relay copy carried - above all "clearedByTicket", which records
         * which tickets have already retired their holds. One tap here wiped
         * it, and the next build_plan.py --clear-ticket-holds then re-cleared
         * every show he owns a ticket to, including any date he had
         * deliberately re-held. Audit 2026-08-17. */
        var doc = {};
        try {
          if (meta && meta.content) {
            doc = JSON.parse(decodeURIComponent(escape(atob(
              meta.content.replace(/\s/g, ""))))) || {};
          }
        } catch (e) { doc = {}; }
        doc.holds = holds;
        doc.updatedAt = new Date().toISOString();
        return fetch(url, {
          method: "PUT",
          headers: { Authorization: "Bearer " + tk, "Content-Type": "application/json" },
          body: JSON.stringify({
            message: "hold " + holds.length + " show(s)",
            content: btoa(unescape(encodeURIComponent(JSON.stringify(doc)))),
            sha: meta.sha
          })
        });
      })
      .then(function (r) { return r.ok ? markPushed(HOLD_KEY, holds) : "local-only"; })
      .catch(function () { return "local-only"; });
  }

  // ⚠️ A tap made in airplane mode is SAFE - it is in localStorage - but the
  // push that carries it to the relay fails silently, and nothing used to try
  // again. It would sit on that one device until he happened to tap something
  // else. Entries are stamped only when the relay really took them, so
  // anything unstamped is retried on the next launch and whenever the phone
  // comes back online.
  /* ⚠️ MERGE, never replace. Each push captures a snapshot of the whole queue,
   * and this used to write that snapshot back when the push resolved - so a row
   * added DURING the round trip was erased by the push that started before it.
   *
   * The sequence, on hotel wifi where a round trip is 0.5-2 s: tap hold A, push
   * 1 starts with [A]; tap hold B, push 2 starts with [A, B]; push 1 resolves
   * and writes [A]. B is gone from localStorage, and because push 2 lost the
   * sha race it never reached the relay either - so B exists nowhere, and the
   * retry net cannot see a row that no longer exists. The button stayed "on"
   * until the next render, which is what made it silent.
   *
   * Re-reading here also covers a removal made mid-flight: a row he deleted
   * while the push was in the air stays deleted, instead of coming back. */
  function markPushed(key, items) {
    var at = new Date().toISOString();
    var idOf = key === HOLD_KEY
      /* ⚠️ The TIME belongs in this id. Without it, two sittings of one show on
       * one day collide: hold 13:25, then hold 23:10 while the first push is
       * still in the air, and BOTH get stamped pushedAt - but 23:10 was never
       * in any payload. Nothing then looks unsynced, so the retry net skips it
       * forever and the hold exists on one device only. The sitting picker
       * invites exactly that double-tap and hotel wifi supplies the window.
       * Audit #3, 2026-08-16. */
      ? function (x) {
          return x.slug + "|" + x.date + "|" + (x.time || "") +
                 "|" + (x.unhold ? "u" : "h");
        }
      : key === RATING_KEY
        /* Every rating event is its own row, so the instant is the id. */
        ? function (x) { return x.slug + "|" + (x.at || ""); }
        : function (x) { return x.slug + "|" + (x.want ? "1" : "0"); };

    var pushed = {};
    (items || []).forEach(function (x) { pushed[idOf(x)] = 1; });

    var current;
    try { current = JSON.parse(localStorage.getItem(key)) || null; } catch (e) { current = null; }
    // Nothing readable to merge into - the snapshot is still the best truth.
    if (!current || !current.length) current = items || [];

    current.forEach(function (x) { if (pushed[idOf(x)]) x.pushedAt = at; });
    try { localStorage.setItem(key, JSON.stringify(current)); } catch (e) {}
    return "queued";
  }

  function unsynced() {
    return localHolds().some(function (h) { return !h.pushedAt; }) ||
           localFavs().some(function (f) { return !f.pushedAt; }) ||
           localRatings().some(function (r) { return !r.pushedAt; }) ||
           Object.keys(pendingStars()).length > 0;
  }

  function retryQueues(why) {
    if (!unsynced()) return;
    if (navigator.onLine === false) return;
    pushHolds(localHolds());
    pushFavs(localFavs());
    pushRatings(localRatings());
    if (why) $("#meta").textContent = "";
  }

  window.addEventListener("online", function () { retryQueues("online"); });

  function holdButton(slug, title, dates) {
    var wrap = el("div", "holdwrap");
    wrap.appendChild(el("div", "note", "Hold a date to pencil it in here. " +
      "Buy the ticket in the official Fringe app when you are ready."));
    var row = el("div", "holdrow");
    dates.forEach(function (d) {
      // Only the ticketed SITTING is blocked - a second showing that day is
      // still holdable. His rule, 2026-08-17.
      var owned = d.time ? bookedTimesOn(slug, d.date).indexOf(d.time) >= 0
                         : bookedOnDate(slug, d.date);
      var held = isHeld(slug, d.date);
      var b = el("button", "holdbtn" + (held ? " on" : "") + (owned ? " owned" : ""),
                 d.date.slice(8) + " Aug" + (d.time ? " · " + d.time : ""));
      var label = d.date.slice(8) + " Aug" + (d.time ? " · " + ampm(d.time) : "");
      b.textContent = owned ? "booked · " + d.date.slice(8) + " Aug" : label;
      if (owned) { b.disabled = true; b.title = "You have a ticket for this one"; }
      b.onclick = function (ev) {
        if (owned) return;
        ev.stopPropagation();
        var nowHeld = !b.classList.contains("on");
        b.classList.toggle("on", nowHeld);
        /* ⚠️ Release the SAME sitting this button holds, not the whole day.
         * addHold passed d.time while removeHold passed none, so on a
         * two-sitting day one tap added 13:25 and the next released both.
         * Found by audit, 2026-08-16. */
        var work = nowHeld ? addHold(slug, title, d.date, d.time || "")
                           : removeHold(slug, d.date, d.time || "");
        renderDays();                    // the timeline reflects it at once
        work.then(function (how) {
          b.title = how === "local-only"
            ? "Saved on this device; not shared with your other devices yet"
            : (nowHeld ? "Held — shared with your other devices"
                       : "Released — shared with your other devices");
        });
      };
      row.appendChild(b);
    });
    wrap.appendChild(row);
    return wrap;
  }

  // ⚠️ A universal https link, NOT comgooglemaps://. On his iPhone this opens
  // the Google Maps app when it is installed and falls back to the browser when
  // it is not; the custom scheme just dies silently without the app. His
  // request 2026-08-16: an icon, no word.
  //
  // The venue NAME plus the city resolves these reliably - they are landmarks -
  // and the room is deliberately left out: "McEwan Hall" alone is a place, but
  // "Underbelly, Bristo Square - McEwan Hall" is not an address anyone can find.
  // ⚠️ DIRECTIONS, not a dropped pin, and WALKING - he is on foot between
  // venues on cobbles, months post-op on the right knee. Driving directions
  // through Edinburgh city centre in August would be actively wrong.
  //
  // Universal https links, never comgooglemaps:// or maps://: these open the
  // installed app on his iPhone and fall back to the browser when it is not
  // there, whereas a custom scheme just dies silently.
  function mapsLink(venue, which) {
    var dest = encodeURIComponent(venue + ", Edinburgh, UK");
    return which === "apple"
      ? "https://maps.apple.com/?daddr=" + dest + "&dirflg=w"
      : "https://www.google.com/maps/dir/?api=1&destination=" + dest
        + "&travelmode=walking";
  }

  // ---- how far is that on foot ---------------------------------------
  //
  // ⚠️ Straight line x a detour factor, NOT routing. Edinburgh's Old and New
  // Towns are split by a valley, so two venues 400 m apart as the crow flies can
  // be a bridge or a flight of steps apart. 1.4 is the usual street-network
  // factor and it is deliberately pessimistic here. Real routing would need an
  // API key and a network call, and this has to work in a basement with no
  // signal - which it does, because the coordinates ship with the catalogue.
  //
  // 4.2 km/h rather than the standard 5: these are hills and cobbles, and he is
  // months post-op on the right knee. Rounding is UP, never down - a walk that
  // takes longer than the app promised is the failure that costs him a show.
  // 4.2 km/h rather than the standard 5 (hills, cobbles, months post-op on the
  // right knee) with a 1.25 street-network factor. ⚠️ Calibrated, not guessed:
  // 1.4 x 4.2 put Pleasance Courtyard 17 minutes from his flat when the real
  // walk is about 11, because it double-counted a slow pace AND a big detour.
  // These give ~15 - still on the generous side, which is the right direction
  // to be wrong in.
  var WALK_KMH = 4.2, DETOUR = 1.25;
  /* Past this it is not a walk at any pad - it is a bus or a taxi, and the flat
   * travel pad is actively lying. Sized to clear the whole festival footprint
   * (Summerhall to the Pleasance is 2.3 km, the Meadows to Leith about 4) while
   * still catching South Queensferry at 13.9. */
  var OUT_OF_TOWN_KM = 5;

  // ⚠️ His accommodation, used when the phone will not give a location - his
  // request 2026-08-16, "Unite Students Salisbury Ct.". Geocoded rather than
  // guessed: Nominatim returns TWO Salisbury Courts in Edinburgh, and the
  // Meadowbank one puts Summerhall 52 minutes away. This is the Southside one,
  // 104 St Leonard's Street, which is the Unite property and gives 9 minutes to
  // Summerhall - the sanity check that settled it.
  var HOME = { lat: 55.9413013, lng: -3.1761578,
               label: "Unite Students Salisbury Court" };
  // Outside this radius he is not in Edinburgh and his own position tells him
  // nothing useful - Glasgow is 70 km and he is not walking from there either.
  var NEAR_EDINBURGH_KM = 50;
  var myPos = null, myPosIsHome = false;
  // null | "away" (out of town - correct, not a fault) | "denied" | "unavailable"
  var posReason = null;

  function haversineKm(a, b, c, d) {
    var R = 6371, toRad = Math.PI / 180;
    var dLat = (c - a) * toRad, dLng = (d - b) * toRad;
    var s1 = Math.sin(dLat / 2), s2 = Math.sin(dLng / 2);
    var h = s1 * s1 + Math.cos(a * toRad) * Math.cos(c * toRad) * s2 * s2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function walkMinutes(lat, lng) {
    if (!myPos || typeof lat !== "number" || typeof lng !== "number") return null;
    var km = haversineKm(myPos.lat, myPos.lng, lat, lng) * DETOUR;
    // Beyond a few km he is not walking it, and a "58m" would be nonsense.
    if (km > 6) return null;
    return Math.max(1, Math.ceil(km / WALK_KMH * 60));
  }

  function walkIcon() {
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    var p2 = document.createElementNS("http://www.w3.org/2000/svg", "path");
    // A walking figure, stroked so it reads at 11px.
    p2.setAttribute("d", "M13 4.5a1.6 1.6 0 1 0 0-.01M11 21l1.6-5.2-2.1-2 .7-4L9 11.5 7.4 14M12.5 9.8l2.6 1.4 1.4 3.2M12.6 15.8 15 21");
    p2.setAttribute("fill", "none");
    p2.setAttribute("stroke", "currentColor");
    p2.setAttribute("stroke-width", "1.9");
    p2.setAttribute("stroke-linecap", "round");
    p2.setAttribute("stroke-linejoin", "round");
    svg.appendChild(p2);
    return svg;
  }

  // A tiny "15m" beside the navigate icon, only when we know both ends.
  // Tappable too, his request: "how far is it" and "take me there" are the same
  // thought, so the time opens the same chooser the arrow does.
  function walkChip(lat, lng, venue) {
    var mins = walkMinutes(lat, lng);
    if (mins === null) return null;
    var span = el(venue ? "button" : "span", "walkchip");
    if (venue) {
      span.type = "button";
      span.setAttribute("aria-label", "Directions to " + venue + ", about "
        + mins + " minutes' walk");
      span.onclick = function (ev) {
        ev.stopPropagation();
        openMapsChooser(venue);
      };
    }
    span.appendChild(walkIcon());
    span.appendChild(el("b", null, mins + "m"));
    // ⚠️ Say WHERE it is measured from. A time quoted from his flat while he is
    // across town would be worse than no time at all.
    span.title = "About " + mins + " minutes' walk from "
      + (myPosIsHome ? HOME.label : "where you are")
      + " (straight line plus a detour allowance, not a route)";
    return span;
  }

  // His words: "the app would fetch my location when i open it on my phone."
  // Silent on refusal or failure - no location simply means no walking times,
  // which is not an error worth a message.
  // ⚠️ The position must be known BEFORE the first popup renders, or the walk
  // time silently does not appear - walkChip() runs at render time and nothing
  // re-renders it. That is exactly what happened: open a show quickly after
  // launch and there is no "17m", with no clue why. So the last known fix is
  // cached and used immediately on the next launch, and a fix arriving later
  // re-renders whatever is already on screen.
  var POS_KEY = "fringe-pos-v1";

  function rememberPos() {
    try {
      localStorage.setItem(POS_KEY, JSON.stringify(
        { lat: myPos.lat, lng: myPos.lng, home: myPosIsHome, at: Date.now() }));
    } catch (e) {}
  }

  function loadPos() {
    try {
      var v = JSON.parse(localStorage.getItem(POS_KEY) || "null");
      // A day-old fix is still the right city and the right side of it; it is
      // replaced the moment a real one arrives.
      // ⚠️ 30 minutes, not 24 hours. A day-old fix was being treated as a real
      // current position: if geolocation then failed, useHome() returned early
      // because that stale fix looked "real and near Edinburgh", so walk times
      // came from wherever he was yesterday while the tooltip said "from where
      // you are". Found by audit, 2026-08-16.
      if (v && typeof v.lat === "number" &&
          Date.now() - (v.at || 0) < 30 * 60 * 1000 &&
          haversineKm(v.lat, v.lng, HOME.lat, HOME.lng) <= NEAR_EDINBURGH_KM) {
        myPos = { lat: v.lat, lng: v.lng };
        myPosIsHome = !!v.home;
      }
    } catch (e) {}
  }

  // Redraw whatever is showing, so a fix that lands late still fills the times
  // in rather than waiting for the next tap.
  function positionChanged() {
    rememberPos();
    if (reopenSheet) { reopenSheet(); return; }
    try { renderBook(); renderBrowse(); renderActivity(); } catch (e) {}
  }

  function useHome(reason, announce) {
    // A real fix only wins if it is actually near Edinburgh.
    if (myPos && !myPosIsHome &&
        haversineKm(myPos.lat, myPos.lng, HOME.lat, HOME.lng) <= NEAR_EDINBURGH_KM) {
      return;
    }
    posReason = reason || posReason || "unavailable";
    if (announce) locFlash(false, "No location - using your flat");
    myPos = { lat: HOME.lat, lng: HOME.lng };
    myPosIsHome = true;
    positionChanged();
    syncLocWarn();
  }

  // ⚠️ Warn ONLY when the answer is missing, never when it is simply "he is not
  // in Edinburgh yet" - falling back to the flat is the correct behaviour then,
  // and an amber pin every time he opens the app in New York would be noise.
  var locFlashTimer = null;

  function locFlash(ok, msg) {
    var n = $("#locok");
    if (!n) return;
    n.innerHTML = "";
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    var d = document.createElementNS("http://www.w3.org/2000/svg", "path");
    d.setAttribute("d", ok
      ? "M12 21s7-5.5 7-11a7 7 0 1 0-14 0c0 5.5 7 11 7 11zM9.4 10.2l1.9 1.9 3.4-3.6"
      : "M12 21s7-5.5 7-11a7 7 0 1 0-14 0c0 5.5 7 11 7 11zM4 4l16 16");
    svg.appendChild(d);
    n.appendChild(svg);
    // ⚠️ Icon only. The text pill overlapped the wordmark on his phone and told
    // him something he already knew ("I know I'm not in Edinburgh"). The words
    // survive as the tooltip and for screen readers.
    n.title = msg;
    n.setAttribute("aria-label", msg);
    n.classList.toggle("warn", ok === false);
    n.hidden = false;
    clearTimeout(locFlashTimer);
    locFlashTimer = setTimeout(function () { n.hidden = true; }, 4000);
  }

  function syncLocWarn() {
    var b = $("#locwarn");
    if (!b) return;
    b.hidden = !(posReason === "denied" || posReason === "unavailable");
  }

  // ⚠️ `announce` only when HE triggered it (refresh button, pull to refresh).
  // On app open it stays silent - a badge every launch would be noise, and he
  // asked for confirmation specifically on refresh.
  function findMe(announce) {
    loadPos();                                // instant, from last time
    if (!navigator.geolocation) return useHome("unavailable", announce);
    var settled = false;
    // ⚠️ NOT syncOn(): the refresh holds that badge for its whole run, so a
    // location message posted into it is swallowed by the depth counter and he
    // never sees it. Its own little pill, shown for a few seconds.
    var said = false;
    var say = function (ok, msg) {
      if (!announce || said) return;
      said = true;
      locFlash(ok, msg);
    };
    navigator.geolocation.getCurrentPosition(function (pos) {
      settled = true;
      // ⚠️ A real fix is only useful if he is IN Edinburgh. Right now he is in
      // America, so every venue was thousands of km away, every walk time was
      // suppressed as out of range, and the feature silently did nothing - which
      // is exactly what he saw. His instruction 2026-08-16: "if i'm in america,
      // just default to unite students." Same on the train down, or in the air.
      var awayKm = haversineKm(pos.coords.latitude, pos.coords.longitude,
                               HOME.lat, HOME.lng);
      if (awayKm > NEAR_EDINBURGH_KM) {
        say(true, "Not in Edinburgh - using your flat");
        return useHome("away");
      }
      myPos = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      myPosIsHome = false;
      posReason = null;
      positionChanged();
      syncLocWarn();
      say(true, "Location updated");
    }, function (err) {
      settled = true;
      var denied = err && err.code === 1;
      say(false, denied ? "Location is off - using your flat"
                        : "No location - using your flat");
      useHome(denied ? "denied" : "unavailable");
    },
       { enableHighAccuracy: false, timeout: 8000,
         maximumAge: 5 * 60 * 1000 });
    // ⚠️ iOS can leave the permission prompt sitting there with neither callback
    // firing - on a first launch that is indefinite. Fall back on our own clock
    // so the times appear either way; a real fix later still overrides it.
    setTimeout(function () {
      if (settled) return;
      say(false, "No location - using your flat");
      useHome("unavailable");
    }, 9000);
  }

  function navIcon() {
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M3 11l18-8-8 18-2-8-8-2z");
    svg.appendChild(path);
    return svg;
  }

  // ⚠️ A real action sheet, not a dropdown. The anchored menu was a cramped
  // 148px box hanging off a 26px icon, which on a phone reads as a glitch
  // rather than a choice. This is the shape EdFringe's own app uses for exactly
  // this decision: dimmed backdrop, title, two full-width targets.
  //
  // It lives on <body>, not inside the sheet, so nothing can clip it.
  function openMapsChooser(venue) {
    var back = el("div", "mapsback");
    var card = el("div", "mapscard");
    // The venue is the subject here, so it gets the weight; "Directions" is
    // just the section label, styled like AVAILABILITY elsewhere in the app.
    card.appendChild(el("div", "mapstitle", "Directions"));
    card.appendChild(el("div", "mapsvenue", venue));
    [["Apple Maps", "apple"], ["Google Maps", "google"]]
      .forEach(function (opt) {
        var link = el("a", "mapsopt");
        link.href = mapsLink(venue, opt[1]);
        link.target = "_blank";
        link.rel = "noopener";
        link.appendChild(navIcon());
        link.appendChild(el("span", null, opt[0]));
        link.onclick = function () { close(); };
        card.appendChild(link);
      });
    var cancel = el("button", "mapsopt cancel", "Cancel");
    cancel.type = "button";
    cancel.onclick = function (ev) { ev.stopPropagation(); close(); };
    card.appendChild(cancel);

    function close() {
      document.removeEventListener("keydown", onKey);
      if (back.parentNode) back.parentNode.removeChild(back);
    }
    function onKey(ev) { if (ev.key === "Escape") close(); }

    // Tapping the dim area closes; tapping the card must not.
    back.onclick = function () { close(); };
    card.onclick = function (ev) { ev.stopPropagation(); };
    document.addEventListener("keydown", onKey);

    back.appendChild(card);
    document.body.appendChild(back);
  }

  function navButton(venue) {
    var a = el("button", "navbtn");
    a.type = "button";
    a.title = "Directions to " + venue;
    a.setAttribute("aria-label", "Directions to " + venue);
    a.appendChild(navIcon());
    a.onclick = function (ev) {
      ev.stopPropagation();                 // never reach the sheet underneath
      openMapsChooser(venue);
    };
    return a;
  }

  function sheetHead(imageUrl, title, parts, slug, focus) {
    var head = el("div", "sheethead");
    var pic = poster(imageUrl);
    if (pic) { pic.classList.add("big"); head.appendChild(pic); }
    var words = el("div", "sheetwords");
    // ⚠️ A float spacer, not padding. Padding on .sub reserved the gutter on
    // every line; this reserves it only for the lines that actually sit beside
    // the close button, so the venue rows below still run the full width.
    words.appendChild(el("i", "closegap"));
    words.appendChild(el("h2", null, title));
    // ⚠️ Venues get their OWN rows, under the meta line - his call 2026-08-16.
    // Inline, the icons broke the wrap: one was orphaned at the start of a line
    // and the venue text spilled over four. They are also the thing he acts on,
    // so they earn a row each rather than being buried mid-sentence.
    var sub = el("div", "sub");
    var placeRows = [];
    var first = true;
    (parts || []).forEach(function (part) {
      if (!part) return;
      if (Array.isArray(part)) {
        part.forEach(function (pl) { if (pl && pl.label) placeRows.push(pl); });
        return;
      }
      if (!first) sub.appendChild(document.createTextNode(" \u00b7 "));
      first = false;
      // A part may be {t, cls} so one piece - the showtime - can be emphasised.
      if (part.t !== undefined) {
        if (!part.t) return;
        sub.appendChild(el("span", part.cls || null, part.t));
        return;
      }
      sub.appendChild(document.createTextNode(part));
    });
    words.appendChild(sub);
    if (placeRows.length) {
      var venues = el("div", "places");
      placeRows.forEach(function (pl) {
        var row = el("div", "placerow");
        row.appendChild(el("span", "placename", pl.label));
        if (pl.venue) row.appendChild(navButton(pl.venue));
        var walk = walkChip(pl.lat, pl.lng, pl.venue);
        if (walk) row.appendChild(walk);
        venues.appendChild(row);
      });
      words.appendChild(venues);
    }
    // ⚠️ Both actions live up here now. "Open on EdFringe" used to sit under
    // the availability grid, which on a long run meant scrolling past 30 dates
    // to reach the one button that leaves the app.
    var acts = null;
    if (slug || (focus && (focus.ticket || focus.offsite))) {
      acts = el("div", "sheetacts");
      if (slug) acts.appendChild(favButton(slug, title));
      /* ⚠️ The star sits beside the heart and is a SEPARATE act - tapping it
       * never favourites. His call 2026-08-23: "no favourite is a separate
       * thing". This is also the reason the star reaches the My Calendar
       * popup: that surface is built from plan.json day events but its header
       * is this same sheetHead, so anything added here lands on both. */
      if (slug) acts.appendChild(starButton(slug, title));
      // "Buy tickets" - short enough to sit beside the heart on a phone, and
      // it says what he actually goes there to do. The buying is his: this
      // only opens the show page.
      if (slug) {
        /* ⚠️ "Listing" ONLY in the popup for a showtime he has bought - his
         * request 2026-08-22. Everywhere else the same button is still "Buy
         * tickets", because everywhere else that is exactly what it is for.
         * Same page either way; the word is about what he goes there to do,
         * and on a ticket he already holds that is to re-read the listing. */
        var go = el("a", "btn small buy",
                    (focus && focus.booked) ? "Listing" : "Buy tickets");
        go.href = "https://www.edfringe.com/tickets/whats-on/" + slug;
        go.target = "_blank";
        go.rel = "noopener";
        acts.appendChild(go);
      } else if (focus && focus.offsite && focus.offsite.url) {
        // Not "Buy tickets": he already holds these, and it is not an EdFringe
        // page. It opens the festival's own listing.
        var lst = el("a", "btn small buy", "Listing");
        lst.href = focus.offsite.url;
        lst.target = "_blank";
        lst.rel = "noopener";
        acts.appendChild(lst);
      }
      // ⚠️ LAST in the row - his call 2026-08-22, swapping it with "Buy
      // tickets". On a phone the row wraps after two, so the ticket gets the
      // second line to itself: the widest target, and the one he is reaching
      // for while a queue moves.
      if (focus && focus.ticket) acts.appendChild(ticketButton(title, focus));
    }
    head.appendChild(words);
    // ⚠️ Returned as a fragment so the buttons are a SIBLING of the header, not
    // a child of the text column - inside it they started at the poster's right
    // edge and could never be centred on the sheet. His request 2026-08-16.
    var frag = document.createDocumentFragment();
    frag.appendChild(head);
    if (acts) frag.appendChild(acts);
    return frag;
  }

  // EdFringe carries a sub-genre as one comma-separated string and most shows
  // have two ("Interactive,Character comedy"); sweep.py splits it. It answers
  // the question the genre alone does not - what KIND of comedy this is.
  // Older payloads have no `sg`/`subGenres`, so this must survive an empty one.
  function subGenreText(list) {
    return (list && list.length) ? list.join(" / ") : "";
  }

  // ⚠️ The headline time has to describe HIS dates. A show's `tm` is its first
  // performance ever, so The Duo announced 8:25 PM while every date he can
  // actually book is 21:20 - the header disagreeing with every square in the
  // grid below it. Where the trip really does hold more than one time, say so
  // and let the grid carry the detail rather than picking one and being wrong.
  function tripTimes(days) {
    if (!plan) return [];
    var start = Number(plan.tripStart.slice(8, 10));
    var end = Number((plan.showEnd || plan.tripEnd).slice(8, 10));
    var set = {};
    days.forEach(function (d) {
      if (!d.open || d.day < start || d.day > end) return;
      (d.times || []).forEach(function (t) { if (t) set[t] = 1; });
    });
    return Object.keys(set).sort();
  }

  function timeLabel(times, fallback) {
    if (!times.length) return ampm(fallback);
    if (times.length === 1) return ampm(times[0]);
    return times.length + " showtimes";
  }

  // ⚠️ 164 shows use more than one venue and EdFringe's API publishes no
  // per-date venue (their GraphQL refuses every such field) - but since
  // 2026-08-16 tools/venuemap.py reads the ONE real venue off their rendered
  // Dates tab, and build_plan pins it where known. Only where venuemap has no
  // answer do both get named rather than one being picked. On a card,
  // where there is no room, the first plus a count - the sheet spells them out.
  // ⚠️ POPUPS name the room as well as the venue - "Underbelly, Bristo Square -
  // McEwan Hall" - because the room is what he has to find once he is there.
  // His request 2026-08-16. Cards keep the venue alone (venueShort below):
  // there is no width for a room name beside a month grid.
  //
  // `places` arrives as [venue, room] pairs already matched on venue code, so a
  // show with two of each never crosses them over.
  // The venues a popup should name, each with the venue to navigate to.
  function placeList(places, list, fallback) {
    var out = [], seen = {};
    (places || []).forEach(function (pr) {
      var v = (pr[0] || pr.venue || "").trim();
      var room = (pr[1] || pr.space || "").trim();
      var label = room && v ? v + " - " + room : (v || room);
      if (label && !seen[label]) {
        seen[label] = 1;
        out.push({ label: label, venue: v || room,
                   lat: pr[2] !== undefined ? pr[2] : pr.lat,
                   lng: pr[3] !== undefined ? pr[3] : pr.lng });
      }
    });
    if (out.length) return out;
    if (list && list.length > 1) {
      return list.map(function (v) { return { label: v, venue: v }; });
    }
    return fallback ? [{ label: fallback, venue: fallback }] : [];
  }

  // A calendar popup already knows the ONE place. Prefer the structured form -
  // [label, venue, lat, lng] - because the walking time needs coordinates; the
  // string is only a fallback for events built before that existed.
  function focusPlaceList(location, pls) {
    if (pls && pls.length) {
      return pls.map(function (q) {
        return { label: q[0], venue: q[1], lat: q[2], lng: q[3] };
      }).filter(function (q) { return q.label; });
    }
    var out = [], seen = {};
    String(location || "").split(" or ").forEach(function (chunk) {
      var label = chunk.trim();
      if (!label || seen[label]) return;
      seen[label] = 1;
      out.push({ label: label, venue: label.split(" - ")[0].trim() });
    });
    return out;
  }

  function placeText(places, list, fallback) {
    if (places && places.length) {
      var seen = {}, out = [];
      places.forEach(function (pr) {
        var v = (pr[0] || pr.venue || "").trim();
        var room = (pr[1] || pr.space || "").trim();
        var label = room && v ? v + " - " + room : (v || room);
        if (label && !seen[label]) { seen[label] = 1; out.push(label); }
      });
      if (out.length) return out.join(" or ");
    }
    return (list && list.length > 1) ? list.join(" or ") : (fallback || "");
  }

  function venueText(list, fallback) {
    return (list && list.length > 1) ? list.join(" or ") : (fallback || "");
  }

  function venueShort(list, fallback) {
    return (list && list.length > 1)
      ? (fallback || list[0]) + " (+" + (list.length - 1) + " venue)"
      : (fallback || "");
  }

  // The compact catalogue row's date cells, as {day, open, times}.
  function catDays(r) {
    return (r.d || []).map(function (c) {
      return { day: c[0], open: c[1] !== "n" && c[1] !== "x",
               times: String(c[2] || r.tm || "").split("/").filter(Boolean) };
    });
  }

  function showCatShow(r, focus) {
    openSheet(function (b) {
      var whenCat = focus && focus.time
        ? shortDate(focus.date) + " · " + ampm(focus.time)
        : timeLabel(tripTimes(catDays(r)), r.tm);
      // The place part is a LIST so each venue carries its own icon.
      var placesCat = focus && focus.location
        ? focusPlaceList(focus.location, focus.pls)
        : placeList(r.pl, r.vn, r.v);
      b.appendChild(sheetHead(r.im, r.t,
        [r.p, placesCat, { t: whenCat, cls: "when" }, r.dm + " min", r.g,
         subGenreText(r.sg)], r.s, focus));

      var fitDays = {};
      (r.fit || []).forEach(function (f2) { fitDays[f2[0]] = 1; });
      var catCells = (r.d || []).map(function (p2) {
        var dd = p2[0] < 10 ? "0" + p2[0] : String(p2[0]);
        var date = plan.tripStart.slice(0, 8) + dd;
        var bookable = p2[1] !== "n" && p2[1] !== "x";
        // ⚠️ `past` is SEPARATE from state, his request 2026-08-15: a date that
        // has been and gone still shows whether it sold out. It used to become
        // "away", which is 30% opacity, so last week's reds and teals were
        // unreadable - and knowing whether the shows he missed sold out is
        // exactly what tells him how hard to chase the ones he has not booked.
        // ⚠️ p2[2] is this DATE's real time, present only when it differs from
        // the show's usual one (or when the day has two sittings, joined by
        // "/"). Without it every date inherits the show's first-ever
        // performance - which is how The Duo read 20:25 across a trip it plays
        // at 21:20, and how a hold on one of those dates got saved 55 minutes
        // early. The hold takes the first sitting; the cell shows them all.
        return { date: date, day: p2[0],
                 time: (p2[2] || r.tm || "").split("/")[0],
                 altTime: p2[2] || "", altCodes: p2[3] || "",
                 past: date < todayISO(),
                 state: !bookable ? "gone" : fitDays[p2[0]] ? "fits" : "busy" };
      });
      b.appendChild(el("h3", null, "Availability"));
      b.appendChild(availabilityWeek(r.s, r.t, catCells, function () { showCatShow(r, focus); }));

      // ⚠️ Browse and What Changed get the same "fits your schedule" list that
      // Book Next has - the data was already in the row (`fit` is
      // [day, minutesBefore, minutesAfter]) and was simply never rendered here.
      // His request 2026-08-16. What Changed routes through this popup too for
      // anything that is not a favourite, so one change covers both.
      var fits = (r.fit || []).slice().sort(function (a, c) { return a[0] - c[0]; });
      if (fits.length) {
        b.appendChild(el("h3", null, "Fits your schedule on"));
        var lines = el("div");
        fits.forEach(function (f2) {
          var dd = f2[0] < 10 ? "0" + f2[0] : String(f2[0]);
          var date = plan.tripStart.slice(0, 8) + dd;
          // The time for THAT date, not the show's usual one.
          // The sitting this fit is FOR - never the day's first, which on a
          // two-sitting day is often the sold-out one.
          var cell = (r.d || []).filter(function (p3) { return p3[0] === f2[0]; })[0];
          var t = f2[3] || ((cell && cell[2]) || r.tm || "").split("/")[0];
          lines.appendChild(fitLine(date, t, f2[1], f2[2]));
        });
        b.appendChild(lines);
      }
      b.appendChild(el("div", "legend",
        "Tap a date to hold it in this planner — buy it in the official "
        + "Fringe app when you're ready."));

      b.appendChild(el("div", "note",
        r.dep + " of " + r.sch + " remaining dates have no Fringe allocation left. " +
        "EdFringe publishes availability per date only, never seat counts."));
    });
  }

  // ------------------------------------------------------------ activity

  // ⚠️ Defaults must match the chip marked is-on in index.html - set in BOTH
  // places, or the page shows one filter while highlighting another.
  var actWhen = 1, actWhat = "all";

  function actLabel(a) {
    if (a.type === "availableAgain") return "Tickets back!";
    if (a.type === "newDates") return "New dates";
    if (a.type === "newShow") return "New show";
    if (a.type.indexOf("threshold:") === 0) {
      var l = a.type.slice(10);
      return l === "sold out" ? "Sold out" : l + " gone";
    }
    return a.detail || "Changed";
  }

  function actClass(a) {
    if (a.type === "availableAgain") return "back";
    if (a.type.indexOf("threshold:") === 0) {
      return a.type.slice(10) === "sold out" ? "gone" : "fast";
    }
    return "new";
  }

  function renderActivity() {
    var box = $("#actList");
    box.innerHTML = "";
    var all = plan.alerts || [];

    var day = new Date(Date.now() - 86400000).toISOString();
    var since = all.filter(function (a) { return (a.at || "") >= day; });
    var mine = since.filter(function (a) { return a.fav; });
    var back = since.filter(function (a) { return a.type === "availableAgain"; });
    $("#actSummary").textContent = since.length
      ? since.length + " change" + (since.length === 1 ? "" : "s") +
        " in the last 24 hours · " + mine.length + " on your favourites · " +
        back.length + " where tickets came back"
      : "Nothing has changed in the last 24 hours.";
    var cutoff = new Date(Date.now() - actWhen * 86400000).toISOString();
    var rows = all.filter(function (a) {
      if (actWhen < 99 && (a.at || "") < cutoff) return false;
      if (actWhat === "fav") return a.fav;
      if (actWhat === "all") return true;
      if (actWhat === "threshold") return a.type.indexOf("threshold:") === 0;
      return a.type === actWhat;
    }).filter(function (a) { return matchesGenre(a, "act"); });

    // Default "recent" keeps the order the ledger already has - newest first -
    // so the page only reorders when he asks it to.
    if (actSort !== "recent") {
      rows = rows.slice().sort(function (a, b) {
        if (actSort === "title") {
          return a.title.toLowerCase() < b.title.toLowerCase() ? -1 : 1;
        }
        if (actSort === "depleted") {
          var ag = a.sch ? a.dep / a.sch : -1, bg = b.sch ? b.dep / b.sch : -1;
          return bg - ag;
        }
        if (actSort === "ending") {
          var ae = lastScheduledDay(a.d), be = lastScheduledDay(b.d);
          if (ae !== be) return ae - be;
          return a.title.toLowerCase() < b.title.toLowerCase() ? -1 : 1;
        }
        if (actSort === "time") {
          var at = fringeDayMin(a.tm), bt = fringeDayMin(b.tm);
          if (at !== bt) return at - bt;
          return a.title.toLowerCase() < b.title.toLowerCase() ? -1 : 1;
        }
        return 0;
      });
    }
    $("#actCount").textContent = rows.length + " of " + all.length + " changes";

    if (!rows.length) {
      box.appendChild(el("div", "emptyday",
        actWhat === "fav"
          ? "Nothing moved on your favourites in that window."
          : "No changes recorded in that window."));
      return;
    }
    rows.slice(0, 200).forEach(function (a) {
      // ⚠️ Deliberately the SAME card as Browse - same classes, same anatomy,
      // same order - so moving between the two tabs is not re-learning a
      // layout. The only difference is the change tag and when it happened.
      var c = el("button", "card cat act");

      var pcol = el("div", "postercol");
      var pic = poster(a.imageUrl);
      if (pic) pcol.appendChild(pic);
      if (a.fit) {
        pcol.appendChild(el("span", "pill2 fit",
          a.fit + (a.fit === 1 ? " gap" : " gaps")));
      }
      c.appendChild(pcol);

      var left = el("div", "catbody");
      var t = el("div", "ttl");
      t.appendChild(el("span", "tag " + actClass(a), actLabel(a)));
      if (a.fav) t.appendChild(el("span", "tag fav", "Fave"));
      t.appendChild(el("span", "ttltext", a.title));
      left.appendChild(t);
      left.appendChild(el("div", "sub",
        [a.venue, a.tm ? ampm(a.tm) : "", a.dm ? a.dm + "m" : ""]
          .filter(Boolean).join(" \u00b7 ")));

      var gone = a.sch ? a.dep / a.sch : 0;
      var state = el("div", "state");
      state.appendChild(el("span", "pill2 " +
        (!a.sch ? "none" : gone >= 1 ? "gone" : gone >= 0.75 ? "fast"
         : gone >= 0.5 ? "filling" : "open"),
        a.sch ? a.dep + "/" + a.sch + " dates gone" : "Run over"));
      left.appendChild(state);

      // What actually changed, and when - the one line Browse does not have.
      var bits = [a.detail];
      if (a.from !== null && a.from !== undefined && a.to !== null && a.to !== undefined) {
        bits.push(a.from + " \u2192 " + a.to + " dates gone");
      }
      if (a.dates && a.dates.length) {
        bits.push(a.dates.map(function (d) { return d.slice(8) + " Aug"; }).join(", "));
      }
      left.appendChild(el("div", "when",
        bits.filter(Boolean).join(" \u00b7 ") + " \u00b7 " + when(a.at)));
      c.appendChild(left);

      // The dates the alert is ABOUT are ringed, so "5 new dates added" shows
      // him which five without reading them off a list.
      // ⚠️ `ot` (plays during the trip), not the length of `d`: since
      // 2026-08-15 `d` carries the whole month, so a show that finished before
      // he landed still has dates - and must still say so rather than draw a
      // calendar of days he could never have attended. Older payloads have no
      // `ot`, so fall back to the old test.
      var onTrip = (a.ot === undefined) ? !!(a.d && a.d.length) : !!a.ot;
      if (onTrip && a.d && a.d.length) {
        var byDay = {}, hot = {};
        a.d.forEach(function (p) {
          byDay[p[0]] = p[1] === "n" ? "n" : (p[1] === "x" ? "x" : "o");
        });
        (a.dates || []).forEach(function (iso) { hot[Number(iso.slice(8))] = 1; });
        c.appendChild(calMonth(byDay, hot, a.d.length, glanceTime(catDays(a))));
      } else {
        // 124 of the 433 alerts are shows whose whole run ends before he
        // arrives. An empty column reads as a broken card, so it says why -
        // and that is genuinely the useful fact about that change.
        c.appendChild(el("div", "calnone", "Not on your dates"));
      }
      c.onclick = function () { openShowByHref(a.href, a.title); };
      box.appendChild(c);
    });
  }

  function when(iso) {
    if (!iso) return "";
    var mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 60) return mins + " min ago";
    if (mins < 60 * 24) return Math.round(mins / 60) + " h ago";
    return Math.round(mins / 1440) + " days ago";
  }

  // -------------------------------------------------------------- sheet

  var reopenSheet = null;

  function openSheet(build) {
    var body = $("#sheetBody");
    body.innerHTML = "";
    // Kept so a position arriving after the sheet opened can redraw it in place.
    reopenSheet = function () {
      if ($("#sheet").classList.contains("is-hidden")) { reopenSheet = null; return; }
      body.innerHTML = "";
      build(body);
    };
    build(body);
    /* ⚠️ The sheet is ONE element, reused for every show, so the panel keeps
     * the scroll position from the last one it displayed. Open a show, scroll
     * down its dates, close it, open another - and the new one appears already
     * scrolled, mid-grid, which reads as a rendering bug rather than as
     * leftover state. Reset both the panel and the body: which one scrolls
     * depends on content height. */
    $("#sheet").classList.remove("is-hidden");
    // ⚠️ AFTER unhiding, not before: setting scrollTop on a hidden element
    // does not stick, and the old position comes back the moment it is shown.
    //
    // ⚠️ And again on the next frame. On iOS the panel's height is not final
    // until layout runs, and a reset applied against the OLD height can be
    // undone as the real one lands - which is how a sheet still opened
    // mid-list on his phone while reading 0 on the Mac.
    var reset = function () {
      var panel = document.querySelector("#sheet .sheet-panel");
      if (panel) panel.scrollTop = 0;
      body.scrollTop = 0;
    };
    reset();
    if (window.requestAnimationFrame) window.requestAnimationFrame(reset);
  }

  /* ------------------------------------------------------ THE TICKET SCREEN
   * Not the sheet. The sheet is themed, scrimmed and scrollable; this is a
   * plain white card whose whole job is to be read by someone else's scanner
   * at a door, in a queue, in the dark.
   *
   * ⚠️ WHITE AND FULL-SCREEN whatever the app's theme is doing. A dark-themed
   * or half-covered barcode is the usual reason a door scanner struggles, and
   * the cost of that is missing the show he paid for.
   *
   * ⚠️ SCREEN WAKE LOCK while it is open, released the moment it closes. He
   * holds the phone out for someone else to scan, so the screen locking after
   * 30 seconds of him not touching it is exactly the wrong behaviour.
   * ⚠️ Brightness is NOT ours to set - no browser exposes it. The white
   * background is the only lever a web app has, which is part of why it is
   * white rather than merely light.
   */
  var ticketWake = null;

  function ticketWakeOn() {
    if (!navigator.wakeLock || !navigator.wakeLock.request) return;
    try {
      navigator.wakeLock.request("screen").then(function (lock) {
        ticketWake = lock;
      }).catch(function () { /* denied or unsupported - the QR still shows */ });
    } catch (e) { /* older WebKit throws rather than rejecting */ }
  }

  function ticketWakeOff() {
    if (!ticketWake) return;
    try { ticketWake.release(); } catch (e) {}
    ticketWake = null;
  }

  function ticketDate(iso) {
    var d = new Date(iso + "T12:00:00+01:00");
    return d.toLocaleDateString("en-GB",
      { weekday: "long", day: "numeric", month: "short" }).toUpperCase();
  }

  function closeTicket() {
    var scr = $("#ticket");
    if (!scr || scr.classList.contains("is-hidden")) return;
    scr.classList.add("is-hidden");
    ticketWakeOff();
  }

  /* rec: the {order, covers, tickets, type} plan.json hung on the event.
   * info: {title, date, time, end, place} - what the popup already knows. */
  function openTicket(rec, info) {
    var body = $("#ticketBody");
    if (!body) return;
    body.innerHTML = "";
    var order = ticketOrder(rec.order);
    /* ⚠️ ONE CODE PER TICKET, where the seller works that way. EdFringe and
     * Assembly send a single code for the whole order; the International
     * Festival attaches a PDF per ticket, so both of his Clown Show codes have
     * to be on screen - the door scans each person in, and a screen showing
     * one of two would strand whoever he brought. */
    var codes = order ? (order.barcodes && order.barcodes.length
                         ? order.barcodes.filter(function (b) { return b && b.b64; })
                         : (order.barcode && order.barcode.b64 ? [order.barcode] : []))
                      : [];

    if (!codes.length) {
      /* ⚠️ Says what is true, and never draws a placeholder square. A fake
       * barcode at a door would be worse than an honest empty screen: he would
       * stop looking for the real one. */
      body.appendChild(el("div", "tkmiss", "This barcode is not on this device yet"));
      body.appendChild(el("div", "tksub",
        "It is in your confirmation email. Tap ↻ with a signal and it will " +
        "sync across; after that it works offline."));
    } else {
      var badge = el("div", "tkbadge");
      badge.appendChild(ticketIcon());
      badge.appendChild(el("span", null, ticketBadgeText(rec)));
      body.appendChild(badge);

      codes.forEach(function (bc, i) {
        if (codes.length > 1) {
          /* The seat, when the seller gives one - "Stalls B15". At a seated
           * theatre that is the difference between the two codes, and holding
           * up the wrong one is the whole problem this line prevents. */
          body.appendChild(el("div", "tkcount",
            "Ticket " + (i + 1) + " of " + codes.length +
            (bc.label ? " \u00b7 " + bc.label : "")));
        }
        var img = new Image();
        img.className = "tkqr";
        img.alt = codes.length > 1
          ? ("Ticket " + (i + 1) + " of " + codes.length) : "Your ticket barcode";
        /* The image is the ONE from the email, byte for byte - never redrawn
         * from the token. A regenerated code guesses the symbology, and a guess
         * that fails is a guess that fails at the door. */
        img.src = "data:" + (bc.mime || "image/png") + ";base64," + bc.b64;
        body.appendChild(img);
      });
    }

    body.appendChild(el("h2", "tktitle", info.title || ""));
    if (info.date) body.appendChild(el("div", "tkwhen", ticketDate(info.date)));
    if (info.time) {
      body.appendChild(el("div", "tktime",
        info.time + (info.end ? " – " + info.end : "")));
    }
    var n = rec.tickets || 1;
    body.appendChild(el("div", "tktype",
      n + " x " + (rec.type || (n === 1 ? "Ticket" : "Tickets"))));
    if (info.place) body.appendChild(el("div", "tkplace", info.place));

    $("#ticket").classList.remove("is-hidden");
    $("#ticketBody").scrollTop = 0;
    ticketWakeOn();
  }

  /* The button on the show sheet. Only ever built when plan.json says this
   * exact sitting has a ticket, so it cannot appear on a hold. */
  function ticketButton(title, focus) {
    var b = el("button", "btn small ticketbtn");
    b.appendChild(ticketIcon());
    b.appendChild(el("span", null, "View Ticket"));
    b.onclick = function (ev) {
      ev.stopPropagation();
      var go = function () {
        openTicket(focus.ticket, {
          title: (focus.offsite && focus.offsite.title) || title,
          date: focus.date, time: focus.time,
          end: focus.end, place: focus.location
        });
      };
      /* Cached copy first so it opens instantly and works with no signal; a
       * fetch only when this device has never seen the store. */
      if (ticketStore || cachedTickets()) { go(); fetchTickets(); }
      else fetchTickets().then(go).catch(go);
    };
    return b;
  }

  // How much slack he really has around a performance: the distance to the
  // commitments either side, measured before the travel padding is applied, so
  // the number is the actual free time rather than the app's safety margin.
  function bookmarkIcon() {
    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("class", "bmk");
    var path = document.createElementNS(ns, "path");
    path.setAttribute("d", "M6 3h12v18l-6-4.5L6 21z");
    svg.appendChild(path);
    return svg;
  }

  function fitLine(date, time, before, after) {
    var row = el("div", "fitrow");
    row.appendChild(el("span", "fd", longDate(date) + (time ? " at " + ampm(time) : "")));
    // Past an hour the exact figure stops mattering - "10h 30m before" and
    // "+1h before" tell him the same thing, which is "plenty". Under an hour
    // it is a real constraint, so that stays exact.
    var room = function (mins) { return mins > 60 ? "+1h" : dur(mins); };
    // Three bands, because he cannot hurry between venues: an hour or more is
    // comfortable, under an hour is worth noticing, under 25 minutes is a
    // problem. His thresholds, 2026-08-15.
    var band = function (mins) {
      return mins < 25 ? "urgent" : mins < 60 ? "tight" : null;
    };
    var slack = el("span", "fs");
    if (before != null) {
      slack.appendChild(el("i", band(before), room(before) + " before"));
    }
    if (after != null) {
      slack.appendChild(el("i", band(after), room(after) + " after"));
    }
    row.appendChild(slack);
    return row;
  }

  // ⚠️ `focus` is the ONE performance he tapped on My Calendar: its date, its
  // time and the venue that entry carries. His request 2026-08-16 - from the
  // calendar he is asking "where and when is THIS", not "when does this show
  // ever run", so the header answers that instead of summarising the run.
  // Browse, Book Next and What Changed pass nothing and keep the summary.
  function openShowByHref(href, fallbackTitle, focus) {
    /* ⚠️ INTERCEPTED FIRST. A ticket to something off the Fringe programme
     * carries its own festival's URL as `href`, so every line below - the
     * favourites lookup, the catalogue row, the fallback that opens
     * edfringe.com/tickets/whats-on/<slug> - would be looking for a show that
     * does not exist there. Clown Show is at the International Festival. */
    if (focus && focus.offsite) return showOffsite(fallbackTitle, focus);
    var slug = String(href || "").split("/").filter(Boolean).pop();
    if (!slug) return;
    var fav = plan.favourites.filter(function (f) { return f.href === href; })[0];
    if (fav) return showFav(fav, focus);

    var fromCat = function () {
      var row = catalogue && catalogue.shows.filter(function (r) { return r.s === slug; })[0];
      if (row) return showCatShow(row, focus);
      window.open("https://www.edfringe.com/tickets/whats-on/" + slug,
                  "_blank", "noopener");
    };
    if (catalogue) return fromCat();
    openSheet(function (b) {
      b.appendChild(el("h2", null, fallbackTitle || "Loading…"));
      b.appendChild(el("div", "sub", "Fetching this show's dates…"));
    });
    loadCatalogue().then(fromCat).catch(function () {
      window.open("https://www.edfringe.com/tickets/whats-on/" + slug,
                  "_blank", "noopener");
    });
  }


  /* A ticket to something outside the Fringe: no catalogue row, no
   * availability grid, no favourite - there is nothing to book and nothing to
   * compare it against. Just what it is, where, when, and the ticket. */
  function showOffsite(fallbackTitle, focus) {
    var off = focus.offsite || {};
    openSheet(function (b) {
      b.appendChild(sheetHead(off.imageUrl, off.title || fallbackTitle,
        [off.festival,
         focusPlaceList(focus.location, focus.pls),
         { t: shortDate(focus.date) + " \u00b7 " + ampm(focus.time), cls: "when" }],
        null, focus));
    });
  }

  // cells: [{date, day, state, time}] where state is fits | busy | gone | away
  // ⚠️ Which sitting picker is open, remembered ACROSS a sheet rebuild. Holding
  // a time calls onChange, which rebuilds the whole sheet - so without this the
  // picker vanished the instant he used it, collapsing him back to the calendar
  // after every single tap. His report, 2026-08-16.
  var timePickOpenFor = null;

  function availabilityWeek(slug, title, cells, onChange) {
    var host = el("div", "availhost");
    var picker = el("div", "timepick is-hidden");
    var cellByDate = {};
    var grid = el("div", "dategrid week");
    WEEKDAYS.forEach(function (w) { grid.appendChild(el("i", "wdh", w)); });
    if (!cells.length) return grid;

    var byDate = {};
    cells.forEach(function (c) { byDate[c.date] = c; });
    var keys = Object.keys(byDate).sort();
    var first = new Date(keys[0] + "T12:00:00Z");
    var lead = (first.getUTCDay() + 6) % 7;

    // ⚠️ Every day of the week carries its date, even when the show is not on.
    // Empty squares made the grid hard to read as a calendar - the eye had
    // nothing to count along - so a day with no performance is the date in
    // grey rather than a hole. Whole weeks, Monday to Sunday, both ends.
    var todayStr = todayISO();
    var cur = new Date(first.getTime() - lead * 86400000);
    var lastKey = new Date(keys[keys.length - 1] + "T12:00:00Z");
    var tail = 6 - ((lastKey.getUTCDay() + 6) % 7);
    var last = new Date(lastKey.getTime() + tail * 86400000);
    while (cur <= last) {
      var iso = cur.toISOString().slice(0, 10);
      var c = byDate[iso];
      var dayNum = cur.getUTCDate();
      cur = new Date(cur.getTime() + 86400000);
      if (!c) {
        var off = el("div", "dcell blank" + (iso === todayStr ? " istoday" : ""));
        off.appendChild(el("div", "d", String(dayNum)));
        grid.appendChild(off);
        continue;
      }

      var owned = bookedOnDate(slug, c.date);
      var held = !owned && isHeld(slug, c.date);
      // A date in the past keeps its colour but cannot be held - holding a
      // performance that has already happened is never what he meant.
      // ⚠️ `owned` labels the square; what he may still HOLD is a separate
      // question. A show playing twice on the day he has a ticket keeps its
      // other sitting available - his rule, 2026-08-17.
      var daySlots = String(c.altTime || c.time || "").split("/").filter(Boolean);
      var freeSlots = holdableSlots(slug, c.date, daySlots);
      var canHold = (!owned || freeSlots.length > 0) &&
        c.state !== "away" && !c.past && !c.offTrip;

      var cls = "dcell " + (owned ? "owned" :
        c.state === "fits" ? "fits" : c.state === "busy" ? "open" :
        c.state === "gone" ? "gone" : "offtrip");
      if (held) cls += " isheld";
      if (c.offTrip) cls += " offtrip";
      if (c.past) cls += " past";
      if (c.date === todayStr) cls += " istoday";
      var cell = el(canHold ? "button" : "div", cls);
      cell.appendChild(el("div", "d", String(c.day)));
      cell.appendChild(el("div", null,
        owned ? "booked" : held ? "held"
        : (c.past || c.offTrip) ? (c.state === "gone" ? "gone" : "open")
        : c.state));
      // His idea, 2026-08-16: a tiny time under the date, but ONLY where the
      // show does not keep its usual hour - otherwise it repeats the time
      // already in the header on every single square.
      //
      // ⚠️ A day with several sittings gets the first plus "+N", never the
      // whole list: 5 Headliners for £10 runs five times on some days, and
      // "12:00/13:30/15:50/18:00/19:30" in a 50px square is unreadable. The
      // exact list is what the header count and the fits list are for.
      if (c.altTime) {
        var slots = String(c.altTime).split("/").filter(Boolean);
        // ⚠️ When he holds a sitting, the cell names THAT one - not the first
        // of the day. Otherwise a hold on the 21:30 reads as 10:00 and the
        // square disagrees with his own calendar.
        var mineHere = held ? heldTimes(slug, c.date) : [];
        var label;
        if (mineHere.length) {
          label = mineHere[0] + (mineHere.length > 1
            ? "+" + (mineHere.length - 1) : "");
        } else {
          // ⚠️ Lead with a sitting still on sale. Ania Magliano on 19 Aug is
          // 13:25 sold out and 23:10 open, and showing "13:25" on an open
          // square invited exactly the hold that went on the sold-out one.
          var codes = String(c.altCodes || "");
          var lead = 0;
          for (var ci = 0; ci < slots.length; ci++) {
            var cc2 = codes.charAt(ci);
            if (cc2 !== "n" && cc2 !== "x") { lead = ci; break; }
          }
          label = slots[lead] + (slots.length > 1 ? "+" + (slots.length - 1) : "");
        }
        cell.appendChild(el("div", "dtime", label));
      }
      cellByDate[c.date] = c;
      if (canHold) {
        /* ⚠️ cell and owned are `var`s in this loop, so a handler that reads
         * them later reads the LAST day's, not its own. Both are captured. */
        (function (cc, isHeldNow, box, isOwned) {
          var heldNow = isHeldNow;
          box.onclick = function (ev) {
            ev.stopPropagation();
            var slots = String(cc.altTime || cc.time || "")
              .split("/").filter(Boolean);
            // ⚠️ More than one sitting: never guess. Defaulting to the first
            // time silently held the 10:00 when he meant the 21:30, and CAI
            // runs six times on the 19th.
            if (slots.length > 1) {
              timePickOpenFor = { slug: slug, date: cc.date };
              return openTimePick(cc, slots);
            }
            // A single-performance date has nothing to choose, so it closes the
            // picker rather than leaving a stale one open under the grid.
            timePickOpenFor = null;
            picker.classList.add("is-hidden");
            // slots is the day's COMPLETE live list, so a release here also
            // clears any orphaned row (stored time no longer scheduled).
            var work = heldNow ? removeHold(slug, cc.date, cc.time || "", slots)
                               : addHold(slug, title, cc.date, cc.time || "");
            /* ⚠️ PAINT IT NOW. The rebuild below waits on the push, and the
             * push is a network round trip - measured at 8.6 s on 17 Aug. For
             * those seconds the square was unchanged and the closure still
             * said "not held", so a second tap looked like a first one. Then
             * both landed: the hold went on and straight back off, and it read
             * as a tap that never worked. Two of his 28 Aug sittings were lost
             * that way. The local store is already written by here, so the
             * square can say so before anything reaches the network. */
            heldNow = !heldNow;
            if (!isOwned) {
              box.classList.toggle("isheld", heldNow);
              if (box.children[1]) {
                box.children[1].textContent = heldNow ? "held" : cc.state;
              }
            }
            renderDays();
            work.then(function () { if (onChange) onChange(); });
          };
        })(c, held, cell, owned);
      }
      grid.appendChild(cell);
    }

    // The sitting picker, under the grid rather than over it: a popover on a
    // phone covers the very dates he is choosing between.
    function openTimePick(cc, slots) {
      picker.innerHTML = "";
      picker.classList.remove("is-hidden");
      var mine = heldTimes(slug, cc.date);
      picker.appendChild(el("div", "tphead",
        longDate(cc.date) + " · " + slots.length + " showtimes"));
      var row = el("div", "tprow");
      // Same colour language as the date squares: sold-out sittings read red,
      // bookable ones teal. Sold out is still tappable - holding one is how he
      // finds out if tickets come back - but it can no longer look available.
      var codeFor = {};
      var rawCodes = String(cc.altCodes || "");
      slots.forEach(function (t, i) { codeFor[t] = rawCodes.charAt(i) || ""; });
      // The day's COMPLETE sitting list, kept from before the filter below:
      // removeHold uses it to clear orphaned rows, and a partial list there
      // would release a second legitimate sitting.
      var allSlots = slots.slice();
      // The ticketed sitting is not on offer - holding it would duplicate the
      // ticket already on his calendar.
      slots = holdableSlots(slug, cc.date, slots);
      slots.slice().sort().forEach(function (t) {
        var on = mine.indexOf(t) >= 0;
        var code = codeFor[t];
        var gone = code === "n" || code === "x";
        var b = el("button",
                   "chip tpchip " + (gone ? "tpgone" : "tpopen") +
                   (on ? " is-on" : ""),
                   short12(t) + (gone ? " · sold out" : "") + (on ? " · held" : ""));
        b.type = "button";
        b.onclick = function (ev) {
          ev.stopPropagation();
          // Tapping a held sitting releases just that one; tapping another
          // ADDS it, so he can hold two times on the same day.
          var work = on ? removeHold(slug, cc.date, t, allSlots)
                        : addHold(slug, title, cc.date, t);
          renderDays();
          /* ⚠️ REBUILD THE CHIPS NOW, not when the push resolves. `on` was
           * read when this row was drawn, and the row was only ever redrawn
           * inside the .then() below - so for the whole round trip (8.6 s,
           * measured 17 Aug) the chip still said what it said before the tap.
           * Tap 11:00 PM, see nothing happen, tap again: the first tap had
           * landed by then, so the second one RELEASED it. That is how both
           * 28 Aug sittings of Bebe Cave went off within half a second of
           * each other. add/removeHold have already written localStorage by
           * the time we get here, so this reads the truth. */
          timePickOpenFor = { slug: slug, date: cc.date };
          openTimePick(cc, allSlots);
          work.then(function () {
            // Stays open: he is usually picking more than one, and the rebuilt
            // sheet reopens this same date because timePickOpenFor survives it.
            timePickOpenFor = { slug: slug, date: cc.date };
            /* ⚠️ allSlots, never the filtered list. openTimePick treats what
             * it is given as the day's COMPLETE sittings and hands it to
             * removeHold as the orphan test - a partial list there releases a
             * second legitimate sitting. */
            if (onChange) onChange();
            else openTimePick(cc, allSlots);
          });
        };
        row.appendChild(b);
      });
      picker.appendChild(row);
      picker.appendChild(el("div", "tpnote",
        "Tap a time to hold it. Hold as many as you like on one day; tap a held "
        + "time again to let it go."));
    }

    host.appendChild(grid);
    host.appendChild(picker);

    if (timePickOpenFor && timePickOpenFor.slug === slug) {
      var again = cellByDate[timePickOpenFor.date];
      var againSlots = again
        ? String(again.altTime || again.time || "").split("/").filter(Boolean) : [];
      if (againSlots.length > 1) openTimePick(again, againSlots);
      else timePickOpenFor = null;       // it no longer has a choice to make
    }
    return host;
  }

  /* How far into the gap this show's sitting starts, in minutes. Ascending is
   * chronological order WITHIN the gap - which is not the same as sorting the
   * clock, once a gap runs past midnight. */
  /* ⚠️ A merged window answers to more than one id: the shows that fit its
   * soft part carry the region's id, and the ones that fit a real gap it
   * swallowed still carry that gap's. Looking up only g.id lost the second
   * kind - they kept their card but fell back to the headline time and sorted
   * last. One lookup, used everywhere. */
  function oppFor(f, g) {
    var ids = {};
    ids[g.id] = 1;
    (g.covers || []).forEach(function (gid) { ids[gid] = 1; });
    return (f.opportunities || []).filter(function (o) { return ids[o.gapId]; })[0];
  }

  function fitSlack(f, g) {
    var opp = oppFor(f, g);
    if (opp && typeof opp.beforeMin === "number") return opp.beforeMin;
    var t = (opp && opp.time) || f.time || "";
    var m = /^(\d{1,2}):(\d{2})$/.exec(t);
    if (!m) return 1e9;                        // no time known: park it last
    var mins = (+m[1]) * 60 + (+m[2]);
    var gs = (+g.start.slice(11, 13)) * 60 + (+g.start.slice(14, 16));
    if (mins < gs) mins += 1440;               // after midnight, so later
    return mins - gs;
  }

  /* Slugs that have just put tickets BACK on sale - one of his three Discover
   * signals. Same alert types the Activity tab counts as "tickets back". */
  function ticketsBackSet() {
    var out = {};
    (plan.alerts || []).forEach(function (a) {
      if (a.type === "availableAgain" || a.type === "new_availability") {
        out[a.slug] = 1;
      }
    });
    return out;
  }

  /* ⚠️ DISCOVER: what could go in this window that is NOT already on his list.
   * His ask, 2026-08-18 - "a selection of shows that are not on my favourites
   * in that time slot. prioritized by popularity, shows that added new
   * tickets, and nearby to the previous event" - and the reason the bands that
   * say "nothing from your list fits" are now worth tapping.
   *
   * ⚠️ Popularity here is DEPLETION, never room size. A sellout says the same
   * thing about a 40-seat room as a 400-seat one; the size only says how
   * famous the act already was, and 101 of his 117 favourites are in rooms of
   * 300 or fewer. Ranking on capacity would fight his own taste.
   *
   * The sitting is checked against the window with the same travel pad the
   * Python fit uses, so Discover and "N favourites fit" cannot disagree. */
  function discoverFor(g) {
    if (!catalogue || !catalogue.shows) return [];
    var date = g.start.slice(0, 10);
    var dayNum = Number(date.slice(8, 10));
    function mins(iso) {
      var m = Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16));
      return iso.slice(0, 10) !== date ? m + 24 * 60 : m;
    }
    var ws = mins(g.start), we = mins(g.end);
    var pad = plan.travelPadMin || 10;
    var back = ticketsBackSet();
    var anchor = g.after || null;
    var alat = anchor && anchor.lat != null ? anchor.lat : null;
    /* ⚠️ A window can run past midnight, and the catalogue is keyed on the
     * CALENDAR day - so 19:20-04:00 has to look at two of them, with the
     * second shifted a day forward. Reading only the first was why the
     * 00:00-04:00 window reported that nothing in the whole catalogue fitted:
     * its own shows are listed under that date at 00:25, not 24:25. */
    var lookDays = [[dayNum, 0]];
    if (we > 24 * 60) lookDays.push([dayNum + 1, 24 * 60]);

    var out = [];
    catalogue.shows.forEach(function (r) {
      if (r.fav || r.bk) return;                  // his list, and his tickets
      var pick = null;
      lookDays.forEach(function (dd) {
        if (pick) return;
        var row = null;
        (r.d || []).forEach(function (p2) { if (p2[0] === dd[0]) row = p2; });
        if (!row) return;
        var codes = String(row[3] || "");
        var slots = String(row[2] || r.tm || "").split("/").filter(Boolean);
        slots.forEach(function (t, i) {
          if (pick) return;
          var code = codes.charAt(i) || row[1];
          if (code === "n" || code === "x") return;       // gone or cancelled
          var st = Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) + dd[1];
          /* ⚠️ The SAME late-start leeway build_plan.py applies, taken from
           * the plan rather than typed here - Discover and "N favourites fit"
           * must not disagree about what fits. Floored at the window's own
           * edge: the leeway shaves the travel pad, it never starts a show
           * before the gap opens. */
          var lee = plan.lateStartLeewayMin || 0;
          if (st >= Math.max(ws + pad - lee, ws) &&
              st + (r.dm || 60) + pad <= we) {
            pick = { time: t, date: dd[0] };
          }
        });
      });
      if (!pick) return;

      var pop = r.sch ? r.dep / r.sch : 0;
      var fresh = back[r.s] ? 1 : 0;
      var near = 0.4, km = null;                          // neutral if unknown
      var pl = (r.pl || [])[0];
      if (alat != null && pl && pl[2] != null) {
        km = haversineKm(alat, anchor.lng, pl[2], pl[3]) * DETOUR;
        near = 1 - Math.min(1, km / OUT_OF_TOWN_KM);
      }
      out.push({ r: r, time: pick.time, day: pick.date, km: km,
                 score: 0.55 * pop + 0.25 * fresh + 0.20 * near });
    });
    out.sort(function (a, b) { return b.score - a.score; });
    return out;                       // paged in showGap, never truncated here
  }

  /* ------------------------------------------------------- NEARBY NOW
   * His request 2026-08-23: what is within a 10 minute walk and starts within
   * the hour, ordered by urgency. Then, unprompted and decisive:
   *
   *   "the nearby now is particularly useful when discovering a NEW show
   *    during a gap. i could impulsively go and see something"
   *
   * So it reads the CATALOGUE, not his favourites - all 4,296 shows, with his
   * own marked by the Fave tag the card already draws. A list that could only
   * ever return things he had already chosen would not answer the question he
   * asked it.
   *
   * ⚠️ It deliberately IGNORES the gap it was opened from, and the
   * Faves/Discover segment with it. His own screenshot settled the first part:
   * at 17:43 he was looking at a 20:00-04:00 window, so "starts within the
   * hour" restricted to that gap could only ever be empty. This answers "what
   * can I get to right now" - a question about the clock and his feet, not
   * about the window.
   *
   * ⚠️ Ranked on DEPLETION SHARE, not the blended `urgency`. Urgency is
   * 0.65*share + 0.35/openOnTrip, and how many chances remain over the whole
   * trip is meaningless for a show starting in forty minutes - the only thing
   * that matters standing in the street is how nearly gone it is. Share is
   * also the number the card already shows ("5/8 dates gone"), so the order
   * and the card agree.
   */
  /* ⚠️ 7 minutes - his call 2026-08-23, after 10 then 5. Standing in the
   * street with forty minutes, a ten minute walk each way is most of the
   * decision; this is the "round the corner" list, not the "across town" one.
   *
   * ⚠️ 7 rather than 5 because the WALK MODEL runs slow, and he set the radius
   * to match the model rather than have the model changed. His own two data
   * points ("Summerhall is 5 minutes from my flat" - the app says 8; "Dome to
   * George Square is 5" - the app says 4) contradict each other under any pure
   * speed model, since 230 m cannot take as long as 519 m. The signature is a
   * missing FIXED OVERHEAD - leaving a venue, crossing a Fringe crowd - not a
   * wrong km/h, so nothing was tuned on two rounded estimates. Left as a known
   * blank spot; a single long-walk measurement would separate the two.
   *
   * The note, the empty state and the filter all read this one number. */
  var NEARBY_WALK_MIN = 7, NEARBY_START_MIN = 60;
  /* ⚠️ A sitting that began up to this many minutes ago is STILL OFFERED - his
   * call 2026-08-23: "sometimes shows start a little late, or allow late walk
   * ins." Nearby now only. Everywhere else in the app a sitting that has
   * started is over, because everywhere else he is planning rather than
   * standing outside the venue. */
  var NEARBY_LATE_MIN = 5;

  function nearbyNow() {
    if (!catalogue || !catalogue.shows || !myPos) return [];
    var now = new Date();
    var today = todayISO();
    var dayNum = Number(today.slice(8, 10));
    var nowMin = now.getHours() * 60 + now.getMinutes();
    var out = [];
    catalogue.shows.forEach(function (r) {
      if (r.bk) return;                                  // already has a ticket
      // The closest door this show uses - a run can move building mid-run.
      var walk = null;
      (r.pl || []).forEach(function (pl) {
        var w = walkMinutes(pl[2], pl[3]);
        if (w !== null && (walk === null || w < walk)) walk = w;
      });
      if (walk === null || walk > NEARBY_WALK_MIN) return;
      var row = null;
      (r.d || []).forEach(function (p2) { if (p2[0] === dayNum) row = p2; });
      if (!row) return;
      var codes = String(row[3] || "");
      var slots = String(row[2] || r.tm || "").split("/").filter(Boolean);
      slots.forEach(function (t, i) {
        var code = codes.charAt(i) || row[1];
        if (code === "n" || code === "x") return;        // gone or cancelled
        var st = Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
        var inMin = st - nowMin;
        // Not one further off than an hour, and not one so far gone that
        // walking in is fantasy - see NEARBY_LATE_MIN.
        if (inMin < -NEARBY_LATE_MIN || inMin > NEARBY_START_MIN) return;
        out.push({ r: r, time: t, day: dayNum, walk: walk, inMin: inMin,
                   share: r.sch ? r.dep / r.sch : 0 });
      });
    });
    out.sort(function (a, c) {
      if (c.share !== a.share) return c.share - a.share;
      return a.inMin - c.inMin;                          // then the soonest
    });
    return out;
  }

  function showGap(g, fits) {
    openSheet(function (b) {
      /* ⚠️ A plannable window is not FREE time and must not claim to be: on
       * 19 Aug it is 9h 20m only because his Video Work block stopped
       * blocking, and he is still working through most of it. The wide band
       * that opened this sheet says "1h 20m free" and means it. */
      b.appendChild(el("h2", null, dur(g.minutes) +
        (String(g.id || "").charAt(0) === "p" ? " to plan" : " free")));
      b.appendChild(el("div", "sub", longDate(g.start.slice(0, 10)) + " · " +
        clock(g.start) + " – " + clock(g.end)));

      /* ⚠️ Say what the gap hangs between. Without it every fit inherits the
       * flat travel pad and reads as equally reachable - so a 4-hour gap after
       * his reception in South Queensferry offered a 12:25 AM show in town
       * "25m before", which is 13.9 km away and true only by taxi. The bounds
       * line is free (the data is on the gap); the distance note appears only
       * where the anchor has coordinates. Preview 3 of audit #3, 2026-08-16. */
      var anchor = g.after || null;
      if (anchor && anchor.summary) {
        var line = el("div", "gapanchor");
        line.appendChild(el("b", null, "After: " + anchor.summary));
        var tail = [];
        if (anchor.where) tail.push(anchor.where.split(",")[0].trim());
        tail.push("ends " + clock(anchor.at));
        line.appendChild(el("span", null, " · " + tail.join(" · ")));
        line.appendChild(el("i", null, " — the fits below start from here"));
        b.appendChild(line);
      }

      /* His request 2026-08-17: the fits were always ordered by urgency, which
       * answers "what should I book" but not "what could I actually do next".
       * Both live on one row with the heading - the toggle is always there,
       * whichever way it is set, so the control never appears or disappears. */
      var gapHead = el("div", "gaphead");
      gapHead.appendChild(el("h3", null,
        gapSort === "nearby" ? "Near you, starting soon"
        : gapSource === "discover" ? "Not on your list"
        : "Favourites that fit"));

      /* Both segments are always here, whichever way either is set - a control
       * that appears and disappears is a control he has to hunt for. */
      function segment(opts, now, pick) {
        var seg = el("div", "gapsort");
        opts.forEach(function (opt) {
          var c = el("button", "chip" + (now === opt[0] ? " is-on" : ""));
          c.type = "button";
          c.textContent = opt[1];
          c.onclick = function (ev) {
            ev.stopPropagation();
            if (now === opt[0]) return;
            pick(opt[0]);
            showGap(g, fits);               // same redraw the hold button uses
          };
          seg.appendChild(c);
        });
        return seg;
      }
      var segs = el("div", "gapsegs");
      gapHead.appendChild(segment([["favourites", "Faves"], ["discover", "Discover"]],
        gapSource, function (v) { gapSource = v; discoverShown = DISCOVER_PAGE; }));
      segs.appendChild(segment([["priority", "Priority"], ["urgency", "Urgency"],
                                ["time", "Time"], ["nearby", "Nearby now"]],
        gapSort, function (v) {
          gapSort = v;
          /* ⚠️ The three ORDERINGS are remembered; "Nearby now" is not. It is
           * a question about this minute, and opening the app tomorrow to a
           * list of what was near him last night would be wrong. */
          if (v !== "nearby") {
            try { localStorage.setItem(GAPSORT_KEY, gapSort); } catch (e) {}
          }
        }));
      /* ⚠️ TWO ROWS since 2026-08-23. The fourth sort option pushed "Nearby
       * now" off the right edge of his phone - both segmented controls no
       * longer fit on one line beside the heading. His layout: the heading and
       * the WHICH-LIST toggle share the top line, and the four orderings get
       * their own line underneath, centred. */
      b.appendChild(gapHead);
      b.appendChild(segs);

      var wrap = el("div", "cards");
      var gapDate = g.start.slice(0, 10);

      /* ⚠️ The catalogue is 2.3 MB and fetched on demand, so Discover has to
       * survive not having it yet: say so, load it, and redraw. Falling back
       * to an empty list would have read as "nothing fits", which is the one
       * answer this tab exists to stop giving. */
      if (gapSource === "discover" && !catalogue) {
        wrap.appendChild(el("div", "note", "Loading the catalogue…"));
        b.appendChild(wrap);
        loadCatalogue().then(function () { showGap(g, fits); })
          .catch(function () {});
        return;
      }

      if (gapSort === "nearby") {
        /* Reads the catalogue, so it has the same on-demand problem Discover
         * does - say so, fetch it, redraw. */
        if (!catalogue) {
          wrap.appendChild(el("div", "note", "Loading the catalogue…"));
          b.appendChild(wrap);
          loadCatalogue().then(function () { showGap(g, fits); })
            .catch(function () {});
          return;
        }
        var near = nearbyNow();
        wrap.appendChild(el("div", "note",
          "Anything in the catalogue starting within " + NEARBY_START_MIN +
          " minutes — or up to " + NEARBY_LATE_MIN + " minutes ago, since " +
          "shows run late and take walk-ins — within a " + NEARBY_WALK_MIN +
          " minute walk" +
          (myPosIsHome ? " of your flat" : " of where you are") +
          ". Not limited to this gap, or to your favourites."));
        /* ⚠️ An empty list must say WHICH condition emptied it - the rule the
         * Book Now chips already follow. "Nothing found" would leave him
         * guessing whether the app knows where he is. */
        if (!myPos) {
          wrap.appendChild(el("div", "note",
            "This needs to know where you are, and it does not yet."));
        } else if (!near.length) {
          wrap.appendChild(el("div", "note",
            "Nothing within a " + NEARBY_WALK_MIN + " minute walk starts in " +
            "the next " + NEARBY_START_MIN + " minutes, or started in the " +
            "last " + NEARBY_LATE_MIN + "."));
        }
        near.forEach(function (hit) {
          var r = hit.r, item = el("div", "gapitem");
          item.appendChild(catCard(r));
          /* The two facts this list exists for, said plainly. */
          /* ⚠️ Say "started 3m ago", never "starts in -3m". The number is the
           * whole point of this row and a negative one reads as a bug. */
          item.appendChild(el("div", "gapwalk",
            "About " + hit.walk + "m walk · " + (hit.inMin < 0
              ? "started " + (-hit.inMin) + "m ago — may still let you in"
              : "starts in " + hit.inMin + "m")));
          var ndate = todayISO();
          var nheld = isHeld(r.s, ndate, hit.time);
          var nh = el("button", "gaphold" + (nheld ? " on" : ""));
          nh.appendChild(bookmarkIcon());
          nh.appendChild(el("span", null,
            (nheld ? "Held for " : "Hold ") + ndate.slice(8) + " Aug" +
            (hit.time ? " · " + ampm(hit.time) : "")));
          nh.onclick = function (ev) {
            ev.stopPropagation();
            var nrow = null;
            (r.d || []).forEach(function (p2) {
              if (p2[0] === hit.day) nrow = p2;
            });
            var nslots = nrow
              ? String(nrow[2] || r.tm || "").split("/").filter(Boolean) : [];
            var work = nheld ? removeHold(r.s, ndate, hit.time, nslots)
                             : addHold(r.s, r.t, ndate, hit.time);
            renderDays();
            work.then(function () { showGap(g, fits); });
          };
          item.appendChild(nh);
          wrap.appendChild(item);
        });
        b.appendChild(wrap);
        return;
      }

      /* ⚠️ Sort on the gap's own SLACK, never on the clock string. This gap
       * runs 19:20 to 04:00, so a 00:25 show is the LAST thing in it while
       * "00:25" sorts first as text. beforeMin is minutes of slack ahead of
       * the sitting, worked out in build_plan.py from real datetimes, so it
       * already carries the day roll. The clock fallback re-adds it by hand. */
      (gapSource === "discover" ? [] : fits.slice().sort(
          gapSort === "time"
          ? function (a, c) { return fitSlack(a, g) - fitSlack(c, g); }
          : gapSort === "priority"
          ? function (a, c) {
              /* Same regret order as Book Now. Inside a gap the
               * can-I-actually-go term is already answered - everything here
               * fits THIS slot - so what is left is want x gone-risk, which
               * is exactly the question. Ties fall to urgency then title so
               * the order is stable between renders. */
              var ap = priorityOf(a), cp = priorityOf(c);
              if (ap !== cp) return cp - ap;
              if ((c.urgency || 0) !== (a.urgency || 0)) {
                return (c.urgency || 0) - (a.urgency || 0);
              }
              return a.title.toLowerCase() < c.title.toLowerCase() ? -1 : 1;
            }
          : function (a, c) { return c.urgency - a.urgency; }))
        .forEach(function (f) {
          // Each show gets a hold for THIS gap's date, so he never has to open
          // the show and find the right day - the day is the reason he is here.
          var slug = f.href.split("/").pop();
          var opp = oppFor(f, g);
          var time = (opp && opp.time) || f.time || "";
          /* ⚠️ Same trap as Discover below: a window that runs past midnight
           * holds shows on the NEXT calendar day, and the opportunity is the
           * thing that knows which. */
          var fdate = (opp && opp.date) || gapDate;
          var item = el("div", "gapitem");
          item.appendChild(favCard(f));
          /* ⚠️ This button is about ONE sitting - its own label names the time -
           * so it must both read and release that sitting. It used to ask
           * isHeld() about the whole day (so a held 5:40 made the 1:25 button
           * say "Held") and then release the whole day on tap. Audit, 2026-08-16. */
          var held = isHeld(slug, fdate, time);
          var hb = el("button", "gaphold" + (held ? " on" : ""));
          hb.appendChild(bookmarkIcon());
          hb.appendChild(el("span", null,
            (held ? "Held for " : "Hold ") + fdate.slice(8) + " Aug"
            + (time ? " · " + ampm(time) : "")));
          hb.onclick = function (ev) {
            ev.stopPropagation();
            // The date row's full sitting list, so a release also clears any
            // orphaned row for this date. Absent row: no orphan clearing.
            var dayRow = (f.dates || []).filter(function (d) {
              return d.date === fdate;
            })[0];
            var gapSlots = dayRow
              ? ((dayRow.times && dayRow.times.length) ? dayRow.times
                 : (dayRow.time ? [dayRow.time] : [])) : [];
            var work = held ? removeHold(slug, fdate, time, gapSlots)
                            : addHold(slug, f.title, fdate, time);
            renderDays();
            work.then(function () { showGap(g, fits); });
          };
          // How far this show actually is from whatever ends the gap.
          if (anchor && anchor.lat != null) {
            var pl = (f.places && f.places[0]) || null;
            var vlat = pl && pl.lat != null ? pl.lat : null;
            var vlng = pl && pl.lng != null ? pl.lng : null;
            if (vlat != null) {
              var km = haversineKm(anchor.lat, anchor.lng, vlat, vlng) * DETOUR;
              var pad = plan.travelPadMin || 25;
              var walk = Math.ceil(km / WALK_KMH * 60);
              var where = (anchor.where || "").split(",")[0].trim() ||
                          "the last thing";
              /* ⚠️ Two bands, because one was wrong. Flagging everything that
               * exceeds the pad put "only works by taxi" on a 2.3 km hop
               * between Summerhall and the Pleasance - an ordinary Fringe walk
               * he does all day, and a note on every fit is a note he stops
               * reading. Beyond OUT_OF_TOWN_KM it genuinely is not a walk;
               * inside it, say the real number and let him decide. */
              if (km > OUT_OF_TOWN_KM) {
                item.appendChild(el("div", "gapfar",
                  km.toFixed(1) + " km from " + where +
                  " — " + pad + "m only works by taxi"));
              } else if (walk > pad) {
                item.appendChild(el("div", "gapwalk",
                  km.toFixed(1) + " km from " + where + " — about " + walk +
                  "m on foot, more than the " + pad + "m pad"));
              }
            }
          }
          item.appendChild(hb);
          wrap.appendChild(item);
        });
      if (gapSource === "discover") {
        /* ⚠️ Pick the selection FIRST, then order it. Sorting the whole
         * catalogue by time and taking the top 40 would hand him the 40
         * earliest shows in the window regardless of whether any of them is
         * worth seeing - the ranking is the point of this tab. So the 40 are
         * always the best 40, and Time only decides how they are laid out. */
        var ranked = discoverFor(g);
        var total = ranked.length;
        /* ⚠️ The PAGE is cut off the ranking, then ordered - so "load more"
         * always brings the next best shows, whichever way the list is laid
         * out. Slicing after a time sort would page through the morning first
         * and bury the good ones. */
        var found = ranked.slice(0, discoverShown);
        if (gapSort === "time") {
          found = found.slice().sort(function (a, c) {
            return (a.day - c.day) || (a.time < c.time ? -1 : a.time > c.time ? 1 : 0);
          });
        }
        if (!found.length) {
          wrap.appendChild(el("div", "note",
            "Nothing else in the catalogue fits this window."));
        }
        found.forEach(function (hit) {
          var r = hit.r, item = el("div", "gapitem");
          item.appendChild(catCard(r));
          /* ⚠️ The SHOW's date, not the window's. A 00:25 sitting found in the
           * 19:20-04:00 window belongs to the next calendar day, and a hold
           * keyed on the window's date would be a hold on the wrong night. */
          var ddate = gapDate.slice(0, 8) + ("0" + hit.day).slice(-2);
          var dheld = isHeld(r.s, ddate, hit.time);
          var dh = el("button", "gaphold" + (dheld ? " on" : ""));
          dh.appendChild(bookmarkIcon());
          dh.appendChild(el("span", null,
            (dheld ? "Held for " : "Hold ") + ddate.slice(8) + " Aug" +
            (hit.time ? " · " + ampm(hit.time) : "")));
          dh.onclick = function (ev) {
            ev.stopPropagation();
            // This date's whole sitting list, so a release also retires any
            // orphaned row - the same rule the favourites list follows.
            var drow = null;
            (r.d || []).forEach(function (p2) {
              if (p2[0] === hit.day) drow = p2;
            });
            var dslots = drow
              ? String(drow[2] || r.tm || "").split("/").filter(Boolean) : [];
            var work = dheld ? removeHold(r.s, ddate, hit.time, dslots)
                             : addHold(r.s, r.t, ddate, hit.time);
            renderDays();
            work.then(function () { showGap(g, fits); });
          };
          // Same two bands the favourites get: a real walk, or not a walk.
          if (hit.km != null) {
            var dpad = plan.travelPadMin || 10;
            var dwalk = Math.ceil(hit.km / WALK_KMH * 60);
            var dwhere = ((g.after && g.after.where) || "").split(",")[0].trim()
                         || "the last thing";
            if (hit.km > OUT_OF_TOWN_KM) {
              item.appendChild(el("div", "gapfar", hit.km.toFixed(1) +
                " km from " + dwhere + " — " + dpad + "m only works by taxi"));
            } else if (dwalk > dpad) {
              item.appendChild(el("div", "gapwalk", hit.km.toFixed(1) +
                " km from " + dwhere + " — about " + dwalk + "m on foot, more than the "
                + dpad + "m pad"));
            }
          }
          item.appendChild(dh);
          wrap.appendChild(item);
        });

        /* ⚠️ Say what is being held back, and offer the rest. A list that
         * stops at 30 with nothing said about it reads as "that is all there
         * is", which is exactly the silent cap this project refuses to ship. */
        if (total > found.length) {
          var more = el("button", "loadmore");
          more.type = "button";
          more.textContent = "Showing " + found.length + " of " + total +
                             " — load " + Math.min(DISCOVER_PAGE, total - found.length) + " more";
          more.onclick = function (ev) {
            ev.stopPropagation();
            discoverShown += DISCOVER_PAGE;
            showGap(g, fits);
          };
          wrap.appendChild(more);
        } else if (total > DISCOVER_PAGE) {
          wrap.appendChild(el("div", "note",
            "That is all " + total + " that fit this window."));
        }
      }

      b.appendChild(wrap);

      /* ⚠️ The other end of the window, his ask 2026-08-18: "can you have a
       * similar info message at the very bottom of the scroll that shows when
       * the next booked event on my schedule begins?" Only in TIME order -
       * that is the sort where the bottom of the list really is the latest
       * thing, so a deadline underneath it means something. In urgency order
       * the last card is simply the least urgent and the line would be
       * answering a question nobody asked. */
      var ends = g.before || null;
      if (gapSort === "time" && ends && ends.summary) {
        var endLine = el("div", "gapanchor ends");
        endLine.appendChild(el("b", null, "Then: " + ends.summary));
        var etail = [];
        if (ends.where) etail.push(ends.where.split(",")[0].trim());
        etail.push("starts " + clock(ends.at));
        endLine.appendChild(el("span", null, " · " + etail.join(" · ")));
        endLine.appendChild(el("i", null, " — the fits above all end before it"));
        b.appendChild(endLine);
      }

      b.appendChild(el("div", "note",
        "Fit allows " + plan.travelPadMin + " minutes either side for getting there and out."));
    });
  }

  function showFav(f, focus) {
    openSheet(function (b) {
      var favDays = favDaysOf(f);
      var whenFav = focus && focus.time
        ? shortDate(focus.date) + " · " + ampm(focus.time)
        : timeLabel(tripTimes(favDays), f.time);
      var placesFav = focus && focus.location
        ? focusPlaceList(focus.location, focus.pls)
        : placeList(f.places, f.venues, f.venue);
      b.appendChild(sheetHead(f.imageUrl, f.title,
        [f.presenter, placesFav, { t: whenFav, cls: "when" }, f.duration,
         f.genre, subGenreText(f.subGenres)], f.href.split("/").pop(), focus));

      b.appendChild(el("h3", null, "Availability"));
      var cells = f.dates.map(function (d) {
        var onTrip = d.date >= plan.tripStart && d.date <= (plan.showEnd || plan.tripEnd);
        var opp = f.opportunities.filter(function (o) { return o.date === d.date; })[0];
        // ⚠️ Keep the REAL availability for dates outside the trip too. These
        // used to collapse to "away", which threw the information away: every
        // pre-trip date read "open" whether it had sold out or not. He reads
        // that row to judge how fast a show is going, so it has to be true.
        // `offTrip` carries "he is not in Edinburgh" separately.
        // Same per-date truth as Browse. `d.time` beats f.time, which is only
        // the show's first performance ever; opportunities cover bookable trip
        // dates alone, so they cannot answer for the rest of the run.
        var slots = (d.times && d.times.length) ? d.times : (d.time ? [d.time] : []);
        var varies = slots.length > 1 || (d.time && f.time && d.time !== f.time);
        var st = d.timeStatus || {};
        return { date: d.date, day: d.day,
                 time: (opp && opp.time) || d.time || f.time,
                 altTime: varies ? slots.join("/") : "",
                 altCodes: varies ? slots.map(function (t) {
                   var k = st[t];
                   return k === "noAllocation" ? "n" : k === "cancelled" ? "x" : "o";
                 }).join("") : "",
                 past: d.date < todayISO(),
                 offTrip: !onTrip,
                 state: !d.open ? "gone" : (opp && opp.fits) ? "fits" : "busy" };
      });
      var favGrid = availabilityWeek(f.href.split("/").pop(), f.title, cells,
                                     function () { showFav(f, focus); });
      b.appendChild(favGrid);

      var fitting = f.opportunities.filter(function (o) { return o.fits; });
      if (fitting.length) {
        b.appendChild(el("h3", null, "Fits your schedule on"));
        var lines = el("div");
        fitting.forEach(function (o) {
          lines.appendChild(fitLine(o.date, o.time, o.beforeMin, o.afterMin));
        });
        b.appendChild(lines);
      }


      b.appendChild(el("div", "note",
        f.depleted + " of " + f.scheduled + " upcoming dates have no Fringe allocation left. " +
        "EdFringe publishes availability per date only, never seat counts, so a date " +
        "marked open may still be nearly full. Checked " +
        (plan.sourceScanAt || "").slice(0, 16).replace("T", " ") + "."));
    });
  }

  // --------------------------------------------------------------- wire

  document.querySelectorAll(".tab").forEach(function (t) {
    t.onclick = function () {
      document.querySelectorAll(".tab").forEach(function (x) { x.classList.remove("is-on"); });
      t.classList.add("is-on");
      ["days", "book", "browse", "activity"].forEach(function (v) {
        $("#view-" + v).classList.toggle("is-hidden", v !== t.dataset.view);
      });
      if (t.dataset.view === "browse") {
        loadCatalogue().then(renderBrowse).catch(function (err) {
          var why = String(err && err.message);
          $("#browseList").innerHTML = "";
          $("#browseList").appendChild(el("div", "emptyday",
            why === "no-token" || why === "bad-token"
              ? "Connect your data first — tap ↻."
              : "Catalogue unavailable offline until it has been loaded once."));
        });
      }
    };
  });

  function wireChips(sel, attr, apply) {
    document.querySelectorAll(sel + " .chip").forEach(function (c) {
      c.onclick = function () {
        document.querySelectorAll(sel + " .chip").forEach(function (x) {
          x.classList.remove("is-on");
        });
        c.classList.add("is-on");
        apply(c.dataset[attr]);
      };
    });
  }

  wireChips("#browseFilters", "f", function (v) {
    browseFilter = v; browseLimit = 60; renderBrowse();
  });
  wireChips("#actWhen", "when", function (v) { actWhen = Number(v); renderActivity(); });
  wireChips("#actWhat", "what", function (v) { actWhat = v; renderActivity(); });

  $("#browseSort").onchange = function () {
    browseSort = this.value; browseLimit = 60; renderBrowse();
  };
  $("#browseSearch").oninput = function () { browseLimit = 60; renderBrowse(); };

  findMe();

  // Tapping the warning asks again. If permission was permanently refused the
  // browser will not re-prompt, so say where to change it rather than looking
  // broken.
  $("#locwarn").onclick = function () {
    posReason = null;
    myPosIsHome = false;
    myPos = null;
    findMe();
    setTimeout(function () {
      if (posReason === "denied") {
        syncOn("Location is off for this app")(false, "Allow it in Settings");
      }
    }, 1200);
  };

  initGenrePick("browse", $("#genrePick"),
    function () { return (catalogue && catalogue.shows) || []; },
    function () { browseLimit = 60; renderBrowse(); });
  initGenrePick("book", document.querySelector('[data-gpick="book"]'),
    function () { return (plan && plan.favourites) || []; },
    function () { renderBook(); });
  initGenrePick("act", document.querySelector('[data-gpick="act"]'),
    function () { return (plan && plan.alerts) || []; },
    function () { renderActivity(); });

  document.addEventListener("click", closeAllGenrePanels);
  // A panel is anchored to its button, so a page scroll would leave it
  // stranded over the cards. Close it instead. Scrolling the list INSIDE the
  // panel does not fire this - that is what overscroll-behavior guards.
  window.addEventListener("scroll", closeAllGenrePanels, { passive: true });

  $("#bookSort").onchange = function () { bookSort = this.value; renderBook(); };
  $("#actSort").onchange = function () { actSort = this.value; renderActivity(); };
  $("#browseMoreBtn").onclick = function () { browseLimit += 120; renderBrowse(); };

  document.querySelectorAll("#bookFilters .chip").forEach(function (c) {
    c.onclick = function () {
      document.querySelectorAll("#bookFilters .chip").forEach(function (x) { x.classList.remove("is-on"); });
      c.classList.add("is-on");
      bookFilter = c.dataset.fit;
      renderBook();
    };
  });

  /* ⚠️ The ticket screen closes on its own control and on Escape, and on
   * NOTHING else. No tap-anywhere-to-dismiss: he is holding the phone out for
   * a stranger to scan, and a stray thumb on the glass must not take the
   * barcode away mid-scan. */
  document.querySelectorAll("[data-tclose]").forEach(function (n) {
    n.onclick = function (ev) { ev.stopPropagation(); closeTicket(); };
  });
  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape") closeTicket();
  });

  document.querySelectorAll("[data-close]").forEach(function (n) {
    n.onclick = function () {
      $("#sheet").classList.add("is-hidden");
      // Closing the sheet ends the choice: reopening a show should start at
      // the calendar, not halfway into a picker he left behind.
      timePickOpenFor = null;
      reopenSheet = null;
    };
  });

  // Asks the Mac for the LIGHT job, his decision 2026-08-15: re-read Google
  // Calendar, rebuild the plan, publish. It writes a request into the private
  // data repo, which the Mac's sync watcher picks up, then polls for the
  // result. If the watcher is not running the request simply expires - the
  // button reloads the latest published data either way, and says which of the
  // two happened rather than claiming work it did not do.
  //
  // ⚠️ This deliberately does NOT scan edfringe.com or send queued holds to
  // their site. That is heavier, slower and clicks their buttons, so it only
  // runs when he starts it on the Mac (sync_watch.py --once --full).
  /* ── Cloud refresh ────────────────────────────────────────────────────────
   *
   * Preferred over asking the Mac, since 2026-08-15: a GitHub Actions job reads
   * Google Calendar directly and republishes plan.json. No laptop, and it lands
   * in about a minute rather than up to five and a half.
   *
   * ⚠️ It is a SEPARATE, deliberately tiny token, not the data-repo one.
   * `workflow_dispatch` needs only "Actions: write" on fringe-planner-src -
   * enough to start this workflow and nothing else. The obvious alternative,
   * repository_dispatch, needs "Contents: write", which would let a leaked
   * phone token push code into the repo that holds his Google service-account
   * key: code push -> workflow edit -> secrets read. Not worth the convenience.
   *
   * ⚠️ The cloud job refreshes the CALENDAR half only. EdFringe availability
   * still needs the Mac, because their API sits behind a Cloudflare challenge.
   */
  var SRC_REPO = "fy9syzbg24-svg/fringe-planner-src";
  var WORKFLOW = "calendar-refresh.yml";
  var ACTIONS_TOKEN_KEY = "fringe-actions-token";

  function actionsToken() {
    try { return localStorage.getItem(ACTIONS_TOKEN_KEY) || ""; } catch (e) { return ""; }
  }

  function askForActionsToken(message) {
    var v = window.prompt(message ||
      "Paste a GitHub token with Actions write access to " + SRC_REPO +
      ".\n\nThis starts the calendar refresh in the cloud. Leave blank to keep " +
      "asking your Mac instead.");
    if (v === null) return "";
    v = v.trim();
    try { localStorage.setItem(ACTIONS_TOKEN_KEY, v); } catch (e) {}
    return v;
  }

  function cloudRefresh() {
    var tk = actionsToken();
    if (!tk) return Promise.resolve("no-cloud-token");

    var before = (plan && plan.generatedAt) || "";
    return fetch("https://api.github.com/repos/" + SRC_REPO +
                 "/actions/workflows/" + WORKFLOW + "/dispatches", {
      method: "POST",
      headers: { Authorization: "Bearer " + tk, "Content-Type": "application/json",
                 Accept: "application/vnd.github+json" },
      body: JSON.stringify({ ref: "main" })
    }).then(function (r) {
      if (r.status === 401 || r.status === 403) {
        try { localStorage.removeItem(ACTIONS_TOKEN_KEY); } catch (e) {}
        throw new Error("bad-actions-token");
      }
      if (r.status !== 204) throw new Error("dispatch-" + r.status);
      $("#meta").textContent = "Refreshing in the cloud…";
      return pollPlan(0, before);
    });
  }

  /* Watches for plan.json's generatedAt to MOVE. The workflow writes no status
   * file, and "the run finished" is not the question the phone cares about -
   * "is there new data for me" is. ~2 min: a runner starts in 10-20 s and the
   * job takes about 40. */
  var CLOUD_MAX_MS = 120000;

  function pollPlan(tries, before) {
    if (tries * POLL_EVERY_MS > CLOUD_MAX_MS) return "cloud-slow";
    var tk = token();
    return new Promise(function (res) { setTimeout(res, POLL_EVERY_MS); })
      .then(function () {
        return fetch("https://api.github.com/repos/" + DATA_REPO +
                     "/contents/plan.json?t=" + Date.now(), {
          cache: "no-store",
          headers: { Authorization: "Bearer " + tk, Accept: "application/vnd.github.raw" }
        });
      })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.generatedAt || d.generatedAt === before) {
          return pollPlan(tries + 1, before);
        }
        return "done";
      })
      .catch(function () { return pollPlan(tries + 1, before); });
  }

  function requestRemoteRefresh() {
    var tk = token();
    if (!tk) return Promise.reject(new Error("no-token"));
    var url = "https://api.github.com/repos/" + DATA_REPO + "/contents/refresh-request.json";
    var body = { requestedAt: new Date().toISOString(), from: "phone" };
    return fetch(url, { headers: { Authorization: "Bearer " + tk } })
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (meta) {
        return fetch(url, {
          method: "PUT",
          headers: { Authorization: "Bearer " + tk, "Content-Type": "application/json" },
          body: JSON.stringify({
            message: "refresh requested",
            content: btoa(JSON.stringify(body)),
            sha: meta.sha
          })
        });
      })
      .then(function (r) {
        if (r.status === 403 || r.status === 404) throw new Error("read-only");
        if (!r.ok) throw new Error(String(r.status));
        return pollStatus(0, body.requestedAt);
      });
  }

  // The Mac's watcher checks every 5 minutes, so the phone has to be willing
  // to wait longer than that or it would report "still running" on every
  // press even when the scan works perfectly. 6.5 min = one full watcher
  // interval, plus the ~30 s the scan itself takes, plus slack.
  var POLL_MAX_MS = 390000;
  var POLL_EVERY_MS = 5000;

  // ⚠️ Only a status that names THIS request counts. The status file always
  // holds the last run's result, so with the Mac asleep the phone used to read
  // yesterday's {"state":"done"} within five seconds and report a successful
  // sync that never happened.
  function pollStatus(tries, stamp) {
    if (tries * POLL_EVERY_MS > POLL_MAX_MS) return "asleep";
    var tk = token();
    return new Promise(function (res) { setTimeout(res, POLL_EVERY_MS); })
      .then(function () {
        return fetch("https://api.github.com/repos/" + DATA_REPO +
                     "/contents/refresh-status.json?t=" + Date.now(), {
          cache: "no-store",
          headers: { Authorization: "Bearer " + tk, Accept: "application/vnd.github.raw" }
        });
      })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (s) {
        if (!s || s.requestedAt !== stamp) return pollStatus(tries + 1, stamp);
        if (s.state === "working") {
          $("#meta").textContent = "Your Mac is working… " + (s.message || "");
          return pollStatus(tries + 1, stamp);
        }
        return s.state;                                   // done | failed
      })
      .catch(function () { return "unknown"; });
  }

  // While a refresh runs, the badge mirrors whatever step the Mac is on - so
  // the label always names the step the Mac is really doing.
  function watchSteps(stop) {
    if (!isLocal()) return;
    var tick = setInterval(function () {
      if (stop.done) { clearInterval(tick); return; }
      fetch("/api/status", { cache: "no-store" })
        .then(function (r) { return r.json(); })
        /* ⚠️ Check stop.done AGAIN here, not only before the fetch. A poll
         * started during the last step resolves after the run has finished and
         * the badge has already been released, and it then repaints the step
         * it saw - so a finished sync sat there reading "Syncing to GitHub"
         * instead of "Calendar synced". Seen on the new calendar button
         * 2026-08-18; the same race was always in the ↻ path. */
        .then(function (d) { if (!stop.done && d && d.step) syncSay(d.step); })
        .catch(function () {});
    }, 1500);
  }

  // ⚠️ Pull-to-refresh fetches the latest PUBLISHED data - it does not ask the
  // Mac for anything. The ↻ button is the one that does, and he has to mean to
  // press it.
  (function pullToRefresh() {
    var ptr = $("#ptr");
    if (!ptr) return;
    var startY = 0, startX = 0, pulling = false, dist = 0, busy = false;
    var THRESHOLD = 72, MAX = 96;

    function place(px, label) {
      ptr.style.transform = "translateY(" + px + "px)";
      ptr.querySelector("b").textContent = label;
      ptr.classList.toggle("armed", px >= THRESHOLD);
    }

    function reset() {
      ptr.classList.remove("on", "armed");
      ptr.style.transform = "";
      pulling = false; dist = 0;
    }

    document.addEventListener("touchstart", function (ev) {
      if (busy || ev.touches.length !== 1 || window.scrollY > 0) return;
      /* ⚠️ The sheet is a FIXED overlay, so the document is never scrolled
       * while it is open - `window.scrollY > 0` cannot see it, and pull to
       * refresh armed itself over the sheet's own scrolling. Scrolling back up
       * through a show's dates showed "Release to refresh" instead of moving,
       * which is the app fighting his thumb. Caught on his screen recording,
       * 2026-08-15.
       *
       * A gesture that starts anywhere inside the sheet belongs to the sheet. */
      var sheet = $("#sheet");
      if (sheet && !sheet.classList.contains("is-hidden")) return;
      if (ev.target && ev.target.closest && ev.target.closest("#sheet")) return;
      /* ⚠️ Same rule for EVERY scrolling overlay, not just the sheet. The genre
       * panel is its own fixed, scrolling list; flicking up it fast armed pull
       * to refresh and the page tried to reload underneath him. His report,
       * 2026-08-16. Any open overlay owns the gesture. */
      var overlaySel = ".gpickpanel:not(.is-hidden), .mapsback, .timepick:not(.is-hidden)";
      if (document.querySelector(".gpickpanel:not(.is-hidden), .mapsback")) return;
      if (ev.target && ev.target.closest && ev.target.closest(overlaySel)) return;
      startY = ev.touches[0].clientY;
      startX = ev.touches[0].clientX;
      pulling = true; dist = 0;
    }, { passive: true });

    document.addEventListener("touchmove", function (ev) {
      if (!pulling || busy) return;
      var dy = ev.touches[0].clientY - startY;
      var dx = Math.abs(ev.touches[0].clientX - startX);
      // The day strip scrolls sideways; a sideways drag is not a pull.
      if (dx > Math.abs(dy)) { pulling = false; return; }
      if (dy <= 0 || window.scrollY > 0) { reset(); return; }
      ev.preventDefault();                             // stop the rubber band
      dist = Math.min(MAX, dy * 0.55);                 // resistance
      ptr.classList.add("on");
      place(dist, dist >= THRESHOLD ? "Release to refresh" : "Pull to refresh");
    }, { passive: false });

    document.addEventListener("touchend", function () {
      if (!pulling || busy) { reset(); return; }
      if (dist < THRESHOLD) { reset(); return; }
      busy = true;
      place(THRESHOLD, "Refreshing…");
      ptr.classList.add("spin");
      // His spec: location on OPEN and on REFRESH, never in between. One shot,
      // and the 5-minute maximumAge means a pull straight after opening reuses
      // the fix the system already has rather than waking the radios again.
      findMe(true);
      // ⚠️ A pull to refresh also clears every page's genre filter, his rule
      // 2026-08-16 - a refresh should show him everything again, not silently
      // keep a filter he set on another page an hour ago.
      clearAllGenres();
      var release = syncOn("Syncing to GitHub");
      var jobs = isLocal()
        ? fetch("/api/pull", { method: "POST" }).catch(function () {})
        : Promise.resolve();
      var got = false;
      jobs.then(fetchPlan)
        .then(function (d) {
          got = true;                       // the network part succeeded
          try { localStorage.setItem(CACHE_KEY, JSON.stringify(d)); } catch (e) {}
          boot(d, false);
          release(true, "Up to date");
        })
        /* ⚠️ Distinguish "could not fetch" from "fetched fine, then a render
         * threw". Reporting a render failure as "Could not reach GitHub" sent
         * him looking for signal that was never the problem. Found by audit,
         * 2026-08-16. */
        .catch(function (err) {
          release(false, got ? "Refreshed, but the view failed to draw"
                             : "Could not reach GitHub");
          if (got) throw err;               // still surface it to the console
        })
        .then(function () {
          busy = false;
          ptr.classList.remove("spin");
          reset();
        });
    }, { passive: true });
  })();

  // ⚠️ ⌘R was collateral damage when ⌘Z came out - the whole key handler went
  // with it. Restored on its own: in a standalone window there is no browser
  // chrome to fall back on, so ⌘R has to be wired explicitly. No ⌘Z, by his
  // decision - the holds it would undo are real commitments.
  /* ⌘R on the MAC syncs the calendar first, then reloads - his request
   * 2026-08-18. Two rules make that safe to bolt onto a key he already uses:
   *
   *  - It ALWAYS ends in a reload, whether the sync worked, failed, or was
   *    refused because one was already running. ⌘R has meant "reload" since
   *    the app existed; the sync is added to it and may never take it away.
   *  - Off the Mac it is untouched. There is no /api/refresh on the phone, and
   *    holding ⌘R there in the standalone window is his only way back.
   *
   * calendarSync is assigned by calsyncButton() below, which runs at load, so
   * it is in place long before any keypress. If it is somehow missing, the
   * reload still happens. */
  var calendarSync = null;

  document.addEventListener("keydown", function (ev) {
    if (!(ev.metaKey || ev.ctrlKey) || ev.altKey) return;
    if ((ev.key || "").toLowerCase() !== "r") return;
    ev.preventDefault();
    if (ev.shiftKey && $("#refresh")) return $("#refresh").click();  // full scan
    if (!calendarSync) return location.reload();
    // ⚠️ Reload from the .then, never on a timer beside it: reloading mid-push
    // would leave his phone's queue half-sent with nothing on screen saying so.
    calendarSync().then(function () { location.reload(); },
                        function () { location.reload(); });
  });

  /* The desktop's SECOND button - his request 2026-08-18: "either do a full
   * sync, or just sync to github/calendar". Same sequence as ↻ with the three
   * EdFringe steps dropped (server.py EDFRINGE_STEPS), which is exactly the
   * light refresh sync_watch already runs when it spots a purchase.
   *
   * ⚠️ It is REMOVED from the DOM on anything but the Mac, not merely hidden.
   * "No changes to the mobile version" was the instruction, and on the phone
   * there is nothing for it to call: /api/refresh is the Mac's own server.
   * Removing it also means no stray control can appear if a class is ever
   * dropped by a later edit. */
  (function calsyncButton() {
    var btn = $("#calsync");
    if (!btn) return;
    if (!isLocal()) { btn.remove(); return; }
    btn.classList.remove("is-hidden");

    /* ⚠️ ↻ MEANS SOMETHING DIFFERENT ON EACH DEVICE, so its tooltip cannot be
     * one string. On the phone it really is "ask the Mac to re-read your
     * calendar and publish" - that is the whole of what the cloud path does -
     * and the markup keeps exactly that wording, untouched. On the Mac the
     * calendar half now has its own button beside it, so describing ↻ that way
     * describes the wrong control. His catch, 2026-08-18.
     *
     * It is retitled HERE, inside the desktop-only block, so there is one
     * place that decides the phone is unaffected. And it says "then everything
     * the calendar button does" rather than "EdFringe scan" alone, because the
     * full sequence still reads his calendar, rebuilds, publishes and mirrors -
     * ↻ is a superset of the new button, not an alternative to it. */
    var full = $("#refresh");
    if (full) {
      full.title = "Full sync — scan EdFringe for availability, then everything "
                 + "the calendar button does";
      full.setAttribute("aria-label", "Full sync including the EdFringe scan");
    }
    /* One implementation, two ways in: this button, and ⌘R above. Returns a
     * promise that RESOLVES either way - ⌘R reloads on both arms, and a
     * rejection there would be an unhandled one on a key he presses often. */
    function runCalendarSync() {
      // Same one-shot location rule as ↻: on open and on refresh, never between.
      findMe(true);
      btn.classList.add("is-busy");
      var release = syncOn("Reading your calendar");
      var stop = { done: false };
      watchSteps(stop);
      $("#meta").textContent = "Syncing your calendar — no EdFringe scan…";
      return fetch("/api/refresh?light=1", { method: "POST" })
        /* ⚠️ 409 means a sync is ALREADY running - the server refuses to start
         * a second. Its body has no `ok` at all, so this used to fall through
         * the ok !== false test and report "Calendar synced" for a sync that
         * never started. Reachable in one keypress now that ⌘R runs this. */
        .then(function (r) {
          return r.json().then(function (s) {
            return r.status === 409 ? { busy: true } : s;
          });
        })
        /* ⚠️ Report the SERVER's verdict, not merely that the fetch resolved.
         * A failed step still answers 200 with ok:false, and calling that
         * "Calendar synced" is the app telling him a sync happened when it
         * did not.
         *
         * ⚠️ And a FAILED sync must not re-render. build_plan never ran, so
         * there is nothing new to draw - but boot() starts a sync batch of its
         * own (retryQueues), and that batch settled the badge to "Up to date"
         * about a second after this one settled it to "failed". The meta line
         * said failed, the badge said fine, and the badge is the half he
         * glances at. Found 2026-08-18. */
        .then(function (s) {
          stop.done = true;
          if (s && s.ok === false) {
            release(false, "Calendar sync failed");
            $("#meta").textContent = "The calendar sync failed on your Mac — "
              + "your holds are safe; try the full sync, or check the log.";
            return;
          }
          catalogue = null;                               // force a re-fetch
          return fetchPlan().then(function (d) {
            release(true, s && s.busy ? "A sync was already running"
                                      : "Calendar synced");
            try { localStorage.setItem(CACHE_KEY, JSON.stringify(d)); } catch (e) {}
            boot(d, false);
          });
        })
        .catch(function () {
          stop.done = true;
          release(false, "Calendar sync failed");
          $("#meta").textContent += " · calendar sync unavailable";
        })
        .then(function () {
          stop.done = true;
          btn.classList.remove("is-busy");
        });
    }

    btn.onclick = runCalendarSync;
    calendarSync = runCalendarSync;
  })();

  $("#refresh").onclick = function () {
    // His spec: grab the location when the app opens and when he refreshes,
    // and at no other time. One shot each, never a running watch.
    findMe(true);
    var btn = this;
    btn.classList.add("is-busy");
    var cloud = !isLocal() && !!actionsToken();
    var release = syncOn(isLocal() ? "Starting"
                         : cloud ? "Refreshing in the cloud" : "Asking your Mac to scan");
    var stop = { done: false };
    watchSteps(stop);
    $("#meta").textContent = isLocal()
      ? "Scanning EdFringe…"
      : cloud ? "Refreshing your calendar in the cloud — about a minute…"
              : "Asking your Mac to scan — up to 5 minutes…";

    /* Cloud first when a token for it exists, the Mac otherwise. The cloud path
     * does the CALENDAR half only - EdFringe availability still needs the Mac -
     * and falls back rather than failing if the token is missing or rejected. */
    var first = isLocal()
      ? fetch("/api/refresh", { method: "POST" }).then(function (r) { return r.json(); })
      : (cloud ? cloudRefresh().catch(function (err) {
            var why = String(err.message);
            if (why === "bad-actions-token") {
              $("#meta").textContent = "That cloud token was rejected — asking your Mac instead.";
            }
            return requestRemoteRefresh();               // fall back, do not fail
          })
        : requestRemoteRefresh()
        ).catch(function (err) {
          if (String(err.message) === "read-only") return "read-only";
          throw err;
        });

    first
      .then(function (outcome) {
        catalogue = null;                                 // force a re-fetch
        return fetchPlan().then(function (d) { return [d, outcome]; });
      })
      .then(function (pair) {
        stop.done = true;
        var d = pair[0], outcome = pair[1];
        release(outcome !== "failed" && outcome !== "asleep" && outcome !== "cloud-slow",
                outcome === "failed" ? "Sync failed"
                : outcome === "asleep" ? "Your Mac didn't answer"
                : outcome === "cloud-slow" ? "Still running — pull down shortly"
                : "Calendar synced");
        try { localStorage.setItem(CACHE_KEY, JSON.stringify(d)); } catch (e) {}
        boot(d, false);
        if (outcome === "read-only") {
          $("#meta").textContent += " · reloaded only (token cannot request a scan)";
        } else if (outcome === "asleep") {
          $("#meta").textContent =
            "Your Mac never picked this up — is it awake and online? " +
            "Your holds are saved and will go out when it is.";
        } else if (outcome === "failed") {
          $("#meta").textContent += " · the scan failed on your Mac";
        }
      })
      .catch(function (err) {
        var why = String(err && err.message);
        if (why === "no-token" || why === "bad-token") askForToken();
        else $("#meta").textContent += " · refresh unavailable";
        release(false, "EdFringe sync failed");
      })
      .then(function () {
        stop.done = true;
        release(true, "Calendar synced");           // no-op if already released
        btn.classList.remove("is-busy");
      });
  };

  /* The build he is actually running, read from the service worker file that
   * deploy.sh stamps. Shown so a deploy can be confirmed from the phone rather
   * than assumed - "is it on the new one?" was previously unanswerable there.
   * no-store, or this reads the very cache we are trying to see past. */
  function showBuild() {
    var out = $("#appBuild");
    if (!out) return;

    /* ⚠️ This used to report only the PUBLISHED build - it fetched sw.js from
     * the server - which is the opposite of the question being asked. The
     * reason to look here at all is "I deployed a change and the phone still
     * looks the same", and in exactly that state the old readout showed the NEW
     * hash while the phone was still running the OLD shell. It confirmed the
     * deploy and said nothing about the app in his hand. Audit, 2026-08-16.
     *
     * The RUNNING version is knowable without the network: the active worker
     * named its own shell cache "fringe-shell-<VERSION>", and activate() has
     * already deleted every cache that is not current. */
    function runningBuild() {
      if (!window.caches) return Promise.resolve("");
      return caches.keys().then(function (keys) {
        for (var i = 0; i < keys.length; i++) {
          var m = /^fringe-shell-(.+)$/.exec(keys[i]);
          if (m) return m[1];
        }
        return "";
      }).catch(function () { return ""; });
    }

    function publishedBuild() {
      return fetch("sw.js", { cache: "no-store" })
        .then(function (r) { return r.text(); })
        .then(function (t) {
          var m = t.match(/var VERSION = "([^"]+)"/);
          return m ? m[1] : "";
        })
        .catch(function () { return ""; });      // offline: not an error
    }

    /* VERSION is "1.4+<hash>". He reads the number; the comparison uses the
     * whole string, because the hash half is the part that actually changes
     * when the app files do. Older builds carry a bare hash and no "+", which
     * pretty() passes through unchanged rather than mangling. */
    function pretty(v) {
      if (!v) return "";
      var plus = v.indexOf("+");
      return plus > 0 ? "v" + v.slice(0, plus) : v;
    }

    Promise.all([runningBuild(), publishedBuild()]).then(function (v) {
      var running = v[0], published = v[1];
      if (!running && !published) { out.textContent = ""; return; }
      if (!running) { out.textContent = pretty(published); return; }
      out.textContent = (!published || published === running)
        ? pretty(running)
        : pretty(running) + " · " + pretty(published) +
          " is published - use Force update the app";
    });
  }

  /* Force update: throw away the app's OWN cached files and reload.
   *
   * ⚠️ Deliberately does NOT touch localStorage - that is where his holds
   * queue, favourites queue, cached plan and GitHub token live. Only the
   * service worker registration and the caches it created are cleared, which
   * is what forces a clean re-download. Same design as the ACL tracker. */
  /* ⚠️ NEVER clear the cache without proving we can replace it.
   *
   * Clearing the worker and its caches offline BRICKS the app: the reload has
   * no worker, no cache and no network, so Safari shows its "not connected"
   * page and there is nothing to go back to until signal returns. On a plane or
   * in a venue basement that is a terrible trade for a convenience button - and
   * he asked exactly this before it ever bit him.
   *
   * navigator.onLine is not enough (it reads true on a captive wifi that serves
   * nothing), so this fetches a real file, from the network, with a timeout. If
   * that fails, NOTHING is touched and the app keeps working offline exactly as
   * it did. Same instinct as the rest of this workspace: verify the way back
   * before destroying what you have. */
  function canReachTheServer() {
    if (!window.fetch) return Promise.resolve(false);
    var ctl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 6000);
    return fetch("sw.js?probe=" + Date.now().toString(36), {
      cache: "no-store", signal: ctl ? ctl.signal : undefined
    }).then(function (r) {
      clearTimeout(timer);
      return r.ok;
    }).catch(function () {
      clearTimeout(timer);
      return false;
    });
  }

  function wireForceUpdate() {
    var btn = $("#forceUpdate");
    if (!btn) return;
    btn.onclick = function () {
      var status = $("#forceUpdateStatus");
      btn.disabled = true;
      if (status) status.textContent = "checking connection…";
      canReachTheServer().then(function (online) {
        if (!online) {
          btn.disabled = false;
          if (status) {
            status.textContent = "No connection — nothing cleared. "
                               + "The app still works offline; try again once you have signal.";
          }
          return;
        }
        clearAndReload(btn, status);
      });
    };
  }

  function clearAndReload(btn, status) {
    if (status) status.textContent = "clearing…";
    var jobs = [];
    if ("serviceWorker" in navigator) {
      jobs.push(navigator.serviceWorker.getRegistrations().then(function (regs) {
        return Promise.all(regs.map(function (r) { return r.unregister(); }));
      }));
    }
    if (window.caches) {
      jobs.push(caches.keys().then(function (keys) {
        return Promise.all(keys.map(function (k) { return caches.delete(k); }));
      }));
    }
    Promise.all(jobs).then(function () {
      if (status) status.textContent = "reloading…";
      // Bust the HTTP cache too, or iOS can hand back the same index.html.
      var u = new URL(location.href);
      u.searchParams.set("u", Date.now().toString(36));
      location.replace(u.toString());
    }).catch(function (err) {
      btn.disabled = false;
      if (status) status.textContent = "could not clear: " + (err && err.message ? err.message : err);
    });
  }

  /* Where the cloud token is entered, and the only place it can be cleared.
   * Deliberately next to Force update rather than hidden behind the ↻: he
   * should be able to see whether the phone can start a cloud refresh at all,
   * without pressing something that does work. */
  function wireCloudToken() {
    var btn = $("#cloudToken");
    if (!btn) return;
    var paint = function () {
      btn.textContent = actionsToken() ? "Cloud refresh: on" : "Cloud refresh: off";
    };
    paint();
    btn.onclick = function () {
      var status = $("#forceUpdateStatus");
      if (actionsToken()) {
        if (window.confirm("Turn off cloud refresh on this device?\n\n" +
                           "↻ will go back to asking your Mac. The token is " +
                           "forgotten here; nothing is revoked.")) {
          try { localStorage.removeItem(ACTIONS_TOKEN_KEY); } catch (e) {}
          if (status) status.textContent = "cloud refresh off";
        }
      } else if (askForActionsToken()) {
        if (status) status.textContent = "cloud refresh on — ↻ now runs in the cloud";
      }
      paint();
    };
  }

  wireForceUpdate();
  wireCloudToken();
  showBuild();

  /* ⚠️ `updateViaCache: "none"` is why a deploy reaches the phone at all.
   *
   * GitHub Pages serves sw.js with `cache-control: max-age=600` (measured).
   * Without this option the browser looks for a new service worker THROUGH that
   * HTTP cache, so for ten minutes after a deploy it re-reads the old bytes,
   * concludes nothing changed, and keeps serving the cache-first shell. Pulling
   * to refresh cannot fix it: the shell never goes to the network, so the pull
   * just re-renders the same cached app.js. That is exactly how a fix looked
   * invisible on his phone on 2026-08-15.
   *
   * The explicit update() on every launch and on return-to-foreground makes the
   * check happen when he actually opens the app, rather than whenever the
   * browser decides. sw.js calls skipWaiting()/clients.claim(), so once a new
   * worker is found it takes over immediately. */
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" })
      .then(function (reg) {
        // Offline, update() rejects because sw.js cannot be fetched. That is
        // the correct and safe outcome - nothing installs, nothing is deleted,
        // the app keeps opening from the cache it already has - but an
        // uncaught rejection still logs, so swallow it deliberately.
        var check = function () { reg.update().catch(function () {}); };
        check();
        document.addEventListener("visibilitychange", function () {
          if (!document.hidden) check();
        });
      })
      .catch(function () {});
  }

  load();
})();
