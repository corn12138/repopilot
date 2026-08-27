import { Switch, Redirect } from './router/index.mjs';

export function buildRouter() {
  return Switch([
    { path: '/', view: 'home' },
    { path: '/runs', view: 'runs' },
    { path: '*', view: Redirect('/404') },
  ]);
}
