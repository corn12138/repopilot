// 合同：onChange(value: string) —— 订阅者只关心值，不关心事件形状
export function attachInput(field, onChange) {
  field.subscribe((event) => {
    onChange(event);
  });
}
