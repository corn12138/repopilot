// 部署 base 由外层传入（"/" 或 "/repo-pilot/"）；生成的地址必须落在 base 之下
export function assetUrl(base, path) {
  return '/' + path;
}

export function routeHref(base, path) {
  return path;
}
