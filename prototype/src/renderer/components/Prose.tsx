import { type ReactNode } from 'react';

/**
 * 模型正文的最小 Markdown 呈现。
 *
 * 为什么需要它：模型写的是 Markdown，而时间线一直用 `{text}` 直接渲染 ——
 * 于是 `**Monorepo 结构**`、`` `apps/web` ``、`## 我了解到的` 全部以原样字符
 * 出现在界面上。那不是"朴素"，是把格式标记当正文给用户看。
 *
 * 为什么是"最小"而不是接一个 Markdown 库：
 *   1. 这里渲染的是**模型产出**，是不可信输入。整条实现只构造 React 元素，
 *      不存在 `dangerouslySetInnerHTML`，也不解析链接/图片/HTML ——
 *      结构上就没有注入面，不需要再配一个消毒器。
 *   2. 模型正文的实际形态就这几种：标题、无序/有序列表、粗体、行内码、围栏码块。
 *      支持到这里，剩下的原样透出即可 —— 认不出的标记显示成字面量，
 *      比认错了显示成别的东西安全。
 *
 * 标题刻意**不**渲染成 h1–h6：这是聊天流里的一段话，不是文档，
 * 不该参与页面的标题大纲（读屏会把它念成章节结构）。只做视觉加重。
 */

/** 行内标记：`**粗体**` 与 `` `行内码` ``。两者都不嵌套 —— 模型也几乎不这么写。 */
function inline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*([^*]+)\*\*|`([^`]+)`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    i += 1;
    if (m[2] !== undefined) {
      out.push(<strong key={`${keyPrefix}-b${i}`}>{m[2]}</strong>);
    } else {
      out.push(<code key={`${keyPrefix}-c${i}`}>{m[3]}</code>);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out.length > 0 ? out : [text];
}

type Block =
  | { kind: 'p'; lines: string[] }
  | { kind: 'h'; level: number; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] }
  | { kind: 'code'; lines: string[]; lang: string };

function parse(src: string): Block[] {
  const blocks: Block[] = [];
  const lines = src.split('\n');
  let i = 0;

  const flushParagraph = (buf: string[]) => {
    if (buf.length > 0) blocks.push({ kind: 'p', lines: [...buf] });
    buf.length = 0;
  };

  const para: string[] = [];
  while (i < lines.length) {
    const line = lines[i]!;

    // 围栏码块：结束围栏缺失时一直读到结尾，不把剩下的正文吞成段落
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      flushParagraph(para);
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) {
        body.push(lines[i]!);
        i += 1;
      }
      i += 1; // 跳过收尾围栏（没有就是已经到结尾）
      blocks.push({ kind: 'code', lines: body, lang: fence[1] ?? '' });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph(para);
      blocks.push({ kind: 'h', level: heading[1]!.length, text: heading[2]! });
      i += 1;
      continue;
    }

    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph(para);
      const items: string[] = [];
      while (i < lines.length) {
        const b = /^\s*[-*]\s+(.*)$/.exec(lines[i]!);
        if (!b) break;
        items.push(b[1]!);
        i += 1;
      }
      blocks.push({ kind: 'ul', items });
      continue;
    }

    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      flushParagraph(para);
      const items: string[] = [];
      while (i < lines.length) {
        const n = /^\s*\d+[.)]\s+(.*)$/.exec(lines[i]!);
        if (!n) break;
        items.push(n[1]!);
        i += 1;
      }
      blocks.push({ kind: 'ol', items });
      continue;
    }

    if (line.trim() === '') {
      flushParagraph(para);
      i += 1;
      continue;
    }

    para.push(line);
    i += 1;
  }
  flushParagraph(para);
  return blocks;
}

export function Prose({ text }: { text: string }) {
  const blocks = parse(text);
  return (
    <div className="prose">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'h':
            return (
              <div key={i} className={`prose-h prose-h${b.level}`}>
                {inline(b.text, `h${i}`)}
              </div>
            );
          case 'ul':
            return (
              <ul key={i} className="prose-list">
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it, `u${i}-${j}`)}</li>
                ))}
              </ul>
            );
          case 'ol':
            return (
              <ol key={i} className="prose-list">
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it, `o${i}-${j}`)}</li>
                ))}
              </ol>
            );
          case 'code':
            return (
              <pre key={i} className="prose-code" data-lang={b.lang || undefined}>
                {b.lines.join('\n')}
              </pre>
            );
          case 'p':
            return (
              <p key={i} className="prose-p">
                {b.lines.map((l, j) => (
                  // 段内换行原样保留：模型经常用软换行排版，合并会把对齐弄散
                  <span key={j}>
                    {j > 0 && <br />}
                    {inline(l, `p${i}-${j}`)}
                  </span>
                ))}
              </p>
            );
        }
      })}
    </div>
  );
}
