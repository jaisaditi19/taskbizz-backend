// src/templates.ts
export function renderTaskStartTemplate(occurrence: any) {
  // occurrence includes .title, .task, etc. Adjust to your model
  const title = occurrence.title ?? occurrence.task?.title ?? "Task";
  const body = occurrence.description ?? "";
  return `
    <html>
      <body>
        <h2>${escapeHtml(title)} — starts today</h2>
        <p>${escapeHtml(body)}</p>
        <p>Start: ${escapeHtml(
          new Date(occurrence.startDate).toUTCString()
        )}</p>
      </body>
    </html>
  `;
}

function escapeHtml(s: any) {
  if (!s) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
