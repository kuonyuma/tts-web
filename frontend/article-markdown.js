import { escapeHtml } from './api.js';

// Article-only presentation. Stored text and the existing AI renderer stay independent.
function inline(text, depth = 0) {
  if (depth > 8) return escapeHtml(text);
  const tokens = /(`+)(.*?)\1|(!?)\[([^\]\n]+)\]\(([^)\s]+)\)|(\*\*|__)([^\n]+?)\6|([*_])([^\n]+?)\8/g;
  let result = '', cursor = 0;
  for (const match of text.matchAll(tokens)) {
    result += escapeHtml(text.slice(cursor, match.index));
    if (match[1]) result += `<code>${escapeHtml(match[2])}</code>`;
    else if (match[4]) {
      const label = inline(match[4], depth + 1);
      // Images remain captions; rendering an article must not fetch external resources.
      if (!match[3] && /^(https?:\/\/|mailto:|#)/i.test(match[5])) {
        result += `<a href="${escapeHtml(match[5])}" target="_blank" rel="noopener noreferrer">${label}</a>`;
      } else result += label;
    } else if (match[6]) result += `<strong>${inline(match[7], depth + 1)}</strong>`;
    else result += `<em>${inline(match[9], depth + 1)}</em>`;
    cursor = match.index + match[0].length;
  }
  return result + escapeHtml(text.slice(cursor));
}

const fence = line => line.match(/^\s{0,3}(`{3,}|~{3,})([^`]*)$/);
const heading = line => line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
const listItem = line => line.match(/^(\s*)([-+*]|\d+[.)])\s+(.+)$/);
const quote = line => /^\s{0,3}>/.test(line);
const rule = line => /^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line);
const tableRule = line => /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line || '');
const cells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));

function blocks(lines, depth = 0, collect = null) {
  if (depth > 16) return `<p>${lines.map(escapeHtml).join('<br>')}</p>`;
  const output = [];
  const startsBlock = i => fence(lines[i]) || heading(lines[i]) || rule(lines[i])
    || quote(lines[i]) || listItem(lines[i]) || (lines[i].includes('|') && tableRule(lines[i + 1]));
  for (let i = 0; i < lines.length;) {
    if (!lines[i].trim()) { i++; continue; }
    const start = i, outputStart = output.length;
    const finish = () => {
      if (!collect) return;
      let end = i;
      while (end > start && !lines[end - 1].trim()) end--;
      collect({ start, end, html: output.slice(outputStart).join('') });
    };
    const codeFence = fence(lines[i]);
    if (codeFence) {
      const closing = new RegExp('^\\s{0,3}' + codeFence[1][0] + '{' + codeFence[1].length + ',}\\s*$');
      const content = [];
      i++;
      while (i < lines.length && !closing.test(lines[i])) content.push(lines[i++]);
      if (i < lines.length) i++;
      output.push(`<pre><code>${escapeHtml(content.join('\n'))}</code></pre>`);
      finish();
      continue;
    }
    const title = heading(lines[i]);
    if (title) {
      output.push(`<h${title[1].length}>${inline(title[2])}</h${title[1].length}>`);
      i++; finish(); continue;
    }
    if (rule(lines[i])) { output.push('<hr>'); i++; finish(); continue; }
    if (quote(lines[i])) {
      const quoted = [];
      while (i < lines.length && quote(lines[i])) quoted.push(lines[i++].replace(/^\s{0,3}>\s?/, ''));
      output.push(`<blockquote>${blocks(quoted, depth + 1)}</blockquote>`);
      finish();
      continue;
    }
    const item = listItem(lines[i]);
    if (item) {
      const ordered = /^\d/.test(item[2]), indent = item[1].length;
      const tag = ordered ? 'ol' : 'ul';
      const start = ordered ? Number.parseInt(item[2], 10) : 1;
      output.push(`<${tag}${ordered && start !== 1 ? ` start="${start}"` : ''}>`);
      while (i < lines.length) {
        const next = listItem(lines[i]);
        if (!next || next[1].length !== indent || /^\d/.test(next[2]) !== ordered) break;
        const content = [next[3]];
        i++;
        while (i < lines.length) {
          if (!lines[i].trim()) { content.push(''); i++; continue; }
          const spaces = lines[i].match(/^\s*/)[0].length;
          if (spaces <= indent) break;
          content.push(lines[i++].slice(Math.min(spaces, indent + 2)));
        }
        output.push(`<li>${blocks(content, depth + 1)}</li>`);
      }
      output.push(`</${tag}>`);
      finish();
      continue;
    }
    if (lines[i].includes('|') && tableRule(lines[i + 1])) {
      const headers = cells(lines[i]); i += 2;
      output.push('<table><thead><tr>' + headers.map(cell => `<th>${inline(cell)}</th>`).join('') + '</tr></thead><tbody>');
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        const row = cells(lines[i++]);
        output.push('<tr>' + headers.map((_, index) => `<td>${inline(row[index] || '')}</td>`).join('') + '</tr>');
      }
      output.push('</tbody></table>');
      finish();
      continue;
    }
    const paragraph = [lines[i++]];
    while (i < lines.length && lines[i].trim() && !startsBlock(i)) paragraph.push(lines[i++]);
    output.push(`<p>${paragraph.map(line => inline(line)).join('<br>')}</p>`);
    finish();
  }
  return output.join('');
}

/** UTF-16 source offsets, including original CRLF and Markdown syntax, for editing and anchors. */
export function renderArticleBlocks(text) {
  const source = String(text), lines = source.split(/\r\n|\r|\n/), starts = [0], result = [];
  for (const match of source.matchAll(/\r\n|\r|\n/g)) starts.push(match.index + match[0].length);
  blocks(lines, 0, part => result.push({
    start: starts[part.start],
    end: starts[part.end - 1] + lines[part.end - 1].length,
    html: part.html,
  }));
  return result;
}
