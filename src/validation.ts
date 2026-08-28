import { Token } from 'aws-cdk-lib';

export function requireLiteral(value: string, label: string): void {
  if (typeof value !== 'string' || value.trim().length === 0 || Token.isUnresolved(value)) {
    throw new Error(`${label} must be a non-empty, concrete string (no unresolved CDK tokens).`);
  }
}

export function requireUnique(ids: readonly string[], id: string, label: string): void {
  if (ids.includes(id)) throw new Error(`Duplicate ${label} ID: ${id}`);
}
