import { createPanelStore } from "../sidepanel/store.js";
import test from "node:test";
import assert from "node:assert/strict";

import {
  createSelectorController,
  createNewSelectorRule,
  formatRuleHeading,
  validateSelectorRules
} from "../sidepanel/selector-controller.js";

test("selector validation rejects empty rule lists", () => {
  assert.equal(validateSelectorRules([]), "At least one selector rule is required.");
});

test("selector validation rejects duplicate ids", () => {
  const rules = [
    {
      id: "rule-1",
      cssSelector: "a[href]"
    },
    {
      id: "rule-1",
      cssSelector: "a[href]"
    }
  ];

  assert.equal(validateSelectorRules(rules), "Rule 2 has a duplicate id.");
});

test("selector validation rejects missing css selector", () => {
  const rules = [
    {
      id: "rule-1",
      cssSelector: ""
    }
  ];

  assert.equal(validateSelectorRules(rules), "Rule 1 must include a CSS selector.");
});

test("selector validation accepts well-formed rules", () => {
  const rules = [
    {
      id: "rule-1",
      cssSelector: "a[href]"
    }
  ];

  assert.equal(validateSelectorRules(rules), null);
});

test("new selector rules use generated ids and defaults", () => {
  const rule = createNewSelectorRule(() => "rule-123");

  assert.equal(rule.id, "rule-123");
  assert.equal(rule.name, "Custom rule");
  assert.equal(rule.cssSelector, "a[href]");
  assert.equal(rule.urlAttribute, "href");
  assert.equal(rule.enabled, true);
});

test("selector heading formatter prefers name then id", () => {
  assert.equal(formatRuleHeading("  Rule Name  ", "rule-1"), "Rule Name");
  assert.equal(formatRuleHeading("", "  rule-1  "), "rule-1");
  assert.equal(formatRuleHeading("", ""), "Unnamed rule");
});

function createSaveHarness(saveAction, options = {}) {
  const panelStore = createPanelStore();
  const fields = new Map([
    [".rule-name-input", { value: "Articles" }],
    [".rule-selector-input", { value: "a.article" }],
    [".rule-attribute-input", { value: "href" }],
    [".rule-enabled-input", { checked: true }]
  ]);
  const item = { dataset: { ruleId: "articles" }, querySelector: selector => fields.get(selector) };
  const saveRulesButton = {};
  const statuses = [];
  const controller = createSelectorController({
    panelStore,
    selectorRulesListEl: { querySelectorAll: () => [item] },
    rulesSummaryEl: {},
    saveRulesButton,
    setSelectorRulesActionImpl: saveAction,
    setStatus: status => statuses.push(status),
    messageFromError: error => error?.message,
    logger: { error() {} },
    ...options
  });
  return { controller, panelStore, saveRulesButton, statuses, fields };
}

test("selector Save is enabled for drafts and validation failures preserve the draft", async () => {
  const h = createSaveHarness(() => assert.fail("Invalid drafts must not be persisted"));
  assert.equal(h.saveRulesButton.disabled, true);
  h.fields.get(".rule-selector-input").value = "";
  h.controller.markSelectorRulesDirty();
  assert.equal(h.saveRulesButton.disabled, false);
  assert.equal(h.saveRulesButton.textContent, "Save rules");
  assert.equal(await h.controller.ensureSelectorRulesSaved(), false);
  assert.equal(h.panelStore.state.selectorRulesDirty, true);
  assert.equal(h.saveRulesButton.disabled, false);
  assert.match(h.statuses.at(-1), /must include a CSS selector/);
});

test("failed and thrown saves restore Save and prevent collection with stale rules", async () => {
  for (const save of [
    async () => ({ ok: false, error: { message: "Storage unavailable" } }),
    async () => { throw new Error("Disconnected"); }
  ]) {
    const h = createSaveHarness(save);
    h.controller.markSelectorRulesDirty();
    assert.equal(await h.controller.ensureSelectorRulesSaved(), false);
    assert.equal(h.panelStore.state.selectorRulesDirty, true);
    assert.equal(h.saveRulesButton.disabled, false);
    assert.equal(h.saveRulesButton.textContent, "Save rules");
  }
});

test("Collect joins an in-flight save and newer edits are not overwritten or marked saved", async () => {
  let finish;
  let calls = 0;
  const h = createSaveHarness(() => {
    calls += 1;
    return new Promise(resolve => { finish = resolve; });
  });
  h.controller.markSelectorRulesDirty();
  const saving = h.controller.saveSelectorRules();
  const collecting = h.controller.ensureSelectorRulesSaved();
  assert.equal(h.saveRulesButton.disabled, true);
  assert.equal(h.saveRulesButton.textContent, "Saving…");
  await Promise.resolve();
  h.fields.get(".rule-selector-input").value = "a.newer";
  h.controller.markSelectorRulesDirty();
  finish({ ok: true, selectorRules: [{ id: "articles", cssSelector: "a.article" }] });
  assert.equal(await saving, false);
  assert.equal(await collecting, false);
  assert.equal(calls, 1);
  assert.equal(h.fields.get(".rule-selector-input").value, "a.newer");
  assert.equal(h.panelStore.state.selectorRulesDirty, true);
  assert.equal(h.saveRulesButton.disabled, false);
});

test("collecting with saved rules does not write them again", async () => {
  const h = createSaveHarness(() => assert.fail("No save needed"));
  assert.equal(await h.controller.ensureSelectorRulesSaved(), true);
});

test("a hung save times out, restores the button, and ignores a late acknowledgement", async () => {
  let finish;
  const h = createSaveHarness(() => new Promise(resolve => { finish = resolve; }), { saveTimeoutMs: 5 });
  h.controller.markSelectorRulesDirty();
  const saving = h.controller.saveSelectorRules();
  const collecting = h.controller.ensureSelectorRulesSaved();
  assert.equal(await saving, false);
  assert.equal(await collecting, false);
  assert.match(h.statuses.at(-1), /timed out/);
  assert.equal(h.saveRulesButton.textContent, "Save rules");
  assert.equal(h.saveRulesButton.disabled, false);
  assert.equal(h.panelStore.state.selectorRulesDirty, true);
  h.fields.get(".rule-selector-input").value = "a.newer";
  h.controller.markSelectorRulesDirty();
  finish({ ok: true, selectorRules: [{ id: "articles", cssSelector: "a.article" }] });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(h.fields.get(".rule-selector-input").value, "a.newer");
  assert.equal(h.panelStore.state.selectorRulesDirty, true);
  assert.match(h.statuses.at(-1), /timed out/);
});
