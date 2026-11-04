<script setup>
import { computed, ref, watch } from "vue";
import {
  useClipboard,
  useDocumentVisibility,
  useIntervalFn,
  useNow,
  useDark,
  useToggle,
  useTitle,
  useWindowFocus,
} from "@vueuse/core";
import { useInbox } from "./store";
import { isProxyHeader } from "./headers";
import {
  PhShieldCheck,
  PhArrowUpRight,
  PhArrowCounterClockwise,
  PhArrowDownLeft,
  PhArrowRight,
  PhCopy,
  PhCheck,
  PhClock,
  PhTrash,
  PhMoon,
  PhSun,
  PhCircle,
  PhHeart,
  PhCoffee,
  PhGithubLogo,
  PhTerminalWindow,
} from "@phosphor-icons/vue";
const isDark = useDark({ storageKey: "hookachu-theme" });
const toggleTheme = useToggle(isDark);
const inbox = useInbox(),
  visibility = useDocumentVisibility(),
  now = useNow({ interval: 1000 });
const focused = useWindowFocus();
watch(
  () => visibility.value === "visible" && focused.value,
  (value) => inbox.setAttended(value),
  { immediate: true, flush: "sync" },
);
useTitle(
  computed(() =>
    inbox.unreadCount
      ? `(${inbox.unreadCount}) New requests · Hookachu`
      : "Hookachu — temporary webhook inbox",
  ),
);
const tab = ref("body"),
  pretty = ref(true),
  showProxyHeaders = ref(false),
  query = ref(""),
  copiedLabel = ref(""),
  confirmDelete = ref(false);
const { copy, isSupported } = useClipboard();
const remaining = computed(() =>
  Math.max(0, Math.ceil((inbox.expiresAt - now.value.getTime()) / 60000)),
);
const filtered = computed(() =>
  inbox.requests.filter((r) =>
    `${r.method} ${r.url}`.toLowerCase().includes(query.value.toLowerCase()),
  ),
);
const decoded = computed(() => {
  if (!inbox.selected) return "";
  try {
    const bytes = Uint8Array.from(atob(inbox.selected.body), (c) =>
      c.charCodeAt(0),
    );
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (pretty.value) {
      try {
        return JSON.stringify(JSON.parse(text), null, 2);
      } catch {}
    }
    return text || "(empty body)";
  } catch {
    return (
      "[Binary payload — use Base64 to inspect losslessly]\n" +
      inbox.selected.body
    );
  }
});
const allHeaderRows = computed(() => {
  const h = inbox.selected?.headers || [];
  return Array.from({ length: h.length / 2 }, (_, i) => [
    h[i * 2],
    h[i * 2 + 1],
  ]);
});
const proxyHeaderCount = computed(
  () => allHeaderRows.value.filter(([name]) => isProxyHeader(name)).length,
);
const headerRows = computed(() =>
  showProxyHeaders.value
    ? allHeaderRows.value
    : allHeaderRows.value.filter(([name]) => !isProxyHeader(name)),
);
const queryRows = computed(() =>
  inbox.selected
    ? [...new URL(inbox.selected.url, location.origin).searchParams.entries()]
    : [],
);
async function copyText(text, label) {
  try {
    await copy(text);
    copiedLabel.value = label;
    setTimeout(() => (copiedLabel.value = ""), 2000);
  } catch {
    copiedLabel.value = "Copy unavailable";
  }
}
async function tick() {
  if (visibility.value === "visible" && inbox.waiting && !inbox.id) {
    await inbox.create();
    return;
  }
  await inbox.refresh();
}
useIntervalFn(tick, 5000);
watch(visibility, (v) => {
  if (v === "visible") tick();
});
if (inbox.id) tick();
function copyCurl() {
  copyText(
    `curl -X POST '${inbox.endpoint}' -H 'Content-Type: application/json' -d '{"hello":"world"}'`,
    "cURL copied",
  );
}
function bytes(n) {
  return n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`;
}
function time(n) {
  return new Date(n).toLocaleTimeString([], { hour12: false });
}
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <a href="/" class="brand" @click.prevent="inbox.goHome()"
        ><img
          class="brand-logo"
          src="/hookachu.png?v=2"
          alt=""
          width="40"
          height="40"
        />hookachu<span class="brand-dot">.</span></a
      >
      <div class="flex items-center gap-5">
        <span class="hidden sm:inline text-xs text-stone-500"
          >A little inbox for your HTTP requests</span
        ><span class="pill"
          ><PhClock :size="13" aria-hidden="true" /> Temporary by design</span
        ><button
          class="theme-toggle"
          :aria-label="
            isDark ? 'Switch to light theme' : 'Switch to dark theme'
          "
          :title="isDark ? 'Light theme' : 'Dark theme'"
          @click="toggleTheme()"
        >
          <PhSun v-if="isDark" :size="19" aria-hidden="true" /><PhMoon
            v-else
            :size="19"
            aria-hidden="true"
          />
        </button>
      </div>
    </header>
    <main v-if="!inbox.id" class="landing">
      <div class="eyebrow">
        <span class="tiny-line"></span> RECEIVE. INSPECT. DISAPPEAR.
      </div>
      <h1>Your webhook.<br /><span>Here for a little while.</span></h1>
      <p class="intro">
        A disposable URL to see exactly what your app sends.<br
          class="hidden sm:block"
        />
        No account, no setup, just a short-lived inbox.
      </p>
      <div class="landing-actions">
        <button
          class="primary large"
          :disabled="inbox.busy"
          @click="inbox.create()"
        >
          {{
            inbox.busy
              ? "Creating your inbox…"
              : inbox.waiting
                ? "Try for a free inbox"
                : "Get a webhook URL"
          }}
          <PhArrowUpRight :size="20" aria-hidden="true" />
        </button>
        <button
          v-if="inbox.savedInbox && inbox.savedInbox.expiresAt > now.getTime()"
          class="resume-button"
          :disabled="inbox.busy"
          :title="`${Math.max(0, Math.ceil((inbox.savedInbox.expiresAt - now.getTime()) / 60000))} minutes left · Saved in this browser`"
          @click="inbox.resume()"
        >
          <PhArrowCounterClockwise :size="20" aria-hidden="true" />Open last
          inbox
        </button>
      </div>
      <p class="under-button">
        Free to use <span>·</span> No sign-up <span>·</span> 1-hour history
      </p>
      <div v-if="inbox.error" class="notice" role="status">
        {{ inbox.waiting ? "All hands full. " : "" }}{{ inbox.error }}
        <p v-if="inbox.waiting">
          Retrying automatically every few seconds while this page is visible.
          This is a waiting room, not a reserved queue position.
        </p>
        <button
          v-if="inbox.waiting"
          class="text-button"
          @click="
            inbox.waiting = false;
            inbox.error = '';
          "
        >
          Stop waiting
        </button>
      </div>
      <div class="example-card">
        <div class="example-top">
          <span
            ><PhCircle
              class="status-dot"
              :size="7"
              weight="fill"
              aria-hidden="true"
            />
            YOUR NEXT DEBUGGING SESSION</span
          ><span>01 / SIMPLE BY DESIGN</span>
        </div>
        <div class="example-url">
          <span class="method">POST</span
          ><span
            >hookachu<span class="text-stone-400">
              / h / your-random-url</span
            ></span
          ><PhArrowDownLeft
            class="example-arrow"
            :size="22"
            aria-hidden="true"
          />
        </div>
        <pre>
{
  "event": "something.happened",
  "finally": "see the whole picture"
}</pre>
        <span class="example-label">ILLUSTRATIVE PAYLOAD</span>
      </div>
      <div class="features">
        <article>
          <span>01 —</span>
          <h3>Point it here</h3>
          <p>
            Paste your unique URL into Stripe, GitHub, or anything that sends
            HTTP.
          </p>
        </article>
        <article>
          <span>02 —</span>
          <h3>Look under the hood</h3>
          <p>
            Inspect the raw body, headers, query parameters, sender, and timing.
          </p>
        </article>
        <article>
          <span>03 —</span>
          <h3>Keep it temporary</h3>
          <p>
            Requests expire after an hour. Inboxes last one hour; extend in the
            last 10 minutes, up to 24 hours total.
          </p>
        </article>
      </div>
      <section class="privacy-section" aria-labelledby="privacy-title">
        <div class="privacy-heading">
          <span class="privacy-icon"
            ><PhShieldCheck :size="26" aria-hidden="true"
          /></span>
          <div>
            <div class="eyebrow">PRIVATE BY DESIGN</div>
            <h2 id="privacy-title">
              Just your requests. Here for a little while.
            </h2>
          </div>
        </div>
        <div class="privacy-grid">
          <article>
            <h3>No tracking. No profiling.</h3>
            <p>
              We store request bodies, headers and sender IPs only so you can
              inspect them. We don’t use your request content for analytics or
              AI training. No advertising.
            </p>
          </article>
          <article>
            <h3>One hour, then gone from the app.</h3>
            <p>
              Each request expires after 1 hour, or sooner when cleared, evicted
              or its inbox is deleted. You can clear requests or delete the
              inbox at any time.
            </p>
          </article>
          <article>
            <h3>Your link stays with you.</h3>
            <p>
              Only the receiver URL is for sharing. Keep your viewing key
              private. This browser saves your latest inbox link locally so you
              can return to it.
            </p>
          </article>
        </div>
        <div class="privacy-recovery">
          <PhClock :size="17" aria-hidden="true" />
          <p>
            A note on deletion: Cloudflare’s infrastructure recovery history may
            retain deleted data for up to 30 days. App expiry does not mean
            immediate physical erasure.
          </p>
        </div>
      </section>
    </main>
    <main v-else-if="!inbox.secret" class="landing unavailable">
      <div class="eyebrow">TEMPORARY BY DESIGN</div>
      <h1>Inbox unavailable<span class="brand-dot">.</span></h1>
      <p class="intro">
        {{
          inbox.error ||
          "This inbox has expired, or its viewing key is missing."
        }}
      </p>
      <section class="unavailable-card" aria-label="Create a fresh inbox">
        <div class="unavailable-icon">
          <PhClock :size="26" aria-hidden="true" />
        </div>
        <div class="unavailable-content">
          <h2>A fresh start for your next request</h2>
          <p>
            Expired inboxes cannot be restored. Create a new inbox to get a
            fresh URL.
          </p>
          <div class="unavailable-actions">
            <button
              class="primary large"
              :disabled="inbox.busy"
              @click="
                inbox.reset();
                inbox.create();
              "
            >
              Create a new inbox <PhArrowRight :size="20" aria-hidden="true" />
            </button>
            <a href="/" class="text-button" @click.prevent="inbox.goHome()"
              >Back to homepage</a
            >
          </div>
        </div>
      </section>
    </main>
    <main v-else class="workspace">
      <div class="workspace-heading">
        <div>
          <div class="eyebrow">YOUR TEMPORARY WORKSPACE</div>
          <h1>Request inbox<span class="brand-dot">.</span></h1>
        </div>
        <div class="flex items-center gap-3">
          <span class="connection"
            ><PhCircle
              :size="7"
              weight="fill"
              :class="{ live: inbox.connected }"
              aria-hidden="true"
            />{{ inbox.connected ? "Listening" : "Disconnected" }}</span
          ><button class="secondary" @click="confirmDelete = true">
            <PhTrash :size="14" aria-hidden="true" />Delete inbox
          </button>
        </div>
      </div>
      <section class="endpoint-card">
        <div class="flex items-center justify-between">
          <label
            >YOUR WEBHOOK URL
            <span>Send any HTTP method to this address</span></label
          >
          <div class="expiry-actions">
            <span class="mono text-xs text-stone-500"
              >{{ remaining }}m until expiry</span
            ><button
              v-if="
                remaining > 0 &&
                remaining <= 10 &&
                inbox.expiresAt < inbox.maxExpiresAt
              "
              class="secondary"
              :disabled="inbox.extending"
              @click="inbox.extend()"
            >
              {{ inbox.extending ? "Extending…" : "Extend for 1 hour" }}</button
            ><span
              v-else-if="
                remaining <= 10 && inbox.expiresAt >= inbox.maxExpiresAt
              "
              class="mono text-xs text-stone-500"
              >24-hour limit reached</span
            >
          </div>
        </div>
        <div class="endpoint-row">
          <span class="any-tag">ANY</span><code>{{ inbox.endpoint }}</code
          ><button
            class="primary"
            :disabled="!isSupported"
            @click="copyText(inbox.endpoint, 'URL copied')"
          >
            <PhCheck
              v-if="copiedLabel === 'URL copied'"
              :size="15"
              aria-hidden="true"
            /><PhCopy v-else :size="15" aria-hidden="true" />{{
              copiedLabel === "URL copied" ? "Copied" : "Copy URL"
            }}
          </button>
        </div>
        <div class="endpoint-note">
          <span
            ><PhClock :size="13" aria-hidden="true" /> Inbox expires after 1
            hour. Extend in the last 10 minutes; 24-hour maximum. Requests keep
            their own 1-hour expiry.</span
          ><button class="text-button" @click="copyCurl()">
            <PhCheck
              v-if="copiedLabel === 'cURL copied'"
              :size="13"
              aria-hidden="true"
            /><PhTerminalWindow v-else :size="13" aria-hidden="true" />{{
              copiedLabel === "cURL copied" ? "Copied" : "Copy test cURL"
            }}
          </button>
        </div>
      </section>
      <div v-if="inbox.error" class="notice" role="alert">
        {{ inbox.error }}
        <button v-if="!inbox.secret" class="text-button" @click="inbox.reset()">
          Create a new inbox <PhArrowRight :size="13" aria-hidden="true" />
        </button>
      </div>
      <div class="inspector">
        <aside class="request-list">
          <div class="list-heading">
            <h2>
              Requests <span>{{ inbox.requests.length }}</span>
            </h2>
            <button
              class="text-button"
              :disabled="!inbox.requests.length"
              @click="inbox.clear()"
            >
              Clear
            </button>
          </div>
          <input
            v-model="query"
            aria-label="Filter requests"
            placeholder="Filter by method or path…"
            class="filter"
          />
          <div v-if="!filtered.length" class="empty-list">
            <PhArrowDownLeft :size="28" aria-hidden="true" />
            <p>
              {{
                inbox.requests.length
                  ? "No matching requests"
                  : "Waiting for the first hello"
              }}
            </p>
            <small>Requests arrive live over WebSocket.</small>
          </div>
          <button
            v-for="r in filtered"
            :key="r.id"
            class="request-row"
            :class="{ selected: inbox.selected?.id === r.id }"
            @click="inbox.selectedId = r.id"
          >
            <div>
              <span class="method" :class="r.method.toLowerCase()">{{
                r.method
              }}</span
              ><time>{{ time(r.receivedAt) }}</time>
            </div>
            <p>{{ r.url.replace(`/h/${inbox.id}`, "") || "/" }}</p>
            <small
              >{{ bytes(r.bodyBytes) }} <span>·</span>
              {{ r.remoteAddress }}</small
            >
          </button>
          <div class="list-footer">LAST 25 REQUESTS · MAX 2 MiB / INBOX</div>
        </aside>
        <section class="request-detail">
          <template v-if="inbox.selected"
            ><div class="detail-heading">
              <div>
                <span class="method">{{ inbox.selected.method }}</span
                ><code>{{ inbox.selected.url }}</code>
              </div>
              <span
                >{{ time(inbox.selected.receivedAt) }} ·
                {{ bytes(inbox.selected.bodyBytes) }}</span
              >
            </div>
            <nav class="tabs" aria-label="Request details">
              <button
                v-for="t in ['body', 'headers', 'query', 'metadata', 'base64']"
                :key="t"
                :class="{ active: tab === t }"
                @click="tab = t"
              >
                {{ t
                }}<small v-if="t === 'headers'">{{ headerRows.length }}</small
                ><small v-if="t === 'query'">{{ queryRows.length }}</small>
              </button>
            </nav>
            <div class="payload-tools">
              <span>{{ tab === "body" ? "PAYLOAD" : tab.toUpperCase() }}</span>
              <div class="payload-actions">
                <label v-if="tab === 'headers' && proxyHeaderCount"
                  ><input v-model="showProxyHeaders" type="checkbox" /> Show
                  proxy headers ({{ proxyHeaderCount }})</label
                >
                <label v-if="tab === 'body'"
                  ><input v-model="pretty" type="checkbox" /> Pretty JSON</label
                ><button
                  class="text-button"
                  @click="
                    copyText(
                      tab === 'base64'
                        ? inbox.selected.body
                        : tab === 'body'
                          ? decoded
                          : JSON.stringify(
                              tab === 'headers'
                                ? headerRows
                                : tab === 'query'
                                  ? queryRows
                                  : inbox.selected,
                              null,
                              2,
                            ),
                      'Content copied',
                    )
                  "
                >
                  <PhCheck
                    v-if="copiedLabel === 'Content copied'"
                    :size="13"
                    aria-hidden="true"
                  /><PhCopy v-else :size="13" aria-hidden="true" />{{
                    copiedLabel === "Content copied" ? "Copied" : "Copy"
                  }}
                </button>
              </div>
            </div>
            <p v-if="tab === 'headers'" class="headers-note">
              {{
                !showProxyHeaders && proxyHeaderCount
                  ? `${proxyHeaderCount} proxy headers hidden. `
                  : ""
              }}Headers are captured after Cloudflare processing; some values
              may have been added or changed.
            </p>
            <pre v-if="tab === 'body' || tab === 'base64'" class="payload">{{
              tab === "body" ? decoded : inbox.selected.body
            }}</pre>
            <dl v-else-if="tab === 'metadata'" class="data-table">
              <template
                v-for="[k, v] in [
                  [
                    'Received',
                    new Date(inbox.selected.receivedAt).toISOString(),
                  ],
                  ['Sender IP', inbox.selected.remoteAddress],
                  ['HTTP version', inbox.selected.httpVersion],
                  ['Body size', bytes(inbox.selected.bodyBytes)],
                  ['Request ID', inbox.selected.id],
                ]"
                :key="k"
                ><dt>{{ k }}</dt>
                <dd>{{ v }}</dd></template
              >
            </dl>
            <dl v-else class="data-table">
              <template
                v-for="([k, v], i) in tab === 'headers'
                  ? headerRows
                  : queryRows"
                :key="i"
                ><dt>{{ k }}</dt>
                <dd>{{ v }}</dd></template
              >
              <p v-if="tab === 'query' && !queryRows.length">
                No query parameters.
              </p>
            </dl></template
          >
          <div v-else class="detail-empty">
            <div class="empty-illustration">
              <span class="code-brace" aria-hidden="true">{</span
              ><span class="empty-hook"
                ><img
                  src="/hookachu.png?v=2"
                  alt="Hookachu"
                  width="64"
                  height="64" /></span
              ><span class="code-brace" aria-hidden="true">}</span>
            </div>
            <h2>A place for your next request.</h2>
            <p>
              Send something to your URL above.<br />Every header, every byte,
              right here.
            </p>
            <span class="keyboard-hint">NO REQUEST SELECTED</span>
          </div>
        </section>
      </div>
      <div class="workspace-note">
        <span
          ><PhCircle
            class="status-dot"
            :size="7"
            weight="fill"
            aria-hidden="true"
          />
          Short-lived storage. Auto-expiring.</span
        ><span
          >256 KiB / request <b>·</b> 30 requests / min / inbox <b>·</b> No
          tracking</span
        >
      </div>
    </main>
    <footer>
      <span class="footer-credit">
        Made with <PhHeart :size="13" weight="fill" aria-label="love" /> by
        <a href="https://h2u.lv" target="_blank" rel="noopener noreferrer"
          >h2u.lv</a
        >
      </span>
      <nav class="footer-links" aria-label="Project links">
        <a
          class="footer-link"
          href="https://github.com/h2u/hookachu"
          target="_blank"
          rel="noopener noreferrer"
        >
          <PhGithubLogo :size="15" aria-hidden="true" />GitHub<PhArrowUpRight
            :size="12"
            aria-hidden="true"
          />
        </a>
        <a
          class="coffee-link"
          href="https://buymeacoffee.com/edgars.spirins"
          target="_blank"
          rel="noopener noreferrer"
        >
          <PhCoffee :size="15" aria-hidden="true" />Buy me a
          coffee<PhArrowUpRight :size="12" aria-hidden="true" />
        </a>
      </nav>
    </footer>
    <div
      v-if="confirmDelete"
      class="modal-backdrop"
      @click.self="confirmDelete = false"
    >
      <section
        class="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-title"
      >
        <h2 id="delete-title">Delete this inbox?</h2>
        <p>
          All captured requests disappear and the webhook URL stops working.
        </p>
        <div class="flex gap-3 justify-end">
          <button class="secondary" @click="confirmDelete = false">
            Keep inbox</button
          ><button
            class="primary"
            @click="
              inbox.remove();
              confirmDelete = false;
            "
          >
            Delete everything
          </button>
        </div>
      </section>
    </div>
  </div>
</template>
