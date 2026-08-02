export const CONTEXT_MAP_RELATIVE_PATH = ".handoff/context-map.md";
export const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
export const MAX_NODES = 2_000;
export const WATCH_DEBOUNCE_MS = 150;

export const SECTION_KEYS = [
  "goal",
  "status",
  "tasks",
  "decisions",
  "questions",
  "risks",
  "knowledge",
  "excluded",
];

export const SECTION_LABELS = {
  goal: ["Current Goal", "当前目标", "現在の目標", "현재 목표", "Aktuelles Ziel", "Objectif actuel", "Objetivo actual"],
  status: ["Current Status", "当前状态", "現在のステータス", "현재 상태", "Aktueller Status", "État actuel", "Estado actual"],
  tasks: ["Tasks", "任务", "タスク", "작업", "Aufgaben", "Tâches", "Tareas"],
  decisions: ["Decisions", "决策", "決定", "결정", "Entscheidungen", "Décisions", "Decisiones"],
  questions: ["Open Questions", "未决问题", "未解決の質問", "미해결 질문", "Offene Fragen", "Questions ouvertes", "Preguntas abiertas"],
  risks: ["Risks", "风险", "リスク", "위험", "Risiken", "Risques", "Riesgos"],
  knowledge: ["Knowledge and Notes", "知识与备注", "知識とメモ", "지식과 노트", "Wissen und Notizen", "Connaissances et notes", "Conocimientos y notas"],
  excluded: ["Excluded", "已排除", "除外", "제외됨", "Ausgeschlossen", "Exclu", "Excluido"],
};
