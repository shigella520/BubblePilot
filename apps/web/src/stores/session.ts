import { computed, onScopeDispose, ref } from "vue";
import { defineStore } from "pinia";

import {
  apiRequest,
  isSessionInvalidationError,
  jsonBody,
  setSessionInvalidationHandler,
} from "../services/api";
import { nextSessionDeadline, sessionTimeState } from "./session-expiry";

export interface SessionView {
  expiresAt: string;
  sensitiveUntil: string | null;
}

export const useSessionStore = defineStore("session", () => {
  const checked = ref(false);
  const session = ref<SessionView | null>(null);
  const observedAt = ref(Date.now());
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;

  const timeState = computed(() =>
    sessionTimeState(session.value, observedAt.value),
  );
  const authenticated = computed(() => timeState.value.authenticated);
  const sensitiveActive = computed(() => timeState.value.sensitiveActive);

  function clearExpiryTimer() {
    if (expiryTimer === null) return;
    clearTimeout(expiryTimer);
    expiryTimer = null;
  }

  function scheduleExpiryRefresh() {
    clearExpiryTimer();
    observedAt.value = Date.now();
    if (session.value === null) return;
    const nextDeadline = nextSessionDeadline(session.value, observedAt.value);
    if (nextDeadline === null) return;
    expiryTimer = setTimeout(
      () => {
        expiryTimer = null;
        scheduleExpiryRefresh();
      },
      Math.max(0, nextDeadline - observedAt.value + 10),
    );
  }

  function applySession(value: SessionView | null) {
    session.value = value;
    scheduleExpiryRefresh();
  }

  const removeSessionInvalidationHandler = setSessionInvalidationHandler(() => {
    applySession(null);
    checked.value = true;
  });

  function refreshTimeBoundary() {
    scheduleExpiryRefresh();
  }

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", refreshTimeBoundary);
  }

  onScopeDispose(() => {
    clearExpiryTimer();
    removeSessionInvalidationHandler();
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", refreshTimeBoundary);
    }
  });

  async function restore() {
    try {
      applySession(await apiRequest<SessionView>("/api/v1/auth/session"));
    } catch {
      applySession(null);
    } finally {
      checked.value = true;
    }
  }

  async function login(password: string) {
    applySession(
      await apiRequest<SessionView>("/api/v1/auth/session", {
        method: "POST",
        body: jsonBody({ password }),
      }),
    );
    checked.value = true;
  }

  async function logout() {
    try {
      await apiRequest<void>("/api/v1/auth/session", { method: "DELETE" });
    } catch (cause) {
      if (!isSessionInvalidationError(cause)) {
        throw cause;
      }
    }
    applySession(null);
  }

  async function verifySensitive(password: string) {
    applySession(
      await apiRequest<SessionView>("/api/v1/auth/sensitive", {
        method: "POST",
        body: jsonBody({ password }),
      }),
    );
  }

  return {
    checked,
    session,
    authenticated,
    sensitiveActive,
    restore,
    login,
    logout,
    verifySensitive,
  };
});
