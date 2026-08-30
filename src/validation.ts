import { Token } from 'aws-cdk-lib';
import { REGIONS, type Region } from './schema';

export function requireLiteral(value: string, label: string): void {
  if (typeof value !== 'string' || value.trim().length === 0 || Token.isUnresolved(value)) {
    throw new Error(`${label} must be a non-empty, concrete string (no unresolved CDK tokens).`);
  }
}

export function requireUnique(ids: readonly string[], id: string, label: string): void {
  if (ids.includes(id)) throw new Error(`Duplicate ${label} ID: ${id}`);
}

/** Foundry stores the account as a string of exactly twelve digits. */
export function requireAccountId(value: string, label: string): void {
  requireLiteral(value, label);
  if (!/^\d{12}$/.test(value)) throw new Error(`${label} must be a 12-digit AWS account ID, got "${value}".`);
}

/** Foundry runs in a fixed set of regions, so anything else is rejected before it is stored. */
export function requireRegion(value: string, label: string): Region {
  requireLiteral(value, label);
  if (!REGIONS.includes(value as Region)) {
    throw new Error(`${label} must be one of ${REGIONS.join(', ')}, got "${value}".`);
  }
  return value as Region;
}

export function requirePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer.`);
}
