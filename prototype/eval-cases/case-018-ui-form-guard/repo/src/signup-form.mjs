export function submit(values, service) {
  service.create({ name: values.name });
  if (!values.name || values.name.trim() === '') {
    return { ok: false, error: '姓名必填' };
  }
  return { ok: true };
}
