/* Fringe Planner service worker.
 *
 * Shell is cache-first so the app opens instantly with no signal.
 * Data is network-first with a cache fallback, so a refresh gets fresh
 * availability when there is signal and the last good copy when there isn't.
 * The app also keeps its own localStorage copy, so it renders even if
 * both of these miss.
 */

/* ⚠️ The shell is cache-first, so a browser only picks up a new app.js when
 * THIS FILE's bytes change. tools/deploy.sh rewrites the stamp below with a
 * hash of the app files on every deploy; without that, an installed PWA keeps
 * serving the version it first cached and every later fix is invisible on his
 * phone. Do not hand-edit the stamp. */
var VERSION = "4.2+e76d07c3cb16";
var SHELL = "fringe-shell-" + VERSION;
var DATA = "fringe-data-" + VERSION;
/* Without these four there is no app, so a failure to fetch any of them must
   fail the whole install (see below). */
var CORE = [
  "./",
  "index.html",
  "style.css",
  "app.js"
];

/* Nice to have. A missing icon or manifest is not worth throwing away an
   otherwise good update for. */
var EXTRAS = [
  "manifest.webmanifest",
  "img/icon-180.png",
  "img/icon-192.png"
];

/* ⚠️ Every precache fetch carries the deploy id as a query string.
 *
 * GitHub Pages edges lag a deploy by up to minutes. A worker installing in
 * that window can fetch OLD index.html together with NEW app.js and seal that
 * mixed pair into its cache generation - and nothing inside a generation ever
 * revalidates, so the bad pairing simply persists. That is what made the rehab
 * app render half-old, half-new on his phone. The CDN keys on the full URL, so
 * `?sv=<stamp>` forces every file past a stale edge. `cache: "reload"` bypasses
 * the browser's own HTTP cache for the same reason.
 *
 * Stored under the CLEAN url, so runtime lookups know nothing about the query.
 *
 * ⚠️ CORE failures reject, and that is deliberate: a rejected install means the
 * new worker is discarded and the OLD one keeps serving its complete cache. It
 * is what makes an update safe on a flaky connection - never a half-written
 * shell, and never no shell at all. Do not "fix" this by tolerating failures
 * the way a larger asset list can afford to. */
function precache(cache, url, required) {
  var busted = url + (url.indexOf("?") >= 0 ? "&" : "?") + "sv=" + VERSION;
  return fetch(new Request(busted, { cache: "reload" })).then(function (res) {
    if (!res.ok) throw new Error(url + " -> " + res.status);
    return cache.put(url, res);
  }).catch(function (err) {
    if (required) throw err;
  });
}

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(SHELL).then(function (c) {
      return Promise.all(CORE.map(function (u) { return precache(c, u, true); }))
        .then(function () {
          return Promise.all(EXTRAS.map(function (u) { return precache(c, u, false); }));
        });
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== SHELL && k !== DATA) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

/* ⚠️ On the Mac (127.0.0.1) the shell is NEVER served from cache.
 *
 * The published version stamps VERSION with a hash of the app files, so the
 * phone picks up new code. Locally the stamp stays "dev", which means a
 * cache-first shell keeps serving the build it first saw - so an edit lands on
 * disk, the server serves it, and Safari shows yesterday's app with no error
 * and nothing to click. That cost a round of "I refreshed, it looks the same".
 * Local is where we iterate, so it goes to the network first and only falls
 * back to cache if the server is down. */
var LOCAL = ["127.0.0.1", "localhost"].indexOf(self.location.hostname) >= 0;

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);

  if (url.pathname.indexOf("/api/") === 0) return;

  if (LOCAL) {
    e.respondWith(fetch(req).catch(function () { return caches.match(req); }));
    return;
  }

  if (url.pathname.indexOf("plan.json") >= 0) {
    /* ⚠️ Never cache a cache-BUSTED plan URL. The cloud poll fetches
     * plan.json?t=<now> every 5 s for up to two minutes, and each unique URL
     * became its own ~1.4 MB cache entry that is never matched again and never
     * pruned within a build - roughly 27 MB of junk per refresh press. Quota
     * pressure is the one thing that can evict the IndexedDB catalogue he needs
     * in a basement. Found by audit, 2026-08-16.
     *
     * ignoreSearch on the read so a busted URL can still be served by the
     * canonical entry when he is offline. */
    var bust = url.search && url.search.indexOf("t=") >= 0;
    e.respondWith(
      fetch(req).then(function (res) {
        if (!bust) {
          var copy = res.clone();
          caches.open(DATA).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () {
        return caches.match(req, { ignoreSearch: true }).then(function (hit) {
          /* ⚠️ 503, NOT 200. This used to return the error body with a
           * default 200, so fetchPlan - which only throws on !r.ok - handed
           * {"error": ...} back as if it were the plan. load() then wrote that
           * over the good cached copy and boot() died on plan.days, and
           * because the cached boot is the FIRST thing the next launch does,
           * the app opened to a dead shell even back online. A status code is
           * the cheapest place to break that chain. */
          return hit || new Response('{"error":"offline, no cached plan"}', {
            status: 503,
            headers: { "Content-Type": "application/json" }
          });
        });
      })
    );
    return;
  }

  /* ⚠️ The exact match first, so "Force update the app" still works: it
   * reloads onto ?u=<nonce>, which is deliberately NOT in the cache, so that
   * request has to reach the network to fetch the new shell.
   *
   * But the nonce STAYS in the address bar afterwards. Reload that URL with no
   * signal - hotel wifi that resolves nothing, a venue basement - and an exact
   * match misses, the fetch fails, and Safari shows its error page with a fully
   * cached app sitting right there. The ignoreSearch fallback runs only after
   * the network has already failed, so it can never pre-empt a force update.
   * Found by audit, 2026-08-16. */
  e.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).catch(function (err) {
        return caches.match(req, { ignoreSearch: true }).then(function (alt) {
          if (alt) return alt;
          throw err;
        });
      });
    })
  );
});
