function initials(name) {
  return name.split(' ').filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
}

export function avatarLabel(user) {
  const url = user.avatarUrl.trim();
  if (url) return 'img:' + url;
  return 'initials:' + initials(user.name);
}
