import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const collectorScriptSource = fs.readFileSync(
  new URL("../content/collector.js", import.meta.url),
  "utf8"
);

test("collector auto-scrolls and captures links loaded later", async () => {
  const harness = createCollectorHarness({ growthRounds: 2 });

  const links = await harness.collector.run("test-run", {
    rules: [
      {
        id: "anchors",
        cssSelector: "a[href]",
        urlAttribute: "href",
        enabled: true
      }
    ],
    maxLinks: 50,
    autoScrollEnabled: true,
    autoScrollMaxRounds: 10,
    autoScrollIdleRounds: 2,
    autoScrollSettleDelayMs: 1
  });

  assert.deepEqual(
    Array.from(links, (link) => link.url),
    [
      "https://example.com/post-1",
      "https://example.com/post-2",
      "https://example.com/post-3"
    ]
  );
  assert.ok(harness.state.scrollCalls.length > 0);
  assert.equal(harness.scrollingElement.scrollTop, harness.initialScrollTop);
});

test("collector can skip auto-scroll when disabled", async () => {
  const harness = createCollectorHarness({ growthRounds: 2 });

  const links = await harness.collector.run("test-run", {
    rules: [
      {
        id: "anchors",
        cssSelector: "a[href]",
        urlAttribute: "href",
        enabled: true
      }
    ],
    maxLinks: 50,
    autoScrollEnabled: false
  });

  assert.equal(links.length, 1);
  assert.equal(links[0].url, "https://example.com/post-1");
  assert.equal(harness.state.scrollCalls.length, 0);
  assert.equal(harness.scrollingElement.scrollTop, harness.initialScrollTop);
});

test("cancelling collection stops scrolling and restores the original position", async () => {
  const harness = createCollectorHarness();
  const pending = harness.collector.run("cancel-me", {
    rules: [{ id: "anchors", cssSelector: "a[href]" }],
    autoScrollMaxRounds: 200,
    autoScrollSettleDelayMs: 100
  });
  harness.collector.cancel("cancel-me");
  await pending;
  assert.equal(harness.state.scrollCalls.length, 2);
  assert.equal(harness.scrollingElement.scrollTop, harness.initialScrollTop);
});

function createCollectorHarness({ growthRounds = 0, initialScrollTop = 120 } = {}) {
  const state = {
    round: 0,
    scrollCalls: []
  };

  const scrollingElement = {
    scrollTop: initialScrollTop,
    clientHeight: 800,
    scrollHeight: 1800
  };
  const documentElement = {
    scrollHeight: scrollingElement.scrollHeight
  };
  const body = {
    scrollHeight: scrollingElement.scrollHeight
  };

  const linkSetsByRound = [
    [
      createLinkElement({
        href: "https://example.com/post-1",
        title: "Post 1"
      })
    ],
    [
      createLinkElement({
        href: "https://example.com/post-1",
        title: "Post 1"
      }),
      createLinkElement({
        href: "https://example.com/post-2",
        title: "Post 2"
      })
    ],
    [
      createLinkElement({
        href: "https://example.com/post-1",
        title: "Post 1"
      }),
      createLinkElement({
        href: "https://example.com/post-2",
        title: "Post 2"
      }),
      createLinkElement({
        href: "https://example.com/post-3",
        title: "Post 3"
      })
    ]
  ];

  const document = {
    baseURI: "https://example.com/",
    scrollingElement,
    documentElement,
    body,
    querySelectorAll(selector) {
      if (selector !== "a[href]") {
        return [];
      }

      const roundIndex = Math.min(state.round, linkSetsByRound.length - 1);
      return linkSetsByRound[roundIndex];
    }
  };

  const window = {
    innerHeight: scrollingElement.clientHeight,
    scrollTo(_x, y) {
      const top = Number.isFinite(y) ? Math.max(0, Math.trunc(y)) : 0;
      state.scrollCalls.push(top);
      scrollingElement.scrollTop = top;

      const bottomThreshold = Math.max(0, scrollingElement.scrollHeight - scrollingElement.clientHeight);
      if (top >= bottomThreshold && state.round < growthRounds) {
        state.round += 1;
        scrollingElement.scrollHeight += 700;
        documentElement.scrollHeight = scrollingElement.scrollHeight;
        body.scrollHeight = scrollingElement.scrollHeight;
      }
    }
  };
  Object.defineProperty(window, "scrollY", {
    get() {
      return scrollingElement.scrollTop;
    }
  });

  const context = vm.createContext({
    document,
    window,
    URL,
    RegExp,
    Set,
    Number,
    Math,
    Promise,
    String,
    Boolean,
    setTimeout,
    clearTimeout,
    console
  });
  context.globalThis = context;

  vm.runInContext(collectorScriptSource, context, {
    filename: "content/collector.js"
  });

  return {
    collector: context.__archivistLinkCollector,
    state,
    scrollingElement,
    initialScrollTop
  };
}

function createLinkElement({ href, title }) {
  return {
    href,
    textContent: title,
    getAttribute(name) {
      if (name === "href") {
        return href;
      }
      if (name === "title") {
        return title;
      }
      return null;
    }
  };
}
