// generate_board.ts
const PROJECT_TITLE = "My Jira";
const TOKEN: string = process.env.GH_TOKEN ?? "";

if (!TOKEN) {
  console.error("❌ Переменная GH_TOKEN не задана");
  process.exit(1);
}

// Типы
interface GitHubProject {
  id: string;
  title: string;
}

interface IssueOrPR {
  title?: string;
  url?: string;
  number?: number;
}

type FieldValue =
  | { type: "text"; text: string; field: { name: string } }
  | { type: "select"; name: string; field: { name: string } }
  | { type: "unknown" };

interface ProjectItem {
  id: string;
  fieldValues: FieldValue[];
  content: IssueOrPR | null;
}

interface BoardCard {
  title: string;
  url: string;
  number: string;
  status: string;
}

// GraphQL-запрос
async function graphqlRequest<T = any>(query: string, variables: Record<string, any> = {}): Promise<T> {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "JiraBoardGenerator/2.1",
    },
    body: JSON.stringify({ query, variables }),
  });

  const body = await response.text();
  if (!response.ok) {
    console.error(`❌ HTTP ${response.status}: ${body}`);
    throw new Error(`HTTP ${response.status}`);
  }

  const json = JSON.parse(body);
  if (json.errors) {
    console.error("❌ GraphQL errors:", JSON.stringify(json.errors, null, 2));
    throw new Error("GraphQL errors");
  }

  return json as T;
}

// Поиск проекта
async function findProjectId(title: string): Promise<string> {
  const query = `
    query {
      viewer {
        projectsV2(first: 20) {
          nodes {
            id
            title
          }
        }
      }
    }
  `;
  console.log(`🔍 Ищем проект с названием "${title}"...`);
  const data = await graphqlRequest<{ data: { viewer: { projectsV2: { nodes: GitHubProject[] } } } }>(query);
  const projects = data.data.viewer.projectsV2.nodes;
  console.log("📋 Доступные проекты:", JSON.stringify(projects, null, 2));
  const project = projects.find((p) => p.title === title);
  if (!project) throw new Error(`Проект "${title}" не найден`);
  console.log(`✅ Найден проект ID: ${project.id}`);
  return project.id;
}

// Загрузка элементов
async function fetchBoardItems(projectId: string): Promise<ProjectItem[]> {
  const query = `
    query($projectId: ID!) {
      node(id: $projectId) {
        ... on ProjectV2 {
          items(first: 100) {
            nodes {
              id
              fieldValues(first: 20) {
                nodes {
                  ... on ProjectV2ItemFieldTextValue {
                    text
                    field { ... on ProjectV2FieldCommon { name } }
                  }
                  ... on ProjectV2ItemFieldSingleSelectValue {
                    name
                    field { ... on ProjectV2FieldCommon { name } }
                  }
                }
              }
              content {
                ... on Issue {
                  title
                  url
                  number
                }
                ... on PullRequest {
                  title
                  url
                  number
                }
              }
            }
          }
        }
      }
    }
  `;
  console.log("📥 Загружаем элементы проекта...");
  const data = await graphqlRequest<{ data: { node: { items: { nodes: any[] } } | null } }>(query, { projectId });
  const node = data?.data?.node;
  if (!node) {
    console.error("❌ Ответ API:", JSON.stringify(data, null, 2));
    throw new Error("Project node is null. Проверь PROJECT_ID и права токена (read:project).");
  }

  const items: ProjectItem[] = (node.items?.nodes ?? []).map((raw: any) => ({
    id: raw.id,
    fieldValues: (raw.fieldValues?.nodes ?? []).map((fv: any) => {
      if (fv.text !== undefined) {
        return { type: "text" as const, text: fv.text, field: fv.field };
      } else if (fv.name !== undefined) {
        return { type: "select" as const, name: fv.name, field: fv.field };
      }
      return { type: "unknown" as const };
    }),
    content: raw.content
      ? {
          title: raw.content.title ?? undefined,
          url: raw.content.url ?? undefined,
          number: raw.content.number ?? undefined,
        }
      : null,
  }));

  console.log(`📊 Получено задач: ${items.length}`);
  return items;
}

// Парсинг
function parseItems(items: ProjectItem[]): BoardCard[] {
  const cards: BoardCard[] = [];
  for (const item of items) {
    let title = "No title";
    let url = "#";
    let number = "";
    let status = "No Status";

    if (item.content) {
      title = item.content.title ?? title;
      url = item.content.url ?? url;
      number = item.content.number?.toString() ?? "";
    }

    for (const fv of item.fieldValues) {
      if (fv.field?.name === "Status") {
        if (fv.type === "select") {
          status = fv.name || "No Status";
        }
        break;
      }
    }
    cards.push({ title, url, number, status });
  }
  return cards;
}

// Генерация HTML
function generateHtml(columns: Record<string, BoardCard[]>): string {
  const now = new Date().toISOString().replace("T", " ").substring(0, 19) + " UTC";
  let html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Jira-like Board</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 20px; background: #f0f2f5; }
        .board { display: flex; gap: 20px; }
        .column { flex: 1; min-width: 250px; background: #f6f8fa; border-radius: 6px; padding: 10px; }
        .column h2 { margin-top: 0; }
        .card { background: white; padding: 10px; margin-bottom: 10px; border-radius: 6px; box-shadow: 0 1px 3px rgba(0,0,0,0.12); }
        .card a { text-decoration: none; color: #0366d6; font-weight: 500; }
        .card span { font-size: 0.8em; color: #586069; }
    </style>
</head>
<body>
    <h1>My Jira Board</h1>
    <p>Last updated: ${now}</p>
    <div class="board">
`;

  for (const [colName, cards] of Object.entries(columns)) {
    html += `<div class="column"><h2>${colName}</h2>`;
    for (const card of cards) {
      html += `<div class="card"><a href="${card.url}" target="_blank">#${card.number} ${card.title}</a></div>`;
    }
    html += `</div>`;
  }

  html += `</div></body></html>`;
  return html;
}

// Главная
async function main() {
  try {
    const projectId = await findProjectId(PROJECT_TITLE);
    const items = await fetchBoardItems(projectId);
    const cards = parseItems(items);

    console.log("Parsed cards:", JSON.stringify(cards, null, 2));

    // Динамическая группировка
    const columns: Record<string, BoardCard[]> = {};
    for (const card of cards) {
      const col = card.status;
      if (!columns[col]) columns[col] = [];
      columns[col].push(card);
    }
    // Гарантируем наличие трёх основных колонок
    if (!columns["Todo"]) columns["Todo"] = [];
    if (!columns["In Progress"]) columns["In Progress"] = [];
    if (!columns["Done"]) columns["Done"] = [];

    console.log("Columns:", Object.keys(columns));

    const html = generateHtml(columns);
    const fs = await import("fs");
    const outputPath = process.env.GITHUB_WORKSPACE
      ? `${process.env.GITHUB_WORKSPACE}/index.html`
      : "index.html";
    fs.writeFileSync(outputPath, html, "utf-8");
    console.log("✅ index.html успешно создан");
  } catch (error: any) {
    console.error("💥 Ошибка:", error.message);
    process.exit(1);
  }
}

main();
