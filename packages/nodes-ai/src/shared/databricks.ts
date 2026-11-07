/**
 * Databricks workspace URLs. Calls to the workspace carry the client secret or an OAuth token, so
 * anything but plain https is refused. The error never repeats the host.
 */
import { trimSlash } from './chat-model';

/**
 * The workspace host as an https origin with no trailing slash, such as
 * `https://<workspace>.cloud.databricks.com`. Refuses http, credentials in the URL, a query and a hash.
 */
export function databricksHttpsHost(host: string): string {
  const base = trimSlash(host);
  let url: URL | undefined;
  try {
    url = new URL(base);
  } catch {
    url = undefined;
  }
  if (url?.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(
      'The Databricks host must be an https URL, such as https://<workspace>.cloud.databricks.com',
    );
  }
  return base;
}

/** The base URL of a Databricks workspace's OpenAI-compatible AI gateway. */
export function databricksGatewayUrl(host: string): string {
  return `${databricksHttpsHost(host)}/ai-gateway/openai/v1`;
}
