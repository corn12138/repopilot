import { describe, expect, it } from 'vitest';
import { describeDlpHits, redactText, scanSegments, scanText } from './dlp';

/**
 * 最小 DLP 的两个方向都要钉：高置信度模式必须命中；常见的"像但不是"不能误报。
 * 以及一条纪律：结论里**绝不出现原文**。
 */

describe('scanText：高置信度命中', () => {
  it.each([
    ['AWS_ACCESS_KEY_ID', 'export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE'],
    ['AWS_ACCESS_KEY_ID', 'key=ASIAIOSFODNN7EXAMPLE;'],
    ['PRIVATE_KEY_BLOCK', '-----BEGIN RSA PRIVATE KEY-----\nMIIE...'],
    ['PRIVATE_KEY_BLOCK', '-----BEGIN OPENSSH PRIVATE KEY-----'],
    ['PRIVATE_KEY_BLOCK', '-----BEGIN PGP PRIVATE KEY BLOCK-----'],
    ['BEARER_TOKEN', 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc'],
    ['OPENAI_STYLE_KEY', 'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD'],
    ['GITHUB_TOKEN', 'ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123'],
    ['SLACK_TOKEN', 'xoxb-123456789012-abcdefghijkl'],
    ['GOOGLE_API_KEY', 'AIzaSyA1234567890abcdefghijklmnopqrstuv'],
  ])('%s', (kind, text) => {
    expect(scanText(text, 'x').map((h) => h.kind)).toContain(kind);
  });
});

describe('scanText：不误报', () => {
  it.each([
    'const password = process.env.PASSWORD;',
    'token: "sk-test"', // 太短，不是真 key 形态
    'AKIA placeholder: AKIA...', // 没有 16 位大写字母数字
    'Authorization: Bearer <token>',
    'BEGIN PRIVATE KEY is what PEM files start with', // 没有 ----- 围栏
    'ghp_short',
    'xoxb-',
    'AIza123', // 不够长
  ])('%s', (text) => {
    expect(scanText(text, 'x')).toEqual([]);
  });
});

describe('scanSegments / describeDlpHits', () => {
  it('按 (kind, where) 去重，描述里只有种类与位置、没有原文', () => {
    const secret = 'AKIAIOSFODNN7EXAMPLE';
    const hits = scanSegments([
      { text: `a ${secret}`, where: 'message[1]' },
      { text: `b ${secret}`, where: 'message[1]' },
      { text: `c ${secret}`, where: 'message[3].tool_result' },
    ]);
    expect(hits).toEqual([
      { kind: 'AWS_ACCESS_KEY_ID', where: 'message[1]' },
      { kind: 'AWS_ACCESS_KEY_ID', where: 'message[3].tool_result' },
    ]);
    const text = describeDlpHits(hits);
    expect(text).toBe('DLP: AWS_ACCESS_KEY_ID @ message[1], message[3].tool_result');
    expect(text).not.toContain(secret);
  });
});

describe('redactText：脱敏用于本地持久化/展示层', () => {
  it('把命中的 span 换成占位符，保留前缀字符；私钥块整段拿掉', () => {
    const r = redactText(
      'export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\nxyz\n-----END RSA PRIVATE KEY-----\ntail ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123',
    );
    expect(r.text).toBe('export AWS_ACCESS_KEY_ID=[REDACTED:AWS_ACCESS_KEY_ID]\n[REDACTED:PRIVATE_KEY_BLOCK]\ntail [REDACTED:GITHUB_TOKEN]');
    expect([...r.redacted].sort()).toEqual(['AWS_ACCESS_KEY_ID', 'GITHUB_TOKEN', 'PRIVATE_KEY_BLOCK']);
    expect(r.text).not.toContain('MIIEabc');
  });
  it('没有 END 围栏的私钥块：从 BEGIN 到文末全部拿掉', () => {
    const r = redactText('before\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNz\nmore');
    expect(r.text).toBe('before\n[REDACTED:PRIVATE_KEY_BLOCK]');
  });
  it('没命中的文本原样返回，redacted 为空', () => {
    const r = redactText('const password = process.env.PASSWORD;');
    expect(r).toEqual({ text: 'const password = process.env.PASSWORD;', redacted: [] });
  });
  it('脱敏后的文本再扫一遍不再命中 —— 占位符本身不是凭据形态', () => {
    const r = redactText('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abcdef AIzaSyA1234567890abcdefghijklmnopqrstuv');
    expect(scanText(r.text, 'x')).toEqual([]);
  });
});
