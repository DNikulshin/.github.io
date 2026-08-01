const https = require('https');
const fs = require('fs');
const path = require('path');

// ---------- КОНФИГУРАЦИЯ ----------
const PROJECT_TITLE = 'My Jira';   // название твоего проекта (можно заменить на ID)
let PROJECT_ID = '';               // если оставить пустым, скрипт найдёт по названию
const TOKEN = process.env.GH_TOKEN;

if (!TOKEN) {
  console.error('❌ Переменная GH_TOKEN не задана');
  process.exit(1);
}

// ---------- ПОМОЩНИК ДЛЯ GraphQL‑ЗАПРОСОВ ----------
function graphqlRequest(query, variables = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ query, variables });
    const options = {
      hostname: 'api.github.com',
      path: '/graphql',
      method: 'POST',
      headers: {
        'Authorization': `bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'JiraBoardGenerator/1.0'
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (res.statusCode !== 200) {
            console.error(`❌ HTTP ${res.statusCode}: ${body}`);
            reject(new Error(`HTTP ${res.statusCode}`));
          } else if (json.errors) {
            console.error('❌ GraphQL errors:', JSON.stringify(json.errors, null, 2));
            reject(new Error('GraphQL errors'));
          } else {
            resolve(json);
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ---------- ПОЛУЧЕНИЕ ID ПРОЕКТА (если не задан) ----------
async function getProjectId() {
  if (PROJECT_ID) return PROJECT_ID;

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

  console.log('🔍 Ищем проект по названию:', PROJECT_TITLE);
  const result = await graphqlRequest(query);
  const projects = result.data.viewer.projectsV2.nodes;
  console.log('📋 Доступные проекты:', JSON.stringify(projects, null, 2));

  const project = projects.find(p => p.title === PROJECT_TITLE);
  if (!project) {
    throw new Error(`Проект с названием "${PROJECT_TITLE}" не найден`);
  }
  PROJECT_ID = project.id;
  console.log('✅ Найден PROJECT_ID:', PROJECT_ID);
  return PROJECT_ID;
}

// ---------- ЗАГРУЗКА ЭЛЕМЕНТОВ ПРОЕКТА ----------
async function fetchBoardItems(projectId) {
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

  console.log('📥 Загружаем элементы проекта...');
  const result = await graphqlRequest(query, { projectId });

  // проверяем, что node не null
  const node = result?.data?.node;
  if (!node) {
    console.error('❌ Ответ API:', JSON.stringify(result, null, 2));
    throw new Error('Project node is null. Проверь PROJECT_ID и права токена (read:project).');
  }

  const items = node.items?.nodes || [];
  console.log(`📊 Получено задач: ${items.length}`);
  return items;
}

// ---------- ПАРСИНГ ДАННЫХ ----------
function parseItems(items) {
  const parsed = [];
  for (const item of items) {
    let title = 'No title';
    let url = '#';
    let number = '';
    let status = 'No Status';

    if (item.content) {
      title = item.content.title || title;
      url = item.content.url || url;
      number = item.content.number || '';
    }

    // Ищем поле статуса
    for (const fv of item.fieldValues?.nodes || []) {
      if (fv?.field?.name === 'Status') {
        status = fv.name || 'No Status';
        break;
      }
    }

    parsed.push({ title, url, number, status });
  }
  return parsed;
}

// ---------- ГЕНЕРАЦИЯ HTML ----------
function generateHtml(columns) {
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19) + ' UTC';
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
    html += '</div>';
  }

  html += `</div></body></html>`;
  return html;
}

// ---------- ГЛАВНАЯ ФУНКЦИЯ ----------
async function main() {
  try {
    const projectId = await getProjectId();
    const items = await fetchBoardItems(projectId);
    const parsed = parseItems(items);

    // Группировка по статусам
    const columns = {
      'Todo': [],
      'In Progress': [],
      'Done': [],
    };
    for (const item of parsed) {
      const col = item.status;
      if (!columns[col]) columns[col] = [];
      columns[col].push(item);
    }

    const html = generateHtml(columns);
    const outputPath = path.join(process.env.GITHUB_WORKSPACE || '.', 'index.html');
    fs.writeFileSync(outputPath, html, 'utf-8');
    console.log('✅ index.html успешно создан');
  } catch (e) {
    console.error('💥 Ошибка:', e.message);
    process.exit(1);
  }
}

main();
