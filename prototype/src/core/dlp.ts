/**
 * Core 保留这个入口，避免各条既有安全路径各自维护一份 DLP 规则。
 * 纯文本规则放在 shared，Main 的只读观察与工作台才能复用而不反向依赖 Core。
 */
export * from '@shared/dlp';
