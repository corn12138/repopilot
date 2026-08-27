export function renderUserCard(user) {
  const lines = [];
  lines.push('name: ' + user.name);
  if (user.email) {
    lines.push('email: ' + user.email);
  return lines.join('\n');
}
