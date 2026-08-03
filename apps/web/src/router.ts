import { createRouter, createWebHashHistory } from "vue-router";

import AiView from "./views/AiView.vue";
import AutomationView from "./views/AutomationView.vue";
import DashboardView from "./views/DashboardView.vue";
import ExecutionsView from "./views/ExecutionsView.vue";
import LoginView from "./views/LoginView.vue";
import MessagesView from "./views/MessagesView.vue";

export default createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/login", component: LoginView },
    { path: "/", component: DashboardView },
    { path: "/messages", component: MessagesView },
    { path: "/automation", component: AutomationView },
    { path: "/ai", component: AiView },
    { path: "/executions", component: ExecutionsView },
  ],
});
