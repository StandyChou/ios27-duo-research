import { calculateProgress, matchesTask, mergeTaskState, normalizeRole } from "./dashboard-core.mjs";
import { createTodoController } from "./shared-todo.mjs";
import { createSupabaseGateway } from "./supabase-gateway.mjs";

const CATEGORY_ROLES = Object.freeze({
  components: Object.freeze(["研发", "设计"]),
  theme: Object.freeze(["研发", "设计"]),
  system: Object.freeze(["研发"]),
  distribution: Object.freeze(["运营", "研发"]),
});

const ROLE_SUMMARIES = Object.freeze({
  总览: "显示全部已核验结论与团队任务",
  运营: "优先查看产品口径、限制和分发事项",
  研发: "优先查看 API、适配风险和验收任务",
  设计: "优先查看尺寸、组件和视觉验证任务",
});

const ROLE_FOCUS_LINKS = Object.freeze({
  总览: Object.freeze([
    Object.freeze({ href: "#impact", label: "研发影响" }),
    Object.freeze({ href: "#duo-specs", label: "Duo 尺寸" }),
    Object.freeze({ href: "#todos", label: "研发调研清单" }),
  ]),
  运营: Object.freeze([
    Object.freeze({ href: "#impact", label: "产品口径" }),
    Object.freeze({ href: "#todos", label: "运营任务" }),
    Object.freeze({ href: "#system", label: "分发与系统限制" }),
  ]),
  研发: Object.freeze([
    Object.freeze({ href: "#impact", label: "研发影响" }),
    Object.freeze({ href: "#components", label: "组件适配" }),
    Object.freeze({ href: "#system", label: "系统 API" }),
    Object.freeze({ href: "#todos", label: "研发任务" }),
  ]),
  设计: Object.freeze([
    Object.freeze({ href: "#duo-specs", label: "Duo 尺寸" }),
    Object.freeze({ href: "#components", label: "组件" }),
    Object.freeze({ href: "#theme", label: "主题" }),
    Object.freeze({ href: "#todos", label: "设计任务" }),
  ]),
});

const REALTIME_MESSAGES = Object.freeze({
  CONNECTING: "正在连接共享进度",
  SUBSCRIBED: "共享进度已连接",
  TIMED_OUT: "共享连接超时，页面保持只读",
  CHANNEL_ERROR: "共享连接异常，页面保持只读",
  CLOSED: "共享连接已断开，页面保持只读",
});

export function configurationState(config) {
  const configured = typeof config?.supabaseUrl === "string"
    && config.supabaseUrl.trim() !== ""
    && typeof config?.supabaseAnonKey === "string"
    && config.supabaseAnonKey.trim() !== "";
  return { configured, reason: configured ? "" : "共享服务未配置" };
}

export function redirectUrlFor(href) {
  const url = new URL(href);
  url.search = "";
  url.hash = "";
  return url.href;
}

export function rolesForCategory(category) {
  return [...(CATEGORY_ROLES[category] ?? ["共享"])];
}

export function roleSummaryFor(role) {
  return ROLE_SUMMARIES[normalizeRole(role)];
}

export function roleFocusLinksFor(role) {
  return ROLE_FOCUS_LINKS[normalizeRole(role)].map((item) => ({ ...item }));
}

export function taskSearchText(row) {
  return row.querySelector("[data-task-copy]")?.textContent.trim() ?? "";
}

export function realtimePresentation(status) {
  return {
    connected: status === "SUBSCRIBED",
    message: REALTIME_MESSAGES[status] ?? REALTIME_MESSAGES.CONNECTING,
  };
}

function formatUpdatedAt(value) {
  if (!value) return "尚无团队更新";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "更新时间不可用";
  return `更新于 ${new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date)}`;
}

function createTaskEditor(doc, row) {
  const taskId = row.dataset.taskId;
  const content = row.lastElementChild;
  content.dataset.taskCopy = "";
  const searchText = taskSearchText(row);
  const controls = doc.createElement("div");
  controls.className = "task-editor";
  controls.innerHTML = `
    <label class="task-field" for="status-${taskId}">
      <span>状态</span>
      <select id="status-${taskId}" data-status-for="${taskId}" data-edit-control disabled>
        <option value="待处理">待处理</option>
        <option value="进行中">进行中</option>
        <option value="阻塞">阻塞</option>
        <option value="已完成">已完成</option>
      </select>
    </label>
    <label class="task-field" for="owner-${taskId}">
      <span>负责人显示名</span>
      <input id="owner-${taskId}" type="text" data-owner-for="${taskId}" data-edit-control disabled maxlength="40" autocomplete="off" aria-describedby="owner-privacy-help">
    </label>
    <div class="task-save-state" role="status" aria-live="polite">
      <span data-save-message>只读</span>
      <button type="button" data-retry hidden>重试</button>
    </div>`;

  const note = doc.createElement("details");
  note.className = "member-note";
  note.hidden = true;
  note.innerHTML = `
    <summary>成员备注</summary>
    <label for="note-${taskId}" class="sr-only">成员备注</label>
    <textarea id="note-${taskId}" data-note-for="${taskId}" maxlength="1000" rows="3"></textarea>
    <div class="note-actions">
      <span data-note-message></span>
      <button type="button" data-save-note>保存备注</button>
    </div>`;

  content.append(controls, note);
  return {
    row,
    taskId,
    searchText,
    checkbox: row.querySelector('input[type="checkbox"]'),
    status: controls.querySelector("[data-status-for]"),
    owner: controls.querySelector("[data-owner-for]"),
    message: controls.querySelector("[data-save-message]"),
    retry: controls.querySelector("[data-retry]"),
    note,
    noteInput: note.querySelector("[data-note-for]"),
    noteMessage: note.querySelector("[data-note-message]"),
    saveNote: note.querySelector("[data-save-note]"),
    noteLoaded: false,
    pendingPayload: null,
    saveVersion: 0,
  };
}

export async function initDashboard(doc = document, win = window) {
  const rows = [...doc.querySelectorAll(".todo-item")];
  const editors = rows.map((row) => createTaskEditor(doc, row));
  const editorById = new Map(editors.map((editor) => [editor.taskId, editor]));
  const sharedState = new Map();
  const roleButtons = [...doc.querySelectorAll("[data-role]")];
  const roleSummary = doc.getElementById("role-summary");
  const roleFocusLinks = doc.getElementById("role-focus-links");
  const statusMessage = doc.getElementById("status-message");
  const syncStatus = doc.getElementById("sync-status");
  const memberSummary = doc.getElementById("member-summary");
  const authOpen = doc.getElementById("auth-open");
  const authSignout = doc.getElementById("auth-signout");
  const authDialog = doc.getElementById("auth-dialog");
  const authForm = doc.getElementById("auth-form");
  const authEmail = doc.getElementById("auth-email");
  const authFeedback = doc.getElementById("auth-feedback");
  const resetProgress = doc.getElementById("reset-progress");
  const progress = doc.getElementById("progress-native");
  const progressText = doc.getElementById("progress-text");
  const lastUpdated = doc.getElementById("last-updated");
  const filterSummary = doc.getElementById("filter-summary");
  const filterEmpty = doc.getElementById("filter-empty");
  const controls = {
    keyword: doc.getElementById("filter-keyword"),
    category: doc.getElementById("filter-category"),
    priority: doc.getElementById("filter-priority"),
    stack: doc.getElementById("filter-stack"),
    evidence: doc.getElementById("filter-evidence"),
    incomplete: doc.getElementById("filter-incomplete"),
  };

  let activeRole = "总览";
  let currentSession = null;
  let currentMember = null;
  let gateway = null;
  let controller = null;
  let realtimeStatus = "CONNECTING";

  const announce = (message) => {
    statusMessage.textContent = "";
    win.setTimeout(() => { statusMessage.textContent = message; }, 20);
  };

  const taskFromEditor = (editor) => ({
    id: editor.taskId,
    text: editor.searchText,
    roles: rolesForCategory(editor.row.dataset.category),
    category: editor.row.dataset.category,
    priority: editor.row.dataset.priority,
    stack: editor.row.dataset.stack,
    evidence: editor.row.dataset.evidence,
    status: editor.status.value,
  });

  const currentFilters = () => ({
    role: activeRole,
    keyword: controls.keyword.value,
    category: controls.category.value,
    priority: controls.priority.value,
    stack: controls.stack.value,
    evidence: controls.evidence.value,
    incomplete: controls.incomplete.checked,
  });

  const applyFilters = () => {
    const filters = currentFilters();
    let visible = 0;
    editors.forEach((editor) => {
      const show = matchesTask(taskFromEditor(editor), filters);
      editor.row.hidden = !show;
      if (show) visible += 1;
    });
    filterSummary.textContent = `显示 ${visible} 项，共 ${editors.length} 项 · ${ROLE_SUMMARIES[activeRole]}`;
    filterEmpty.hidden = visible !== 0;
  };

  const updateRoleFocusLinks = () => {
    const label = doc.createElement("span");
    label.textContent = "优先入口";
    const links = roleFocusLinksFor(activeRole).map(({ href, label: linkLabel }) => {
      const link = doc.createElement("a");
      link.href = href;
      link.textContent = linkLabel;
      return link;
    });
    roleFocusLinks.replaceChildren(label, ...links);
  };

  const updateProgress = () => {
    const result = calculateProgress(editors.map(taskFromEditor));
    progress.max = result.total;
    progress.value = result.completed;
    progress.textContent = `${result.percentage}%`;
    progressText.textContent = `已完成 ${result.completed} / ${result.total} · ${result.percentage}%`;
    const latest = [...sharedState.values()]
      .map((row) => row.updated_at)
      .filter(Boolean)
      .sort()
      .at(-1);
    lastUpdated.textContent = formatUpdatedAt(latest);
  };

  const renderSharedState = (state) => {
    sharedState.clear();
    state.forEach((value, key) => sharedState.set(key, value));
    editors.forEach((editor) => {
      if (editor.row.dataset.pending === "true") return;
      const merged = mergeTaskState({
        id: editor.taskId,
        status: "待处理",
      }, sharedState.get(editor.taskId));
      editor.status.value = merged.status;
      editor.checkbox.checked = merged.status === "已完成";
      editor.owner.value = merged.ownerLabel;
    });
    updateProgress();
    applyFilters();
  };

  const updateAccess = () => {
    const editable = Boolean(currentMember && controller && realtimePresentation(realtimeStatus).connected);
    editors.forEach((editor) => {
      editor.checkbox.disabled = !editable;
      editor.status.disabled = !editable;
      editor.owner.disabled = !editable;
      editor.note.hidden = !editable;
      if (!editor.row.dataset.pending) editor.message.textContent = editable ? "已同步" : "只读";
    });
    resetProgress.disabled = !editable;
    authOpen.hidden = Boolean(currentSession);
    authSignout.hidden = !currentSession;
    memberSummary.hidden = !currentMember;
    memberSummary.textContent = currentMember ? `${currentMember.display_name} · ${currentMember.role}` : "";
  };

  const updateSyncStatus = () => {
    const realtime = realtimePresentation(realtimeStatus);
    if (!realtime.connected) syncStatus.textContent = realtime.message;
    else if (currentSession && !currentMember) syncStatus.textContent = "当前邮箱未受邀，页面保持只读";
    else if (currentMember) syncStatus.textContent = realtime.message;
    else syncStatus.textContent = `${realtime.message} · 登录后可编辑`;
  };

  const saveEditor = async (editor) => {
    if (!controller || !currentMember) {
      announce("请使用受邀邮箱登录后编辑。");
      return;
    }
    const payload = editor.pendingPayload ?? {
      task_id: editor.taskId,
      status: editor.status.value,
      owner_label: editor.owner.value.trim(),
    };
    const version = ++editor.saveVersion;
    editor.pendingPayload = payload;
    editor.row.dataset.pending = "true";
    editor.message.textContent = "保存中";
    editor.retry.hidden = true;
    try {
      await controller.update(payload);
      if (version !== editor.saveVersion) return;
      editor.pendingPayload = null;
      delete editor.row.dataset.pending;
      editor.message.textContent = "已同步";
      announce("任务状态已同步。");
    } catch {
      if (version !== editor.saveVersion) return;
      editor.message.textContent = "保存失败";
      editor.retry.hidden = false;
      announce("任务保存失败，请检查网络后重试。");
    }
  };

  editors.forEach((editor) => {
    editor.checkbox.addEventListener("change", () => {
      editor.status.value = editor.checkbox.checked ? "已完成" : "待处理";
      editor.pendingPayload = null;
      saveEditor(editor);
    });
    editor.status.addEventListener("change", () => {
      editor.checkbox.checked = editor.status.value === "已完成";
      editor.pendingPayload = null;
      saveEditor(editor);
    });
    editor.owner.addEventListener("change", () => {
      editor.pendingPayload = null;
      saveEditor(editor);
    });
    editor.retry.addEventListener("click", () => saveEditor(editor));
    editor.note.addEventListener("toggle", async () => {
      if (!editor.note.open || editor.noteLoaded || !gateway || !currentMember) return;
      editor.noteMessage.textContent = "读取中";
      try {
        const note = await gateway.fetchNote(editor.taskId);
        editor.noteInput.value = note?.note ?? "";
        editor.noteLoaded = true;
        editor.noteMessage.textContent = "";
      } catch {
        editor.noteMessage.textContent = "读取失败";
      }
    });
    editor.saveNote.addEventListener("click", async () => {
      if (!gateway || !controller || !currentMember || !currentSession?.user?.email) return;
      editor.noteMessage.textContent = "保存中";
      try {
        await controller.update({
          task_id: editor.taskId,
          status: editor.status.value,
          owner_label: editor.owner.value.trim(),
        });
        await gateway.saveNote({
          task_id: editor.taskId,
          note: editor.noteInput.value,
          email: currentSession.user.email,
        });
        editor.noteMessage.textContent = "已保存";
      } catch {
        editor.noteMessage.textContent = "保存失败";
      }
    });
  });

  roleButtons.forEach((button) => {
    button.addEventListener("click", () => {
      activeRole = normalizeRole(button.dataset.role);
      roleButtons.forEach((candidate) => candidate.setAttribute("aria-pressed", String(candidate === button)));
      doc.body.dataset.activeRole = activeRole;
      roleSummary.textContent = roleSummaryFor(activeRole);
      updateRoleFocusLinks();
      applyFilters();
    });
  });

  const resetFilters = () => {
    controls.keyword.value = "";
    controls.category.value = "all";
    controls.priority.value = "all";
    controls.stack.value = "all";
    controls.evidence.value = "all";
    controls.incomplete.checked = false;
    applyFilters();
    announce("已重置筛选。");
  };

  controls.keyword.addEventListener("input", applyFilters);
  [controls.category, controls.priority, controls.stack, controls.evidence, controls.incomplete]
    .forEach((control) => control.addEventListener("change", applyFilters));
  doc.getElementById("reset-filters").addEventListener("click", resetFilters);
  doc.querySelector("[data-reset-filters]").addEventListener("click", resetFilters);

  resetProgress.addEventListener("click", async () => {
    if (!currentMember || !controller || !win.confirm("确定将全部团队任务恢复为待处理并清空负责人吗？")) return;
    resetProgress.disabled = true;
    syncStatus.textContent = "正在重置团队进度";
    try {
      for (const editor of editors) {
        await controller.update({ task_id: editor.taskId, status: "待处理", owner_label: "" });
      }
      syncStatus.textContent = "共享进度已连接";
      announce("团队任务已全部重置。");
    } catch {
      syncStatus.textContent = "部分任务重置失败";
      announce("重置未全部完成，请刷新后检查。");
    } finally {
      resetProgress.disabled = false;
    }
  });

  authOpen.addEventListener("click", () => authDialog.showModal());
  doc.getElementById("auth-close").addEventListener("click", () => authDialog.close());
  authForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!gateway) {
      authFeedback.textContent = "共享服务未配置";
      return;
    }
    const submit = doc.getElementById("auth-submit");
    submit.disabled = true;
    authFeedback.textContent = "正在发送";
    try {
      await gateway.signIn(authEmail.value, redirectUrlFor(win.location.href));
      authFeedback.textContent = "登录链接已发送，请检查邮箱";
    } catch {
      authFeedback.textContent = "发送失败，请确认邮箱和网络后重试";
    } finally {
      submit.disabled = false;
    }
  });
  authSignout.addEventListener("click", async () => {
    if (!gateway) return;
    try {
      await gateway.signOut();
    } catch {
      announce("退出失败，请检查网络后重试。");
    }
  });

  const setSession = async (session) => {
    currentSession = session;
    currentMember = null;
    if (session?.user?.email && gateway) {
      try {
        currentMember = await gateway.fetchProfile(session.user.email);
      } catch {
        currentMember = null;
      }
    }
    updateSyncStatus();
    updateAccess();
  };

  renderSharedState(sharedState);
  updateRoleFocusLinks();
  updateAccess();

  const config = win.IOS_RESEARCH_CONFIG ?? {};
  const configStatus = configurationState(config);
  if (!configStatus.configured) {
    syncStatus.textContent = configStatus.reason;
    lastUpdated.textContent = "当前为静态只读版";
    authOpen.disabled = true;
    return;
  }

  if (!win.supabase?.createClient) {
    syncStatus.textContent = "共享客户端加载失败";
    authOpen.disabled = true;
    return;
  }

  const client = win.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { persistSession: true, detectSessionInUrl: true, flowType: "pkce" },
  });
  gateway = createSupabaseGateway(client);
  controller = createTodoController(gateway);
  controller.onChange(renderSharedState);
  controller.onConnectionChange((status) => {
    realtimeStatus = status;
    updateSyncStatus();
    updateAccess();
  });

  try {
    updateSyncStatus();
    await controller.start();
    updateSyncStatus();
  } catch {
    controller = null;
    realtimeStatus = "CHANNEL_ERROR";
    syncStatus.textContent = "共享服务连接失败，页面保持只读";
    updateAccess();
  }

  gateway.onAuthStateChange((session) => { setSession(session); });
  await setSession(await gateway.getSession());
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => initDashboard());
  } else {
    initDashboard();
  }
}
