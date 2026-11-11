/**
 * P6-54 (L9): the database category of the security audit. Database: SQL nodes (app.postgres, app.mySql) with an expression in the query or unused query parameters.
 */
import type { ServiceDeps } from '../../context';
import type { AuditLocation, AuditRiskReport, AuditRunOptions, AuditSection } from './types';
import { eachWorkflow, nodeLocation } from './types';

const SQL_NODE_TYPES = new Set(['app.postgres', 'app.mySql']);

/** `$1` (Postgres) or `?` (MySQL) */
const PLACEHOLDER = /\$\d+|\?/;

function hasValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.trim() !== '';
  return value !== undefined && value !== null;
}

/** null when the category finds no risk */
export async function databaseReport(
  deps: ServiceDeps,
  tenantId: string,
  _options: AuditRunOptions,
): Promise<AuditRiskReport | null> {
  const withExpression: AuditLocation[] = [];
  const withUnused: AuditLocation[] = [];
  await eachWorkflow(deps, tenantId, (workflow) => {
    for (const node of workflow.nodes) {
      if (!SQL_NODE_TYPES.has(node.type)) continue;
      const parameters = (node.parameters ?? {}) as Record<string, unknown>;
      if (parameters.operation !== 'executeQuery') continue;
      const query = typeof parameters.query === 'string' ? parameters.query : '';
      if (query.startsWith('=') && query.includes('{{')) withExpression.push(nodeLocation(workflow, node));
      const options = (parameters.options ?? {}) as Record<string, unknown>;
      if (hasValue(options.queryReplacement) && !PLACEHOLDER.test(query)) {
        withUnused.push(nodeLocation(workflow, node));
      }
    }
  });

  const sections: AuditSection[] = [];
  if (withExpression.length > 0) {
    sections.push({
      title: 'SQL queries that contain expressions',
      description:
        'The query text of these nodes holds an expression. A value that comes from outside the workflow can change the query itself (SQL injection).',
      recommendation: 'Keep the query text fixed and pass values as query parameters ($1, $2 or ?).',
      location: withExpression,
    });
  }
  if (withUnused.length > 0) {
    sections.push({
      title: 'SQL nodes with query parameters the query does not use',
      description:
        'These nodes set query parameters, but the query has no placeholder for them. The values are probably joined into the query text instead.',
      recommendation: 'Refer to each value with a placeholder ($1, $2 or ?) in the query.',
      location: withUnused,
    });
  }
  return sections.length > 0 ? { risk: 'database', sections } : null;
}
