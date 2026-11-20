import type { Project } from "@crewpip/shared";

export function projectTitle(project: Project, noProject: string): string {
  return project.displayName ?? (project.standaloneChats?.length ? noProject : project.name);
}

interface NavigationEntry {
  key: string;
  project: Project;
  chatId?: string;
  name: string;
}

export function navigationEntries(projects: Project[], noProject: string): NavigationEntry[] {
  return projects.flatMap((project): NavigationEntry[] => project.standaloneChats?.length
    ? project.standaloneChats.map(chat => ({ key: `session:${chat.id}`, project, chatId: chat.id, name: chat.name }))
    : [{ key: project.id, project, name: projectTitle(project, noProject) }]
  ).sort((a, b) => a.name.localeCompare(b.name));
}
