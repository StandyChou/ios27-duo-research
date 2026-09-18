export const ROLES = Object.freeze(["总览", "运营", "研发", "设计"]);

export function normalizeRole(role) {
  return ROLES.includes(role) ? role : "总览";
}

export function taskMatchesRole(task, role) {
  const activeRole = normalizeRole(role);
  const roles = Array.isArray(task.roles) ? task.roles : [];
  return activeRole === "总览" || roles.includes("共享") || roles.includes(activeRole);
}

export function matchesTask(task, filters = {}) {
  const keyword = String(filters.keyword || "").trim().toLocaleLowerCase("zh-CN");
  const textMatches = !keyword || String(task.text || "").toLocaleLowerCase("zh-CN").includes(keyword);
  const roleMatches = taskMatchesRole(task, filters.role);
  const categoryMatches = !filters.category || filters.category === "all" || task.category === filters.category;
  const priorityMatches = !filters.priority || filters.priority === "all" || task.priority === filters.priority;
  const stackMatches = !filters.stack || filters.stack === "all" || task.stack === "all" || task.stack === filters.stack;
  const evidenceMatches = !filters.evidence || filters.evidence === "all" || task.evidence === filters.evidence;
  const completionMatches = !filters.incomplete || task.status !== "已完成";
  return textMatches
    && roleMatches
    && categoryMatches
    && priorityMatches
    && stackMatches
    && evidenceMatches
    && completionMatches;
}

export function calculateProgress(tasks) {
  const total = tasks.length;
  const completed = tasks.filter((task) => task.status === "已完成").length;
  return {
    completed,
    total,
    percentage: total ? Math.round((completed / total) * 100) : 0,
  };
}

export function mergeTaskState(task, remote) {
  return {
    ...task,
    status: remote?.status ?? task.status,
    ownerLabel: remote?.owner_label ?? "",
    updatedAt: remote?.updated_at ?? null,
  };
}
