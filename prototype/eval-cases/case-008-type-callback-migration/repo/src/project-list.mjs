import { makeCard } from './project-card.mjs';

export function renderList(projects, onSelect) {
  // 旧签名的残留：把 id 当"项目"传了下去
  return projects.map((p) => makeCard(p.id, onSelect));
}
