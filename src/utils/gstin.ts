const BASE36 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export function isValidGSTIN(gstin: string): boolean {
  const v = gstin?.toUpperCase()?.trim();
  if (!/^[0-9]{2}[A-Z0-9]{13}$/.test(v)) return false;

  const val = (ch: string) => BASE36.indexOf(ch);
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const c = val(v[i]);
    if (c < 0) return false;
    const prod = i % 2 === 0 ? c : c * 2;
    sum += Math.floor(prod / 36) + (prod % 36);
  }
  const check = (36 - (sum % 36)) % 36;
  return BASE36[check] === v[14];
}

export function panFromGSTIN(gstin: string) {
  const v = gstin?.toUpperCase()?.trim();
  return v?.length === 15 ? v.slice(2, 12) : null;
}
