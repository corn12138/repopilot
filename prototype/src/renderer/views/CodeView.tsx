import { useEffect, useRef } from 'react';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { HighlightStyle, bracketMatching, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { markdown } from '@codemirror/lang-markdown';

/**
 * 只读代码视图（CodeMirror 6，全部本地打包，无远程资源）。
 *
 * 边界与这个应用的不变式一致：这是**查看器不是写入口** ——
 * Renderer 没有 FS，内容来自 files.read 的 IPC 投影；编辑态被显式关闭
 * （readOnly + 不可编辑），用户改代码的唯一路径仍然是任务 → 补丁 → 人工接受。
 * 语法高亮颜色走 CSS 变量（--syn-*），主题层可整体覆盖。
 */

const HIGHLIGHT = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--syn-keyword, #c792ea)' },
  { tag: [tags.name, tags.deleted, tags.character, tags.macroName], color: 'var(--syn-name, #e6e1dc)' },
  { tag: [tags.function(tags.variableName), tags.labelName], color: 'var(--syn-function, #82aaff)' },
  { tag: [tags.color, tags.constant(tags.name), tags.standard(tags.name)], color: 'var(--syn-constant, #f78c6c)' },
  { tag: [tags.definition(tags.name), tags.separator], color: 'var(--syn-definition, #e6e1dc)' },
  { tag: [tags.typeName, tags.className, tags.number, tags.changed, tags.annotation, tags.modifier, tags.self, tags.namespace], color: 'var(--syn-type, #ffcb6b)' },
  { tag: [tags.operator, tags.operatorKeyword, tags.url, tags.escape, tags.regexp, tags.link, tags.special(tags.string)], color: 'var(--syn-operator, #89ddff)' },
  { tag: [tags.meta, tags.comment], color: 'var(--syn-comment, #7f8ea3)', fontStyle: 'italic' },
  { tag: [tags.atom, tags.bool, tags.special(tags.variableName)], color: 'var(--syn-atom, #f78c6c)' },
  { tag: [tags.processingInstruction, tags.string, tags.inserted], color: 'var(--syn-string, #c3e88d)' },
  { tag: tags.invalid, color: 'var(--syn-invalid, #ff5370)' },
]);

const THEME = EditorView.theme({
  '&': { backgroundColor: 'transparent', color: 'var(--text-primary)', fontSize: '12px', height: '100%' },
  '.cm-content': { fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)', caretColor: 'transparent' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--text-tertiary)',
    border: 'none',
    borderRight: '1px solid var(--border-hairline)',
  },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { overflow: 'auto' },
});

/** 按扩展名挑语言；认不出就返回 null —— 纯文本展示，不硬套一个语法 */
export function languageOf(path: string): Extension | null {
  const name = path.toLowerCase();
  const ext = name.slice(name.lastIndexOf('.') + 1);
  switch (ext) {
    case 'ts':
    case 'mts':
    case 'cts':
      return javascript({ typescript: true });
    case 'tsx':
      return javascript({ typescript: true, jsx: true });
    case 'js':
    case 'mjs':
    case 'cjs':
      return javascript();
    case 'jsx':
      return javascript({ jsx: true });
    case 'json':
      return json();
    case 'css':
      return css();
    case 'html':
    case 'htm':
      return html();
    case 'md':
    case 'markdown':
      return markdown();
    default:
      return null;
  }
}

export function CodeView({ path, content }: { path: string; content: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const lang = languageOf(path);
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: content,
        extensions: [
          lineNumbers(),
          bracketMatching(),
          syntaxHighlighting(HIGHLIGHT, { fallback: true }),
          THEME,
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.lineWrapping,
          ...(lang ? [lang] : []),
        ],
      }),
    });
    return () => view.destroy();
  }, [path, content]);

  return <div ref={hostRef} className="codeview" data-testid="codeview" />;
}
