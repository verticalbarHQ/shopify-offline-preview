import { Drop } from "liquidjs";

export class UnknownBackupValue extends Drop {
  valueOf() {
    return undefined;
  }
  override liquidMethodMissing() {
    return this;
  }
}
export class UnknownCapturedValue extends UnknownBackupValue {
  constructor(readonly output: string) {
    super();
  }
}
export class UnknownSelectedVariant extends UnknownBackupValue {}
export function capturedBackupOutput(value: unknown): string | undefined {
  return value instanceof UnknownCapturedValue ? value.output : undefined;
}
export function unknownBackupValue(value: unknown): boolean {
  return value instanceof UnknownBackupValue;
}
export const unknown = new UnknownBackupValue();
export const unknownSelectedVariant = new UnknownSelectedVariant();
export function unknownBackupFact(): unknown {
  return unknown;
}
