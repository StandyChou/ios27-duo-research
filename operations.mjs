import { calculateGrowthEconomics, filterHook } from "./operations-core.mjs";

const supportedCurrencies = new Set(["USD", "EUR", "GBP", "JPY", "CAD", "AUD"]);
const currencyFormatters = new Map();

function getCurrencyFormatter(currency) {
  const normalizedCurrency = String(currency ?? "USD").toUpperCase();
  const selectedCurrency = supportedCurrencies.has(normalizedCurrency) ? normalizedCurrency : "USD";
  if (!currencyFormatters.has(selectedCurrency)) {
    currencyFormatters.set(selectedCurrency, new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: selectedCurrency,
    }));
  }
  return currencyFormatters.get(selectedCurrency);
}

export function applyView(view, {
  body,
  buttons = [],
  groupedSections = [],
  mainSections = [],
  announce = () => {},
} = {}) {
  if (!view) return null;
  if (body?.dataset) body.dataset.view = view;

  for (const button of buttons) {
    button.setAttribute("aria-pressed", String(button.dataset.view === view));
  }
  for (const section of groupedSections) {
    const groups = section.dataset.viewGroup?.split(/\s+/).filter(Boolean) ?? [];
    section.hidden = view !== "全部" && !groups.includes(view);
  }

  const firstVisibleSection = mainSections.find((section) => !section.hidden);
  const firstVisibleId = firstVisibleSection?.id ?? "main-content";
  announce(`已切换至${view}视图，当前首个章节：${firstVisibleId}`);
  return firstVisibleId;
}

export function applyHookFilters(hookItems, filters, { count, empty } = {}) {
  let visibleCount = 0;
  for (const item of hookItems) {
    const visible = filterHook(item.dataset, filters);
    item.hidden = !visible;
    if (visible) visibleCount += 1;
  }

  if (count) count.textContent = `显示 ${visibleCount} 条，共 ${hookItems.length} 条`;
  if (empty) empty.hidden = visibleCount !== 0;
  return visibleCount;
}

export function formatGrowthEconomics(input, currency = "USD") {
  const result = calculateGrowthEconomics(input);
  const formatter = getCurrencyFormatter(currency);
  const paidCac = result.paidCac === null
    ? "无法计算 Paid CAC（没有付费人数）"
    : `Paid CAC ${formatter.format(result.paidCac)}`;
  const roas = result.roas === null
    ? "无法计算 ROAS（广告花费为 0）"
    : `ROAS ${result.roas.toFixed(2)}`;
  const sign = result.contributionMargin >= 0 ? "+" : "-";
  const contribution = `${sign}${formatter.format(Math.abs(result.contributionMargin))}`;
  return `${paidCac}；${roas}；贡献差额 ${contribution}。`;
}

export function createCopyFeedbackController({
  writeText,
  announce = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  delay = 1600,
} = {}) {
  if (typeof writeText !== "function") throw new TypeError("writeText must be a function");
  const buttonStates = new WeakMap();

  function getButtonState(button) {
    let state = buttonStates.get(button);
    if (!state) {
      state = { label: button.textContent, timer: null, version: 0 };
      buttonStates.set(button, state);
    }
    return state;
  }

  async function copy(button, text, description) {
    const state = getButtonState(button);
    state.version += 1;
    const version = state.version;

    if (state.timer !== null) {
      clearTimer(state.timer);
      state.timer = null;
    }
    button.textContent = state.label;

    let copied = false;
    try {
      copied = await writeText(text);
    } catch {
      copied = false;
    }

    if (state.version !== version) return false;
    if (!copied) {
      button.textContent = state.label;
      announce(`${description}复制失败，请手动选择文本。`);
      return false;
    }

    button.textContent = "已复制";
    announce(`${description}已复制。`);
    const timer = setTimer(() => {
      const current = buttonStates.get(button);
      if (!current || current.version !== version || current.timer !== timer) return;
      button.textContent = current.label;
      current.timer = null;
    }, delay);
    state.timer = timer;
    return true;
  }

  return { copy };
}

export async function writeClipboard(text, {
  navigatorRef = typeof navigator === "undefined" ? null : navigator,
  documentRef = typeof document === "undefined" ? null : document,
} = {}) {
  try {
    if (navigatorRef?.clipboard?.writeText) {
      await navigatorRef.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Continue to the local selection fallback when clipboard permission is denied.
  }

  if (!documentRef?.body) return false;
  let textarea;

  try {
    textarea = documentRef.createElement("textarea");
    textarea.className = "clipboard-fallback";
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    documentRef.body.append(textarea);
    textarea.select();
    return Boolean(documentRef.execCommand("copy"));
  } catch {
    return false;
  } finally {
    textarea?.remove();
  }
}

const requirementHeadings = ["优先级", "责任团队", "运营需求", "交付物", "验收标准", "依赖", "最晚时间"];

export function serializeRequirementRow(row) {
  if (!row?.cells) return null;
  const values = [...row.cells].slice(0, requirementHeadings.length)
    .map((cell) => cell.textContent.trim().replace(/\s+/g, " "));
  if (values.length !== requirementHeadings.length) return null;
  return requirementHeadings
    .map((heading, index) => `${heading}：${values[index]}`)
    .join("｜");
}

function bindViewSwitcher(doc, announce) {
  const viewSwitcher = doc.getElementById("view-switcher");
  if (!viewSwitcher) return;
  const buttons = [...viewSwitcher.querySelectorAll("button[data-view]")];
  const groupedSections = [...doc.querySelectorAll("main > section[data-view-group]")];
  const mainSections = [...doc.querySelectorAll("main > section")];

  viewSwitcher.addEventListener("click", (event) => {
    const target = event.target;
    if (!target || typeof target.closest !== "function") return;
    const button = target.closest("button[data-view]");
    if (!button || !viewSwitcher.contains(button)) return;
    applyView(button.dataset.view, {
      body: doc.body,
      buttons,
      groupedSections,
      mainSections,
      announce,
    });
  });
}

function bindHookFilters(doc) {
  const hookChannel = doc.getElementById("hook-channel");
  const hookTiming = doc.getElementById("hook-timing");
  const hookScenario = doc.getElementById("hook-scenario");
  const count = doc.getElementById("hook-count");
  const empty = doc.getElementById("hook-empty");
  const hookItems = [...doc.querySelectorAll(".hook-item")];

  function refreshHookFilters() {
    applyHookFilters(hookItems, {
      channel: hookChannel?.value ?? "全部",
      timing: hookTiming?.value ?? "全部",
      scenario: hookScenario?.value ?? "全部",
    }, { count, empty });
  }

  for (const control of [hookChannel, hookTiming, hookScenario]) {
    control?.addEventListener("change", refreshHookFilters);
  }
  refreshHookFilters();
}

function bindCopyButtons(doc, copyController) {
  for (const button of doc.querySelectorAll("[data-copy-text]")) {
    button.addEventListener("click", () => {
      const text = button.dataset.copyText;
      if (text) void copyController.copy(button, text, "广告行");
    });
  }

  for (const button of doc.querySelectorAll("[data-copy-requirement]")) {
    button.addEventListener("click", () => {
      const row = button.closest(".requirement-row");
      if (!row) return;
      const text = serializeRequirementRow(row);
      if (!text) return;
      void copyController.copy(button, text, "运营需求");
    });
  }
}

function bindEconomicsForm(doc, announce, FormDataRef) {
  const economicsForm = doc.getElementById("economics-form");
  const economicsOutput = doc.getElementById("economics-output");
  if (!economicsForm || !economicsOutput || typeof FormDataRef !== "function") return;

  economicsForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const formData = new FormDataRef(economicsForm);
    economicsOutput.textContent = formatGrowthEconomics({
      spend: Number(formData.get("spend")),
      paid: Number(formData.get("paid")),
      proceeds: Number(formData.get("proceeds")),
    }, formData.get("currency"));
    announce("订阅经济模型已更新。");
  });
}

export function initializeOperations(doc, {
  navigatorRef = typeof navigator === "undefined" ? null : navigator,
  FormDataRef = typeof FormData === "undefined" ? null : FormData,
} = {}) {
  if (!doc) return;
  const statusMessage = doc.getElementById("status-message");
  const announce = (message) => {
    if (statusMessage) statusMessage.textContent = message;
  };
  const copyController = createCopyFeedbackController({
    writeText: (text) => writeClipboard(text, { navigatorRef, documentRef: doc }),
    announce,
  });

  bindViewSwitcher(doc, announce);
  bindHookFilters(doc);
  bindCopyButtons(doc, copyController);
  bindEconomicsForm(doc, announce, FormDataRef);
}

if (typeof document !== "undefined") initializeOperations(document);
