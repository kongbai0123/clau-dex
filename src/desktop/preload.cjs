const { contextBridge, ipcRenderer } = require("electron");
const invoke = channel => (...args) => ipcRenderer.invoke(`bridge:${channel}`, ...args);
const listen = channel => callback => {
  if (typeof callback !== "function") throw new TypeError("A callback is required");
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(`bridge:${channel}`, listener);
  return () => ipcRenderer.removeListener(`bridge:${channel}`, listener);
};
contextBridge.exposeInMainWorld("bridge", {
  getSnapshot: invoke("getSnapshot"), refreshStatus: invoke("refreshStatus"),
  createTask: invoke("createTask"), cancelTask: invoke("cancelTask"), selectWorkspace: invoke("selectWorkspace"),
  createConversation: invoke("createConversation"), sendMessage: invoke("sendMessage"), resumeTask: invoke("resumeTask"),
  importImages: invoke("importImages"), deleteConversation: invoke("deleteConversation"),
  startBridge: invoke("startBridge"), stopBridge: invoke("stopBridge"),
  launchApp: invoke("launchApp"), closeApp: invoke("closeApp"), updateSettings: invoke("updateSettings"),
  onUpdate: listen("update"), onShutdown: listen("shutdown"),
});
