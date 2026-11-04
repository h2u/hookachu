import { defineStore } from "pinia";
import { ref, computed, watch } from "vue";
export const useInbox = defineStore("inbox", () => {
  const id = ref(location.pathname.split("/")[2] || ""),
    secret = ref(new URLSearchParams(location.hash.slice(1)).get("key") || "");
  const requests = ref([]),
    detail = ref(null),
    selectedId = ref(""),
    expiresAt = ref(0),
    error = ref(""),
    waiting = ref(false),
    busy = ref(false),
    connected = ref(false),
    maxExpiresAt = ref(0),
    extending = ref(false);
  const unreadCount = ref(0);
  let attended = true,
    hasSnapshot = false;
  const seenRequests = new Set();
  function setAttended(value) {
    attended = value;
    if (value) unreadCount.value = 0;
  }
  function applySnapshot(items) {
    if (hasSnapshot && !attended)
      unreadCount.value += items.filter(
        (item) => !seenRequests.has(item.id),
      ).length;
    for (const item of items) seenRequests.add(item.id);
    hasSnapshot = true;
    requests.value = items;
  }
  function resetUnread() {
    unreadCount.value = 0;
    hasSnapshot = false;
    seenRequests.clear();
  }
  const savedInbox = ref(readSavedInbox());
  function readSavedInbox() {
    try {
      const saved = JSON.parse(
        localStorage.getItem("hookachu-last-inbox") || "null",
      );
      if (
        saved &&
        /^[\w-]{24}$/.test(saved.id) &&
        /^[\w-]{43}$/.test(saved.secret) &&
        saved.expiresAt > Date.now()
      )
        return saved;
      localStorage.removeItem("hookachu-last-inbox");
    } catch {}
    return null;
  }
  function forgetSavedInbox() {
    if (savedInbox.value?.id !== id.value) return;
    savedInbox.value = null;
    try {
      localStorage.removeItem("hookachu-last-inbox");
    } catch {}
  }
  watch(
    [id, secret, expiresAt, maxExpiresAt],
    () => {
      if (!id.value || !secret.value || expiresAt.value <= Date.now()) return;
      savedInbox.value = {
        id: id.value,
        secret: secret.value,
        expiresAt: expiresAt.value,
        maxExpiresAt: maxExpiresAt.value,
      };
      try {
        localStorage.setItem(
          "hookachu-last-inbox",
          JSON.stringify(savedInbox.value),
        );
      } catch {}
    },
    { flush: "sync" },
  );
  function resume() {
    const saved = readSavedInbox();
    savedInbox.value = saved;
    if (!saved) return;
    id.value = saved.id;
    secret.value = saved.secret;
    expiresAt.value = saved.expiresAt;
    maxExpiresAt.value = saved.maxExpiresAt || 0;
    history.replaceState(null, "", `/inbox/${saved.id}#key=${saved.secret}`);
    refresh();
  }
  let socket,
    lastHeartbeat = 0,
    retryAfter = 0,
    loadingId = "",
    generation = 0;
  const endpoint = computed(() =>
    id.value ? `${location.origin}/h/${id.value}` : "",
  );
  const activeId = computed(
    () =>
      requests.value.find((r) => r.id === selectedId.value)?.id ||
      requests.value[0]?.id ||
      "",
  );
  const selected = computed(() =>
    detail.value?.id === activeId.value ? detail.value : null,
  );
  async function api(suffix = "", method = "GET") {
    const response = await fetch(`/api/inboxes/${id.value}${suffix}`, {
      method,
      headers: { Authorization: `Bearer ${secret.value}` },
      cache: "no-store",
    });
    const data = await response.json();
    if (response.status === 410)
      expire("Inbox expired. Its URL is no longer accepting requests.");
    if (!response.ok) {
      const e = new Error(data.error);
      e.status = response.status;
      throw e;
    }
    return data;
  }
  async function loadDetail() {
    const target = activeId.value,
      version = generation;
    if (!target || loadingId === target || detail.value?.id === target) return;
    loadingId = target;
    try {
      const data = await api(`/requests/${target}`);
      if (generation === version && activeId.value === target)
        detail.value = data;
    } catch (e) {
      if (e.status === 404) {
        requests.value = requests.value.filter((r) => r.id !== target);
        detail.value = null;
      } else error.value = e.message;
    } finally {
      if (loadingId === target) loadingId = "";
    }
  }
  watch(activeId, () => {
    if (detail.value?.id !== activeId.value) detail.value = null;
    loadDetail();
  });
  async function create() {
    if (busy.value || Date.now() < retryAfter) return;
    busy.value = true;
    error.value = "";
    try {
      const response = await fetch("/api/inboxes", { method: "POST" });
      const data = await response.json();
      if (!response.ok) {
        waiting.value = [429, 503].includes(response.status);
        retryAfter =
          Date.now() +
          Number(response.headers.get("Retry-After") || 15) * 1000 +
          Math.random() * 3000;
        throw new Error(data.error);
      }
      id.value = data.id;
      secret.value = data.secret;
      expiresAt.value = data.expiresAt;
      maxExpiresAt.value = data.maxExpiresAt;
      waiting.value = false;
      resetUnread();
      generation++;
      history.replaceState(null, "", `/inbox/${data.id}#key=${data.secret}`);
      connect();
    } catch (e) {
      error.value = e.message;
    } finally {
      busy.value = false;
    }
  }
  function expire(message) {
    forgetSavedInbox();
    resetUnread();
    generation++;
    pause();
    connected.value = false;
    requests.value = [];
    detail.value = null;
    secret.value = "";
    selectedId.value = "";
    expiresAt.value = 0;
    error.value = message;
    history.replaceState(null, "", `/inbox/${id.value}`);
  }
  function connect() {
    if (
      !id.value ||
      !secret.value ||
      (socket &&
        [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState))
    )
      return;
    const version = generation;
    socket = new WebSocket(
      `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/inboxes/${id.value}/events`,
      ["hookachu", `key.${secret.value}`],
    );
    const current = socket;
    current.onopen = () => {
      if (generation !== version) return;
      connected.value = true;
      error.value = "";
      lastHeartbeat = Date.now();
      current.send("heartbeat");
    };
    current.onmessage = (event) => {
      if (generation !== version) return;
      try {
        const data = JSON.parse(event.data);
        if (data.expiresAt) expiresAt.value = data.expiresAt;
        if (data.maxExpiresAt) maxExpiresAt.value = data.maxExpiresAt;
        if (data.type === "snapshot") {
          applySnapshot(data.requests);
          loadDetail();
        }
      } catch {
        error.value = "Invalid server message";
      }
    };
    current.onclose = (event) => {
      if (generation !== version) return;
      connected.value = false;
      if (event.code === 4004)
        expire("Inbox expired or deleted. Create a new one to continue.");
      else {
        retryAfter = Date.now() + 15000 + Math.random() * 5000;
        error.value =
          "Connection lost. Reconnecting while this page is visible.";
      }
    };
    current.onerror = () => {
      connected.value = false;
    };
  }
  async function refresh() {
    if (!id.value || !secret.value) return;
    if (Date.now() >= expiresAt.value && expiresAt.value) {
      expire("Inbox expired. Create a new one to continue.");
      return;
    }
    if (!socket || socket.readyState === WebSocket.CLOSED) {
      if (Date.now() < retryAfter) return;
      const version = generation;
      try {
        const data = await api("/requests");
        if (generation !== version) return;
        applySnapshot(data.requests);
        expiresAt.value = data.expiresAt;
        maxExpiresAt.value = data.maxExpiresAt;
        connect();
      } catch (e) {
        if (generation !== version) return;
        if (e.status === 404)
          expire(
            "Inbox unavailable or viewing key invalid. Create a new inbox to continue.",
          );
        else {
          error.value = e.message;
          retryAfter = Date.now() + 15000;
        }
      }
      return;
    }
    if (
      socket.readyState === WebSocket.OPEN &&
      Date.now() - lastHeartbeat >= 300000
    ) {
      socket.send("heartbeat");
      lastHeartbeat = Date.now();
    }
    await loadDetail();
  }
  function pause() {
    if (socket) {
      socket.onclose = null;
      socket.close();
      socket = null;
    }
    connected.value = false;
  }
  async function extend() {
    if (extending.value || !secret.value) return;
    extending.value = true;
    error.value = "";
    try {
      const data = await api("/extend", "POST");
      expiresAt.value = data.expiresAt;
    } catch (e) {
      error.value = e.message;
    } finally {
      extending.value = false;
    }
  }
  async function clear() {
    try {
      await api("/requests", "DELETE");
      requests.value = [];
      detail.value = null;
      selectedId.value = "";
    } catch (e) {
      error.value = e.message;
    }
  }
  async function remove() {
    try {
      await api("", "DELETE");
      reset();
    } catch (e) {
      error.value = e.message;
    }
  }
  function reset(preserveSaved = false) {
    if (!preserveSaved) forgetSavedInbox();
    resetUnread();
    generation++;
    pause();
    id.value = "";
    secret.value = "";
    requests.value = [];
    detail.value = null;
    selectedId.value = "";
    expiresAt.value = 0;
    maxExpiresAt.value = 0;
    error.value = "";
    waiting.value = false;
    retryAfter = 0;
    history.replaceState(null, "", "/");
  }
  function goHome() {
    reset(true);
  }
  return {
    id,
    secret,
    requests,
    selectedId,
    selected,
    endpoint,
    unreadCount,
    setAttended,
    savedInbox,
    resume,
    goHome,
    expiresAt,
    maxExpiresAt,
    extending,
    extend,
    error,
    waiting,
    busy,
    connected,
    create,
    refresh,
    clear,
    remove,
    reset,
    pause,
  };
});
