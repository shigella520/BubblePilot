export interface PluginListItem {
  id: string;
  name: string;
  enabled: boolean;
  version: number;
  package_version: string;
  metadata: { description?: string; skills: number; servers: number };
  source: { type?: string; url?: string };
  pending_review?: string[];
  summary?: {
    toolsEnabled: number;
    toolsApproved: number;
    skillsEnabled: number;
    skillsTotal: number;
    servers: number;
    activeWorkflows: number;
    autoSyncTools: boolean;
    lastCheckAt: string | null;
    lastSyncStatus: "unchanged" | "updated" | "review" | "failed" | null;
  };
}
