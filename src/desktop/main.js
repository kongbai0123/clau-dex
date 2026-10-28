import { createDesktopApp } from "./desktop-app.js";
import { createRequire } from "node:module";
const { app } = createRequire(import.meta.url)("electron");
createDesktopApp().catch(error => { console.error("Desktop startup failed:", error.message); app.exit(1); });
