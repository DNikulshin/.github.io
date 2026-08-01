import os
import json
import requests
from datetime import datetime

# Конфигурация
PROJECT_ID = "твой_project_id"  # Узнаешь ниже
TOKEN = os.environ["GH_TOKEN"]
HEADERS = {"Authorization": f"bearer {TOKEN}", "Content-Type": "application/json"}

def run_query(query, variables={}):
    response = requests.post("https://api.github.com/graphql",
                             json={"query": query, "variables": variables},
                             headers=HEADERS)
    if response.status_code == 200:
        return response.json()
    else:
        raise Exception(f"Query failed: {response.status_code}, {response.text}")

# Получаем Project ID, если не знаешь — сначала выполни запрос списка проектов
# В GraphQL API ID проекта нужен глобальный (начинается с "PVT_")
if not PROJECT_ID:
    user_query = """
    query {
      viewer {
        projectsV2(first: 10) {
          nodes {
            id
            title
          }
        }
      }
    }
    """
    data = run_query(user_query)
    projects = data["data"]["viewer"]["projectsV2"]["nodes"]
    for p in projects:
        if p["title"] == "My Jira":  # название твоего проекта
            PROJECT_ID = p["id"]
            break
    if not PROJECT_ID:
        raise Exception("Project not found")

# Запрос элементов проекта с нужными полями (title, status, url)
query = """
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
"""
variables = {"projectId": PROJECT_ID}
result = run_query(query, variables)

# Парсим ответ в удобный вид
items = result["data"]["node"]["items"]["nodes"]
parsed = []
for item in items:
    title = ""
    url = ""
    number = ""
    status = "No Status"
    if item["content"]:
        content = item["content"]
        title = content.get("title", "No title")
        url = content.get("url", "#")
        number = content.get("number", "")
    # Ищем поле статуса
    for field_value in item["fieldValues"]["nodes"]:
        if field_value.get("field", {}).get("name") == "Status":
            status = field_value.get("name", "No Status")
            break
    parsed.append({
        "title": title,
        "url": url,
        "number": number,
        "status": status
    })

# Группируем по статусам для канбана
columns = {"Todo": [], "In Progress": [], "Done": []}
for p in parsed:
    col = p["status"]
    if col not in columns:
        columns[col] = []
    columns[col].append(p)

# Генерируем HTML
html = f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Jira-like Board</title>
    <style>
        body {{ font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 20px; }}
        .board {{ display: flex; gap: 20px; }}
        .column {{ flex: 1; min-width: 250px; background: #f6f8fa; border-radius: 6px; padding: 10px; }}
        .column h2 {{ margin-top: 0; }}
        .card {{ background: white; padding: 10px; margin-bottom: 10px; border-radius: 6px; box-shadow: 0 1px 3px rgba(0,0,0,0.12); }}
        .card a {{ text-decoration: none; color: #0366d6; font-weight: 500; }}
        .card span {{ font-size: 0.8em; color: #586069; }}
    </style>
</head>
<body>
    <h1>My Jira Board</h1>
    <p>Last updated: {datetime.utcnow().strftime('%Y-%m-%d %H:%M UTC')}</p>
    <div class="board">
"""

for col_name, cards in columns.items():
    html += f'<div class="column"><h2>{col_name}</h2>'
    for card in cards:
        html += f'<div class="card"><a href="{card["url"]}" target="_blank">#{card["number"]} {card["title"]}</a></div>'
    html += '</div>'

html += """
    </div>
</body>
</html>
"""

# Сохраняем в index.html
with open("index.html", "w", encoding="utf-8") as f:
    f.write(html)
print("Board generated successfully")
