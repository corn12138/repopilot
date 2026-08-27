export function joinClasses(base, flags) {
  const out = [base];
  for (const [name, on] of Object.entries(flags)) {
    if (on) out.push(name);
  }
  return out.join(' ');
}
