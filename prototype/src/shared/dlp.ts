/**
 * 模型出站前的最小 DLP（PRD-DATA-003 的原型子集）。
 *
 * 只做**高置信度**模式：命中即阻断、整笔 NOT_SENT、P0 没有"仍然发送"旁路（DEC-008）。
 * 不做低置信度启发（高熵字符串、"password=" 之类）—— 误报会把合法任务拦死，
 * 而原型没有 override，所以宁可漏一些低置信度的，也不让一条假警报把人锁在门外。
 *
 * 命中结果只带**种类、条数、位置**，绝不带命中的原文 —— DLP 的结论本身也会写进
 * manifest / 事件 / UI，把 secret 抄进去等于自己先泄漏一次。
 */

export type DlpKind =
  | 'AWS_ACCESS_KEY_ID'
  | 'PRIVATE_KEY_BLOCK'
  | 'BEARER_TOKEN'
  | 'OPENAI_STYLE_KEY'
  | 'ANTHROPIC_STYLE_KEY'
  | 'GITHUB_TOKEN'
  | 'SLACK_TOKEN'
  | 'GOOGLE_API_KEY';

interface Pattern {
  readonly kind: DlpKind;
  readonly re: RegExp;
}

/*
 * 全部是"前缀 + 固定字符集 + 固定长度"的结构化凭据；不用 \b 是因为有些前缀前后是符号。
 * 不放 sk- 的短形式：那会命中太多测试夹具里的占位符。
 */
const PATTERNS: readonly Pattern[] = [
  { kind: 'AWS_ACCESS_KEY_ID', re: /(?:^|[^A-Z0-9])(AKIA|ASIA)[0-9A-Z]{16}(?![A-Z0-9])/ },
  { kind: 'PRIVATE_KEY_BLOCK', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/ },
  { kind: 'BEARER_TOKEN', re: /Authorization:\s*Bearer\s+[A-Za-z0-9._~+/=-]{24,}/i },
  { kind: 'OPENAI_STYLE_KEY', re: /(?:^|[^A-Za-z0-9])sk-(?:proj-|ant-api\d{2}-)?[A-Za-z0-9_-]{32,}/ },
  { kind: 'ANTHROPIC_STYLE_KEY', re: /sk-ant-api\d{2}-[A-Za-z0-9_-]{40,}/ },
  { kind: 'GITHUB_TOKEN', re: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}/ },
  { kind: 'SLACK_TOKEN', re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { kind: 'GOOGLE_API_KEY', re: /AIza[0-9A-Za-z_-]{35}/ },
];

export interface DlpHit {
  readonly kind: DlpKind;
  /** 调用方给的定位（第几条消息 / 哪个文件），不含原文 */
  readonly where: string;
}

/** 扫一段文本。返回命中的种类（每种只报一次），不返回原文 */
export function scanText(text: string, where: string): DlpHit[] {
  const hits: DlpHit[] = [];
  for (const p of PATTERNS) {
    if (p.re.test(text)) hits.push({ kind: p.kind, where });
  }
  return hits;
}

/** 扫多段（例如整个对话）：每段独立定位，结果去重到 (kind, where) */
export function scanSegments(segments: readonly { text: string; where: string }[]): DlpHit[] {
  const seen = new Set<string>();
  const out: DlpHit[] = [];
  for (const seg of segments) {
    for (const h of scanText(seg.text, seg.where)) {
      const key = `${h.kind}@${h.where}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(h);
    }
  }
  return out;
}

/** 给 blockReason / 事件用的一句话：种类 + 位置，绝不含原文 */
export function describeDlpHits(hits: readonly DlpHit[]): string {
  const kinds = [...new Set(hits.map((h) => h.kind))];
  const wheres = [...new Set(hits.map((h) => h.where))];
  return `DLP: ${kinds.join(', ')} @ ${wheres.slice(0, 5).join(', ')}${wheres.length > 5 ? ` 等 ${wheres.length} 处` : ''}`;
}

/*
 * 脱敏：把命中的 span 换成 `[REDACTED:<KIND>]`。用于**本地持久化与展示**层（命令输出预览、
 * 工具输出预览/artifact）—— 这是 TD §9.4 "ToolResultProjection 先做 DLP/redaction" 的原型落点，
 * 也是 08-17 审计 D4（持久化前没有内容级 DLP）的修补。私钥块整段（BEGIN…END）一起拿掉，
 * 只脱头部会把密钥正文留在后面。
 */
const REDACT_PATTERNS: readonly { kind: DlpKind; re: RegExp; keepPrefixGroup: boolean }[] = [
  { kind: 'PRIVATE_KEY_BLOCK', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----|$)/g, keepPrefixGroup: false },
  { kind: 'AWS_ACCESS_KEY_ID', re: /(^|[^A-Z0-9])((?:AKIA|ASIA)[0-9A-Z]{16})(?![A-Z0-9])/g, keepPrefixGroup: true },
  { kind: 'BEARER_TOKEN', re: /(Authorization:\s*Bearer\s+)[A-Za-z0-9._~+/=-]{24,}/gi, keepPrefixGroup: true },
  { kind: 'ANTHROPIC_STYLE_KEY', re: /sk-ant-api\d{2}-[A-Za-z0-9_-]{40,}/g, keepPrefixGroup: false },
  { kind: 'OPENAI_STYLE_KEY', re: /(^|[^A-Za-z0-9])(sk-(?:proj-)?[A-Za-z0-9_-]{32,})/g, keepPrefixGroup: true },
  { kind: 'GITHUB_TOKEN', re: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}/g, keepPrefixGroup: false },
  { kind: 'SLACK_TOKEN', re: /xox[baprs]-[A-Za-z0-9-]{10,}/g, keepPrefixGroup: false },
  { kind: 'GOOGLE_API_KEY', re: /AIza[0-9A-Za-z_-]{35}/g, keepPrefixGroup: false },
];

export interface RedactResult {
  readonly text: string;
  /** 被脱敏的种类（去重）；空数组 = 原文未动 */
  readonly redacted: readonly DlpKind[];
}

export function redactText(text: string): RedactResult {
  let out = text;
  const kinds = new Set<DlpKind>();
  for (const p of REDACT_PATTERNS) {
    p.re.lastIndex = 0;
    if (!p.re.test(out)) continue;
    p.re.lastIndex = 0;
    kinds.add(p.kind);
    out = p.keepPrefixGroup
      ? out.replace(p.re, (_m, prefix: string) => `${prefix}[REDACTED:${p.kind}]`)
      : out.replace(p.re, `[REDACTED:${p.kind}]`);
  }
  return { text: out, redacted: [...kinds] };
}
