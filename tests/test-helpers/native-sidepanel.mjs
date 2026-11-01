// Playwright does not expose native side-panel targets as Pages. Attach to the
// target through CDP so these tests exercise the real SIDE_PANEL context.
export async function openNativeSidePanel(context, panelPage) {
  const cdp = await context.newCDPSession(panelPage);
  const before = new Set((await cdp.send("Target.getTargets")).targetInfos.map(target => target.targetId));
  const window = await panelPage.evaluate(() => chrome.windows.getCurrent());
  await panelPage.evaluate(id => chrome.sidePanel.open({ windowId: id }), window.id);
  const targets = (await cdp.send("Target.getTargets")).targetInfos;
  const target = targets.find(value => !before.has(value.targetId) && value.url === panelPage.url());
  if (!target) throw new Error("Native side panel target did not open.");
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: false });
  const pending = new Map();
  let serial = 0;
  cdp.on("Target.receivedMessageFromTarget", event => {
    if (event.sessionId !== sessionId) return;
    const message = JSON.parse(event.message);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error || message.result?.exceptionDetails) request.reject(new Error(JSON.stringify(message)));
    else request.resolve(message.result?.result?.value);
  });
  return {
    evaluate(expression) {
      return new Promise((resolve, reject) => {
        const id = ++serial;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("Native side-panel evaluation timed out."));
        }, 10000);
        pending.set(id, { resolve, reject, timer });
        void cdp.send("Target.sendMessageToTarget", {
          sessionId,
          message: JSON.stringify({ id, method: "Runtime.evaluate", params: {
            expression, awaitPromise: true, returnByValue: true, userGesture: true
          } })
        }).catch(error => { clearTimeout(timer); pending.delete(id); reject(error); });
      });
    },
    async stopWorker() {
      await cdp.send("ServiceWorker.enable");
      await cdp.send("ServiceWorker.stopAllWorkers");
    }
  };
}
