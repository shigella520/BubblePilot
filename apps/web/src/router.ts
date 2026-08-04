import { createRouter, createWebHashHistory } from "vue-router";

import AiView from "./views/AiView.vue";
import AutomationView from "./views/AutomationView.vue";
import WorkflowCanvasView from "./views/WorkflowCanvasView.vue";
import DashboardView from "./views/DashboardView.vue";
import ExecutionsView from "./views/ExecutionsView.vue";
import LoginView from "./views/LoginView.vue";
import MessagesView from "./views/MessagesView.vue";
import SettingsView from "./views/SettingsView.vue";

export default createRouter({
  history: createWebHashHistory(),
  scrollBehavior() {
    return { top: 0 };
  },
  routes: [
    { path: "/login", component: LoginView },
    { path: "/", component: DashboardView },
    { path: "/messages", component: MessagesView },
    { path: "/automation", component: AutomationView },
    { path: "/automation/new", component: WorkflowCanvasView },
    { path: "/automation/:workflowId", component: WorkflowCanvasView },
    { path: "/ai", component: AiView },
    { path: "/executions", component: ExecutionsView },
    { path: "/settings", component: SettingsView },
    // Keep stale anchor URLs (for example, #search) from rendering an empty
    // RouterView after older sidebar links are still present in a browser tab.
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
});
