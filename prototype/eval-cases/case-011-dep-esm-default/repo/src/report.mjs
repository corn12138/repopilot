import toolkit from './lib/toolkit.mjs';

export function report(names) {
  return toolkit.unique(names.map(toolkit.slugify)).join(',');
}
