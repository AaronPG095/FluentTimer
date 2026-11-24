export function section(body, heading) {
  const out = [];
  let on = false;
  for (const line of body.split('\n')) {
    if (/^## /.test(line)) {
      on = line.slice(3).trim().toLowerCase() === heading.toLowerCase();
      continue;
    }
    if (on) out.push(line);
  }
  return out.join('\n').trim();
}

export function appendToSection(body, heading, entry) {
  const lines = body.split('\n');
  const start = lines.findIndex(
    (l) => l.trim().toLowerCase() === `## ${heading}`.toLowerCase(),
  );
  if (start === -1)
    return `${body.replace(/\s*$/, '')}\n\n## ${heading}\n\n${entry}\n`;
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end === -1) end = lines.length;
  while (end > start + 1 && lines[end - 1].trim() === '') end--;
  lines.splice(end, 0, entry);
  return lines.join('\n');
}

export function findCheckboxes(body) {
  const lines = body.split('\n');
  const items = [];
  let currentSection = '';
  let openIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s+/.test(line)) {
      currentSection = line.replace(/^##\s+/, '').trim();
      continue;
    }
    const match = line.match(/^(\s*-\s*\[)([ xX])(\]\s*)(.*)$/);
    if (match) {
      const isChecked = match[2].toLowerCase() === 'x';
      const text = match[4].trim();
      const isDeferred = /deferred:/i.test(text);
      if (!isChecked && !isDeferred) {
        openIndex++;
      }
      items.push({
        lineIndex: i,
        prefix: match[1],
        box: match[2],
        delim: match[3],
        text,
        isChecked,
        isDeferred,
        section: currentSection,
        openIndex: !isChecked && !isDeferred ? openIndex : null,
      });
    }
  }
  return { lines, items };
}

export function findRunnerTarget(items, target) {
  const identity = (item) =>
    item.text
      .replace(
        /\s+(?:verified(?:\((?:test|cmd|manual|inspect)\))?|deferred):.*$/i,
        '',
      )
      .trim();
  const targetText = identity(target);
  const candidates = items.filter(
    (item) =>
      item.section.toLowerCase() === target.section.toLowerCase() &&
      identity(item) === targetText,
  );
  return (
    candidates.find((item) => item.lineIndex === target.lineIndex) ||
    (candidates.length === 1 ? candidates[0] : null)
  );
}

export function countOpenQuestions(body) {
  const raw = section(body, 'Open questions');
  if (!raw) return 0;
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter(
      (l) =>
        l &&
        !l.startsWith('<!--') &&
        !l.endsWith('-->') &&
        !/^<[^>]+>$/.test(l) &&
        !/^(?:\(none\)|none\.?)$/i.test(l) &&
        !/^- \[[xX]\]/.test(l),
    )
    .filter((l) => /^- /.test(l) || /\?$/.test(l)).length;
}

export function missingCheckboxes(original, candidate) {
  const identity = (item) =>
    JSON.stringify([
      item.section.toLowerCase(),
      item.text
        .replace(
          /\s+(?:verified(?:\((?:test|cmd|manual|inspect)\))?|deferred):.*$/i,
          '',
        )
        .trim(),
    ]);
  const remaining = new Map();
  for (const item of findCheckboxes(candidate).items) {
    const key = identity(item);
    remaining.set(key, (remaining.get(key) || 0) + 1);
  }
  return findCheckboxes(original).items.filter((item) => {
    const key = identity(item);
    const count = remaining.get(key) || 0;
    if (!count) return true;
    remaining.set(key, count - 1);
    return false;
  });
}

export function bodyOf(text) {
  const norm = text.replace(/\r\n/g, '\n');
  const m = norm.match(/^---\n[\s\S]*?\n---\n/);
  return m ? norm.slice(m[0].length) : norm;
}
