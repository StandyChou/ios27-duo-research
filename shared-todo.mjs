function assertTaskRow(row) {
  if (!row || typeof row.task_id !== "string" || !row.task_id.trim()) {
    throw new TypeError("Shared task row requires a task_id");
  }
  return row;
}

function isAtLeastAsFresh(current, incoming) {
  if (!current) return true;
  const currentTime = Date.parse(current.updated_at ?? "");
  const incomingTime = Date.parse(incoming.updated_at ?? "");
  if (Number.isFinite(currentTime) && Number.isFinite(incomingTime)) {
    return incomingTime >= currentTime;
  }
  return true;
}

function normalizeSubscription(subscription) {
  if (typeof subscription === "function") {
    return { ready: Promise.resolve(), unsubscribe: subscription };
  }
  if (!subscription || typeof subscription.unsubscribe !== "function") {
    throw new TypeError("A shared task subscription is required");
  }
  return {
    ready: Promise.resolve(subscription.ready),
    unsubscribe: subscription.unsubscribe,
  };
}

export function createTodoController(gateway) {
  if (!gateway) throw new TypeError("A shared task gateway is required");

  const state = new Map();
  const listeners = new Set();
  const connectionListeners = new Set();
  const pendingByTask = new Map();
  const saveQueues = new Map();
  let unsubscribe = null;
  let connectionStatus = "CONNECTING";

  const publish = () => {
    const snapshot = new Map(state);
    listeners.forEach((listener) => listener(snapshot));
  };

  const apply = (incoming) => {
    const row = assertTaskRow(incoming);
    if (!isAtLeastAsFresh(state.get(row.task_id), row)) return;
    state.set(row.task_id, { ...state.get(row.task_id), ...row });
    publish();
  };

  const reportConnection = (status) => {
    connectionStatus = status;
    connectionListeners.forEach((listener) => listener(status));
  };

  return {
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    onConnectionChange(listener) {
      connectionListeners.add(listener);
      return () => connectionListeners.delete(listener);
    },

    async start() {
      const subscription = normalizeSubscription(gateway.subscribe(apply, reportConnection));
      unsubscribe = subscription.unsubscribe;
      try {
        await subscription.ready;
        const rows = await gateway.fetchStates();
        rows.forEach(apply);
      } catch (error) {
        unsubscribe?.();
        unsubscribe = null;
        throw error;
      }
      return new Map(state);
    },

    stop() {
      unsubscribe?.();
      unsubscribe = null;
    },

    async update(change) {
      const queued = { ...assertTaskRow(change) };
      pendingByTask.set(queued.task_id, queued);
      const previous = saveQueues.get(queued.task_id) ?? Promise.resolve();
      const operation = previous.catch(() => {}).then(async () => {
        const saved = await gateway.saveState(queued);
        apply(saved);
        if (pendingByTask.get(queued.task_id) === queued) pendingByTask.delete(queued.task_id);
        return saved;
      });
      saveQueues.set(queued.task_id, operation);
      try {
        return await operation;
      } finally {
        if (saveQueues.get(queued.task_id) === operation) saveQueues.delete(queued.task_id);
      }
    },

    getPending(taskId) {
      const pending = taskId
        ? pendingByTask.get(taskId)
        : [...pendingByTask.values()].at(-1);
      return pending ? { ...pending } : null;
    },

    getState() {
      return new Map(state);
    },

    getConnectionStatus() {
      return connectionStatus;
    },
  };
}
